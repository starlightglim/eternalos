/**
 * "Try the demo" for Ask Eternal: a 30-second tour of what makes it
 * different. It installs a small Reading List app (its own backend and
 * database) and a desktop note, then asks for one change that spans both.
 * The user sees the plain-words preview, approves once, watches the app
 * update live, and can Undo it all.
 *
 * Everything goes through the normal routes (dev-deploy, items), so the demo
 * app is an ordinary app the user owns and can delete. Setup is idempotent:
 * an existing demo app or note is reused.
 */

import type { DesktopItem } from '../types';
import { deployApp } from './apps';
import { createItem } from './desktop';

export const DEMO_APP_NAME = 'Reading List';
export const DEMO_NOTE_NAME = 'Books to read.txt';
export const DEMO_PROMPT = `Add the books from my “${DEMO_NOTE_NAME}” note to my Reading List app, and mark Dune as read.`;

const DEMO_NOTE_TEXT = `Project Hail Mary — Andy Weir
Piranesi — Susanna Clarke
The Left Hand of Darkness — Ursula K. Le Guin
`;

const SERVER_JS = `const SEED = [
  ['Dune', 'Frank Herbert', 0],
  ['Neuromancer', 'William Gibson', 0],
  ['The Hobbit', 'J.R.R. Tolkien', 1],
];

function setup(env) {
  env.sql.exec('CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT, is_read INTEGER NOT NULL DEFAULT 0)');
  env.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const seeded = env.sql.exec("SELECT value FROM meta WHERE key = 'seeded'").toArray()[0];
  if (!seeded) {
    for (const [title, author, isRead] of SEED) env.sql.exec('INSERT INTO books (title, author, is_read) VALUES (?, ?, ?)', title, author, isRead);
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
  }
}

export default {
  async fetch(request, env) {
    setup(env);
    const url = new URL(request.url);
    // GET /api/books — every book, oldest first
    if (url.pathname === '/api/books' && request.method === 'GET') {
      return Response.json(env.sql.exec('SELECT * FROM books ORDER BY id').toArray());
    }
    // POST /api/books — add a book { title, author?, is_read? }
    if (url.pathname === '/api/books' && request.method === 'POST') {
      const body = await request.json();
      if (!body.title) return Response.json({ error: 'title is required' }, { status: 400 });
      return Response.json(env.sql.exec('INSERT INTO books (title, author, is_read) VALUES (?, ?, ?) RETURNING *', String(body.title), body.author ? String(body.author) : null, body.is_read ? 1 : 0).one(), { status: 201 });
    }
    const match = url.pathname.match(/^\\/api\\/books\\/(\\d+)$/);
    if (match) {
      const id = Number(match[1]);
      const row = env.sql.exec('SELECT * FROM books WHERE id = ?', id).toArray()[0];
      // GET /api/books/:id
      if (request.method === 'GET') {
        return row ? Response.json(row) : Response.json({ error: 'not found' }, { status: 404 });
      }
      // PATCH /api/books/:id — change title, author or is_read
      if (request.method === 'PATCH' || request.method === 'PUT') {
        if (!row) return Response.json({ error: 'not found' }, { status: 404 });
        const next = { ...row, ...(await request.json()) };
        env.sql.exec('UPDATE books SET title = ?, author = ?, is_read = ? WHERE id = ?', String(next.title), next.author ?? null, next.is_read ? 1 : 0, id);
        return Response.json(env.sql.exec('SELECT * FROM books WHERE id = ?', id).one());
      }
      // DELETE /api/books/:id
      if (request.method === 'DELETE') {
        env.sql.exec('DELETE FROM books WHERE id = ?', id);
        return Response.json({ ok: true });
      }
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
`;

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <header>
    <h1>Reading List</h1>
    <p id="progress">Loading…</p>
    <div class="bar"><div id="bar-fill"></div></div>
  </header>
  <ul id="list"></ul>
  <form id="add">
    <input id="title" placeholder="Add a book…" autocomplete="off">
    <button type="submit">Add</button>
  </form>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

const STYLES_CSS = `:root { color-scheme: light; --accent: #3d78d2; --ok: #2f9e58; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 18px; font: 13px/1.45 -apple-system, system-ui, sans-serif; color: #1d1d1f; background: #fbfbfd; }
h1 { margin: 0; font-size: 17px; }
header { margin-bottom: 12px; }
#progress { margin: 2px 0 6px; color: #6e6e73; }
.bar { height: 6px; border-radius: 3px; background: #e5e5ea; overflow: hidden; }
#bar-fill { height: 100%; width: 0; background: var(--ok); transition: width .5s ease; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
li { display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid #e5e5ea; border-radius: 8px; background: #fff; cursor: pointer; transition: background .2s; }
li:hover { background: #f5f5f7; }
.check { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #c7c7cc; display: grid; place-items: center; color: #fff; font-size: 11px; font-weight: 700; }
li.read .check { background: var(--ok); border-color: var(--ok); }
li.read .title { color: #8e8e93; text-decoration: line-through; }
.title { font-weight: 600; }
.author { color: #6e6e73; font-size: 12px; }
li.flash { animation: flash 1.6s ease-out; }
@keyframes flash { 0% { background: #fff4c2; border-color: #f0c84b; } 100% { background: #fff; } }
form { display: flex; gap: 6px; margin-top: 12px; }
input { flex: 1; padding: 7px 9px; border: 1px solid #d1d1d6; border-radius: 7px; font: inherit; }
button { padding: 7px 12px; border: 0; border-radius: 7px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { li.flash { animation: none; } #bar-fill { transition: none; } }
`;

const APP_JS = `const list = document.getElementById('list');
const progress = document.getElementById('progress');
const barFill = document.getElementById('bar-fill');
let previous = null;

function row(book, changed) {
  const li = document.createElement('li');
  if (book.is_read) li.classList.add('read');
  if (changed) li.classList.add('flash');
  const check = document.createElement('span');
  check.className = 'check';
  check.textContent = book.is_read ? '✓' : '';
  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = book.title;
  text.appendChild(title);
  if (book.author) {
    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = book.author;
    text.appendChild(author);
  }
  li.append(check, text);
  li.addEventListener('click', async () => {
    await window.eternal.api.patch('/books/' + book.id, { is_read: book.is_read ? 0 : 1 });
    load();
  });
  return li;
}

async function load() {
  const books = await window.eternal.api.get('/books');
  const before = previous;
  previous = new Map(books.map((book) => [book.id, JSON.stringify(book)]));
  list.replaceChildren(...books.map((book) => row(book, before !== null && before.get(book.id) !== JSON.stringify(book))));
  const read = books.filter((book) => book.is_read).length;
  progress.textContent = books.length ? read + ' of ' + books.length + ' read' : 'No books yet';
  barFill.style.width = books.length ? Math.round((read / books.length) * 100) + '%' : '0';
}

document.getElementById('add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('title');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await window.eternal.api.post('/books', { title });
  load();
});

window.eternal.api.onChange(load);
load();
`;

export const DEMO_APP_FILES: Record<string, string> = {
  'index.html': INDEX_HTML,
  'styles.css': STYLES_CSS,
  'app.js': APP_JS,
  'server.js': SERVER_JS,
};

/** First free top-level grid cell, filled column by column (like the agent's placement). */
export function freeDesktopCell(items: Pick<DesktopItem, 'parentId' | 'position' | 'isTrashed'>[], rows = 7, columns = 14): { x: number; y: number } {
  const taken = new Set(
    items
      .filter((item) => !item.parentId && !item.isTrashed)
      .map((item) => `${Math.round(item.position.x)},${Math.round(item.position.y)}`),
  );
  for (let x = 0; x < columns; x += 1) {
    for (let y = 0; y < rows; y += 1) {
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Make sure the demo app and note exist. Returns the desktop item id of the
 * app so the caller can open it (null when the app icon hasn't appeared).
 */
export async function ensureAgentDemo(
  items: DesktopItem[],
  reloadItems: () => Promise<DesktopItem[]>,
): Promise<{ appItemId: string | null }> {
  const findApp = (list: DesktopItem[]) =>
    list.find((item) => item.type === 'app' && !item.isTrashed && item.appManifest?.name === DEMO_APP_NAME);
  const hasNote = items.some((item) => item.type === 'text' && !item.isTrashed && !item.parentId && item.name === DEMO_NOTE_NAME);

  let current = items;
  if (!hasNote) {
    await createItem({
      type: 'text',
      name: DEMO_NOTE_NAME,
      parentId: null,
      position: freeDesktopCell(current),
      isPublic: false,
      textContent: DEMO_NOTE_TEXT,
    });
  }
  if (!findApp(current)) {
    await deployApp({
      manifest: {
        name: DEMO_APP_NAME,
        description: 'A small reading list with its own backend — made for the Ask Eternal demo.',
        version: '1.0.0',
        windowConfig: { defaultWidth: 380, defaultHeight: 460, resizable: true },
      },
      files: DEMO_APP_FILES,
    });
  }
  current = await reloadItems();
  return { appItemId: findApp(current)?.id ?? null };
}
