/**
 * App tools for the OrchestratorAgent.
 *
 * These tools are exposed to codemode — the LLM writes TypeScript
 * that calls them to create, update, list, and manage apps.
 * Apps are compiled via @cloudflare/worker-bundler and run as Dynamic Workers.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { createWorker } from '@cloudflare/worker-bundler';
import type { Env } from '../../index';
import type { AppManifest, DesktopItem } from '../../types';

interface AppToolsContext {
  env: Env;
  sql: SqlStorage;
  agentName: string; // uid
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
  const html = files['index.html'] || files['app.html'] || files['html'] || '';
  const css = files['styles.css'] || files['style.css'] || files['app.css'] || files['css'] || '';
  const js = files['app.js'] || files['script.js'] || files['index.js'] || files['js'] || '';

  // If the user provided a complete HTML document, use it as-is
  const isCompleteHtml = html.toLowerCase().includes('<!doctype') || html.toLowerCase().includes('<html');
  const fullHtml = isCompleteHtml
    ? html
    : `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${css}</style>
</head>
<body>
${html}
<script>${js}</script>
</body>
</html>`;

  return {
    'index.js': `
const HTML = ${JSON.stringify(fullHtml)};

export default {
  async fetch(request) {
    return new Response(HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
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
    createApp: tool({
      description: 'Create a new app on the desktop. Provide HTML, CSS, and JS as separate files. The app runs in a sandboxed iframe.',
      parameters: z.object({
        name: z.string().min(1).max(80).describe('App name'),
        description: z.string().max(500).optional().describe('Short description'),
        files: z.record(z.string()).describe('App source files: { "index.html": "...", "styles.css": "...", "app.js": "..." }'),
        width: z.number().optional().default(600).describe('Default window width'),
        height: z.number().optional().default(500).describe('Default window height'),
      }),
      execute: async ({ name, description, files, width, height }) => {
        const appId = crypto.randomUUID();
        const r2Prefix = `apps/${uid}/${appId}`;

        // Assemble into a Worker and bundle
        const workerFiles = assembleWorkerFiles(files);
        const { mainModule, modules } = await createWorker({ files: workerFiles });

        // Store the compiled bundle in R2
        const bundle = JSON.stringify({ mainModule, modules });
        await env.ETERNALOS_FILES.put(`${r2Prefix}/bundle.json`, bundle);

        // Store original source files in R2 for later editing
        await env.ETERNALOS_FILES.put(`${r2Prefix}/source.json`, JSON.stringify(files));

        // Register in the agent's SQLite database
        const now = Date.now();
        sql.exec(
          `INSERT INTO apps (id, name, description, version, r2_prefix, width, height, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          appId, name, description ?? '', r2Prefix, width, height, now, now,
        );

        // Store app ownership in KV for the serving route
        await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({ uid, version: 1 }));

        // Create a DesktopItem on the user's desktop
        const doId = env.USER_DESKTOP.idFromName(uid);
        const stub = env.USER_DESKTOP.get(doId);
        const manifest: AppManifest = {
          name,
          description,
          version: '1',
          windowConfig: { defaultWidth: width, defaultHeight: height, resizable: true },
          appId,
        };

        const createRes = await stub.fetch(new Request('http://internal/items', {
          method: 'POST',
          body: JSON.stringify({
            type: 'app',
            name,
            parentId: null,
            position: { x: 60 + Math.random() * 200, y: 60 + Math.random() * 200 },
            isPublic: false,
            appManifest: manifest,
          }),
        }));

        if (!createRes.ok) {
          throw new Error(`Failed to create desktop item (${createRes.status})`);
        }

        const item = await createRes.json<DesktopItem>();

        // Update the registry with the desktop item ID
        sql.exec('UPDATE apps SET desktop_item_id = ? WHERE id = ?', item.id, appId);

        return { appId, itemId: item.id, name, status: 'created' };
      },
    }),

    updateApp: tool({
      description: 'Update an existing app\'s code. Provide the full updated files.',
      parameters: z.object({
        appId: z.string().describe('The app ID to update'),
        files: z.record(z.string()).describe('Updated source files'),
        name: z.string().optional().describe('Updated name'),
      }),
      execute: async ({ appId, files, name }) => {
        // Look up the app in the registry
        const rows = [...sql.exec<{ version: number; r2_prefix: string; desktop_item_id: string | null }>(
          'SELECT version, r2_prefix, desktop_item_id FROM apps WHERE id = ?', appId,
        ).results];
        if (rows.length === 0) throw new Error(`App ${appId} not found`);
        const app = rows[0];

        const newVersion = app.version + 1;

        // Re-bundle
        const workerFiles = assembleWorkerFiles(files);
        const { mainModule, modules } = await createWorker({ files: workerFiles });

        // Update R2
        const bundle = JSON.stringify({ mainModule, modules });
        await env.ETERNALOS_FILES.put(`${app.r2_prefix}/bundle.json`, bundle);
        await env.ETERNALOS_FILES.put(`${app.r2_prefix}/source.json`, JSON.stringify(files));

        // Update registry
        const now = Date.now();
        if (name) {
          sql.exec('UPDATE apps SET version = ?, name = ?, updated_at = ? WHERE id = ?', newVersion, name, now, appId);
        } else {
          sql.exec('UPDATE apps SET version = ?, updated_at = ? WHERE id = ?', newVersion, now, appId);
        }

        // Update KV version for the serving route
        await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({ uid, version: newVersion }));

        // Update the desktop item manifest if we have a linked item
        if (app.desktop_item_id && name) {
          const doId = env.USER_DESKTOP.idFromName(uid);
          const stub = env.USER_DESKTOP.get(doId);
          await stub.fetch(new Request('http://internal/items', {
            method: 'PATCH',
            body: JSON.stringify([{
              id: app.desktop_item_id,
              updates: { name },
            }]),
          }));
        }

        return { appId, version: newVersion, status: 'updated' };
      },
    }),

    listApps: tool({
      description: 'List all apps created by the user.',
      parameters: z.object({}),
      execute: async () => {
        const rows = [...sql.exec<{ id: string; name: string; description: string; version: number; created_at: number }>(
          'SELECT id, name, description, version, created_at FROM apps ORDER BY created_at DESC',
        ).results];
        return { apps: rows };
      },
    }),

    getAppSource: tool({
      description: 'Get the source files of an existing app so you can see or modify its code.',
      parameters: z.object({
        appId: z.string().describe('The app ID to read source from'),
      }),
      execute: async ({ appId }) => {
        const rows = [...sql.exec<{ r2_prefix: string; name: string }>(
          'SELECT r2_prefix, name FROM apps WHERE id = ?', appId,
        ).results];
        if (rows.length === 0) throw new Error(`App ${appId} not found`);

        const obj = await env.ETERNALOS_FILES.get(`${rows[0].r2_prefix}/source.json`);
        if (!obj) throw new Error('Source files not found');

        const files = await obj.json<Record<string, string>>();
        return { appId, name: rows[0].name, files };
      },
    }),

    deleteApp: tool({
      description: 'Delete an app from the desktop and clean up its stored data.',
      parameters: z.object({
        appId: z.string().describe('The app ID to delete'),
      }),
      execute: async ({ appId }) => {
        const rows = [...sql.exec<{ r2_prefix: string; desktop_item_id: string | null }>(
          'SELECT r2_prefix, desktop_item_id FROM apps WHERE id = ?', appId,
        ).results];
        if (rows.length === 0) throw new Error(`App ${appId} not found`);
        const app = rows[0];

        // Delete from R2
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/bundle.json`);
        await env.ETERNALOS_FILES.delete(`${app.r2_prefix}/source.json`);

        // Delete from KV
        await env.DESKTOP_KV.delete(`app:${appId}`);

        // Delete from registry
        sql.exec('DELETE FROM apps WHERE id = ?', appId);

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

        return { appId, status: 'deleted' };
      },
    }),
  };
}
