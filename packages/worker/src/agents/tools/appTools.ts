/**
 * App tools for the OrchestratorAgent.
 *
 * These tools are exposed directly to the OrchestratorAgent so it can create,
 * update, list, and manage apps without routing normal app builds through a
 * secondary code-execution sandbox.
 *
 * Apps are compiled via @cloudflare/worker-bundler and run as Dynamic Workers.
 */

import { generateObject, tool } from 'ai';
import { z } from 'zod';
import { createWorker } from '@cloudflare/worker-bundler';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../../index';
import type { AppManifest, AppPermissions, DesktopItem, UserProfile } from '../../types';
import type { AppGrantedPermissions } from '../../utils/jwt';

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
  permissions?: AppPermissions;
  rationale?: string;
}

type AppWorkspaceProfile = 'static-html';

type AppBuildStageKey =
  | 'prepare-workspace'
  | 'bundle-worker'
  | 'write-storage'
  | 'install-desktop';

interface AppWorkspaceManifest {
  version: 1;
  profile: AppWorkspaceProfile;
  entryHtml: string;
  sourceFiles: string[];
  runtimeAsset: string;
  workerEntrypoint: string;
}

interface AppWorkspace {
  manifest: AppWorkspaceManifest;
  files: Record<string, string>;
}

interface AppBuildStageSummary {
  key: AppBuildStageKey;
  label: string;
  status: 'completed' | 'current' | 'pending';
}

interface AppBuildSummary {
  currentStage: AppBuildStageKey | 'ready';
  stages: AppBuildStageSummary[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

interface StoredAppMetadata {
  id: string;
  uid: string;
  name: string;
  description?: string;
  width: number;
  height: number;
  permissions?: AppPermissions;
  rationale?: string;
  granted: AppGrantedPermissions;
  version: number;
  r2Prefix: string;
  createdAt: number;
  expiresAt?: number;
}

type AppArtifactBuildResult = {
  metadata: StoredAppMetadata;
  build: AppBuildSummary;
};

const APP_WORKER_ENTRY_FILE = '__eternal_worker__.js';
const APP_RUNTIME_ASSET_FILE = 'eternal-runtime.js';
const APP_WORKSPACE_MANIFEST_FILE = 'workspace.json';
const APP_BUNDLE_FILE = 'bundle.json';
const APP_SOURCE_FILE = 'source.json';
const APP_METADATA_FILE = 'metadata.json';
const APP_PREVIEW_TTL_SECONDS = 60 * 60 * 6;
const RESERVED_APP_SOURCE_FILES = new Set([
  APP_WORKER_ENTRY_FILE,
  APP_RUNTIME_ASSET_FILE,
]);

const APP_BUILD_STAGE_LABELS: Record<AppBuildStageKey, string> = {
  'prepare-workspace': 'Preparing workspace',
  'bundle-worker': 'Bundling worker runtime',
  'write-storage': 'Writing app files',
  'install-desktop': 'Installing on desktop',
};

/**
 * What the generator is asked to produce. `permissions` is how the LLM
 * declares what the app needs; we store it on the manifest and (for v1)
 * auto-grant it, so the first open just works. A future install-dialog pass
 * will sit between declaration and grant.
 */
const permissionsSchema = z.object({
  fs: z.object({
    read: z.array(z.string().min(1).max(200)).max(20).optional(),
    mimeTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
  }).optional(),
  profile: z.object({
    read: z.array(z.enum(['username', 'displayName', 'bio', 'avatar'])).max(4).optional(),
  }).optional(),
}).optional();

const generatedAppSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  width: z.number().int().min(360).max(1600).default(720),
  height: z.number().int().min(320).max(1200).default(560),
  files: z.record(z.string()).refine(
    (files) => Object.keys(files).length > 0,
    'At least one source file is required',
  ),
  permissions: permissionsSchema,
  rationale: z.string().max(500).optional(),
});

const appSpecSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  kind: z.enum(['viewer', 'editor', 'utility', 'dashboard', 'game', 'other']).default('other'),
  goals: z.array(z.string().min(1).max(200)).max(8).default([]),
  dataDependencies: z.array(z.enum(['images', 'audio', 'video', 'text', 'profile', 'none'])).max(6).default(['none']),
  width: z.number().int().min(360).max(1600).default(720),
  height: z.number().int().min(320).max(1200).default(560),
  permissions: permissionsSchema,
  rationale: z.string().max(500).optional(),
  acceptance: z.array(z.string().min(1).max(200)).max(8).default([]),
});

const generatedAppFilesSchema = z.object({
  files: z.record(z.string()).refine(
    (files) => Object.keys(files).length > 0,
    'At least one source file is required',
  ),
});

type AppSpec = z.infer<typeof appSpecSchema>;

const APP_BUILD_TIMEOUT_MS = {
  desktopSummary: 5_000,
  specGeneration: 30_000,
  fileGeneration: 60_000,
  bundling: 20_000,
  storageWrite: 10_000,
  desktopInstall: 10_000,
} as const;

async function withStepTimeout<T>(
  step: string,
  timeoutMs: number,
  work: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${step} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isCapacityExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('3040') || /capacity temporarily exceeded/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCapacityRetry(attempt: number): Promise<void> {
  const baseDelayMs = [1_500, 4_000, 8_000][attempt] ?? 12_000;
  const jitterMs = Math.floor(Math.random() * 750);
  await sleep(baseDelayMs + jitterMs);
}

/**
 * Project the richer AppPermissions declaration down to the flat
 * AppGrantedPermissions shape used at runtime. These are nearly identical but
 * AppGrantedPermissions is what EternalService sees via ctx.props.
 */
function grantsFromPermissions(permissions: AppPermissions | undefined): AppGrantedPermissions {
  if (!permissions) return {};
  const out: AppGrantedPermissions = {};
  if (permissions.fs && (permissions.fs.read?.length || permissions.fs.mimeTypes?.length)) {
    out.fs = {};
    if (permissions.fs.read?.length) out.fs.read = [...permissions.fs.read];
    if (permissions.fs.mimeTypes?.length) out.fs.mimeTypes = [...permissions.fs.mimeTypes];
  }
  if (permissions.profile?.read?.length) {
    out.profile = { read: [...permissions.profile.read] };
  }
  return out;
}

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

function createBuildTracker() {
  const orderedStages = Object.keys(APP_BUILD_STAGE_LABELS) as AppBuildStageKey[];
  const startedAt = Date.now();
  const completedStages = new Set<AppBuildStageKey>();
  let currentStage: AppBuildStageKey | 'ready' = orderedStages[0];

  const snapshot = (stage: AppBuildStageKey | 'ready' = currentStage, completedAt = Date.now()): AppBuildSummary => ({
    currentStage: stage,
    stages: orderedStages.map((key) => ({
      key,
      label: APP_BUILD_STAGE_LABELS[key],
      status: completedStages.has(key)
        ? 'completed'
        : stage !== 'ready' && key === stage
          ? 'current'
          : 'pending',
    })),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
  });

  return {
    currentStageLabel(): string {
      return currentStage === 'ready' ? 'Ready' : APP_BUILD_STAGE_LABELS[currentStage];
    },
    markCompleted(stage: AppBuildStageKey) {
      completedStages.add(stage);
      const nextStage = orderedStages[orderedStages.indexOf(stage) + 1];
      currentStage = nextStage ?? 'ready';
    },
    success(): AppBuildSummary {
      currentStage = 'ready';
      return snapshot('ready');
    },
  };
}

function wrapBuildError(error: unknown, tracker: ReturnType<typeof createBuildTracker>): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Build failed during ')) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`Build failed during ${tracker.currentStageLabel()}: ${message}`);
}

function selectHtmlEntry(files: Record<string, string>): string {
  return files['index.html']
    ? 'index.html'
    : files['app.html']
      ? 'app.html'
      : files['html']
        ? 'html'
        : Object.keys(files).find((name) => name.endsWith('.html')) || 'index.html';
}

function selectDefaultCssEntry(files: Record<string, string>): string | undefined {
  return files['styles.css']
    ? 'styles.css'
    : files['style.css']
      ? 'style.css'
      : files['app.css']
        ? 'app.css'
        : files['css']
          ? 'css'
          : Object.keys(files).find((name) => name.endsWith('.css'));
}

function selectDefaultJsEntry(files: Record<string, string>): string | undefined {
  return files['app.js']
    ? 'app.js'
    : files['script.js']
      ? 'script.js'
      : files['main.js']
        ? 'main.js'
        : files['index.js']
          ? 'index.js'
          : files['js']
            ? 'js'
            : Object.keys(files).find((name) => name.endsWith('.js') || name.endsWith('.mjs'));
}

function createAppWorkspace(files: Record<string, string>): AppWorkspace {
  const normalizedEntries = Object.entries(files)
    .filter(([name]) => typeof name === 'string' && name.trim().length > 0)
    .map(([name, content]) => [name.replace(/^\/+/, '').trim(), String(content)] as const);
  const normalizedFiles = Object.fromEntries(normalizedEntries);

  for (const reserved of RESERVED_APP_SOURCE_FILES) {
    if (reserved in normalizedFiles) {
      throw new Error(`Source file name "${reserved}" is reserved by the app runtime`);
    }
  }

  const entryHtml = selectHtmlEntry(normalizedFiles);
  if (!(entryHtml in normalizedFiles)) {
    throw new Error('App bundle must include at least one HTML entry file');
  }

  return {
    files: normalizedFiles,
    manifest: {
      version: 1,
      profile: 'static-html',
      entryHtml,
      sourceFiles: Object.keys(normalizedFiles).sort(),
      runtimeAsset: APP_RUNTIME_ASSET_FILE,
      workerEntrypoint: APP_WORKER_ENTRY_FILE,
    },
  };
}

function normalizeGeneratedApp(input: z.infer<typeof generatedAppSchema>): AppBundleInput {
  const files = Object.fromEntries(
    Object.entries(input.files)
      .map(([name, content]) => [name.replace(/^\/+/, '').trim(), String(content)] as const)
      .filter(([name, content]) => name.length > 0 && content.length > 0),
  );
  createAppWorkspace(files);

  return {
    name: input.name.trim() || 'Untitled App',
    description: input.description.trim(),
    width: Math.min(1600, Math.max(360, input.width)),
    height: Math.min(1200, Math.max(320, input.height)),
    files,
    permissions: input.permissions,
    rationale: input.rationale?.trim() || undefined,
  };
}

function normalizeGeneratedFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .map(([name, content]) => [name.replace(/^\/+/, '').trim(), String(content)] as const)
      .filter(([name, content]) => name.length > 0 && content.length > 0),
  );
}

function normalizeAppFromSpec(spec: AppSpec, files: Record<string, string>): AppBundleInput {
  const normalizedFiles = normalizeGeneratedFiles(files);
  createAppWorkspace(normalizedFiles);

  return {
    name: spec.name.trim() || 'Untitled App',
    description: spec.description.trim(),
    width: Math.min(1600, Math.max(360, spec.width)),
    height: Math.min(1200, Math.max(320, spec.height)),
    files: normalizedFiles,
    permissions: spec.permissions,
    rationale: spec.rationale?.trim() || undefined,
  };
}

function validateGeneratedApp(app: AppBundleInput): void {
  const files = app.files;
  const htmlFiles = Object.entries(files).filter(([name]) => name.endsWith('.html') || name === 'html');
  if (htmlFiles.length === 0) {
    throw new Error('App bundle must include at least one HTML file');
  }

  const fullSource = Object.values(files).join('\n');
  const forbiddenPatterns: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /<script[^>]+src=["']https?:\/\//i, message: 'External script URLs are not allowed' },
    { pattern: /<link[^>]+href=["']https?:\/\//i, message: 'External stylesheet URLs are not allowed' },
    { pattern: /\bfetch\(\s*["'`]https?:\/\//i, message: 'External fetch() calls are not allowed' },
    { pattern: /\bnew\s+WebSocket\(\s*["'`]wss?:\/\//i, message: 'External WebSocket connections are not allowed' },
    { pattern: /\bimport\s*\(\s*["'`]https?:\/\//i, message: 'Dynamic imports from external URLs are not allowed' },
    { pattern: /\bfrom\s+["']https?:\/\//i, message: 'Imports from external URLs are not allowed' },
  ];

  for (const { pattern, message } of forbiddenPatterns) {
    if (pattern.test(fullSource)) {
      throw new Error(message);
    }
  }

  const usesFs = /\b(?:window\.)?eternal\.fs\./.test(fullSource);
  const usesProfile = /\b(?:window\.)?eternal\.profile\./.test(fullSource);

  if (usesFs && !(app.permissions?.fs?.read?.length || app.permissions?.fs?.mimeTypes?.length)) {
    throw new Error('App uses window.eternal.fs but did not declare fs permissions');
  }
  if (usesProfile && !app.permissions?.profile?.read?.length) {
    throw new Error('App uses window.eternal.profile but did not declare profile permissions');
  }

  const knownAssets = new Set([...Object.keys(files), APP_RUNTIME_ASSET_FILE]);
  const assetRefPattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const [fileName, html] of htmlFiles) {
    let match: RegExpExecArray | null;
    while ((match = assetRefPattern.exec(html)) !== null) {
      const ref = match[1].trim();
      if (
        ref.length === 0 ||
        ref.startsWith('http://') ||
        ref.startsWith('https://') ||
        ref.startsWith('data:') ||
        ref.startsWith('mailto:') ||
        ref.startsWith('javascript:') ||
        ref.startsWith('#') ||
        ref.startsWith('/')
      ) {
        continue;
      }

      const normalizedRef = ref.replace(/^\.\//, '').replace(/^\//, '');
      if (!knownAssets.has(normalizedRef)) {
        throw new Error(`Missing local asset "${ref}" referenced from ${fileName}`);
      }
    }
  }
}

/**
 * Short, LLM-facing summary of the user's desktop. Intentionally compact —
 * enough signal for the builder to pick sensible defaults and produce
 * believable placeholders, not enough to leak PII into every prompt.
 */
interface DesktopSummary {
  totalActiveItems: number;
  counts: Record<string, number>;
  hasPhotos: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  hasNotes: boolean;
  analyzedImages: number;
  topFolders: Array<{ path: string; count: number; sampleCaptions?: string[] }>;
  sampleTags: string[];
}

function summarizeDesktopForLLM(
  items: DesktopItem[],
  profile: UserProfile | null,
): DesktopSummary {
  const active = items.filter((i) => !i.isTrashed);
  const counts: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  const folderBuckets = new Map<string, DesktopItem[]>();
  let analyzedImages = 0;

  for (const item of active) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    if (item.type === 'image' && item.imageAnalysis?.status === 'complete') {
      analyzedImages += 1;
    }
    for (const tag of item.userTags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    for (const tag of item.imageAnalysis?.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const parentName = item.parentId
      ? (active.find((p) => p.id === item.parentId)?.name ?? 'Desktop')
      : 'Desktop';
    const path = parentName === 'Desktop' ? '/' : `/${parentName}`;
    if (!folderBuckets.has(path)) folderBuckets.set(path, []);
    folderBuckets.get(path)!.push(item);
  }

  const topFolders = Array.from(folderBuckets.entries())
    .map(([path, entries]) => {
      const sampleCaptions = entries
        .map((e) => e.imageAnalysis?.caption)
        .filter((c): c is string => Boolean(c))
        .slice(0, 3);
      return {
        path,
        count: entries.length,
        sampleCaptions: sampleCaptions.length > 0 ? sampleCaptions : undefined,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const sampleTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag]) => tag);

  return {
    totalActiveItems: active.length,
    counts,
    hasPhotos: (counts.image ?? 0) > 0,
    hasAudio: (counts.audio ?? 0) > 0,
    hasVideo: (counts.video ?? 0) > 0,
    hasNotes: (counts.text ?? 0) > 0,
    analyzedImages,
    topFolders,
    sampleTags,
  };
}

async function loadDesktopSummary(ctx: AppToolsContext): Promise<DesktopSummary | null> {
  try {
    const stub = ctx.env.USER_DESKTOP.get(ctx.env.USER_DESKTOP.idFromName(ctx.agentName));
    const res = await withStepTimeout(
      'Loading desktop summary',
      APP_BUILD_TIMEOUT_MS.desktopSummary,
      stub.fetch(new Request('http://internal/items')),
    );
    if (!res.ok) return null;
    const data = await res.json<{ items: DesktopItem[]; profile: UserProfile | null }>();
    return summarizeDesktopForLLM(data.items, data.profile);
  } catch {
    return null;
  }
}

async function generateAppSpec(
  env: Env,
  prompt: string,
  desktopSummary: DesktopSummary | null,
): Promise<AppSpec> {
  const contextBlock = desktopSummary
    ? `User desktop summary:
${JSON.stringify(desktopSummary, null, 2)}`
    : 'Desktop summary not available.';

  const { object } = await withStepTimeout(
    'Generating app specification',
    APP_BUILD_TIMEOUT_MS.specGeneration,
    generateObject({
      model: getAppBuilderModel(env),
      schema: appSpecSchema,
      system: `You design app specifications for EternalOS before code generation.

Your job:
- translate a natural-language app request into a compact product spec
- request the narrowest permissions that still let the app work
- prefer mime-type permissions over full-path or full-desktop permissions
- if the app does not need desktop data, omit permissions entirely
- if broad permissions are required, include a short rationale
- produce a realistic default window size
- write concrete acceptance bullets that can be validated later`,
      prompt: `Create an app specification for this request:

${prompt}

${contextBlock}`,
    }),
  );

  return object;
}

async function generateAppFromPrompt(
  env: Env,
  prompt: string,
  spec: AppSpec,
  desktopSummary: DesktopSummary | null,
  previousError?: string,
): Promise<AppBundleInput> {
  const repairContext = previousError
    ? `Previous attempt failed during validation or bundling with this error:\n${previousError}\n\nReturn a corrected app bundle.`
    : 'This is the first generation attempt.';

  const contextBlock = desktopSummary
    ? `User's desktop summary (use this to pick sensible defaults, scope permissions, and make the app feel personal — but only request permissions you will actually use):
${JSON.stringify(desktopSummary, null, 2)}`
    : 'Desktop summary not available; design the app as a general-purpose starter.';

  const { object } = await withStepTimeout(
    'Generating app files',
    APP_BUILD_TIMEOUT_MS.fileGeneration,
    generateObject({
      model: getAppBuilderModel(env),
      schema: generatedAppFilesSchema,
      system: `You generate complete desktop web apps as structured source files for EternalOS.

Apps run in a sandboxed iframe with NO network access. The platform injects a
window.eternal bridge that gives apps access to the user's desktop if (and only
if) they declare the right permissions. Always prefer window.eternal APIs over
asking the user to paste data.

Available in window.eternal (platform-injected — do not re-implement):
  eternal.fs.list({ path?, mimeType?, limit? })   -> Item[]
  eternal.fs.read(id)       -> Blob
  eternal.fs.readText(id)   -> string
  eternal.fs.readJson(id)   -> object
  eternal.fs.urlFor(id)     -> same-origin URL safe for <img src>, <audio src>
  eternal.profile.get()     -> { username?, displayName?, bio?, avatar? }
  eternal.window.setTitle(s), eternal.window.close(), eternal.window.requestFocus()

Item shape: { id, name, type, path, mimeType?, fileSize?, updatedAt, isPublic, caption?, tags?, dominantColors?, url? }

Permissions — declare what you use, nothing more:
  fs.read: path globs — ['**'], ['/Photos/**'], ['/Notes/*.md']
  fs.mimeTypes: ['image/*'], ['audio/*'], ['video/*'], ['text/*'], ['application/pdf']
  profile.read: subset of ['username', 'displayName', 'bio', 'avatar']

If the app doesn't need desktop data, omit permissions entirely and it runs hermetic.

Rules for files:
- Return a COMPLETE app bundle: at minimum index.html, styles.css, app.js
- Do NOT include eternal-runtime.js — the platform auto-injects it
- Do NOT load external CDNs, fonts, or images
- Reference local assets with relative paths: ./styles.css, ./app.js
- Use standard browser APIs and window.eternal only — no npm packages
- Output production-ready HTML/CSS/JS. No markdown fences, no placeholder "// TODO" stubs
- Handle the empty case gracefully: eternal.fs.list() returns [] until the user grants permission
- Wrap fetches in try/catch so a permission denial or empty desktop doesn't crash the UI
- Match the supplied app specification exactly for metadata and permissions`,
      prompt: `Build a desktop web app for this request:

${prompt}

App specification:
${JSON.stringify(spec, null, 2)}

${contextBlock}

${repairContext}`,
    }),
  );

  const app = normalizeAppFromSpec(spec, object.files);
  validateGeneratedApp(app);
  return app;
}

async function buildAppFromPromptWithRetries(
  ctx: AppToolsContext,
  prompt: string,
): Promise<{ appId: string; itemId: string; name: string; status: 'created'; permissions?: AppPermissions }> {
  let lastError = 'Unknown generation error';
  const desktopSummary = await loadDesktopSummary(ctx);
  let spec: AppSpec | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      spec = await generateAppSpec(ctx.env, prompt, desktopSummary);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!isCapacityExceededError(error) || attempt === 2) {
        throw error;
      }
      await waitForCapacityRetry(attempt);
    }
  }

  if (!spec) {
    throw new Error('Failed to generate app specification');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const generatedApp = await generateAppFromPrompt(
        ctx.env,
        prompt,
        spec,
        desktopSummary,
        attempt > 0 ? lastError : undefined,
      );
      const registered = await createAndRegisterApp(ctx, generatedApp);
      return { ...registered, permissions: generatedApp.permissions };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (isCapacityExceededError(error) && attempt < 2) {
        await waitForCapacityRetry(attempt);
      }
    }
  }

  if (isCapacityExceededError(lastError)) {
    throw new Error('Cloudflare Workers AI is temporarily out of capacity for Kimi. Please retry in a minute.');
  }

  throw new Error(`Failed to generate a working app after multiple attempts: ${lastError}`);
}

async function writeAppArtifact(
  ctx: AppToolsContext,
  input: AppBundleInput,
  artifactId: string,
  r2Prefix: string,
  mountBasePath: '/api/apps' | '/api/app-previews',
  tracker: ReturnType<typeof createBuildTracker>,
  options?: { expiresAt?: number },
): Promise<AppArtifactBuildResult> {
  const { env, agentName: uid } = ctx;
  const workspace = createAppWorkspace(input.files);
  tracker.markCompleted('prepare-workspace');

  const workerFiles = createWorkerModuleFiles(workspace, mountBasePath);
  const { mainModule, modules } = await withStepTimeout(
    'Bundling app worker',
    APP_BUILD_TIMEOUT_MS.bundling,
    createWorker({
      files: {
        ...workerFiles,
        [APP_WORKER_ENTRY_FILE]: workerFiles[APP_WORKER_ENTRY_FILE].replaceAll('__APP_ID__', artifactId),
      },
      entryPoint: APP_WORKER_ENTRY_FILE,
    }),
  );
  tracker.markCompleted('bundle-worker');

  const now = Date.now();
  const metadata: StoredAppMetadata = {
    id: artifactId,
    uid,
    name: input.name,
    description: input.description,
    width: input.width,
    height: input.height,
    permissions: input.permissions,
    rationale: input.rationale,
    granted: grantsFromPermissions(input.permissions),
    version: 1,
    r2Prefix,
    createdAt: now,
    expiresAt: options?.expiresAt,
  };

  const bundle = JSON.stringify({ mainModule, modules });
  await withStepTimeout(
    'Writing app bundle',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_BUNDLE_FILE}`, bundle),
  );
  await withStepTimeout(
    'Writing app source',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_SOURCE_FILE}`, JSON.stringify(workspace.files)),
  );
  await withStepTimeout(
    'Writing workspace manifest',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_WORKSPACE_MANIFEST_FILE}`, JSON.stringify(workspace.manifest)),
  );
  await withStepTimeout(
    'Writing app metadata',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_METADATA_FILE}`, JSON.stringify(metadata)),
  );
  tracker.markCompleted('write-storage');

  return { metadata, build: tracker.success() };
}

async function createAndRegisterApp(
  ctx: AppToolsContext,
  input: AppBundleInput
): Promise<{ appId: string; itemId: string; name: string; status: 'created'; build: AppBuildSummary }> {
  const { env, sql, agentName: uid } = ctx;
  const appId = crypto.randomUUID();
  const r2Prefix = `apps/${uid}/${appId}`;
  const tracker = createBuildTracker();

  try {
    const artifact = await writeAppArtifact(ctx, input, appId, r2Prefix, '/api/apps', tracker);

    const now = Date.now();
    sql.exec(
      `INSERT INTO apps (id, name, description, version, r2_prefix, width, height, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      appId, input.name, input.description ?? '', r2Prefix, input.width, input.height, now, now,
    );

    await withStepTimeout(
      'Saving app registry metadata',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.DESKTOP_KV.put(
        `app:${appId}`,
        JSON.stringify({
          uid,
          version: 1,
          granted: artifact.metadata.granted,
          r2Prefix,
        }),
      ),
    );

    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);
    const position = await withStepTimeout(
      'Finding desktop placement',
      APP_BUILD_TIMEOUT_MS.desktopInstall,
      getNextDesktopGridPosition(stub),
    );
    const manifest: AppManifest = {
      name: input.name,
      description: input.description,
      version: '1',
      windowConfig: { defaultWidth: input.width, defaultHeight: input.height, resizable: true },
      appId,
      permissions: input.permissions,
      rationale: input.rationale,
    };

    const createRes = await withStepTimeout(
      'Installing app on desktop',
      APP_BUILD_TIMEOUT_MS.desktopInstall,
      stub.fetch(new Request('http://internal/items', {
        method: 'POST',
        body: JSON.stringify({
          type: 'app',
          name: input.name,
          parentId: null,
          position,
          isPublic: false,
          appManifest: manifest,
          grantedPermissions: artifact.metadata.granted,
          permissionGrantedAt: now,
        }),
      })),
    );

    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      throw new Error(`Failed to create desktop item (${createRes.status})${detail ? `: ${detail}` : ''}`);
    }

    const item = await createRes.json<DesktopItem>();
    sql.exec('UPDATE apps SET desktop_item_id = ? WHERE id = ?', item.id, appId);
    tracker.markCompleted('install-desktop');

    return {
      appId,
      itemId: item.id,
      name: input.name,
      status: 'created',
      build: {
        ...artifact.build,
        currentStage: 'ready',
        stages: artifact.build.stages.map((stage) => (
          stage.key === 'install-desktop' ? { ...stage, status: 'completed' } : stage
        )),
        completedAt: Date.now(),
        durationMs: Date.now() - artifact.build.startedAt,
      },
    };
  } catch (error) {
    throw wrapBuildError(error, tracker);
  }
}

async function createAppPreview(
  ctx: AppToolsContext,
  input: AppBundleInput,
): Promise<{
  previewId: string;
  name: string;
  status: 'preview-ready';
  previewUrl: string;
  expiresAt: number;
  permissions?: AppPermissions;
  build: AppBuildSummary;
}> {
  const { env, agentName: uid } = ctx;
  const previewId = crypto.randomUUID();
  const r2Prefix = `app-previews/${uid}/${previewId}`;
  const tracker = createBuildTracker();
  const expiresAt = Date.now() + APP_PREVIEW_TTL_SECONDS * 1000;

  try {
    const artifact = await writeAppArtifact(
      ctx,
      input,
      previewId,
      r2Prefix,
      '/api/app-previews',
      tracker,
      { expiresAt },
    );

    await withStepTimeout(
      'Saving preview registry metadata',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.DESKTOP_KV.put(
        `app-preview:${previewId}`,
        JSON.stringify({
          ...artifact.metadata,
          // Previews deliberately run hermetic. Desktop grants only activate
          // after the user installs the app onto their desktop.
          granted: {},
        }),
        { expirationTtl: APP_PREVIEW_TTL_SECONDS },
      ),
    );

    return {
      previewId,
      name: input.name,
      status: 'preview-ready',
      previewUrl: `/api/app-previews/${previewId}/`,
      expiresAt,
      permissions: input.permissions,
      build: artifact.build,
    };
  } catch (error) {
    throw wrapBuildError(error, tracker);
  }
}

async function buildAppPreviewFromPromptWithRetries(
  ctx: AppToolsContext,
  prompt: string,
): Promise<Awaited<ReturnType<typeof createAppPreview>>> {
  let lastError = 'Unknown generation error';
  const desktopSummary = await loadDesktopSummary(ctx);
  let spec: AppSpec | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      spec = await generateAppSpec(ctx.env, prompt, desktopSummary);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!isCapacityExceededError(error) || attempt === 2) {
        throw error;
      }
      await waitForCapacityRetry(attempt);
    }
  }

  if (!spec) {
    throw new Error('Failed to generate app specification');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const generatedApp = await generateAppFromPrompt(
        ctx.env,
        prompt,
        spec,
        desktopSummary,
        attempt > 0 ? lastError : undefined,
      );
      return createAppPreview(ctx, generatedApp);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (isCapacityExceededError(error) && attempt < 2) {
        await waitForCapacityRetry(attempt);
      }
    }
  }

  if (isCapacityExceededError(lastError)) {
    throw new Error('Cloudflare Workers AI is temporarily out of capacity for Kimi. Please retry in a minute.');
  }

  throw new Error(`Failed to generate a working app preview after multiple attempts: ${lastError}`);
}

async function installAppPreview(
  ctx: AppToolsContext,
  previewId: string,
): Promise<{ appId: string; itemId: string; name: string; status: 'created'; previewId: string }> {
  const { env, sql, agentName: uid } = ctx;
  const previewMeta = await env.DESKTOP_KV.get<StoredAppMetadata>(`app-preview:${previewId}`, 'json');
  if (!previewMeta || previewMeta.uid !== uid) {
    throw new Error(`Preview ${previewId} not found`);
  }
  if (previewMeta.expiresAt && previewMeta.expiresAt < Date.now()) {
    throw new Error('App preview expired; generate a new preview');
  }

  const sourceObj = await env.ETERNALOS_FILES.get(`${previewMeta.r2Prefix}/${APP_SOURCE_FILE}`);
  if (!sourceObj) {
    throw new Error('Preview source files not found');
  }
  const sourceFiles = await sourceObj.json<Record<string, string>>();

  return createAndRegisterApp(ctx, {
    name: previewMeta.name,
    description: previewMeta.description,
    files: sourceFiles,
    width: previewMeta.width,
    height: previewMeta.height,
    permissions: previewMeta.permissions,
    rationale: previewMeta.rationale,
  }).then((result) => {
    sql.exec('UPDATE apps SET updated_at = ? WHERE id = ?', Date.now(), result.appId);
    return { ...result, previewId };
  });
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
 * Platform-provided runtime bundled with every app. Exposes `window.eternal`
 * as a thin fetch wrapper over same-origin `/_eternal/*` routes handled inside
 * the Dynamic Worker (which then RPCs to the parent's EternalService binding).
 *
 * The iframe never sees a capability token; grants are bound into the Dynamic
 * Worker at load time via ctx.props.
 */
const ETERNAL_RUNTIME_JS = `(() => {
  // The iframe's document URL ends with "/api/apps/:appId/". Resolve bridge
  // calls relative to it so we hit the Dynamic Worker's mount path rather
  // than the origin root (which would bypass our routing).
  function apiUrl(path) {
    return new URL('_eternal' + path, document.baseURI).toString();
  }

  async function request(path, init) {
    const res = await fetch(apiUrl(path), init);
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      throw new Error('eternal ' + path + ' failed (' + res.status + ')' + (detail ? ': ' + detail : ''));
    }
    return res;
  }

  function encodeId(id) {
    return encodeURIComponent(String(id || ''));
  }

  const fs = {
    async list(opts) {
      const params = new URLSearchParams();
      if (opts && opts.path) params.set('path', String(opts.path));
      if (opts && opts.mimeType) params.set('mimeType', String(opts.mimeType));
      if (opts && opts.limit) params.set('limit', String(opts.limit | 0));
      const res = await request('/fs/list' + (params.toString() ? '?' + params : ''));
      return res.json();
    },
    async read(id) {
      const res = await request('/fs/read/' + encodeId(id));
      return res.blob();
    },
    async readText(id) {
      const res = await request('/fs/read/' + encodeId(id));
      return res.text();
    },
    async readJson(id) {
      const res = await request('/fs/read/' + encodeId(id));
      return res.json();
    },
    urlFor(id) {
      return apiUrl('/fs/read/' + encodeId(id));
    },
  };

  const profile = {
    async get() {
      const res = await request('/profile');
      return res.json();
    },
  };

  const postToParent = (msg) => {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
      }
    } catch (_) {}
  };

  const appWindow = {
    setTitle(title) { postToParent({ type: 'eternal:window:setTitle', title: String(title == null ? '' : title) }); },
    close() { postToParent({ type: 'eternal:window:close' }); },
    requestFocus() { postToParent({ type: 'eternal:window:requestFocus' }); },
  };

  function onIntent(cb) {
    const handler = (e) => {
      if (!e || !e.data || e.data.type !== 'eternal:intent') return;
      try { cb(e.data.intent); } catch (_) {}
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }

  const meta = document.querySelector('meta[name="eternal-app-id"]');
  const appId = meta ? meta.getAttribute('content') || '' : '';

  Object.defineProperty(window, 'eternal', {
    value: Object.freeze({ appId, hostVersion: '1', fs, profile, window: appWindow, onIntent }),
    writable: false,
    configurable: false,
  });
})();
`;

/**
 * Wrap user-provided app files into a Worker that serves the assembled HTML
 * page AND handles the `/_eternal/*` bridge calls via the ETERNAL binding.
 */
function createWorkerModuleFiles(
  workspace: AppWorkspace,
  mountBasePath: '/api/apps' | '/api/app-previews' = '/api/apps',
): Record<string, string> {
  const normalizedFiles = workspace.files;
  const htmlPath = workspace.manifest.entryHtml;
  const cssPath = selectDefaultCssEntry(normalizedFiles);
  const jsPath = selectDefaultJsEntry(normalizedFiles);
  const html = normalizedFiles[htmlPath] || '';
  const isCompleteHtml = html.toLowerCase().includes('<!doctype') || html.toLowerCase().includes('<html');

  const ETERNAL_META_ID = '__APP_ID__';
  const eternalMetaTag = `<meta name="eternal-app-id" content="${ETERNAL_META_ID}">`;
  const eternalRuntimeTag = `<script src="./${APP_RUNTIME_ASSET_FILE}"></script>`;

  const injectAssetsIntoHtml = (sourceHtml: string): string => {
    let result = sourceHtml;
    // Runtime + meta always come first so user scripts can rely on window.eternal.
    if (!result.includes(APP_RUNTIME_ASSET_FILE)) {
      if (/<\/head>/i.test(result)) {
        result = result.replace(/<\/head>/i, `${eternalMetaTag}\n${eternalRuntimeTag}\n</head>`);
      } else if (/<body[^>]*>/i.test(result)) {
        result = result.replace(/<body([^>]*)>/i, `<body$1>\n${eternalMetaTag}\n${eternalRuntimeTag}`);
      } else {
        result = `${eternalMetaTag}\n${eternalRuntimeTag}\n${result}`;
      }
    }
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
${eternalMetaTag}
${eternalRuntimeTag}
${cssPath ? `<link rel="stylesheet" href="./${cssPath}">` : ''}
</head>
<body>
${html}
${jsPath ? `<script type="module" src="./${jsPath}"></script>` : ''}
</body>
</html>`;

  const assets: Record<string, string> = {
    ...normalizedFiles,
    [htmlPath]: fullHtml,
    [APP_RUNTIME_ASSET_FILE]: ETERNAL_RUNTIME_JS,
  };
  const mountPath = `${mountBasePath}/__APP_ID__`;

  return {
    [APP_WORKER_ENTRY_FILE]: `
const ASSETS = ${JSON.stringify(assets)};
const ENTRY = ${JSON.stringify(htmlPath)};
const MOUNT_PATH = ${JSON.stringify(mountPath)};
const ETERNAL_PREFIX = '/_eternal';

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

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Sandboxed iframes with only 'allow-scripts' get an opaque (null) origin.
// Bridge calls from there are cross-origin fetches to this Dynamic Worker,
// so every response needs CORS headers the browser will accept from null.
// Credentials are never included (iframe has no cookies/auth for this host),
// so '*' is safe and simpler than echoing 'null' back.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '300',
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleEternal(request, env, bridgePath) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (!env || !env.ETERNAL) {
    return withCors(new Response(JSON.stringify({ error: 'Bridge not available' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
  }
  const url = new URL(request.url);

  if (bridgePath === '/fs/list' && request.method === 'GET') {
    try {
      const items = await env.ETERNAL.list({
        path: url.searchParams.get('path') || undefined,
        mimeType: url.searchParams.get('mimeType') || undefined,
        limit: clampInt(url.searchParams.get('limit'), 1, 500, 100),
      });
      return withCors(Response.json({ items }));
    } catch (err) {
      return withCors(Response.json({ error: String(err && err.message ? err.message : err) }, { status: 500 }));
    }
  }

  if (bridgePath.startsWith('/fs/read/') && request.method === 'GET') {
    const id = bridgePath.slice('/fs/read/'.length);
    if (!id) return withCors(Response.json({ error: 'Missing id' }, { status: 400 }));
    try {
      return withCors(await env.ETERNAL.read(id));
    } catch (err) {
      return withCors(Response.json({ error: String(err && err.message ? err.message : err) }, { status: 500 }));
    }
  }

  if (bridgePath === '/profile' && request.method === 'GET') {
    try {
      const profile = await env.ETERNAL.profile();
      return withCors(Response.json(profile));
    } catch (err) {
      return withCors(Response.json({ error: String(err && err.message ? err.message : err) }, { status: 500 }));
    }
  }

  return withCors(new Response('Not found', { status: 404 }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let assetPath = url.pathname;

    if (assetPath === MOUNT_PATH || assetPath === MOUNT_PATH + '/') {
      assetPath = '/' + ENTRY;
    } else if (assetPath.startsWith(MOUNT_PATH + '/')) {
      assetPath = assetPath.slice(MOUNT_PATH.length);
    }

    if (assetPath === ETERNAL_PREFIX || assetPath.startsWith(ETERNAL_PREFIX + '/')) {
      const bridgePath = assetPath.slice(ETERNAL_PREFIX.length) || '/';
      return handleEternal(request, env, bridgePath);
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
 * Create the app tools that are exposed to the OrchestratorAgent.
 */
export function createAppTools(ctx: AppToolsContext) {
  const { env, sql, agentName: uid } = ctx;

  return {
    previewAppFromPrompt: tool({
      description: 'Generate a new app preview from a natural-language product brief without installing it on the desktop. Use this when the user wants to inspect or approve an app before install.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000).describe('Natural-language app request or product brief'),
      }),
      needsApproval: true,
      execute: async (input) => buildAppPreviewFromPromptWithRetries(ctx, input.prompt),
    }),

    installAppPreview: tool({
      description: 'Install a previously generated app preview onto the user desktop.',
      inputSchema: z.object({
        previewId: z.string().min(1).max(128).describe('Preview ID returned by previewAppFromPrompt'),
      }),
      needsApproval: true,
      execute: async (input) => installAppPreview(ctx, input.previewId),
    }),

    buildAppFromPrompt: tool({
      description: 'Generate and create a new app from a natural-language product brief. Use this for most new app requests instead of embedding full source files in the tool call.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000).describe('Natural-language app request or product brief'),
      }),
      needsApproval: true,
      execute: async (input) => buildAppFromPromptWithRetries(ctx, input.prompt),
    }),

    createCuratedApp: tool({
      description: 'Create a polished, known-good app from a curated template. Prefer this for supported starter apps such as a todo list.',
      inputSchema: z.object({
        template: z.enum(['todo']).describe('Curated app template to use'),
        name: z.string().min(1).max(80).optional().describe('Optional app name override'),
        description: z.string().max(500).optional().describe('Optional app description override'),
      }),
      needsApproval: true,
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
      needsApproval: true,
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
      needsApproval: true,
      execute: async (input) => {
        // Look up the app in the registry
        const rows = [...sql.exec<{ version: number; r2_prefix: string; desktop_item_id: string | null; name: string; description: string; width: number; height: number }>(
          'SELECT version, r2_prefix, desktop_item_id, name, description, width, height FROM apps WHERE id = ?', input.appId,
        )];
        if (rows.length === 0) throw new Error(`App ${input.appId} not found`);
        const app = rows[0];

        const tracker = createBuildTracker();

        try {
          const newVersion = app.version + 1;
          const nextName = input.name ?? app.name;
          const nextDescription = input.description ?? app.description;
          const nextWidth = input.width ?? app.width;
          const nextHeight = input.height ?? app.height;

          const workspace = createAppWorkspace(input.files);
          tracker.markCompleted('prepare-workspace');

          const workerFiles = createWorkerModuleFiles(workspace);
          const { mainModule, modules } = await withStepTimeout(
            'Bundling app worker',
            APP_BUILD_TIMEOUT_MS.bundling,
            createWorker({
              files: {
                ...workerFiles,
                [APP_WORKER_ENTRY_FILE]: workerFiles[APP_WORKER_ENTRY_FILE].replaceAll('__APP_ID__', input.appId),
              },
              entryPoint: APP_WORKER_ENTRY_FILE,
            }),
          );
          tracker.markCompleted('bundle-worker');

          const bundle = JSON.stringify({ mainModule, modules });
          await withStepTimeout(
            'Writing app bundle',
            APP_BUILD_TIMEOUT_MS.storageWrite,
            env.ETERNALOS_FILES.put(`${app.r2_prefix}/bundle.json`, bundle),
          );
          await withStepTimeout(
            'Writing app source',
            APP_BUILD_TIMEOUT_MS.storageWrite,
            env.ETERNALOS_FILES.put(`${app.r2_prefix}/source.json`, JSON.stringify(workspace.files)),
          );
          await withStepTimeout(
            'Writing workspace manifest',
            APP_BUILD_TIMEOUT_MS.storageWrite,
            env.ETERNALOS_FILES.put(`${app.r2_prefix}/${APP_WORKSPACE_MANIFEST_FILE}`, JSON.stringify(workspace.manifest)),
          );
          tracker.markCompleted('write-storage');

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

          const prevMeta = await env.DESKTOP_KV.get<{
            uid: string;
            version: number;
            granted?: AppGrantedPermissions;
          }>(`app:${input.appId}`, 'json');
          const preservedGrants = prevMeta?.granted ?? {};
          await withStepTimeout(
            'Saving app registry metadata',
            APP_BUILD_TIMEOUT_MS.storageWrite,
            env.DESKTOP_KV.put(
              `app:${input.appId}`,
              JSON.stringify({ uid, version: newVersion, granted: preservedGrants }),
            ),
          );

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
            const updateRes = await withStepTimeout(
              'Installing updated app on desktop',
              APP_BUILD_TIMEOUT_MS.desktopInstall,
              stub.fetch(new Request('http://internal/items', {
                method: 'PATCH',
                body: JSON.stringify([{
                  id: app.desktop_item_id,
                  updates: {
                    name: nextName,
                    appManifest: manifest,
                  },
                }]),
              })),
            );
            if (!updateRes.ok) {
              const detail = await updateRes.text().catch(() => '');
              throw new Error(`Failed to update desktop item (${updateRes.status})${detail ? `: ${detail}` : ''}`);
            }
          }

          tracker.markCompleted('install-desktop');
          return { appId: input.appId, version: newVersion, status: 'updated', build: tracker.success() };
        } catch (error) {
          throw wrapBuildError(error, tracker);
        }
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
        const workspaceObj = await env.ETERNALOS_FILES.get(`${rows[0].r2_prefix}/${APP_WORKSPACE_MANIFEST_FILE}`);
        const workspaceManifest = workspaceObj
          ? await workspaceObj.json<AppWorkspaceManifest>().catch(() => null)
          : null;
        return { appId: input.appId, name: rows[0].name, files, workspaceManifest };
      },
    }),

    deleteApp: tool({
      description: 'Delete an app from the desktop and clean up its stored data.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to delete'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const rows = [...sql.exec<{ r2_prefix: string; desktop_item_id: string | null }>(
          'SELECT r2_prefix, desktop_item_id FROM apps WHERE id = ?', input.appId,
        )];
        if (rows.length === 0) throw new Error(`App ${input.appId} not found`);
        const app = rows[0];

        // Delete from R2
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/bundle.json`);
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/source.json`);
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/${APP_WORKSPACE_MANIFEST_FILE}`);

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
