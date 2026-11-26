/**
 * App skins: storage (R2, per app, removed with the app), the skin designer
 * (a model writes a style recipe; Workers AI paints textures) and the Ask
 * Eternal tools. REST routes live in routes/appSkins.ts.
 *
 * Storage: apps/{uid}/{appId}/skins/index.json  { active, skins[] }
 *          apps/{uid}/{appId}/skins/{skinId}.json  canonical AppSkin
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Env } from '../../index';
import {
  THEME_COLOR_NAMES,
  isSkinColor,
  UNIVERSAL_SKIN_PARTS,
  normalizeSkin,
  parseSkinImage,
  summarizeSkin,
  type AppSkin,
} from '../../utils/appSkin';
import { generateStructuredObject } from './appTools';

export const MAX_SKINS_PER_APP = 20;
const MAX_TEXTURES = 3;
const TEXTURE_TIMEOUT_MS = 60_000;
const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export type SkinSource = 'user' | 'assistant';

export interface SkinIndexEntry {
  id: string;
  name: string;
  createdAt: number;
  source: SkinSource;
  summary: ReturnType<typeof summarizeSkin>;
}

export interface SkinIndex {
  active: string | null;
  skins: SkinIndexEntry[];
}

export class SkinStoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SkinStoreError';
    this.status = status;
  }
}

const SKIN_ID_RE = /^[a-z0-9]{6,24}$/;
const skinsPrefix = (uid: string, appId: string) => `apps/${uid}/${appId}/skins`;

export function isSkinId(value: unknown): value is string {
  return typeof value === 'string' && SKIN_ID_RE.test(value);
}

/** The app's registry entry when `uid` owns it, else null. */
export async function ownedApp(env: Env, uid: string, appId: string): Promise<{ uid: string; r2Prefix?: string; name?: string } | null> {
  if (!appId || appId.length > 100) return null;
  const meta = await env.DESKTOP_KV.get<{ uid: string; r2Prefix?: string; name?: string }>(`app:${appId}`, 'json');
  return meta && meta.uid === uid ? meta : null;
}

export async function readSkinIndex(env: Env, uid: string, appId: string): Promise<SkinIndex> {
  const object = await env.ETERNALOS_FILES.get(`${skinsPrefix(uid, appId)}/index.json`);
  if (!object) return { active: null, skins: [] };
  try {
    const parsed = await object.json<SkinIndex>();
    const skins = Array.isArray(parsed.skins) ? parsed.skins.filter((entry) => isSkinId(entry?.id)) : [];
    const active = isSkinId(parsed.active) && skins.some((entry) => entry.id === parsed.active) ? parsed.active : null;
    return { active, skins };
  } catch {
    return { active: null, skins: [] };
  }
}

async function writeSkinIndex(env: Env, uid: string, appId: string, index: SkinIndex): Promise<void> {
  await env.ETERNALOS_FILES.put(`${skinsPrefix(uid, appId)}/index.json`, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function readSkin(env: Env, uid: string, appId: string, skinId: string): Promise<AppSkin | null> {
  if (!isSkinId(skinId)) return null;
  const object = await env.ETERNALOS_FILES.get(`${skinsPrefix(uid, appId)}/${skinId}.json`);
  if (!object) return null;
  try {
    // Stored skins were normalized on save; normalize again so an old or
    // hand-edited object can never reach an app unchecked.
    return normalizeSkin(await object.json());
  } catch {
    return null;
  }
}

export async function saveSkin(
  env: Env,
  uid: string,
  appId: string,
  skin: AppSkin,
  options: { source: SkinSource; activate: boolean },
): Promise<{ entry: SkinIndexEntry; index: SkinIndex; previousActive: string | null }> {
  const index = await readSkinIndex(env, uid, appId);
  if (index.skins.length >= MAX_SKINS_PER_APP) {
    throw new SkinStoreError(`This app already has ${MAX_SKINS_PER_APP} skins. Delete one first.`, 409);
  }
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.ETERNALOS_FILES.put(`${skinsPrefix(uid, appId)}/${id}.json`, JSON.stringify(skin), {
    httpMetadata: { contentType: 'application/json' },
  });
  const entry: SkinIndexEntry = { id, name: skin.name, createdAt: Date.now(), source: options.source, summary: summarizeSkin(skin) };
  const previousActive = index.active;
  const next: SkinIndex = { active: options.activate ? id : index.active, skins: [...index.skins, entry] };
  await writeSkinIndex(env, uid, appId, next);
  return { entry, index: next, previousActive };
}

export async function setActiveSkin(env: Env, uid: string, appId: string, skinId: string | null): Promise<{ index: SkinIndex; previousActive: string | null }> {
  const index = await readSkinIndex(env, uid, appId);
  if (skinId !== null && !index.skins.some((entry) => entry.id === skinId)) {
    throw new SkinStoreError('That skin is not installed for this app.', 404);
  }
  const previousActive = index.active;
  const next = { ...index, active: skinId };
  await writeSkinIndex(env, uid, appId, next);
  return { index: next, previousActive };
}

export async function deleteSkin(env: Env, uid: string, appId: string, skinId: string): Promise<SkinIndex> {
  const index = await readSkinIndex(env, uid, appId);
  if (!index.skins.some((entry) => entry.id === skinId)) throw new SkinStoreError('That skin is not installed for this app.', 404);
  await env.ETERNALOS_FILES.delete(`${skinsPrefix(uid, appId)}/${skinId}.json`);
  const next: SkinIndex = {
    active: index.active === skinId ? null : index.active,
    skins: index.skins.filter((entry) => entry.id !== skinId),
  };
  await writeSkinIndex(env, uid, appId, next);
  return next;
}

// ---------------------------------------------------------------------------
// Which parts does an app have?
// ---------------------------------------------------------------------------

export interface SkinPartInfo {
  name: string;
  label?: string;
  states?: string[];
  frames?: number;
  /** Size in px in the running app (when the Skins panel asked it). */
  w?: number;
  h?: number;
}

/** Skinnable parts named in an app's source (data-skin="…" in HTML or JS). */
export function scanSkinParts(files: Record<string, string>): SkinPartInfo[] {
  const found = new Map<string, SkinPartInfo>();
  const patterns = [
    /data-skin\s*=\s*["'`]([a-z0-9 -]{1,200})["'`]/g,
    /dataset\.skin\s*=\s*["'`]([a-z0-9 -]{1,200})["'`]/g,
    /setAttribute\(\s*["']data-skin["']\s*,\s*["'`]([a-z0-9 -]{1,200})["'`]/g,
  ];
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== 'string' || !/\.(html?|js|mjs|jsx|ts|tsx)$/i.test(path) || path === 'server.js' || path.startsWith('server/')) continue;
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        for (const name of match[1].split(/\s+/)) {
          if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || found.has(name) || (UNIVERSAL_SKIN_PARTS as readonly string[]).includes(name)) continue;
          // Nearby hints on the same tag (HTML only).
          const tagStart = text.lastIndexOf('<', match.index ?? 0);
          const tagEnd = text.indexOf('>', match.index ?? 0);
          const tag = tagStart >= 0 && tagEnd > tagStart && tagEnd - tagStart < 600 ? text.slice(tagStart, tagEnd) : '';
          const info: SkinPartInfo = { name };
          const label = /data-skin-label\s*=\s*["']([^"']{1,40})["']/.exec(tag)?.[1];
          if (label) info.label = label;
          const frames = Number(/data-skin-frames\s*=\s*["'](\d{1,2})["']/.exec(tag)?.[1]);
          if (frames >= 2 && frames <= 64) info.frames = frames;
          if (/^<button\b/i.test(tag)) info.states = ['normal', 'hover', 'pressed', 'disabled'];
          found.set(name, info);
          if (found.size >= 80) return [...found.values()];
        }
      }
    }
  }
  return [...found.values()];
}

export async function loadAppSourceFiles(env: Env, uid: string, appId: string, r2Prefix?: string): Promise<Record<string, string>> {
  const object = await env.ETERNALOS_FILES.get(`${r2Prefix || `apps/${uid}/${appId}`}/source.json`);
  if (!object) return {};
  try {
    const parsed = await object.json<Record<string, unknown>>();
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Skin designer
// ---------------------------------------------------------------------------

const styleSchema = z.object({
  background: z.string().optional().describe('Fill color'),
  gradient: z.object({ from: z.string(), to: z.string(), angle: z.number().optional() }).optional(),
  texture: z.string().optional().describe('Key of a texture from "textures", drawn under the gradient'),
  textureSize: z.number().optional().describe('Tile size in px, 64-512'),
  border: z.object({ width: z.number().optional(), color: z.string().optional(), style: z.string().optional() }).optional(),
  radius: z.number().optional(),
  bevel: z.enum(['raised', 'sunken', 'flat']).optional(),
  text: z.string().optional().describe('Text color'),
  font: z.string().optional().describe('System font list only'),
  weight: z.enum(['normal', 'bold']).optional(),
  shadow: z.enum(['none', 'soft', 'hard']).optional(),
});

const recipeSchema = z.object({
  name: z.string().describe('Short skin name, 1-4 words'),
  description: z.string().optional(),
  colors: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  fonts: z.object({ body: z.string().optional(), title: z.string().optional(), mono: z.string().optional() }).optional(),
  textures: z.array(z.object({ key: z.string(), prompt: z.string() })).optional(),
  window: z.object({
    shape: z.enum(['rect', 'rounded', 'pill', 'ellipse', 'polygon']).describe('rect = normal window'),
    radius: z.number().optional().describe('rounded: corner radius in px'),
    points: z.array(z.array(z.number())).optional().describe('polygon: [x%, y%] points, 0-100'),
    frameless: z.boolean().describe('Hide the desktop title bar and frame; the skin draws the whole window'),
    drag: z.array(z.string()).optional().describe('Parts that drag a frameless window; "app" = any empty area'),
    close: z.string().optional().describe('A part that closes the window when clicked'),
    size: z.object({ w: z.number(), h: z.number() }).optional().describe('Window size in px the design is made for'),
    content: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("Where the app's own content (text, lists, readouts) shows, percent of the window — the object's screen"),
    face: z.string().optional().describe('Image prompt for the whole window face: the object seen straight on, no text'),
  }).optional().describe('Only when the user asks about the window shape or a frameless/Winamp-style window'),
  parts: z.array(z.object({
    part: z.string(),
    place: z.object({ x: z.number(), y: z.number() }).optional().describe("Center of this control in percent of the window (shaped designs: put every app control inside the shape)"),
    style: styleSchema.optional(),
    hover: styleSchema.optional(),
    pressed: styleSchema.optional(),
    active: styleSchema.optional(),
    disabled: styleSchema.optional(),
  })),
});

type SkinRecipe = z.infer<typeof recipeSchema>;

const DESIGNER_SYSTEM_PROMPT = `You design skins for EternalOS desktop apps, like Winamp skins. A skin restyles an app's parts without changing its code or layout.

Universal parts every app has:
- app: the whole app background and default text/font
- button: every button (give hover, pressed and disabled looks)
- field: text inputs, text areas and dropdowns
- link: links
- heading: h1-h3 headings
- scrollbar: style.background = track color, style.text = thumb color
Plus the app's own parts (listed in the request); style those that matter.

Each part has a style (and optional hover/pressed/active/disabled styles with only what changes):
background (color), gradient {from, to, angle}, texture (a texture key) + textureSize, border {width 0-8, color, style solid|dashed|dotted|double|groove|ridge|inset|outset}, radius 0-64, bevel raised|sunken|flat, text (color), font, weight normal|bold, shadow none|soft|hard.

Colors: plain CSS colors only (#hex, rgb(), rgba(), hsl()). Also set theme colors by name so apps that use them follow along: ${THEME_COLOR_NAMES.join(', ')}. Text must stay readable: strong contrast between text and its background.

Fonts: system fonts only (apps cannot load web fonts), e.g. Georgia, "Times New Roman", "Courier New", Verdana, Tahoma, "Trebuchet MS", Impact, "Comic Sans MS", system-ui, serif, sans-serif, monospace. Always end with a generic family.

Textures: up to ${MAX_TEXTURES} generated images for materials the request asks for (brushed metal, wood, marble, paper, fabric, stone, carbon fiber...). Each prompt describes one seamless material up close, no objects or text. Use a texture on the app background or big panels (textureSize 128-512), never behind small text without a solid or semi-transparent background on top. Skip textures when the request is only about colors.

Shaped windows (only when the user asks for a shaped, round, frameless, hardware-like or Winamp-style window) — design a physical object, like a great Winamp skin:
- window.shape: rounded (radius), pill, ellipse or polygon ([x%, y%] points); frameless true hides the desktop title bar (drag ["app"] lets empty areas move it; the desktop keeps a small name tab with a close button).
- window.size: the window size in px the design is made for (e.g. 420x420 for a round player).
- window.face: an image prompt for the whole front of the object seen straight on (brushed-metal disc, walnut radio front, translucent plastic Game Boy shell...). It fills the window and is cut by the shape. No text, no labels, no real buttons in the art — the app's controls sit on top.
- window.content: the box (percent of the window) where the app's own content shows — the object's screen or display. Keep it fully inside the shape (for an ellipse, inside x 18-82, y 18-82).
- parts[].place {x, y}: center of each of the app's own controls in percent of the window. Lay them out like real hardware: transport buttons in a row below the screen, knobs around it, nothing overlapping the content box, every control at least 10% from the shape's edge (for an ellipse keep (x-50)²+(y-50)² ≤ 1100). Use the control sizes given to space them.
- Style the controls so they belong on the face (bevels, metal, glossy plastic) and make the content box readable (a dark LCD, a paper card...).

Make it cohesive and striking: commit to the requested look on every universal part.`;

export interface DesignSkinInput {
  request: string;
  appName?: string;
  parts: SkinPartInfo[];
  /** Charge each texture against the account's AI budget; false = skip textures. */
  allowTexture?: () => Promise<boolean>;
}

function recipeToSkin(recipe: SkinRecipe, textureData: Record<string, string>): Record<string, unknown> {
  const style = (raw?: z.infer<typeof styleSchema>) => {
    if (!raw) return undefined;
    const { texture, textureSize, ...rest } = raw;
    return {
      ...rest,
      // Generated images rarely tile cleanly: the runtime blends the edges.
      ...(texture && textureData[texture] ? { texture: { asset: texture, size: textureSize, blend: true } } : {}),
    };
  };
  const parts: Record<string, unknown> = {};
  for (const entry of recipe.parts.slice(0, 80)) {
    const name = String(entry.part ?? '').trim().toLowerCase();
    parts[name] = {
      ...(entry.place && !(UNIVERSAL_SKIN_PARTS as readonly string[]).includes(name) ? { place: { x: entry.place.x, y: entry.place.y } } : {}),
      style: style(entry.style),
      states: {
        hover: style(entry.hover),
        pressed: style(entry.pressed),
        active: style(entry.active),
        disabled: style(entry.disabled),
      },
    };
  }
  const colors: Record<string, string> = Object.fromEntries((recipe.colors ?? []).map((color) => [String(color.name).trim().toLowerCase(), color.value]));
  // Apps that use the --eternal-* theme variables should follow the skin
  // too: fill missing theme colors from the part styles.
  const partStyle = (name: string) => recipe.parts.find((entry) => String(entry.part).trim().toLowerCase() === name)?.style;
  const derived: Record<string, string | undefined> = {
    bg: partStyle('app')?.background,
    surface: partStyle('field')?.background ?? partStyle('app')?.background,
    text: partStyle('app')?.text,
    'control-bg': partStyle('button')?.background ?? partStyle('button')?.gradient?.from,
    'control-text': partStyle('button')?.text,
    'control-border': partStyle('button')?.border?.color,
    border: partStyle('field')?.border?.color ?? partStyle('button')?.border?.color,
    accent: partStyle('link')?.text,
  };
  for (const [name, value] of Object.entries(derived)) {
    if (value && !colors[name] && isSkinColor(value)) colors[name] = value;
  }
  let window: Record<string, unknown> | undefined;
  if (recipe.window && (recipe.window.shape !== 'rect' || recipe.window.frameless || recipe.window.content || textureData['window-face'])) {
    const w = recipe.window!;
    const shape = w.shape === 'rounded' ? { type: 'rounded', radius: w.radius ?? 28 }
      : w.shape === 'pill' ? { type: 'rounded', radius: 400 }
      : w.shape === 'ellipse' ? { type: 'ellipse' }
      : w.shape === 'polygon' && Array.isArray(w.points) && w.points.length >= 3 ? { type: 'polygon', points: w.points.map((point) => [Number(point[0]), Number(point[1])]) }
      : undefined;
    window = {
      frameless: w.frameless === true,
      ...(shape ? { shape } : {}),
      // A frameless window must be movable: empty areas drag it by default.
      ...(w.frameless ? { drag: w.drag?.length ? w.drag.map((part) => String(part).trim().toLowerCase()) : ['app'] } : {}),
      ...(w.close ? { close: String(w.close).trim().toLowerCase() } : {}),
      ...(w.size ? { size: { w: Math.round(w.size.w), h: Math.round(w.size.h) } } : {}),
      ...(w.content ? { content: w.content } : {}),
      ...(textureData['window-face'] ? { face: { asset: 'window-face' } } : {}),
    };
  }
  return {
    name: recipe.name,
    description: recipe.description,
    author: 'Ask Eternal',
    ...(window ? { window } : {}),
    colors,
    fonts: {
      ...(recipe.fonts?.body ? { font: recipe.fonts.body } : {}),
      ...(recipe.fonts?.title ? { 'font-title': recipe.fonts.title } : {}),
      ...(recipe.fonts?.mono ? { 'font-mono': recipe.fonts.mono } : {}),
    },
    parts,
    assets: textureData,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One seamless texture from Workers AI, as a checked image data URL (or null). */
export async function generateTexture(env: Env, prompt: string): Promise<string | null> {
  const model = env.IMAGE_GEN_MODEL?.startsWith('@cf/') ? env.IMAGE_GEN_MODEL : DEFAULT_IMAGE_MODEL;
  try {
    const result = await withTimeout(
      (env.AI.run as (model: string, input: Record<string, unknown>) => Promise<unknown>)(model, {
        prompt: `${prompt.slice(0, 400)}. Seamless tileable texture, close-up, top-down view, flat even lighting, fills the whole frame, no text, no border, no objects.`,
        steps: 6,
      }),
      TEXTURE_TIMEOUT_MS,
    ) as { image?: unknown };
    if (typeof result?.image !== 'string') return null;
    const image = parseSkinImage(`data:image/jpeg;base64,${result.image}`);
    return 'error' in image ? null : image.data;
  } catch (error) {
    console.warn('[skins] texture generation failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** The whole window face for a shaped design (not tiled). */
export async function generateFace(env: Env, prompt: string): Promise<string | null> {
  const model = env.IMAGE_GEN_MODEL?.startsWith('@cf/') ? env.IMAGE_GEN_MODEL : DEFAULT_IMAGE_MODEL;
  try {
    const result = await withTimeout(
      (env.AI.run as (model: string, input: Record<string, unknown>) => Promise<unknown>)(model, {
        prompt: `${prompt.slice(0, 400)}. Straight-on front view of a single object that fills the entire square frame and touches all four edges, centered, symmetrical, product render, soft studio lighting, no text, no letters, no labels, no people, no white or empty background.`,
        steps: 6,
      }),
      TEXTURE_TIMEOUT_MS,
    ) as { image?: unknown };
    if (typeof result?.image !== 'string') return null;
    const image = parseSkinImage(`data:image/jpeg;base64,${result.image}`);
    return 'error' in image ? null : image.data;
  } catch (error) {
    console.warn('[skins] face generation failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Design a skin from a description: recipe from the model, textures from the image model. */
export async function designSkin(env: Env, input: DesignSkinInput): Promise<{ skin: AppSkin; textures: number }> {
  const partsList = input.parts.length > 0
    ? input.parts.map((part) => `- ${part.name}${part.label && part.label !== part.name ? ` (${part.label})` : ''}${part.w && part.h ? `, ${part.w}x${part.h}px` : ''}${part.frames ? `, ${part.frames} frames` : ''}`).join('\n')
    : '(none: style the universal parts)';
  const recipe = await generateStructuredObject(
    env,
    recipeSchema,
    DESIGNER_SYSTEM_PROMPT,
    `Design a skin${input.appName ? ` for the app "${input.appName}"` : ''}.

Request: ${input.request.slice(0, 1000)}

The app's own parts:
${partsList}`,
    'Designing skin',
    120_000,
  );

  const textureData: Record<string, string> = {};
  const wanted = (recipe.textures ?? [])
    .map((texture) => ({ key: String(texture.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40), prompt: String(texture.prompt ?? '') }))
    .filter((texture) => /^[a-z0-9]/.test(texture.key) && texture.prompt.trim())
    .slice(0, MAX_TEXTURES);
  // Texture keys in part styles use the same cleanup.
  for (const part of recipe.parts) {
    for (const key of ['style', 'hover', 'pressed', 'active', 'disabled'] as const) {
      const style = part[key];
      if (style?.texture) style.texture = style.texture.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    }
  }
  const allowed: typeof wanted = [];
  for (const texture of wanted) {
    if (!input.allowTexture || await input.allowTexture()) allowed.push(texture);
  }
  const facePrompt = recipe.window?.face?.trim();
  const wantFace = Boolean(facePrompt) && (!input.allowTexture || await input.allowTexture());
  const [images, face] = await Promise.all([
    Promise.all(allowed.map((texture) => generateTexture(env, texture.prompt))),
    wantFace ? generateFace(env, facePrompt!) : Promise.resolve(null),
  ]);
  allowed.forEach((texture, i) => { if (images[i]) textureData[texture.key] = images[i]!; });
  if (face) textureData['window-face'] = face;

  const skin = normalizeSkin(recipeToSkin(recipe, textureData), { lenient: true });
  return { skin, textures: Object.keys(skin.assets).length };
}

// ---------------------------------------------------------------------------
// Ask Eternal tools
// ---------------------------------------------------------------------------

export interface SkinToolsContext {
  env: Env;
  uid: string;
  /** Charge one AI request (a texture) to the account; false when over budget. */
  chargeAiRequest?: () => Promise<boolean>;
}

export function createSkinTools(ctx: SkinToolsContext) {
  return {
    designAppSkin: tool({
      description:
        'Make a new skin for one of the user\'s apps from a description ("make my music app look like brushed metal", "give Tally a cozy wood look", "make my player a round frameless window like Winamp") and switch the app to it. A skin restyles the app (colors, fonts, gradients, bevels, borders, up to 3 AI-generated textures, and optionally a shaped, frameless window) without touching its code or data; the previous look stays one click away. Get the appId from listApps first.',
      inputSchema: z.object({
        appId: z.string().min(1).max(100),
        request: z.string().min(3).max(1000).describe('The look the user asked for, in their words plus any details'),
      }),
      execute: async ({ appId, request }) => {
        const app = await ownedApp(ctx.env, ctx.uid, appId);
        if (!app) return { ok: false as const, error: 'No app with that id belongs to this user. Call listApps to get the right appId.' };
        const files = await loadAppSourceFiles(ctx.env, ctx.uid, appId, app.r2Prefix);
        try {
          const { skin, textures } = await designSkin(ctx.env, {
            request,
            appName: app.name,
            parts: scanSkinParts(files),
            allowTexture: ctx.chargeAiRequest,
          });
          const { entry, previousActive } = await saveSkin(ctx.env, ctx.uid, appId, skin, { source: 'assistant', activate: true });
          return {
            ok: true as const,
            appId,
            skinId: entry.id,
            name: skin.name,
            description: skin.description,
            previousSkinId: previousActive,
            parts: entry.summary.parts,
            texturesGenerated: textures,
            note: 'The skin is applied to open windows of this app. The user can switch back in the app\'s Skins panel (right-click the title bar) or ask you to.',
          };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : 'The skin could not be made.' };
        }
      },
    }),
    useAppSkin: tool({
      description: 'Switch one of the user\'s apps to an installed skin, or back to its own look with skinId "none". Lists the app\'s skins when skinId is omitted.',
      inputSchema: z.object({
        appId: z.string().min(1).max(100),
        skinId: z.string().max(40).optional().describe('An installed skin id, or "none" for the app\'s own look; omit to list skins'),
      }),
      execute: async ({ appId, skinId }) => {
        const app = await ownedApp(ctx.env, ctx.uid, appId);
        if (!app) return { ok: false as const, error: 'No app with that id belongs to this user. Call listApps to get the right appId.' };
        if (skinId === undefined) {
          const index = await readSkinIndex(ctx.env, ctx.uid, appId);
          return { ok: true as const, appId, active: index.active, skins: index.skins.map((entry) => ({ id: entry.id, name: entry.name, source: entry.source })) };
        }
        try {
          const { index, previousActive } = await setActiveSkin(ctx.env, ctx.uid, appId, skinId === 'none' ? null : skinId);
          return { ok: true as const, appId, skinId: index.active, previousSkinId: previousActive, name: index.skins.find((entry) => entry.id === index.active)?.name ?? null };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : 'Could not switch skins.' };
        }
      },
    }),
  };
}
