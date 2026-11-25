#!/usr/bin/env node
/**
 * Ask Eternal eval suite — real chat turns against a running dev worker,
 * scored by checking actual app state afterwards (not by reading the reply).
 *
 *   EVAL_EMAIL=... EVAL_PASSWORD=... node scripts/agent-eval.mjs [--api http://localhost:8789]
 *       [--only id,id] [--build] [--repeat N] [--out report.json]
 *
 * Needs: `wrangler dev` with the AI binding (logged-in wrangler) and an
 * existing local account. Each run deploys fixture apps ("Evalog", "Tally")
 * with known data and a known bug, runs every scenario (auto-approving every
 * approval card), checks state through the apps' own backends, then deletes
 * the fixtures. Scenarios come from failures seen in live testing.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const API = flag('api', process.env.EVAL_API ?? 'http://localhost:8789');
const ONLY = flag('only', '')?.split(',').filter(Boolean) ?? [];
const WITH_BUILD = args.includes('--build');
const REPEAT = Number(flag('repeat', '1'));
const OUT = flag('out', '');
const EMAIL = process.env.EVAL_EMAIL;
const PASSWORD = process.env.EVAL_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Set EVAL_EMAIL and EVAL_PASSWORD (a local dev account).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let token = '';
async function api(path, { method = 'GET', body, auth = token, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function login() {
  const res = await api('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, auth: '' });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.data)}`);
  token = res.data.token;
}

/** Call an installed app's backend as its owner (capability token). */
async function appApi(appId, path, init = {}) {
  const cap = await api(`/api/apps/${appId}/capability`, { method: 'POST', body: {} });
  if (!cap.ok) throw new Error(`capability failed for ${appId}: ${cap.status}`);
  return api(`/api/apps/${appId}/api${path}`, { ...init, auth: cap.data.token });
}

async function appFile(appId, file) {
  const res = await fetch(`${API}/api/apps/${appId}/${file}`);
  return res.ok ? res.text() : null;
}

async function listDesktopApps() {
  const res = await api('/api/desktop');
  const items = res.data?.items ?? res.data?.desktop?.items ?? [];
  return items.filter((i) => i.type === 'app' && !i.isTrashed);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVALOG_SERVER = `export default {
  async fetch(request, env) {
    env.sql.exec('CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const url = new URL(request.url);
    // GET /api/entries
    if (url.pathname === '/api/entries' && request.method === 'GET') {
      return Response.json(env.sql.exec('SELECT * FROM entries ORDER BY id').toArray());
    }
    // POST /api/entries
    if (url.pathname === '/api/entries' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
      if (!body.text) return Response.json({ error: 'text is required' }, { status: 400 });
      return Response.json(env.sql.exec('INSERT INTO entries (text, created_at) VALUES (?, ?) RETURNING *', String(body.text), Date.now()).one(), { status: 201 });
    }
    // DELETE /api/entries/:id
    const m = url.pathname.match(/^\\/api\\/entries\\/(\\d+)$/);
    if (m && request.method === 'DELETE') {
      env.sql.exec('DELETE FROM entries WHERE id = ?', Number(m[1]));
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
`;

const EVALOG_FILES = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css"></head><body><h1>Evalog</h1><ul id="list"></ul><script type="module" src="./app.js"></script></body></html>',
  'styles.css': 'body{font:14px system-ui;margin:16px}',
  'app.js': `const list = document.getElementById('list');
async function load() {
  const entries = await window.eternal.api.get('/entries');
  list.innerHTML = '';
  for (const e of entries) { const li = document.createElement('li'); li.textContent = e.text; list.appendChild(li); }
}
window.eternal.api.onChange(load);
load();
`,
  'server.js': EVALOG_SERVER,
};

// A deliberate logic bug: "+" decrements. The fix scenario checks it.
const TALLY_FILES = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Tally</title><link rel="stylesheet" href="./styles.css"></head><body><h1 id="title">Tally</h1><p id="count">0</p><button id="plus">+</button><button id="minus">-</button><script type="module" src="./app.js"></script></body></html>',
  'styles.css': 'body{font:16px system-ui;margin:16px}#count{font-size:40px}',
  'app.js': `let count = 0;
const out = document.getElementById('count');
function render() { out.textContent = String(count); }
function increment() {
  count = count - 1;
  render();
}
function decrement() {
  count = count - 1;
  render();
}
document.getElementById('plus').addEventListener('click', increment);
document.getElementById('minus').addEventListener('click', decrement);
render();
`,
};


// A large frontend with one bug in the middle: totals subtract. Tests that a
// fix lands as a small precise edit in a big file (live failure: rewriting a
// 30KB file in a tool call ran the model out of output).
const LEDGER_HELPERS = Array.from({ length: 120 }, (_, i) => `function fmt${i}(value) {
  const text = String(value ?? '');
  return text.length > ${i % 7 + 3} ? text.slice(0, ${i % 7 + 3}) : text.padStart(${i % 7 + 3}, ' ');
}`).join('\n');
const LEDGER_FILES = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css"></head><body><h1>Ledger</h1><ul id="rows"></ul><p>Total: <span id="total">0</span></p><script type="module" src="./app.js"></script></body></html>',
  'styles.css': 'body{font:14px system-ui;margin:16px}',
  'app.js': `const ROWS = [{ label: 'Coffee', amount: 4 }, { label: 'Lunch', amount: 12 }, { label: 'Books', amount: 30 }];
${LEDGER_HELPERS}
function computeTotal(rows) {
  let total = 0;
  for (const row of rows) {
    total -= row.amount;
  }
  return total;
}
function render() {
  const list = document.getElementById('rows');
  list.textContent = '';
  for (const row of ROWS) {
    const li = document.createElement('li');
    li.textContent = row.label + ': ' + row.amount;
    list.appendChild(li);
  }
  document.getElementById('total').textContent = String(computeTotal(ROWS));
}
render();
`,
};

// Backend fixture with a logic bug (leaderboard sorted ascending) and a route
// that crashes (selects a column that does not exist) — tests server fixes and
// diagnosing from getAppBackendLogs.
const SCORES_SERVER = `export default {
  async fetch(request, env) {
    env.sql.exec('CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, score INTEGER NOT NULL)');
    const url = new URL(request.url);
    // POST /api/scores
    if (url.pathname === '/api/scores' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
      if (!body.player || typeof body.score !== 'number') return Response.json({ error: 'player and numeric score required' }, { status: 400 });
      return Response.json(env.sql.exec('INSERT INTO scores (player, score) VALUES (?, ?) RETURNING *', String(body.player), body.score).one(), { status: 201 });
    }
    // GET /api/top — leaderboard, best first
    if (url.pathname === '/api/top' && request.method === 'GET') {
      return Response.json(env.sql.exec('SELECT player, score FROM scores ORDER BY score ASC LIMIT 10').toArray());
    }
    // GET /api/stats
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      console.log('computing stats');
      return Response.json(env.sql.exec('SELECT COUNT(*) AS games, AVG(points) AS average FROM scores').one());
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
`;
const SCORES_FILES = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css"></head><body><h1>Scores</h1><ol id="top"></ol><p id="stats"></p><script type="module" src="./app.js"></script></body></html>',
  'styles.css': 'body{font:14px system-ui;margin:16px}',
  'app.js': `async function load() {
  const top = await window.eternal.api.get('/top');
  const list = document.getElementById('top');
  list.textContent = '';
  for (const row of top) { const li = document.createElement('li'); li.textContent = row.player + ' ' + row.score; list.appendChild(li); }
  try {
    const stats = await window.eternal.api.get('/stats');
    document.getElementById('stats').textContent = stats.games + ' games, avg ' + stats.average;
  } catch (err) {
    document.getElementById('stats').textContent = 'Stats error: ' + err.message;
  }
}
window.eternal.api.onChange(load);
load();
`,
  'server.js': SCORES_SERVER,
};

async function deployFixture(name, files) {
  // Remove leftovers from an aborted earlier run (same name = ambiguous).
  for (const item of await listDesktopApps()) {
    const appName = item.appManifest?.name ?? item.name;
    if (appName === name && item.appManifest?.appId) await api(`/api/apps/${item.appManifest.appId}`, { method: 'DELETE' });
  }
  const res = await api('/api/apps/dev-deploy', {
    method: 'POST',
    body: {
      manifest: { name, description: `${name} eval fixture`, version: '1.0.0', windowConfig: { defaultWidth: 420, defaultHeight: 360, resizable: true } },
      files,
    },
  });
  if (!res.ok) throw new Error(`deploy ${name} failed: ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`);
  return res.data.appId;
}

// ---------------------------------------------------------------------------
// Chat turn runner (auto-approves every approval card)
// ---------------------------------------------------------------------------

async function runTurn(text, { timeoutMs = 300_000, maxApprovalRounds = 6, threadId: existingThread } = {}) {
  const threadId = existingThread ?? `eval-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mint = await api('/api/agent/chat/ws-token', { method: 'POST', body: {} });
  const wsToken = mint.data?.token ?? mint.data?.wsToken;
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/agent/chat?wsToken=${encodeURIComponent(wsToken)}&threadId=${encodeURIComponent(threadId)}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  const started = Date.now();
  const trace = { tools: [], toolErrors: [], approvals: 0, text: '', streamErrors: [], data: [] };
  const toolNames = new Map();
  const priorHistory = existingThread
    ? await api(`/api/agent/chat/get-messages?threadId=${encodeURIComponent(threadId)}`)
    : null;
  const prior = Array.isArray(priorHistory?.data) ? priorHistory.data : [];
  let messages = [...prior, { id: `u-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }];

  const send = (id) => ws.send(JSON.stringify({
    id,
    init: { method: 'POST', body: JSON.stringify({ messages, trigger: 'submit-message', threadId }) },
    type: 'cf_agent_use_chat_request',
  }));

  const request = (id) => new Promise((resolve) => {
    let pending = 0;
    const timer = setTimeout(() => resolve({ pending, timedOut: true }), Math.max(1, timeoutMs - (Date.now() - started)));
    ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type !== 'cf_agent_use_chat_response' || frame.id !== id) return;
      if (frame.body) {
        let chunk;
        try { chunk = JSON.parse(frame.body); } catch { chunk = null; }
        if (chunk?.type === 'text-delta') trace.text += chunk.delta;
        else if (chunk?.type === 'tool-input-available') {
          toolNames.set(chunk.toolCallId, chunk.toolName);
          trace.tools.push({ name: chunk.toolName, input: chunk.input, toolCallId: chunk.toolCallId });
        } else if (chunk?.type === 'tool-output-error') {
          trace.toolErrors.push({ name: toolNames.get(chunk.toolCallId), error: String(chunk.errorText).slice(0, 300) });
        } else if (chunk?.type === 'tool-input-error') {
          trace.toolErrors.push({ name: chunk.toolName, error: `input: ${String(chunk.errorText).slice(0, 300)}` });
        } else if (chunk?.type === 'tool-output-available') {
          const t = trace.tools.findLast((x) => x.name === toolNames.get(chunk.toolCallId));
          if (t) t.output = chunk.output;
        } else if (chunk?.type === 'tool-approval-request') pending += 1;
        else if (typeof chunk?.type === 'string' && chunk.type.startsWith('data-')) trace.data.push({ type: chunk.type, id: chunk.id, data: chunk.data });
        else if (chunk?.type === 'error') trace.streamErrors.push(String(chunk.errorText).slice(0, 300));
      }
      if (frame.done) { clearTimeout(timer); resolve({ pending, timedOut: false }); }
    };
  });

  let round = 0;
  let result = await (send(`r0-${threadId}`), request(`r0-${threadId}`));
  while (result.pending > 0 && !result.timedOut && round < maxApprovalRounds) {
    round += 1;
    const hist = await api(`/api/agent/chat/get-messages?threadId=${encodeURIComponent(threadId)}`);
    messages = Array.isArray(hist.data) ? hist.data : hist.data?.messages ?? [];
    for (const m of messages) for (const p of m.parts ?? []) {
      if (p.state === 'approval-requested') { p.state = 'approval-responded'; p.approval = { ...p.approval, approved: true }; trace.approvals += 1; }
    }
    const id = `r${round}-${threadId}`;
    send(id);
    result = await request(id);
  }
  ws.close();
  trace.ms = Date.now() - started;
  trace.timedOut = result.timedOut;
  trace.threadId = threadId;
  return trace;
}


/** Several user turns on ONE thread; returns the merged trace (last turn's text). */
async function runConversation(prompts, options = {}) {
  let threadId;
  const merged = { tools: [], toolErrors: [], approvals: 0, text: '', streamErrors: [], data: [], ms: 0, turns: [] };
  for (const prompt of prompts) {
    const trace = await runTurn(prompt, { ...options, threadId });
    threadId = trace.threadId;
    merged.tools.push(...trace.tools);
    merged.toolErrors.push(...trace.toolErrors);
    merged.streamErrors.push(...trace.streamErrors);
    merged.data.push(...trace.data);
    merged.approvals += trace.approvals;
    merged.ms += trace.ms;
    merged.text = trace.text;
    merged.turns.push({ prompt, tools: trace.tools.map((t) => t.name), text: trace.text });
    merged.timedOut = trace.timedOut;
    merged.threadId = threadId;
    if (trace.timedOut) break;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Scenarios — each returns { pass, reason }
// ---------------------------------------------------------------------------

const claimsSuccess = (t) => /\b(I('ve| have) (added|saved|created|updated|fixed)|has been (added|saved|created|updated|fixed)|Done!)/i.test(t);
const usedTool = (trace, name) => trace.tools.some((t) => t.name === name);
const webReadFailure = (trace) => {
  const reads = trace.tools.filter((t) => t.name === 'readWebPage');
  return `did not read the page${reads.length ? ` (${reads.map((t) => `${t.input?.url}: ${t.output?.error ?? 'no output'}`).join('; ')})` : ''}`;
};

function scenarios(ctx) {
  const marker = `eval-${Math.random().toString(36).slice(2, 7)}`;
  return [
    {
      id: 'read-app-data',
      prompt: 'what entries are in my Evalog?',
      check: async (trace) => {
        const missing = ['first seeded entry', 'second seeded entry'].filter((s) => !trace.text.toLowerCase().includes(s));
        return missing.length ? { pass: false, reason: `reply missing: ${missing.join(', ')}` } : { pass: true };
      },
    },
    {
      id: 'write-no-app-word',
      prompt: `add an entry saying '${marker}' to my evalog`,
      check: async (trace) => {
        const rows = (await appApi(ctx.evalog, '/entries')).data ?? [];
        if (!rows.some((r) => r.text === marker)) return { pass: false, reason: 'entry not stored' };
        if (trace.approvals > 1) return { pass: false, reason: `${trace.approvals} approvals for one write` };
        return { pass: true };
      },
    },
    {
      id: 'write-several',
      prompt: 'add three entries to Evalog: alpha, beta and gamma',
      check: async () => {
        const texts = ((await appApi(ctx.evalog, '/entries')).data ?? []).map((r) => r.text.toLowerCase());
        const missing = ['alpha', 'beta', 'gamma'].filter((w) => !texts.includes(w));
        return missing.length ? { pass: false, reason: `missing: ${missing.join(', ')}` } : { pass: true };
      },
    },
    {
      id: 'delete-app-data',
      prompt: "delete the 'beta' entry from my Evalog",
      check: async () => {
        const texts = ((await appApi(ctx.evalog, '/entries')).data ?? []).map((r) => r.text.toLowerCase());
        if (texts.includes('beta')) return { pass: false, reason: 'beta still present' };
        if (!texts.includes('alpha')) return { pass: false, reason: 'deleted the wrong entry' };
        return { pass: true };
      },
    },
    {
      id: 'aggregate-count',
      prompt: 'how many entries does my Evalog have right now? Reply with the number.',
      check: async (trace) => {
        const n = ((await appApi(ctx.evalog, '/entries')).data ?? []).length;
        return new RegExp(`\\b${n}\\b`).test(trace.text) ? { pass: true } : { pass: false, reason: `expected ${n} in reply` };
      },
    },
    {
      id: 'fix-logic-bug',
      prompt: 'the + button in my Tally app makes the number go down instead of up. Please fix it.',
      check: async (trace) => {
        const js = await appFile(ctx.tally, 'app.js');
        const body = /function increment\(\)\s*\{([\s\S]*?)\n\}/.exec(js ?? '')?.[1] ?? '';
        const dec = /function decrement\(\)\s*\{([\s\S]*?)\n\}/.exec(js ?? '')?.[1] ?? '';
        if (!body) return { pass: false, reason: 'increment() missing after edit' };
        if (!/\+\s*1|\+\+|\+=\s*1/.test(body) || /-\s*1|--/.test(body)) return { pass: false, reason: `increment still wrong: ${body.trim().slice(0, 80)}` };
        if (!/-\s*1|--|-=\s*1/.test(dec)) return { pass: false, reason: 'broke decrement()' };
        if (usedTool(trace, 'buildAppFromPrompt')) return { pass: false, reason: 'rebuilt the app instead of fixing it' };
        return { pass: true };
      },
    },
    {
      id: 'edit-ui-text',
      prompt: "change the heading in my Tally app to say 'Tally Counter'",
      check: async () => {
        const html = await appFile(ctx.tally, 'index.html');
        return /<h1[^>]*>\s*Tally Counter\s*<\/h1>/.test(html ?? '') ? { pass: true } : { pass: false, reason: 'heading not changed' };
      },
    },
    {
      id: 'honest-no-such-app',
      prompt: 'add milk to my shopping list',
      check: async (trace) => {
        if (usedTool(trace, 'rememberMemory')) return { pass: false, reason: 'stored app data as a memory' };
        if (claimsSuccess(trace.text)) return { pass: false, reason: 'claimed success without an app' };
        return { pass: true };
      },
    },
    {
      id: 'list-apps',
      prompt: 'which apps do I have?',
      check: async (trace) => {
        const missing = ['Evalog', 'Tally', 'Ledger', 'Scores', 'Counter'].filter((n) => !trace.text.includes(n));
        return missing.length ? { pass: false, reason: `reply missing ${missing.join(', ')}` } : { pass: true };
      },
    },
    {
      id: 'fix-large-file',
      prompt: 'the total at the bottom of my Ledger app is wrong: it subtracts the amounts instead of adding them. Fix it.',
      check: async (trace) => {
        const js = await appFile(ctx.ledger, 'app.js');
        const body = /function computeTotal\(rows\)\s*\{([\s\S]*?)\n\}/.exec(js ?? '')?.[1] ?? '';
        if (!/total\s*\+=|total\s*=\s*total\s*\+/.test(body) || /total\s*-=/.test(body)) return { pass: false, reason: `computeTotal still wrong: ${body.trim().slice(0, 80)}` };
        if (!js.includes('function fmt119(')) return { pass: false, reason: 'rest of the file was lost' };
        return { pass: true };
      },
    },
    {
      id: 'fix-backend-logic',
      prompt: "my Scores app's leaderboard shows the lowest scores first. It should show the highest scores first. Fix it.",
      check: async () => {
        const top = (await appApi(ctx.scores, '/top')).data ?? [];
        const values = top.map((r) => r.score);
        const sorted = [...values].sort((a, b) => b - a);
        if (values.length < 3) return { pass: false, reason: `leaderboard broken: ${JSON.stringify(top).slice(0, 120)}` };
        return JSON.stringify(values) === JSON.stringify(sorted) ? { pass: true } : { pass: false, reason: `order ${values.join(',')}` };
      },
    },
    {
      id: 'diagnose-backend-error',
      prompt: "the stats line in my Scores app shows an error. What's wrong? Don't change anything yet, just tell me.",
      check: async (trace) => {
        if (trace.tools.some((t) => ['editApp', 'updateApp', 'buildAppFromPrompt'].includes(t.name))) return { pass: false, reason: 'changed the app when asked not to' };
        return /points/i.test(trace.text) ? { pass: true } : { pass: false, reason: 'did not identify the missing "points" column' };
      },
    },
    {
      id: 'honest-rejected-write',
      prompt: 'add an entry with no text at all to my Evalog',
      check: async (trace) => {
        const rows = (await appApi(ctx.evalog, '/entries')).data ?? [];
        if (rows.some((r) => !String(r.text).trim())) return { pass: true, reason: 'stored an empty entry (allowed only if the app accepted it)' };
        if (claimsSuccess(trace.text)) return { pass: false, reason: 'claimed success for a rejected write' };
        return { pass: true };
      },
    },
    {
      id: 'batch-ten',
      prompt: 'add the numbers 1 through 10 to my Evalog, each as its own entry',
      check: async () => {
        const texts = new Set(((await appApi(ctx.evalog, '/entries')).data ?? []).map((r) => String(r.text).trim()));
        const missing = Array.from({ length: 10 }, (_, i) => String(i + 1)).filter((n) => !texts.has(n));
        return missing.length ? { pass: false, reason: `missing ${missing.join(',')}` } : { pass: true };
      },
    },
    {
      id: 'followup-write',
      prompts: ['what entries are in my Evalog?', `ok, add '${marker}-followup' to it`],
      check: async () => {
        const rows = (await appApi(ctx.evalog, '/entries')).data ?? [];
        return rows.some((r) => r.text === `${marker}-followup`) ? { pass: true } : { pass: false, reason: 'follow-up write not stored' };
      },
    },
    {
      id: 'followup-edit',
      prompts: ['what does my Counter app do?', "change its heading to say 'Counter Pro'"],
      check: async () => {
        const html = await appFile(ctx.counter, 'index.html');
        return /<h1[^>]*>\s*Counter Pro\s*<\/h1>/.test(html ?? '') ? { pass: true } : { pass: false, reason: 'heading not changed' };
      },
    },
    {
      id: 'followup-affirm',
      prompts: [
        "the + button in my Counter app makes the number go down. What's wrong? Don't change anything yet.",
        'ok, go ahead and fix it',
      ],
      check: async (trace) => {
        if (trace.turns[0]?.tools.some((t) => ['editApp', 'updateApp'].includes(t))) return { pass: false, reason: 'changed the app in the diagnose-only turn' };
        const js = await appFile(ctx.counter, 'app.js');
        const body = /function increment\(\)\s*\{([\s\S]*?)\n\}/.exec(js ?? '')?.[1] ?? '';
        if (!/\+\s*1|\+\+|\+=\s*1/.test(body) || /-\s*1|--/.test(body)) return { pass: false, reason: `increment still wrong: ${body.trim().slice(0, 80)}` };
        return { pass: true };
      },
    },
    {
      id: 'followup-thanks-stays-chat',
      prompts: ['which apps do I have?', 'thanks!'],
      check: async (trace) => {
        const second = trace.turns[1];
        if (second?.tools.some((t) => !['listApps', 'listMemories'].includes(t))) return { pass: false, reason: `acted on "thanks": ${second.tools.join(',')}` };
        return { pass: true };
      },
    },
    // Code Mode previews, undo, cross-app runs and routines.
    {
      id: 'preview-two-writes',
      prompt: `add two entries to my Evalog: 'pv-a-${marker}' and 'pv-b-${marker}'`,
      check: async (trace) => {
        const texts = ((await appApi(ctx.evalog, '/entries')).data ?? []).map((r) => r.text);
        const missing = [`pv-a-${marker}`, `pv-b-${marker}`].filter((t) => !texts.includes(t));
        if (missing.length) return { pass: false, reason: `missing: ${missing.join(', ')}` };
        if (trace.approvals !== 1) return { pass: false, reason: `${trace.approvals} approvals (want one preview)` };
        const preview = trace.data.find((d) => d.type === 'data-codemode-preview' && d.data?.ok);
        if (!preview || preview.data.actions.length !== 2) return { pass: false, reason: `preview: ${JSON.stringify(preview?.data?.actions?.map((a) => a.summary))}` };
        return { pass: true };
      },
    },
    {
      id: 'undo-run',
      prompt: `add entries 'un-1-${marker}' and 'un-2-${marker}' to my Evalog`,
      check: async (trace) => {
        const undo = trace.data.findLast((d) => d.type === 'data-codemode-undo' && d.data?.available);
        if (!undo) return { pass: false, reason: 'no undoable run' };
        const before = ((await appApi(ctx.evalog, '/entries')).data ?? []).filter((r) => r.text.startsWith(`un-`) && r.text.endsWith(marker));
        if (before.length !== 2) return { pass: false, reason: `expected 2 entries before undo, saw ${before.length}` };
        const res = await api(`/api/agent/runs/${encodeURIComponent(undo.data.runId)}/undo?threadId=${encodeURIComponent(trace.threadId)}`, { method: 'POST', body: {} });
        if (!res.ok || res.data?.status !== 'undone') return { pass: false, reason: `undo: ${res.status} ${JSON.stringify(res.data).slice(0, 160)}` };
        const after = ((await appApi(ctx.evalog, '/entries')).data ?? []).filter((r) => r.text.startsWith(`un-`) && r.text.endsWith(marker));
        if (after.length) return { pass: false, reason: `${after.length} entries left after undo` };
        const again = await api(`/api/agent/runs/${encodeURIComponent(undo.data.runId)}/undo?threadId=${encodeURIComponent(trace.threadId)}`, { method: 'POST', body: {} });
        return again.status === 409 ? { pass: true } : { pass: false, reason: `second undo answered ${again.status}` };
      },
    },
    {
      id: 'cross-app-file',
      prompt: `add each line of ${ctx.listFile} as its own entry in my Evalog`,
      check: async () => {
        const texts = ((await appApi(ctx.evalog, '/entries')).data ?? []).map((r) => String(r.text).trim());
        const missing = [`cx-1-${ctx.listMarker}`, `cx-2-${ctx.listMarker}`].filter((t) => !texts.includes(t));
        return missing.length ? { pass: false, reason: `missing: ${missing.join(', ')}` } : { pass: true };
      },
    },
    {
      id: 'save-routine',
      prompt: `every day at 7:00, add an entry 'daily-${marker}' to my Evalog`,
      check: async (trace) => {
        const list = await api(`/api/agent/routines?threadId=${encodeURIComponent(trace.threadId)}`);
        const routines = list.data?.routines ?? [];
        for (const r of routines) await api(`/api/agent/routines/${r.id}?threadId=${encodeURIComponent(trace.threadId)}`, { method: 'DELETE' });
        if (routines.length !== 1) return { pass: false, reason: `${routines.length} routines saved` };
        if (!/07:00|7:00/.test(routines[0].schedule)) return { pass: false, reason: `schedule: ${routines[0].schedule}` };
        if (!routines[0].code.includes('callAppApi')) return { pass: false, reason: 'routine code does not write to the app' };
        return { pass: true };
      },
    },
    {
      id: 'web-to-app',
      prompt: 'add the title of the page https://www.iana.org/help/example-domains as an entry in my Evalog',
      check: async (trace) => {
        const read = trace.tools.find((t) => t.name === 'readWebPage' && t.output?.ok);
        if (!read) return { pass: false, reason: webReadFailure(trace) };
        const texts = ((await appApi(ctx.evalog, '/entries')).data ?? []).map((r) => String(r.text));
        return texts.some((t) => /example domains/i.test(t)) ? { pass: true } : { pass: false, reason: `entries: ${texts.slice(-3).join(' | ')}` };
      },
    },
    {
      id: 'web-to-note',
      prompt: `read https://en.wikipedia.org/wiki/Apple_pie and save a two-sentence summary of it as a note called web-${marker}`,
      check: async (trace) => {
        if (!trace.tools.some((t) => t.name === 'readWebPage' && t.output?.ok)) return { pass: false, reason: webReadFailure(trace) };
        const res = await api('/api/desktop');
        const items = res.data?.items ?? [];
        const note = items.find((i) => i.type === 'text' && !i.isTrashed && String(i.name).startsWith(`web-${marker}`));
        if (!note) return { pass: false, reason: 'no note created' };
        await api('/api/desktop/items', { method: 'PATCH', body: [{ id: note.id, updates: { isTrashed: true, trashedAt: Date.now() } }] });
        return /apple/i.test(String(note.textContent ?? '')) && /pie/i.test(String(note.textContent ?? '')) ? { pass: true } : { pass: false, reason: `note text: ${String(note.textContent).slice(0, 120)}` };
      },
    },
    {
      // The user never gave a link: the assistant must not open pages on its own.
      id: 'web-no-unlinked-reads',
      prompt: "what's the top story on the New York Times website right now?",
      check: async (trace) => {
        const opened = trace.tools.filter((t) => t.name === 'readWebPage' && t.output?.ok);
        if (opened.length) return { pass: false, reason: `opened ${opened.map((t) => t.output.finalUrl).join(', ')}` };
        return { pass: true };
      },
    },
    {
      // App skins: a look request restyles the app (not its code) and is applied.
      id: 'skin-app',
      prompt: 'make my Tally app look like an old brass scientific instrument',
      timeoutMs: 240_000,
      check: async (trace) => {
        const made = trace.tools.find((t) => t.name === 'designAppSkin' && t.output?.ok);
        if (!made) return { pass: false, reason: `no skin made (${trace.tools.map((t) => t.name).join(', ') || 'no tools'})` };
        if (made.output.appId !== ctx.tally) return { pass: false, reason: 'skinned the wrong app' };
        if (trace.tools.some((t) => ['editApp', 'updateApp'].includes(t.name))) return { pass: false, reason: 'changed the app code for a look request' };
        const active = await api(`/api/apps/${ctx.tally}/skins/active`);
        return active.data?.skinId === made.output.skinId ? { pass: true } : { pass: false, reason: 'skin not active' };
      },
    },
    {
      // Shaped windows: a Winamp-style request gets a frameless, shaped window.
      id: 'skin-shaped-window',
      prompt: 'make my Tally app a round frameless window, like an old Winamp skin',
      timeoutMs: 240_000,
      check: async (trace) => {
        const made = trace.tools.find((t) => t.name === 'designAppSkin' && t.output?.ok);
        if (!made) return { pass: false, reason: `no skin made (${trace.tools.map((t) => t.name).join(', ') || 'no tools'})` };
        const active = await api(`/api/apps/${ctx.tally}/skins/active`);
        const win = active.data?.skin?.window;
        if (!win?.frameless || !win.shape) return { pass: false, reason: `window: ${JSON.stringify(win ?? null)}` };
        return win.drag?.length ? { pass: true } : { pass: false, reason: 'frameless window cannot be dragged' };
      },
    },
    {
      id: 'skin-switch-back',
      prompt: 'switch Tally back to its original look',
      check: async (trace) => {
        const active = await api(`/api/apps/${ctx.tally}/skins/active`);
        if (active.data?.skinId) return { pass: false, reason: `still skinned (${trace.tools.map((t) => t.name).join(', ') || 'no tools'})` };
        return { pass: true };
      },
    },
    ...(WITH_BUILD ? [{
      id: 'build-fullstack',
      prompt: 'build me a simple notes app with a backend: add a note, list notes, delete a note',
      timeoutMs: 420_000,
      check: async (trace) => {
        const built = trace.tools.find((t) => t.name === 'buildAppFromPrompt' && t.output?.status === 'created');
        if (!built) return { pass: false, reason: 'no app created' };
        ctx.cleanup.push(built.output.appId);
        const routes = await api(`/api/apps/${built.output.appId}/permissions`);
        return routes.ok ? { pass: true } : { pass: false, reason: 'built app not reachable' };
      },
    }] : []),
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await login();
const results = [];
let budgetExhausted = false;
for (let rep = 0; rep < REPEAT; rep += 1) {
  const ctx = { cleanup: [] };
  ctx.evalog = await deployFixture('Evalog', EVALOG_FILES);
  ctx.tally = await deployFixture('Tally', TALLY_FILES);
  ctx.ledger = await deployFixture('Ledger', LEDGER_FILES);
  ctx.counter = await deployFixture('Counter', Object.fromEntries(Object.entries(TALLY_FILES).map(([name, body]) => [name, body.replaceAll('Tally', 'Counter')])));
  ctx.scores = await deployFixture('Scores', SCORES_FILES);
  for (const [player, score] of [['ana', 12], ['bo', 40], ['cy', 25], ['di', 7]]) {
    await appApi(ctx.scores, '/scores', { method: 'POST', body: { player, score } });
  }
  await appApi(ctx.scores, '/stats'); // populate backend logs with the crash
  await appApi(ctx.evalog, '/entries', { method: 'POST', body: { text: 'first seeded entry' } });
  await appApi(ctx.evalog, '/entries', { method: 'POST', body: { text: 'second seeded entry' } });
  // A desktop text file for the cross-app scenario.
  ctx.listMarker = Math.random().toString(36).slice(2, 7);
  ctx.listFile = `eval-list-${ctx.listMarker}.txt`;
  const listItem = await api('/api/desktop/items', {
    method: 'POST',
    body: { type: 'text', name: ctx.listFile, textContent: `cx-1-${ctx.listMarker}\ncx-2-${ctx.listMarker}\n`, parentId: null, position: { x: 1, y: 1 }, isPublic: false },
  });
  ctx.listItemId = listItem.data?.id;

  for (const s of scenarios(ctx).filter((x) => !ONLY.length || ONLY.includes(x.id))) {
    if (budgetExhausted) break;
    let trace;
    let verdict;
    try {
      trace = s.prompts
        ? await runConversation(s.prompts, { timeoutMs: s.timeoutMs })
        : await runTurn(s.prompt, { timeoutMs: s.timeoutMs });
      const limitError = trace.streamErrors.find((e) => /Daily AI limit reached/i.test(e));
      if (limitError) {
        // The account's daily AI budget is spent: later scenarios would all
        // "fail" in 0s. Stop and say so instead of reporting agent failures.
        budgetExhausted = true;
        console.log(`STOP  daily AI budget exhausted for this account — use a fresh local account. (${limitError.slice(0, 120)})`);
        break;
      }
      verdict = trace.timedOut ? { pass: false, reason: 'timed out' } : await s.check(trace);
    } catch (error) {
      verdict = { pass: false, reason: `harness error: ${error.message}` };
    }
    const row = {
      rep, id: s.id, pass: verdict.pass, reason: verdict.reason ?? '',
      ms: trace?.ms, approvals: trace?.approvals, tools: trace?.tools.map((t) => t.name), toolErrors: trace?.toolErrors,
      text: trace?.text?.slice(0, 400), threadId: trace?.threadId,
    };
    results.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${s.id.padEnd(20)} ${String(Math.round((row.ms ?? 0) / 1000)).padStart(4)}s  approvals=${row.approvals ?? '-'}  tools=${(row.tools ?? []).join('>')}${row.pass ? '' : `  <- ${row.reason}`}`);
    for (const e of row.toolErrors ?? []) console.log(`        tool error ${e.name}: ${e.error.slice(0, 160)}`);
    if (!row.pass) for (const e of trace?.streamErrors ?? []) console.log(`        stream error: ${e.slice(0, 200)}`);
  }

  for (const id of [ctx.evalog, ctx.tally, ctx.ledger, ctx.scores, ctx.counter, ...ctx.cleanup]) await api(`/api/apps/${id}`, { method: 'DELETE' });
  if (ctx.listItemId) await api('/api/desktop/items', { method: 'PATCH', body: [{ id: ctx.listItemId, updates: { isTrashed: true, trashedAt: Date.now() } }] });
  if (budgetExhausted) break;
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ api: API, at: new Date().toISOString(), results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
