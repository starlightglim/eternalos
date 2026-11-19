/**
 * Curated app templates.
 *
 * Per the roadmap (design/12-orchestrator-v2.md, Decision 6) curated templates
 * are fixtures and quality-control references, not the main product path. They
 * live in this dependency-free module so tests can import them directly and
 * assert that each template keeps passing post-bundle validation
 * (utils/appBundleValidation.ts) — the same gate every generated and
 * dev-deployed app must pass.
 *
 * The todo template persists through the `window.eternal.storage` bridge.
 * `localStorage` is NOT usable here: the app iframe runs with an opaque origin
 * (sandbox="allow-scripts"), where *any* storage access throws a
 * SecurityError. Before the post-bundle validator existed this template
 * shipped with `localStorage.setItem` in an unguarded save path — every save
 * threw, so nothing ever persisted.
 */

import type { AppPermissions } from '../../types';

export interface CuratedAppTemplate {
  name: string;
  description?: string;
  width: number;
  height: number;
  files: Record<string, string>;
  permissions?: AppPermissions;
  rationale?: string;
}

export function buildTodoTemplate(name: string, description?: string): CuratedAppTemplate {
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
      <span id="storageText">Saved to your EternalOS account</span>
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

// Persistence goes through the window.eternal.storage bridge. The sandboxed
// app iframe has an opaque origin, so localStorage/sessionStorage throw.
function getBridgeStorage() {
  try {
    return window.eternal && window.eternal.storage ? window.eternal.storage : null;
  } catch {
    return null;
  }
}

let state = {
  filter: 'all',
  tasks: [],
};

async function loadTasks() {
  const storage = getBridgeStorage();
  if (!storage) return [];
  try {
    const raw = await storage.get(STORAGE_KEY);
    if (!raw) return [];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
  const storage = getBridgeStorage();
  if (!storage) {
    storageText.textContent = 'Changes kept in memory (bridge unavailable)';
    return;
  }
  storage.set(STORAGE_KEY, JSON.stringify(state.tasks)).then(
    () => {
      storageText.textContent = state.tasks.length > 0
        ? 'Saved to your EternalOS account'
        : 'Nothing saved yet';
    },
    () => {
      storageText.textContent = 'Save failed — changes kept in memory';
    },
  );
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

render();

// Hydrate from the account-level bridge once the first paint is done, so the
// app is interactive immediately whether or not the bridge answers.
loadTasks().then((tasks) => {
  if (tasks.length > 0) {
    state.tasks = tasks;
    render();
  }
}).catch(() => {});`,
    },
  };
}
