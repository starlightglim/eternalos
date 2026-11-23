/**
 * extractBackendRoutes (src/utils/backendRoutes.ts) feeds listApps' apiRoutes,
 * which the assistant uses instead of guessing app backend paths.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractBackendBodyFields, extractBackendRoutes } from '../src/utils/backendRoutes.ts';

describe('extractBackendRoutes', () => {
  it('pairs pathname comparisons with the method on the same line', () => {
    const server = `export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/api/entries' && request.method === 'GET') return a();
      if (url.pathname === '/api/entries' && request.method === 'POST') return b();
      return new Response('nope', { status: 404 });
    } };`;
    assert.deepEqual(extractBackendRoutes({ 'server.js': server }), ['GET /api/entries', 'POST /api/entries']);
  });

  it('reads router-style calls, regex literals, and server/ helpers', () => {
    const server = "import { route } from './server/router.js';\nconst m = url.pathname.match(/^\\/api\\/todos\\/(\\d+)$/);";
    const helper = "router.post('/api/habits/:id/check', checkHabit);\nrouter.get(\"/api/habits\", listHabits);";
    assert.deepEqual(
      extractBackendRoutes({ 'server.js': server, 'server/router.js': helper }),
      ['/api/todos/:id', 'POST /api/habits/:id/check', 'GET /api/habits'],
    );
  });

  it('ignores frontend files, the bare /api prefix, and drops bare duplicates', () => {
    const server = "const base = '/api/';\nif (path === '/api/items') {\n  if (request.method === 'GET') {}\n}\nif (path === '/api/items' && method === 'DELETE') {}";
    assert.deepEqual(
      extractBackendRoutes({ 'server.js': server, 'app.js': "eternal.api.get('/api/other')" }),
      ['DELETE /api/items'],
    );
  });

  it('treats optional regex groups as suffixes and reads method comments (live generated server)', () => {
    const server = [
      '// GET /api/habits',
      "if (path === '/api/habits' && method === 'GET') {}",
      '// PATCH /api/habits/:id',
      'const habitMatch = path.match(/^\\/api\\/habits\\/(\\d+)(\\/.*)?$/);',
    ].join('\n');
    assert.deepEqual(extractBackendRoutes({ 'server.js': server }), ['GET /api/habits', 'PATCH /api/habits/:id']);
  });

  it('returns nothing for static apps', () => {
    assert.deepEqual(extractBackendRoutes({ 'index.html': '<p>hi</p>', 'app.js': "fetch('/api/x')" }), []);
  });
});

describe('extractBackendBodyFields', () => {
  it('reads member access on the parsed body (live run: model sent { message } to a { text } API)', () => {
    const server = "let body;\ntry { body = await request.json(); } catch {}\nif (!body.text) return bad();\nconst done = body?.done === true;";
    assert.deepEqual(extractBackendBodyFields({ 'server.js': server }), ['text', 'done']);
  });

  it('reads destructuring, including renames and defaults', () => {
    const server = "const { title, due: dueDate, priority = 'low' } = await request.json();";
    assert.deepEqual(extractBackendBodyFields({ 'server.js': server }), ['title', 'due', 'priority']);
  });

  it('ignores frontend files', () => {
    assert.deepEqual(extractBackendBodyFields({ 'app.js': 'const b = await request.json(); b.secret' }), []);
  });
});
