/**
 * App skins REST (owner only):
 *
 *   GET    /api/apps/:appId/skins             { active, skins[] }
 *   POST   /api/apps/:appId/skins             { skin, activate? } → install (strict validation)
 *   POST   /api/apps/:appId/skins/generate    { prompt, parts?, activate? } → designed by AI
 *   GET    /api/apps/:appId/skins/active      { skinId, skin }
 *   PUT    /api/apps/:appId/skins/active      { skinId | null }
 *   GET    /api/apps/:appId/skins/:skinId     the full skin (export)
 *   PUT    /api/apps/:appId/skins/:skinId     { skin } → replace (e.g. edited colors)
 *   DELETE /api/apps/:appId/skins/:skinId
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import { acquireAiRequest, legibleAiErrorMessage } from '../middleware/aiUsage';
import { SkinValidationError, normalizeSkin, summarizeSkin } from '../utils/appSkin';
import {
  SkinStoreError,
  deleteSkin,
  designSkin,
  isSkinId,
  loadAppSourceFiles,
  ownedApp,
  readSkin,
  readSkinIndex,
  saveSkin,
  scanSkinParts,
  setActiveSkin,
  type SkinPartInfo,
} from '../agents/tools/skinTools';

const MAX_BODY_BYTES = 9 * 1024 * 1024;

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: 'That skin is too large (9MB max).' }, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: 'That skin is too large (9MB max).' }, { status: 413 });
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : Response.json({ error: 'Expected a JSON object' }, { status: 400 });
  } catch {
    return Response.json({ error: 'Expected a JSON object' }, { status: 400 });
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof SkinValidationError) return Response.json({ error: error.message, problems: error.problems }, { status: 400 });
  if (error instanceof SkinStoreError) return Response.json({ error: error.message }, { status: error.status });
  console.error('[skins] request failed:', error);
  return Response.json({ error: 'The skin request failed.' }, { status: 500 });
}

function sanitizeParts(raw: unknown): SkinPartInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const parts: SkinPartInfo[] = [];
  for (const entry of raw.slice(0, 80)) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, label, frames } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) continue;
    const info: SkinPartInfo = { name };
    if (typeof label === 'string' && label.trim()) info.label = label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    const frameCount = Number(frames);
    if (Number.isInteger(frameCount) && frameCount >= 2 && frameCount <= 64) info.frames = frameCount;
    parts.push(info);
  }
  return parts;
}

export async function handleAppSkins(
  request: Request,
  env: Env,
  auth: AuthContext,
  appId: string,
  sub: string | undefined,
): Promise<Response> {
  const app = await ownedApp(env, auth.uid, appId);
  if (!app) return Response.json({ error: 'App not found' }, { status: 404 });
  const method = request.method;

  try {
    if (!sub) {
      if (method === 'GET') return Response.json(await readSkinIndex(env, auth.uid, appId));
      if (method === 'POST') {
        const body = await readJsonBody(request);
        if (body instanceof Response) return body;
        const skin = normalizeSkin(body.skin);
        const result = await saveSkin(env, auth.uid, appId, skin, { source: 'user', activate: body.activate !== false });
        return Response.json({ skinId: result.entry.id, entry: result.entry, active: result.index.active, previousActive: result.previousActive }, { status: 201 });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (sub === 'generate') {
      if (method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
      const body = await readJsonBody(request);
      if (body instanceof Response) return body;
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 1000) : '';
      if (prompt.length < 3) return Response.json({ error: 'Describe the look you want.' }, { status: 400 });
      const charge = async () => {
        const decision = await acquireAiRequest(env, auth.uid, { slot: false });
        return decision.allowed ? null : decision;
      };
      let denied;
      try {
        denied = await charge();
      } catch {
        return Response.json({ error: 'AI usage could not be verified right now. Please try again shortly.' }, { status: 503 });
      }
      if (denied) return Response.json({ error: denied.message }, { status: 429, headers: { 'Retry-After': String(denied.retryAfterSeconds) } });
      const parts = sanitizeParts(body.parts) ?? scanSkinParts(await loadAppSourceFiles(env, auth.uid, appId, app.r2Prefix));
      try {
        const { skin, textures } = await designSkin(env, {
          request: prompt,
          appName: app.name,
          parts,
          allowTexture: async () => {
            try { return !(await charge()); } catch { return false; }
          },
        });
        const result = await saveSkin(env, auth.uid, appId, skin, { source: 'assistant', activate: body.activate !== false });
        return Response.json({ skinId: result.entry.id, entry: result.entry, active: result.index.active, previousActive: result.previousActive, textures }, { status: 201 });
      } catch (error) {
        if (error instanceof SkinStoreError || error instanceof SkinValidationError) throw error;
        return Response.json({ error: `The skin could not be designed: ${legibleAiErrorMessage(error)}` }, { status: 502 });
      }
    }

    if (sub === 'active') {
      if (method === 'GET') {
        const index = await readSkinIndex(env, auth.uid, appId);
        const skin = index.active ? await readSkin(env, auth.uid, appId, index.active) : null;
        return Response.json({ skinId: skin ? index.active : null, skin });
      }
      if (method === 'PUT') {
        const body = await readJsonBody(request);
        if (body instanceof Response) return body;
        const skinId = body.skinId === null || body.skinId === 'none' ? null : body.skinId;
        if (skinId !== null && !isSkinId(skinId)) return Response.json({ error: 'skinId must be an installed skin id or null' }, { status: 400 });
        const { index, previousActive } = await setActiveSkin(env, auth.uid, appId, skinId);
        return Response.json({ active: index.active, previousActive });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (!isSkinId(sub)) return Response.json({ error: 'Not found' }, { status: 404 });
    if (method === 'GET') {
      const skin = await readSkin(env, auth.uid, appId, sub);
      return skin ? Response.json({ skinId: sub, skin }) : Response.json({ error: 'Skin not found' }, { status: 404 });
    }
    if (method === 'PUT') {
      const body = await readJsonBody(request);
      if (body instanceof Response) return body;
      const index = await readSkinIndex(env, auth.uid, appId);
      const entry = index.skins.find((candidate) => candidate.id === sub);
      if (!entry) return Response.json({ error: 'Skin not found' }, { status: 404 });
      const skin = normalizeSkin(body.skin);
      await env.ETERNALOS_FILES.put(`apps/${auth.uid}/${appId}/skins/${sub}.json`, JSON.stringify(skin), { httpMetadata: { contentType: 'application/json' } });
      entry.name = skin.name;
      entry.summary = summarizeSkin(skin);
      await env.ETERNALOS_FILES.put(`apps/${auth.uid}/${appId}/skins/index.json`, JSON.stringify(index), { httpMetadata: { contentType: 'application/json' } });
      return Response.json({ skinId: sub, entry });
    }
    if (method === 'DELETE') {
      const index = await deleteSkin(env, auth.uid, appId, sub);
      return Response.json(index);
    }
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET /api/apps/:appId/public-skin — the active skin of an app that is on
 * its owner's public desktop, for visitors. Anything else (private, trashed,
 * unknown) is a 404 so it says nothing about private apps.
 */
export async function handlePublicAppSkin(env: Env, appId: string): Promise<Response> {
  const notFound = () => Response.json({ error: 'Not found' }, { status: 404 });
  if (!appId || appId.length > 100) return notFound();
  const meta = await env.DESKTOP_KV.get<{ uid: string }>(`app:${appId}`, 'json');
  if (!meta?.uid) return notFound();
  const stub = env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(meta.uid));
  const itemsResponse = await stub.fetch(new Request('http://internal/items'));
  if (!itemsResponse.ok) return notFound();
  const items = (await itemsResponse.json() as { items: Array<{ type?: string; isPublic?: boolean; isTrashed?: boolean; appManifest?: { appId?: string } }> }).items;
  const isPublicApp = items.some((item) => item.type === 'app' && item.appManifest?.appId === appId && item.isPublic === true && !item.isTrashed);
  if (!isPublicApp) return notFound();
  const index = await readSkinIndex(env, meta.uid, appId);
  const skin = index.active ? await readSkin(env, meta.uid, appId, index.active) : null;
  return Response.json({ skin }, { headers: { 'cache-control': 'public, max-age=60' } });
}
