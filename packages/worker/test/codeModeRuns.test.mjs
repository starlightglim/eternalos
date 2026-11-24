/**
 * Code Mode previews, live steps and undo (src/agents/tools/codeModeRuns.ts
 * and the run engine in codeModeTools.ts). Code really runs: a fake executor
 * evaluates the model's arrow function against the instrumented tool
 * namespaces, and the app backend is an in-memory books API.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const runs = await import('../src/agents/tools/codeModeRuns.ts');
const { createCodeModeTool } = await import('../src/agents/tools/codeModeTools.ts');
const { tool } = await import('ai');
const { z } = await import('zod');

/** Runs `async () => {...}` with the provider namespaces in scope. */
const fakeExecutor = {
  async execute(code, providers) {
    const names = providers.map((p) => p.name);
    // The real sandbox passes {} when a namespace function is called bare.
    const fns = providers.map((p) => Object.fromEntries(Object.entries(p.fns).map(([k, f]) => [k, (args) => f(args ?? {})])));
    try {
      const fn = new Function(...names, `return (${code})();`);
      return { result: await fn(...fns) };
    } catch (error) {
      return { result: undefined, error: error.message };
    }
  },
};

function booksBackend() {
  const state = { books: [{ id: 1, title: 'Dune', author: 'Frank Herbert', is_read: 0 }], nextId: 2, writes: [] };
  const handle = ({ method = 'GET', path, body }) => {
    const m = /^\/api\/books(?:\/(\d+))?$/.exec(path.split('?')[0]);
    if (!m) return { status: 404, ok: false, data: { error: 'not found' } };
    const id = m[1] ? Number(m[1]) : undefined;
    if (method !== 'GET') state.writes.push(`${method} ${path}`);
    if (method === 'GET') {
      if (id === undefined) return { status: 200, ok: true, data: state.books.map((b) => ({ ...b })) };
      const book = state.books.find((b) => b.id === id);
      return book ? { status: 200, ok: true, data: { ...book } } : { status: 404, ok: false, data: null };
    }
    if (method === 'POST') {
      const book = { id: state.nextId++, is_read: 0, ...body };
      state.books.push(book);
      return { status: 201, ok: true, data: { ...book } };
    }
    const index = state.books.findIndex((b) => b.id === id);
    if (index < 0) return { status: 404, ok: false, data: null };
    if (method === 'PATCH' || method === 'PUT') {
      state.books[index] = { ...(method === 'PUT' ? { id } : state.books[index]), ...body, id };
      return { status: 200, ok: true, data: { ...state.books[index] } };
    }
    state.books.splice(index, 1);
    return { status: 200, ok: true, data: { ok: true } };
  };
  const apps = {
    listApps: tool({ description: 'list', inputSchema: z.object({}), execute: async () => ({ apps: [{ id: 'shelf-id', name: 'Shelf', description: '', version: 1 }] }) }),
    readAppApi: tool({
      description: 'read',
      inputSchema: z.object({ appId: z.string(), path: z.string() }),
      execute: async (input) => handle({ ...input, method: 'GET' }),
    }),
    callAppApi: tool({
      description: 'call',
      inputSchema: z.object({ appId: z.string(), method: z.string().default('GET'), path: z.string(), body: z.unknown().optional() }),
      needsApproval: async (input) => (input.method ?? 'GET') !== 'GET',
      execute: async (input) => handle(input),
    }),
  };
  return { state, apps, handle };
}

function makeTool(extra = {}) {
  const backend = booksBackend();
  const events = [];
  const saved = new Map();
  const previews = new Map();
  const code = createCodeModeTool({
    loader: /** @type {any} */ ({}),
    apps: backend.apps,
    mutating: true,
    executor: fakeExecutor,
    emit: (chunk) => events.push(chunk),
    saveUndo: (runId, plan) => saved.set(runId, plan),
    savePreview: (runId, signatures) => previews.set(runId, signatures),
    loadPreview: (runId) => previews.get(runId) ?? null,
    ...extra,
  });
  // The approved run happens in a later request: a fresh tool instance that
  // shares only the stored preview (like the agent's SQLite).
  const fresh = () => createCodeModeTool({
    loader: /** @type {any} */ ({}),
    apps: backend.apps,
    mutating: true,
    executor: fakeExecutor,
    emit: (chunk) => events.push(chunk),
    saveUndo: (runId, plan) => saved.set(runId, plan),
    savePreview: (runId, signatures) => previews.set(runId, signatures),
    loadPreview: (runId) => previews.get(runId) ?? null,
  });
  return { code, fresh, backend, events, saved, previews, last: (type) => events.filter((e) => e.type === type).at(-1) };
}

const ADD_BOOK = `async () => {
  const list = await apps.listApps();
  const shelf = list.apps.find((a) => a.name === "Shelf");
  const books = await apps.readAppApi({ appId: shelf.id, path: "/api/books" });
  if (books.data.some((b) => b.title === "Neuromancer")) return { skipped: true };
  const res = await apps.callAppApi({ appId: shelf.id, method: "POST", path: "/api/books", body: { title: "Neuromancer", author: "William Gibson" } });
  return { added: res.data.id };
}`;

describe('Code Mode preview (practice run before approval)', () => {
  it('lists the writes in plain language and changes nothing', async () => {
    const { code, backend, last } = makeTool();
    const needs = await code.needsApproval({ code: ADD_BOOK }, { toolCallId: 'call-1' });
    assert.equal(needs, true);
    const preview = last('data-codemode-preview');
    assert.equal(preview.id, 'call-1');
    assert.equal(preview.data.ok, true);
    assert.deepEqual(preview.data.actions.map((a) => a.summary), ['Add book to Shelf']);
    assert.equal(preview.data.actions[0].detail, 'title: “Neuromancer”, author: “William Gibson”');
    assert.deepEqual(backend.state.writes, [], 'the practice run must not write');
    assert.equal(backend.state.books.length, 1);
  });

  it('skips the approval card when the practice run writes nothing', async () => {
    const { code, backend } = makeTool();
    backend.state.books.push({ id: 9, title: 'Neuromancer', author: 'William Gibson' });
    assert.equal(await code.needsApproval({ code: ADD_BOOK }, { toolCallId: 'call-2' }), false);
  });

  it('keeps such a run unapproved: a write it reaches anyway is refused', async () => {
    const { code, backend } = makeTool();
    backend.state.books.push({ id: 9, title: 'Neuromancer', author: 'William Gibson' });
    assert.equal(await code.needsApproval({ code: ADD_BOOK }, { toolCallId: 'call-3' }), false);
    backend.state.books.pop(); // the data changed between the preview and the run
    await assert.rejects(code.execute({ code: ADD_BOOK }, { toolCallId: 'call-3' }), /needs the user's approval/);
    assert.deepEqual(backend.state.writes, []);
  });

  it('still asks, and says why, when the practice run fails', async () => {
    const { code, last } = makeTool();
    const broken = 'async () => { const x = await apps.listApps(); x.nope.find(); await apps.callAppApi({ appId: "a", method: "POST", path: "/api/books" }); }';
    assert.equal(await code.needsApproval({ code: broken }, { toolCallId: 'call-4' }), true);
    assert.equal(last('data-codemode-preview').data.ok, false);
    assert.match(last('data-codemode-preview').data.error, /find|undefined/);
  });

  it('needs no approval (and runs no practice run) for read-only code', async () => {
    const { code, events } = makeTool();
    assert.equal(await code.needsApproval({ code: 'async () => (await apps.listApps()).apps.length' }, { toolCallId: 'r' }), false);
    assert.equal(events.length, 0);
  });
});

describe('Code Mode approved runs are held to their preview', () => {
  const TOGGLE = `async () => {
    const books = await apps.readAppApi({ appId: "shelf-id", path: "/api/books" });
    const hit = books.data.find((b) => b.title === "Neuromancer");
    if (hit) return apps.callAppApi({ appId: "shelf-id", method: "DELETE", path: "/api/books/" + hit.id });
    return apps.callAppApi({ appId: "shelf-id", method: "POST", path: "/api/books", body: { title: "Neuromancer" } });
  }`;

  it('refuses a write the approved preview did not show', async () => {
    const { code, fresh, backend } = makeTool();
    assert.equal(await code.needsApproval({ code: TOGGLE }, { toolCallId: 'p1' }), true); // previewed: Add book
    backend.state.books.push({ id: 7, title: 'Neuromancer' }); // data changed before approval
    await assert.rejects(fresh().execute({ code: TOGGLE }, { toolCallId: 'p1' }), /not in the preview the user approved/);
    assert.deepEqual(backend.state.writes, [], 'nothing was deleted');
  });

  it('allows the previewed writes, even on records created during the run', async () => {
    const { code, fresh, backend } = makeTool();
    const ADD_THEN_MARK = `async () => {
      const made = await apps.callAppApi({ appId: "shelf-id", method: "POST", path: "/api/books", body: { title: "Hail Mary" } });
      await apps.callAppApi({ appId: "shelf-id", method: "PATCH", path: "/api/books/" + made.data.id, body: { is_read: 1 } });
      return made.data.id;
    }`;
    assert.equal(await code.needsApproval({ code: ADD_THEN_MARK }, { toolCallId: 'p2' }), true);
    const output = await fresh().execute({ code: ADD_THEN_MARK }, { toolCallId: 'p2' });
    assert.equal(output.result, 2);
    assert.deepEqual(backend.state.writes, ['POST /api/books', 'PATCH /api/books/2']);
  });

  it('caps each kind of write at the previewed count', async () => {
    const { code, fresh, backend } = makeTool();
    const LOOP = `async () => {
      const books = await apps.readAppApi({ appId: "shelf-id", path: "/api/books" });
      for (const b of books.data) await apps.callAppApi({ appId: "shelf-id", method: "DELETE", path: "/api/books/" + b.id });
    }`;
    assert.equal(await code.needsApproval({ code: LOOP }, { toolCallId: 'p3' }), true); // 1 book → 1 delete previewed
    backend.state.books.push({ id: 8, title: 'Extra' });
    await assert.rejects(fresh().execute({ code: LOOP }, { toolCallId: 'p3' }), /not in the preview/);
    assert.deepEqual(backend.state.writes, ['DELETE /api/books/1'], 'only the previewed delete happened');
  });

  it('refuses a different target or body than the preview showed', async () => {
    const { code, fresh, backend } = makeTool();
    const MARK = `async () => {
      const books = await apps.readAppApi({ appId: "shelf-id", path: "/api/books" });
      const target = books.data.at(-1);
      return apps.callAppApi({ appId: "shelf-id", method: "PATCH", path: "/api/books/" + target.id, body: { is_read: 1 } });
    }`;
    assert.equal(await code.needsApproval({ code: MARK }, { toolCallId: 'p4' }), true); // previewed: book #1
    backend.state.books.push({ id: 9, title: 'Other', is_read: 0 }); // now the last book is #9
    await assert.rejects(fresh().execute({ code: MARK }, { toolCallId: 'p4' }), /not in the preview/);
    assert.deepEqual(backend.state.writes, []);
  });

  it('lets an approved run with no saved preview write nothing (fail closed)', async () => {
    const { fresh, backend } = makeTool();
    await assert.rejects(fresh().execute({ code: ADD_BOOK }, { toolCallId: 'never-previewed' }), /not in the preview/);
    assert.deepEqual(backend.state.writes, []);
  });

  it('never executes a write outside a run', async () => {
    const backend = booksBackend();
    let leaked = null;
    const leakyExecutor = {
      async execute(code, providers) {
        leaked = providers.find((p) => p.name === 'apps').fns.callAppApi;
        return { result: null };
      },
    };
    const code = createCodeModeTool({ loader: {}, apps: backend.apps, mutating: true, executor: leakyExecutor, preApproved: true });
    await code.execute({ code: 'async () => null' }, { toolCallId: 'x' });
    await assert.rejects(leaked({ appId: 'shelf-id', method: 'POST', path: '/api/books', body: { title: 'late' } }), /inside an approved code run/);
    assert.deepEqual(backend.state.writes, []);
  });
});

describe('Code Mode real runs: live steps and undo', () => {
  it('streams one step per tool call with results', async () => {
    const { code, fresh, last } = makeTool();
    assert.equal(await code.needsApproval({ code: ADD_BOOK }, { toolCallId: 'run-1' }), true);
    const output = await fresh().execute({ code: ADD_BOOK }, { toolCallId: 'run-1' });
    assert.equal(output.result.added, 2);
    const steps = last('data-codemode-steps');
    assert.equal(steps.id, 'run-1');
    assert.deepEqual(steps.data.steps.map((s) => [s.label, s.status]), [
      ['List your apps', 'done'],
      ['Read books from Shelf', 'done'],
      ['Add book to Shelf', 'done'],
    ]);
    assert.equal(steps.data.steps[1].detail, '200 · 1 record');
    assert.equal(steps.data.steps[2].write, true);
    assert.deepEqual(output.changedApps, ['shelf-id']);
    assert.equal(output.undoAvailable, true);
  });

  it('records how to reverse every write, and undoing restores the data', async () => {
    const { code, fresh, backend, saved, last } = makeTool();
    const before = JSON.parse(JSON.stringify(backend.state.books));
    const SCRIPT = `async () => {
      const made = await apps.callAppApi({ appId: "shelf-id", method: "POST", path: "/api/books", body: { title: "Hail Mary", author: "Andy Weir" } });
      await apps.callAppApi({ appId: "shelf-id", method: "PATCH", path: "/api/books/1", body: { is_read: 1 } });
      await apps.callAppApi({ appId: "shelf-id", method: "DELETE", path: "/api/books/" + made.data.id });
      return "ok";
    }`;
    assert.equal(await code.needsApproval({ code: SCRIPT }, { toolCallId: 'run-2' }), true);
    await fresh().execute({ code: SCRIPT }, { toolCallId: 'run-2' });
    const plan = saved.get('run-2');
    assert.equal(plan.writes, 3);
    assert.deepEqual(plan.ops.map((op) => [op.method, op.path]), [
      ['DELETE', '/api/books/2'],
      ['PATCH', '/api/books/1'],
      ['POST', '/api/books'],
    ]);
    assert.deepEqual(plan.ops[1].body, { is_read: 0 });
    assert.deepEqual(plan.ops[2].body, { title: 'Hail Mary', author: 'Andy Weir', is_read: 0 });
    assert.equal(last('data-codemode-undo').data.available, true);

    // Apply the plan the way the agent's Undo button does.
    const outcome = await runs.applyUndoPlan(plan.ops, async (op) => backend.handle(op));
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(outcome.changedApps, ['shelf-id']);
    // The deleted-then-restored book comes back as a new entry (new id); the
    // added one is gone again; Dune is unread again.
    assert.deepEqual(backend.state.books.map((b) => [b.title, b.is_read]), before.map((b) => [b.title, b.is_read]));
  });

  it('reports a write it cannot reverse instead of pretending', async () => {
    const plan = runs.planAppInverse({ appId: 'a', method: 'POST', path: '/api/books' }, { ok: true, data: { ok: true } }, null);
    assert.ok('skipped' in plan);
    assert.equal(runs.planAppInverse({ appId: 'a', method: 'POST', path: '/api/books' }, { ok: false, data: {} }, null), null, 'a failed write needs no undo');
  });

  it('undoes desktop moves and new notes', () => {
    const before = [{ id: 'a', name: 'a.txt', parentId: null }, { id: 'b', name: 'b.txt', parentId: 'f0' }];
    const move = runs.planDesktopInverse('moveItems', { itemIds: ['a', 'b'], targetFolderId: 'f1' }, { movedCount: 2 }, before);
    assert.deepEqual(move.op.patches, [{ id: 'a', updates: { parentId: null } }, { id: 'b', updates: { parentId: 'f0' } }]);
    const note = runs.planDesktopInverse('createTextNote', { name: 'n' }, { note: { id: 'n1', name: 'n' } }, null);
    assert.deepEqual(note.op.patches, [{ id: 'n1', updates: { isTrashed: true } }]);
  });
});

describe('Code Mode run descriptions', () => {
  it('parses resource paths', () => {
    assert.deepEqual(runs.parseResourcePath('/api/books/12?full=1'), { noun: 'book', id: '12', collection: '/api/books' });
    assert.deepEqual(runs.parseResourcePath('/api/reading-lists'), { noun: 'reading list', id: undefined, collection: '/api/reading-lists' });
    assert.equal(runs.parseResourcePath('/api/categories/abc-123-def-456').noun, 'category');
  });

  it('reads flags as yes/no', () => {
    assert.equal(runs.summarizeFields({ is_read: 1, title: 'Dune' }), 'read: yes, title: “Dune”');
    assert.equal(runs.summarizeFields({ done: false }), 'done: false');
  });

  it('describes writes in plain words', () => {
    const ctx = { appName: (id) => (id === 's' ? 'Shelf' : undefined), itemName: (id) => ({ f: 'Taxes', a: 'w2.pdf' })[id] };
    assert.equal(runs.describeAction('callAppApi', { appId: 's', method: 'PATCH', path: '/api/books/3', body: { is_read: 1 } }, ctx).summary, 'Update book #3 in Shelf');
    assert.equal(runs.describeAction('callAppApi', { appId: 's', method: 'DELETE', path: '/api/books/3' }, ctx).summary, 'Delete book #3 from Shelf');
    assert.equal(runs.describeAction('moveItems', { itemIds: ['a'], targetFolderId: 'f' }, ctx).summary, 'Move 1 item to “Taxes”');
    assert.equal(runs.describeAction('createTextNote', { name: 'Reading summary', content: 'x' }, ctx).summary, 'Create note “Reading summary” on the desktop');
  });

  it('finds records in common response shapes', () => {
    assert.deepEqual(runs.findRecord([{ id: 1 }, { id: 2, t: 'x' }], '2'), { id: 2, t: 'x' });
    assert.deepEqual(runs.findRecord({ books: [{ id: 5 }] }, '5'), { id: 5 });
    assert.deepEqual(runs.findRecord({ id: 5, t: 1 }, '5'), { id: 5, t: 1 });
    assert.equal(runs.findRecord({ id: 6 }, '5'), null);
    assert.equal(runs.createdRecordId({ book: { id: 7 } }), '7');
    assert.equal(runs.createdRecordId({ lastInsertRowid: 3 }), '3');
  });
});

describe('routine schedules', () => {
  it('runs daily at local wall-clock time, DST-aware', () => {
    // 2026-11-24 12:00 UTC = 07:00 in Toronto (EST, UTC-5).
    const now = new Date('2026-11-24T12:00:00Z');
    assert.equal(runs.nextRoutineRun({ every: 'day', at: '08:00', timeZone: 'America/Toronto' }, now).toISOString(), '2026-11-24T13:00:00.000Z');
    assert.equal(runs.nextRoutineRun({ every: 'day', at: '06:30', timeZone: 'America/Toronto' }, now).toISOString(), '2026-11-25T11:30:00.000Z');
    // Summer time: 08:00 EDT is 12:00 UTC.
    assert.equal(runs.nextRoutineRun({ every: 'day', at: '08:00', timeZone: 'America/Toronto' }, new Date('2026-07-01T00:00:00Z')).toISOString(), '2026-07-01T12:00:00.000Z');
  });

  it('falls back to UTC for an unknown zone and clamps hourly schedules', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    assert.equal(runs.nextRoutineRun({ every: 'day', at: '13:15', timeZone: 'Mars/Base' }, now).toISOString(), '2026-11-24T13:15:00.000Z');
    assert.equal(runs.nextRoutineRun({ every: 'hours', hours: 0.1 }, now).toISOString(), '2026-11-24T13:00:00.000Z');
    assert.equal(runs.describeSchedule({ every: 'hours', hours: 48 }), 'every 2 days');
    assert.equal(runs.describeSchedule({ every: 'day', at: '08:00', timeZone: 'America/Toronto' }), 'every day at 08:00 (America/Toronto)');
  });
});
