/**
 * App tools for the OrchestratorAgent.
 *
 * These tools are exposed to codemode — the LLM writes TypeScript
 * that calls them to create, update, list, and manage apps.
 * Apps are compiled via @cloudflare/worker-bundler and run as Dynamic Workers.
 */

import { generateObject, tool } from 'ai';
import { z } from 'zod';
import { createWorker } from '@cloudflare/worker-bundler';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../../index';
import type { AppManifest, DesktopItem } from '../../types';

interface AppToolsContext {
  env: Env;
  sql: SqlStorage;
  agentName: string; // uid
}

interface AppBundleInput {
  name: string;
  description?: string;
  files: Record<string, string>;
  width: number;
  height: number;
}

const generatedAppSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  width: z.number().int().min(360).max(1600).default(720),
  height: z.number().int().min(320).max(1200).default(560),
  files: z.record(z.string()).refine(
    (files) => Object.keys(files).length > 0,
    'At least one source file is required',
  ),
});

async function getNextDesktopGridPosition(stub: DurableObjectStub): Promise<{ x: number; y: number }> {
  const snapshotRes = await stub.fetch(new Request('http://internal/items'));
  if (!snapshotRes.ok) {
    return { x: 0, y: 0 };
  }

  const snapshot = await snapshotRes.json<{ items: DesktopItem[] }>();
  const rootItems = snapshot.items.filter((item) => item.parentId === null && !item.isTrashed);
  const nextY = rootItems.length > 0
    ? Math.max(...rootItems.map((item) => Number(item.position?.y) || 0)) + 1
    : 0;

  return { x: 0, y: nextY };
}

function buildTodoTemplate(name: string, description?: string): AppBundleInput {
  const appName = name.trim() || 'Tasks';
  const appDescription = description?.trim() || 'A focused task list with filters, persistence, and quick keyboard actions.';

  return {
    name: appName,
    description: appDescription,
    width: 720,
    height: 560,
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appName}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app-shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Focused task manager</p>
        <h1>${appName}</h1>
        <p class="hero-copy">${appDescription}</p>
      </div>
      <section class="summary-card" aria-label="Task summary">
        <div class="summary-label">Progress</div>
        <div class="summary-value" id="progressValue">0%</div>
        <div class="summary-subtle" id="summaryText">No tasks yet</div>
      </section>
    </header>

    <section class="composer">
      <form id="taskForm" class="task-form">
        <label class="sr-only" for="taskInput">Add a task</label>
        <input id="taskInput" name="task" type="text" maxlength="140" placeholder="What needs to get done?" autocomplete="off">
        <button type="submit" class="primary-button">Add task</button>
      </form>
      <div class="toolbar">
        <div class="filter-group" role="tablist" aria-label="Task filters">
          <button type="button" class="filter-button is-active" data-filter="all">All</button>
          <button type="button" class="filter-button" data-filter="active">Active</button>
          <button type="button" class="filter-button" data-filter="completed">Completed</button>
        </div>
        <button type="button" class="ghost-button" id="clearCompletedButton">Clear completed</button>
      </div>
    </section>

    <section class="task-panel">
      <ul id="taskList" class="task-list" aria-live="polite"></ul>
      <div id="emptyState" class="empty-state">
        <div class="empty-icon">+</div>
        <h2>No tasks yet</h2>
        <p>Add your first task to get started.</p>
      </div>
    </section>

    <footer class="status-bar">
      <span id="itemsLeftText">0 items left</span>
      <span id="storageText">Saved locally in this browser</span>
    </footer>
  </main>

  <template id="taskTemplate">
    <li class="task-item">
      <label class="task-toggle">
        <input type="checkbox" class="task-checkbox">
        <span class="task-checkmark" aria-hidden="true"></span>
      </label>
      <button type="button" class="task-text"></button>
      <button type="button" class="delete-button" aria-label="Delete task">Delete</button>
    </li>
  </template>

  <script type="module" src="./app.js"></script>
</body>
</html>`,
      'styles.css': `:root {
  color-scheme: dark;
  --bg: #12131d;
  --panel: #1a1d2b;
  --panel-2: #20253a;
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.16);
  --text: #f7f4ea;
  --muted: #b7bdd3;
  --accent: #6ee7c8;
  --accent-strong: #43d7b0;
  --danger: #ff8a8a;
  --shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
  --radius: 18px;
  --radius-sm: 12px;
  --font-display: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
  --font-body: "Avenir Next", "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(circle at top right, rgba(110, 231, 200, 0.12), transparent 28%),
    linear-gradient(180deg, #171a28 0%, #12131d 100%);
  color: var(--text);
  font-family: var(--font-body);
}

body {
  min-height: 100vh;
  padding: 18px;
}

.app-shell {
  min-height: calc(100vh - 36px);
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 16px;
}

.hero,
.composer,
.task-panel,
.status-bar {
  border: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
  backdrop-filter: blur(8px);
  box-shadow: var(--shadow);
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 16px;
  padding: 22px;
  border-radius: calc(var(--radius) + 4px);
}

.eyebrow {
  margin: 0 0 10px;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 11px;
  font-weight: 700;
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(34px, 6vw, 44px);
  line-height: 0.95;
}

.hero-copy {
  margin: 12px 0 0;
  max-width: 48ch;
  color: var(--muted);
  line-height: 1.45;
}

.summary-card {
  border-radius: var(--radius);
  padding: 18px;
  background: linear-gradient(180deg, rgba(110, 231, 200, 0.12), rgba(67, 215, 176, 0.04));
  border: 1px solid rgba(110, 231, 200, 0.2);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.summary-label,
.summary-subtle {
  color: var(--muted);
  font-size: 13px;
}

.summary-value {
  font-size: 42px;
  font-weight: 800;
  letter-spacing: -0.05em;
}

.composer {
  border-radius: var(--radius);
  padding: 16px;
}

.task-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}

input[type="text"] {
  width: 100%;
  min-width: 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: rgba(5, 7, 14, 0.45);
  color: var(--text);
  padding: 14px 16px;
  font: inherit;
  outline: none;
}

input[type="text"]::placeholder {
  color: #8f96ad;
}

input[type="text"]:focus {
  border-color: rgba(110, 231, 200, 0.6);
  box-shadow: 0 0 0 3px rgba(110, 231, 200, 0.15);
}

button {
  font: inherit;
}

.primary-button,
.ghost-button,
.filter-button,
.delete-button,
.task-text {
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
}

.primary-button,
.ghost-button,
.filter-button,
.delete-button {
  cursor: pointer;
}

.primary-button {
  padding: 0 18px;
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  color: #0d1b17;
  font-weight: 800;
}

.toolbar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.filter-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-button,
.ghost-button {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text);
}

.filter-button.is-active {
  background: rgba(110, 231, 200, 0.18);
  border-color: rgba(110, 231, 200, 0.35);
  color: var(--accent);
}

.task-panel {
  position: relative;
  border-radius: calc(var(--radius) + 2px);
  overflow: hidden;
  min-height: 220px;
}

.task-list {
  list-style: none;
  margin: 0;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.task-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  transition: transform 140ms ease, border-color 140ms ease, opacity 180ms ease;
}

.task-item:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.16);
}

.task-item.is-completed .task-text {
  color: #7f879e;
  text-decoration: line-through;
}

.task-item.is-hidden {
  display: none;
}

.task-toggle {
  display: inline-flex;
  position: relative;
  align-items: center;
  justify-content: center;
}

.task-checkbox {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.task-checkmark {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.04);
  display: inline-block;
  box-shadow: inset 0 0 0 4px transparent;
  transition: all 140ms ease;
}

.task-checkbox:checked + .task-checkmark {
  background: rgba(110, 231, 200, 0.18);
  border-color: rgba(110, 231, 200, 0.5);
  box-shadow: inset 0 0 0 6px var(--accent);
}

.task-text {
  text-align: left;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text);
  font-size: 15px;
  line-height: 1.45;
}

.task-text:focus-visible,
.delete-button:focus-visible,
.filter-button:focus-visible,
.primary-button:focus-visible,
.ghost-button:focus-visible {
  outline: 2px solid rgba(110, 231, 200, 0.7);
  outline-offset: 2px;
}

.delete-button {
  padding: 9px 12px;
  background: rgba(255, 138, 138, 0.1);
  color: var(--danger);
}

.empty-state {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 24px;
  color: var(--muted);
}

.empty-state.is-hidden {
  display: none;
}

.empty-icon {
  width: 52px;
  height: 52px;
  margin: 0 auto 12px;
  border-radius: 16px;
  background: rgba(110, 231, 200, 0.12);
  border: 1px solid rgba(110, 231, 200, 0.28);
  color: var(--accent);
  display: grid;
  place-items: center;
  font-size: 34px;
  font-weight: 300;
}

.status-bar {
  border-radius: 16px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  font-size: 13px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 640px) {
  body {
    padding: 12px;
  }

  .hero {
    grid-template-columns: 1fr;
  }

  .task-form {
    grid-template-columns: 1fr;
  }

  .primary-button,
  .ghost-button,
  .filter-button,
  input[type="text"] {
    width: 100%;
  }

  .status-bar {
    flex-direction: column;
    align-items: flex-start;
  }
}`,
      'app.js': `const STORAGE_KEY = 'eternalos.curated.todo.v1';

const taskForm = document.getElementById('taskForm');
const taskInput = document.getElementById('taskInput');
const taskList = document.getElementById('taskList');
const taskTemplate = document.getElementById('taskTemplate');
const emptyState = document.getElementById('emptyState');
const itemsLeftText = document.getElementById('itemsLeftText');
const summaryText = document.getElementById('summaryText');
const progressValue = document.getElementById('progressValue');
const storageText = document.getElementById('storageText');
const clearCompletedButton = document.getElementById('clearCompletedButton');
const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));

let state = {
  filter: 'all',
  tasks: loadTasks(),
};

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((task) => task && typeof task.id === 'string' && typeof task.text === 'string')
      .map((task) => ({
        id: task.id,
        text: task.text.trim().slice(0, 140),
        completed: Boolean(task.completed),
        createdAt: Number(task.createdAt) || Date.now(),
      }))
      .filter((task) => task.text.length > 0);
  } catch {
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
  storageText.textContent = state.tasks.length > 0
    ? 'Saved locally in this browser'
    : 'Nothing saved yet';
}

function createTask(text) {
  return {
    id: crypto.randomUUID(),
    text: text.trim(),
    completed: false,
    createdAt: Date.now(),
  };
}

function addTask(text) {
  const normalized = text.trim().replace(/\\s+/g, ' ');
  if (!normalized) return;
  state.tasks.unshift(createTask(normalized));
  saveTasks();
  render();
}

function toggleTask(taskId) {
  state.tasks = state.tasks.map((task) =>
    task.id === taskId ? { ...task, completed: !task.completed } : task
  );
  saveTasks();
  render();
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter((task) => task.id !== taskId);
  saveTasks();
  render();
}

function clearCompleted() {
  state.tasks = state.tasks.filter((task) => !task.completed);
  saveTasks();
  render();
}

function setFilter(nextFilter) {
  state.filter = nextFilter;
  render();
}

function taskMatchesFilter(task) {
  if (state.filter === 'active') return !task.completed;
  if (state.filter === 'completed') return task.completed;
  return true;
}

function renderTask(task) {
  const fragment = taskTemplate.content.cloneNode(true);
  const item = fragment.querySelector('.task-item');
  const checkbox = fragment.querySelector('.task-checkbox');
  const textButton = fragment.querySelector('.task-text');
  const deleteButton = fragment.querySelector('.delete-button');

  checkbox.checked = task.completed;
  checkbox.addEventListener('change', () => toggleTask(task.id));

  textButton.textContent = task.text;
  textButton.title = task.text;
  textButton.addEventListener('click', () => toggleTask(task.id));

  deleteButton.addEventListener('click', () => deleteTask(task.id));

  if (task.completed) {
    item.classList.add('is-completed');
  }
  if (!taskMatchesFilter(task)) {
    item.classList.add('is-hidden');
  }

  return fragment;
}

function renderSummary() {
  const activeCount = state.tasks.filter((task) => !task.completed).length;
  const completedCount = state.tasks.length - activeCount;
  const progress = state.tasks.length === 0
    ? 0
    : Math.round((completedCount / state.tasks.length) * 100);

  itemsLeftText.textContent = activeCount === 1 ? '1 item left' : activeCount + ' items left';
  progressValue.textContent = progress + '%';

  if (state.tasks.length === 0) {
    summaryText.textContent = 'No tasks yet';
  } else if (completedCount === 0) {
    summaryText.textContent = 'Nothing completed yet';
  } else if (completedCount === state.tasks.length) {
    summaryText.textContent = 'Everything is done';
  } else {
    summaryText.textContent = completedCount + ' completed, ' + activeCount + ' active';
  }

  clearCompletedButton.disabled = completedCount === 0;
}

function renderFilters() {
  filterButtons.forEach((button) => {
    const isActive = button.dataset.filter === state.filter;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function render() {
  taskList.innerHTML = '';
  state.tasks
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((task) => {
      taskList.appendChild(renderTask(task));
    });

  const visibleCount = state.tasks.filter(taskMatchesFilter).length;
  emptyState.classList.toggle('is-hidden', visibleCount > 0);
  renderSummary();
  renderFilters();
}

taskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addTask(taskInput.value);
  taskInput.value = '';
  taskInput.focus();
});

clearCompletedButton.addEventListener('click', () => {
  clearCompleted();
});

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const nextFilter = button.dataset.filter;
    if (nextFilter === 'all' || nextFilter === 'active' || nextFilter === 'completed') {
      setFilter(nextFilter);
    }
  });
});

render();`,
    },
  };
}

function getAppBuilderModel(env: Env) {
  const workersAI = createWorkersAI({ binding: env.AI });
  const modelId = env.AGENT_CHAT_MODEL?.startsWith('@cf/')
    ? env.AGENT_CHAT_MODEL
    : '@cf/moonshotai/kimi-k2.6';
  return workersAI(modelId as Parameters<typeof workersAI>[0]);
}

function normalizeGeneratedApp(input: z.infer<typeof generatedAppSchema>): AppBundleInput {
  const files = Object.fromEntries(
    Object.entries(input.files)
      .map(([name, content]) => [name.replace(/^\/+/, '').trim(), String(content)] as const)
      .filter(([name, content]) => name.length > 0 && content.length > 0),
  );

  const hasHtmlEntry = Object.keys(files).some((name) => name.endsWith('.html')) || Boolean(files.html);
  if (!hasHtmlEntry) {
    throw new Error('Generated app is missing an HTML entry file');
  }

  return {
    name: input.name.trim() || 'Untitled App',
    description: input.description.trim(),
    width: Math.min(1600, Math.max(360, input.width)),
    height: Math.min(1200, Math.max(320, input.height)),
    files,
  };
}

async function generateAppFromPrompt(
  env: Env,
  prompt: string,
  previousError?: string,
): Promise<AppBundleInput> {
  const repairContext = previousError
    ? `Previous attempt failed during validation or bundling with this error:\n${previousError}\n\nReturn a corrected app bundle.`
    : 'This is the first generation attempt.';

  const { object } = await generateObject({
    model: getAppBuilderModel(env),
    schema: generatedAppSchema,
    system: `You generate complete desktop web apps as structured source files.

Rules:
- Return a complete app bundle, not a partial snippet
- Prefer separate files such as index.html, styles.css, and app.js
- Use only self-contained browser APIs and bundled local assets
- Do not rely on network access, package managers, build steps, or external CDNs
- Keep assets referenced with relative paths like ./styles.css or ./app.js
- Output valid, production-ready HTML/CSS/JS that can run directly in a browser iframe
- Include all files needed by the app in the files object
- Use plain text source code only, never markdown fences`,
    prompt: `Build a desktop web app for this request:

${prompt}

${repairContext}`,
  });

  return normalizeGeneratedApp(object);
}

async function buildAppFromPromptWithRetries(
  ctx: AppToolsContext,
  prompt: string,
): Promise<{ appId: string; itemId: string; name: string; status: 'created' }> {
  let lastError = 'Unknown generation error';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const generatedApp = await generateAppFromPrompt(
        ctx.env,
        prompt,
        attempt > 0 ? lastError : undefined,
      );
      return await createAndRegisterApp(ctx, generatedApp);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Failed to generate a working app after multiple attempts: ${lastError}`);
}

async function createAndRegisterApp(
  ctx: AppToolsContext,
  input: AppBundleInput
): Promise<{ appId: string; itemId: string; name: string; status: 'created' }> {
  const { env, sql, agentName: uid } = ctx;
  const appId = crypto.randomUUID();
  const r2Prefix = `apps/${uid}/${appId}`;

  const workerFiles = assembleWorkerFiles(input.files);
  workerFiles['index.js'] = workerFiles['index.js'].replaceAll('__APP_ID__', appId);
  const { mainModule, modules } = await createWorker({ files: workerFiles });

  const bundle = JSON.stringify({ mainModule, modules });
  await env.ETERNALOS_FILES.put(`${r2Prefix}/bundle.json`, bundle);
  await env.ETERNALOS_FILES.put(`${r2Prefix}/source.json`, JSON.stringify(input.files));

  const now = Date.now();
  sql.exec(
    `INSERT INTO apps (id, name, description, version, r2_prefix, width, height, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    appId, input.name, input.description ?? '', r2Prefix, input.width, input.height, now, now,
  );

  await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({ uid, version: 1 }));

  const doId = env.USER_DESKTOP.idFromName(uid);
  const stub = env.USER_DESKTOP.get(doId);
  const position = await getNextDesktopGridPosition(stub);
  const manifest: AppManifest = {
    name: input.name,
    description: input.description,
    version: '1',
    windowConfig: { defaultWidth: input.width, defaultHeight: input.height, resizable: true },
    appId,
  };

  const createRes = await stub.fetch(new Request('http://internal/items', {
    method: 'POST',
    body: JSON.stringify({
      type: 'app',
      name: input.name,
      parentId: null,
      position,
      isPublic: false,
      appManifest: manifest,
    }),
  }));

  if (!createRes.ok) {
    throw new Error(`Failed to create desktop item (${createRes.status})`);
  }

  const item = await createRes.json<DesktopItem>();
  sql.exec('UPDATE apps SET desktop_item_id = ? WHERE id = ?', item.id, appId);

  return { appId, itemId: item.id, name: input.name, status: 'created' };
}

/**
 * Initialize the app registry table in the agent's SQLite database.
 */
export function initAppRegistry(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    version INTEGER DEFAULT 1,
    r2_prefix TEXT NOT NULL,
    desktop_item_id TEXT,
    width INTEGER DEFAULT 600,
    height INTEGER DEFAULT 500,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/**
 * Wrap user-provided app files into a Worker that serves the assembled HTML page.
 */
function assembleWorkerFiles(files: Record<string, string>): Record<string, string> {
  const normalizedEntries = Object.entries(files)
    .filter(([name]) => typeof name === 'string' && name.trim().length > 0)
    .map(([name, content]) => [name.replace(/^\/+/, '').trim(), content] as const);
  const normalizedFiles = Object.fromEntries(normalizedEntries);

  const htmlPath = normalizedFiles['index.html']
    ? 'index.html'
    : normalizedFiles['app.html']
      ? 'app.html'
      : normalizedFiles['html']
        ? 'html'
        : Object.keys(normalizedFiles).find((name) => name.endsWith('.html')) || 'index.html';
  const cssPath = normalizedFiles['styles.css']
    ? 'styles.css'
    : normalizedFiles['style.css']
      ? 'style.css'
      : normalizedFiles['app.css']
        ? 'app.css'
        : normalizedFiles['css']
          ? 'css'
          : Object.keys(normalizedFiles).find((name) => name.endsWith('.css'));
  const jsPath = normalizedFiles['app.js']
    ? 'app.js'
    : normalizedFiles['script.js']
      ? 'script.js'
      : normalizedFiles['index.js']
        ? 'index.js'
        : normalizedFiles['js']
          ? 'js'
          : Object.keys(normalizedFiles).find((name) => name.endsWith('.js'));

  const html = normalizedFiles[htmlPath] || '';
  const isCompleteHtml = html.toLowerCase().includes('<!doctype') || html.toLowerCase().includes('<html');

  const injectAssetsIntoHtml = (sourceHtml: string): string => {
    let result = sourceHtml;
    if (cssPath && !result.includes(cssPath)) {
      const cssTag = `<link rel="stylesheet" href="./${cssPath}">`;
      if (/<\/head>/i.test(result)) {
        result = result.replace(/<\/head>/i, `${cssTag}\n</head>`);
      } else {
        result = `${cssTag}\n${result}`;
      }
    }
    if (jsPath && !result.includes(jsPath)) {
      const jsTag = `<script type="module" src="./${jsPath}"></script>`;
      if (/<\/body>/i.test(result)) {
        result = result.replace(/<\/body>/i, `${jsTag}\n</body>`);
      } else {
        result = `${result}\n${jsTag}`;
      }
    }
    return result;
  };

  const fullHtml = isCompleteHtml
    ? injectAssetsIntoHtml(html)
    : `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cssPath ? `<link rel="stylesheet" href="./${cssPath}">` : ''}
</head>
<body>
${html}
${jsPath ? `<script type="module" src="./${jsPath}"></script>` : ''}
</body>
</html>`;

  const assets = {
    ...normalizedFiles,
    [htmlPath]: fullHtml,
  };
  const mountPath = '/api/apps/__APP_ID__';

  return {
    'index.js': `
const ASSETS = ${JSON.stringify(assets)};
const ENTRY = ${JSON.stringify(htmlPath)};
const MOUNT_PATH = ${JSON.stringify(mountPath)};

function getContentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.otf')) return 'font/otf';
  return 'application/octet-stream';
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let assetPath = url.pathname;

    if (assetPath === MOUNT_PATH || assetPath === MOUNT_PATH + '/') {
      assetPath = '/' + ENTRY;
    } else if (assetPath.startsWith(MOUNT_PATH + '/')) {
      assetPath = assetPath.slice(MOUNT_PATH.length);
    }

    const normalizedPath = assetPath.replace(/^\\/+/, '') || ENTRY;
    const asset = ASSETS[normalizedPath];
    if (asset == null) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(asset, {
      headers: {
        'content-type': getContentType(normalizedPath),
        'cache-control': 'no-cache',
      },
    });
  },
};
`,
  };
}

/**
 * Create the app tools that will be exposed to codemode.
 */
export function createAppTools(ctx: AppToolsContext) {
  const { env, sql, agentName: uid } = ctx;

  return {
    buildAppFromPrompt: tool({
      description: 'Generate and create a new app from a natural-language product brief. Use this for most new app requests instead of embedding full source files in the tool call.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000).describe('Natural-language app request or product brief'),
      }),
      execute: async (input) => buildAppFromPromptWithRetries(ctx, input.prompt),
    }),

    createCuratedApp: tool({
      description: 'Create a polished, known-good app from a curated template. Prefer this for supported starter apps such as a todo list.',
      inputSchema: z.object({
        template: z.enum(['todo']).describe('Curated app template to use'),
        name: z.string().min(1).max(80).optional().describe('Optional app name override'),
        description: z.string().max(500).optional().describe('Optional app description override'),
      }),
      execute: async (input) => {
        if (input.template === 'todo') {
          return createAndRegisterApp(
            ctx,
            buildTodoTemplate(input.name ?? 'Tasks', input.description),
          );
        }

        throw new Error(`Unsupported curated template: ${input.template}`);
      },
    }),

    createApp: tool({
      description: 'Create a new desktop app from bundled static files. You can provide HTML, CSS, JS, JSON, SVG, images, fonts, and other relative-path assets. The app runs in a sandboxed iframe.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('App name'),
        description: z.string().max(500).optional().describe('Short description'),
        files: z.record(z.string()).describe('App source files: { "index.html": "...", "styles.css": "...", "app.js": "..." }'),
        width: z.number().optional().default(600).describe('Default window width'),
        height: z.number().optional().default(500).describe('Default window height'),
      }),
      execute: async (input) => createAndRegisterApp(ctx, {
        name: input.name,
        description: input.description,
        files: input.files,
        width: input.width,
        height: input.height,
      }),
    }),

    updateApp: tool({
      description: 'Update an existing app\'s code. Provide the full updated files.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to update'),
        files: z.record(z.string()).describe('Updated source files'),
        name: z.string().optional().describe('Updated name'),
        description: z.string().max(500).optional().describe('Updated description'),
        width: z.number().optional().describe('Updated default window width'),
        height: z.number().optional().describe('Updated default window height'),
      }),
      execute: async (input) => {
        // Look up the app in the registry
        const rows = [...sql.exec<{ version: number; r2_prefix: string; desktop_item_id: string | null; name: string; description: string; width: number; height: number }>(
          'SELECT version, r2_prefix, desktop_item_id, name, description, width, height FROM apps WHERE id = ?', input.appId,
        )];
        if (rows.length === 0) throw new Error(`App ${input.appId} not found`);
        const app = rows[0];

        const newVersion = app.version + 1;
        const nextName = input.name ?? app.name;
        const nextDescription = input.description ?? app.description;
        const nextWidth = input.width ?? app.width;
        const nextHeight = input.height ?? app.height;

        // Re-bundle
        const workerFiles = assembleWorkerFiles(input.files);
        workerFiles['index.js'] = workerFiles['index.js'].replaceAll('__APP_ID__', input.appId);
        const { mainModule, modules } = await createWorker({ files: workerFiles });

        // Update R2
        const bundle = JSON.stringify({ mainModule, modules });
        await env.ETERNALOS_FILES.put(`${app.r2_prefix}/bundle.json`, bundle);
        await env.ETERNALOS_FILES.put(`${app.r2_prefix}/source.json`, JSON.stringify(input.files));

        // Update registry
        const now = Date.now();
        sql.exec(
          'UPDATE apps SET version = ?, name = ?, description = ?, width = ?, height = ?, updated_at = ? WHERE id = ?',
          newVersion,
          nextName,
          nextDescription,
          nextWidth,
          nextHeight,
          now,
          input.appId,
        );

        // Update KV version for the serving route
        await env.DESKTOP_KV.put(`app:${input.appId}`, JSON.stringify({ uid, version: newVersion }));

        // Update the desktop item manifest if we have a linked item
        if (app.desktop_item_id) {
          const doId = env.USER_DESKTOP.idFromName(uid);
          const stub = env.USER_DESKTOP.get(doId);
          const manifest: AppManifest = {
            name: nextName,
            description: nextDescription,
            version: String(newVersion),
            windowConfig: {
              defaultWidth: nextWidth,
              defaultHeight: nextHeight,
              resizable: true,
            },
            appId: input.appId,
          };
          await stub.fetch(new Request('http://internal/items', {
            method: 'PATCH',
            body: JSON.stringify([{
              id: app.desktop_item_id,
              updates: {
                name: nextName,
                appManifest: manifest,
              },
            }]),
          }));
        }

        return { appId: input.appId, version: newVersion, status: 'updated' };
      },
    }),

    listApps: tool({
      description: 'List all apps created by the user.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = [...sql.exec<{ id: string; name: string; description: string; version: number; created_at: number }>(
          'SELECT id, name, description, version, created_at FROM apps ORDER BY created_at DESC',
        )];
        return { apps: rows };
      },
    }),

    getAppSource: tool({
      description: 'Get the source files of an existing app so you can see or modify its code.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to read source from'),
      }),
      execute: async (input) => {
        const rows = [...sql.exec<{ r2_prefix: string; name: string }>(
          'SELECT r2_prefix, name FROM apps WHERE id = ?', input.appId,
        )];
        if (rows.length === 0) throw new Error(`App ${input.appId} not found`);

        const obj = await env.ETERNALOS_FILES.get(`${rows[0].r2_prefix}/source.json`);
        if (!obj) throw new Error('Source files not found');

        const files = await obj.json<Record<string, string>>();
        return { appId: input.appId, name: rows[0].name, files };
      },
    }),

    deleteApp: tool({
      description: 'Delete an app from the desktop and clean up its stored data.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to delete'),
      }),
      execute: async (input) => {
        const rows = [...sql.exec<{ r2_prefix: string; desktop_item_id: string | null }>(
          'SELECT r2_prefix, desktop_item_id FROM apps WHERE id = ?', input.appId,
        )];
        if (rows.length === 0) throw new Error(`App ${input.appId} not found`);
        const app = rows[0];

        // Delete from R2
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/bundle.json`);
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/source.json`);

        // Delete from KV
        await env.DESKTOP_KV.delete(`app:${input.appId}`);

        // Delete from registry
        sql.exec('DELETE FROM apps WHERE id = ?', input.appId);

        // Trash the desktop item if it exists
        if (app.desktop_item_id) {
          const doId = env.USER_DESKTOP.idFromName(uid);
          const stub = env.USER_DESKTOP.get(doId);
          await stub.fetch(new Request('http://internal/items', {
            method: 'PATCH',
            body: JSON.stringify([{
              id: app.desktop_item_id,
              updates: { isTrashed: true, trashedAt: Date.now() },
            }]),
          }));
        }

        return { appId: input.appId, status: 'deleted' };
      },
    }),
  };
}
