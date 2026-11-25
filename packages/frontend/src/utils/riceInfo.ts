/**
 * Live facts about the desktop for bar modules, conky-style desktop text and
 * the fetch card: {time}, {date}, {user}, {layout}, {windows}, {uptime}...
 * Pure formatting; useRiceInfo (hooks/useRiceInfo.ts) gathers the inputs.
 */

import type { TilingMode } from './tiling';

export interface RiceFacts {
  now: Date;
  startedAt: number;
  user: string;
  theme: string;
  layout: TilingMode;
  windows: number;
  activeWindow: string;
  apps: number;
  items: number;
  font: string;
  accent: string;
  wallpaper: string;
  online: boolean;
  battery: { level: number; charging: boolean } | null;
  cores: number | null;
  memoryGb: number | null;
  screen: string;
  browser: string;
  os: string;
  clockFormat: '12h' | '24h' | 'seconds';
}

/** dwm-style layout symbols. */
export const LAYOUT_SYMBOLS: Record<TilingMode, string> = {
  floating: '><>',
  master: '[]=',
  columns: '|||',
  grid: '###',
};

export function formatClock(now: Date, format: RiceFacts['clockFormat']): string {
  const h24 = now.getHours();
  const mm = String(now.getMinutes()).padStart(2, '0');
  if (format === '24h') return `${String(h24).padStart(2, '0')}:${mm}`;
  if (format === 'seconds') return `${String(h24).padStart(2, '0')}:${mm}:${String(now.getSeconds()).padStart(2, '0')}`;
  const h = h24 % 12 || 12;
  return `${h}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function formatUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function formatDate(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Browser and OS names from the user agent (rough, for display only). */
export function describeAgent(userAgent: string, platform = ''): { browser: string; os: string } {
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) || /Mac/.test(platform) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /CrOS/.test(ua) ? 'ChromeOS' : 'Unknown OS';
  return { browser, os };
}

/** Values for every {placeholder}. */
export function riceValues(facts: RiceFacts): Record<string, string> {
  return {
    time: formatClock(facts.now, facts.clockFormat),
    date: formatDate(facts.now),
    user: facts.user,
    host: 'eternalos',
    theme: facts.theme,
    layout: `${LAYOUT_SYMBOLS[facts.layout]} ${facts.layout}`,
    windows: String(facts.windows),
    window: facts.activeWindow,
    apps: String(facts.apps),
    items: String(facts.items),
    font: facts.font,
    accent: facts.accent,
    wallpaper: facts.wallpaper,
    uptime: formatUptime(facts.now.getTime() - facts.startedAt),
    online: facts.online ? 'online' : 'offline',
    battery: facts.battery ? `${Math.round(facts.battery.level * 100)}%${facts.battery.charging ? ' ⚡' : ''}` : 'n/a',
    cores: facts.cores ? String(facts.cores) : 'n/a',
    memory: facts.memoryGb ? `${facts.memoryGb} GB` : 'n/a',
    screen: facts.screen,
    browser: facts.browser,
    os: facts.os,
  };
}

export const RICE_PLACEHOLDERS = ['time', 'date', 'user', 'theme', 'layout', 'windows', 'window', 'apps', 'items', 'font', 'accent', 'wallpaper', 'uptime', 'online', 'battery', 'cores', 'memory', 'screen', 'browser', 'os'];

/** Fill {placeholders} in a template; unknown ones are left as typed. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

// ---------------------------------------------------------------------------
// Bar settings (design tokens)
// ---------------------------------------------------------------------------

export const BAR_MODULES = ['layout', 'window', 'windows', 'text', 'online', 'battery', 'cores', 'uptime', 'date', 'clock', 'bazaar'] as const;
export type BarModule = (typeof BAR_MODULES)[number];

export interface BarSettings {
  modules: BarModule[];
  style: 'classic' | 'floating' | 'transparent';
  clockFormat: RiceFacts['clockFormat'];
  text: string;
}

export interface ConkySettings {
  enabled: boolean;
  text: string;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  size: number;
}

export const DEFAULT_CONKY_TEXT = '{time}\n{date}\n\n{user}@eternalos\nlayout  {layout}\nwindows {windows}\nuptime  {uptime}';

export function barFromTokens(tokens: Record<string, unknown> | undefined): BarSettings {
  const raw = typeof tokens?.['bar.modules'] === 'string' ? (tokens['bar.modules'] as string) : 'bazaar,clock';
  const modules = raw.split(',').map((m) => m.trim()).filter((m): m is BarModule => (BAR_MODULES as readonly string[]).includes(m));
  const style = tokens?.['bar.style'];
  const clock = tokens?.['bar.clockFormat'];
  return {
    modules: [...new Set(modules)],
    style: style === 'floating' || style === 'transparent' ? style : 'classic',
    clockFormat: clock === '24h' || clock === 'seconds' ? clock : '12h',
    text: typeof tokens?.['bar.text'] === 'string' ? String(tokens['bar.text']).slice(0, 80) : '',
  };
}

export function conkyFromTokens(tokens: Record<string, unknown> | undefined): ConkySettings {
  const position = tokens?.['conky.position'];
  const size = Number(tokens?.['conky.size']);
  return {
    enabled: tokens?.['conky.enabled'] === true,
    text: typeof tokens?.['conky.text'] === 'string' ? String(tokens['conky.text']).slice(0, 500) : DEFAULT_CONKY_TEXT,
    position: position === 'top-left' || position === 'bottom-left' || position === 'bottom-right' || position === 'center' ? position : 'top-right',
    size: Number.isFinite(size) ? Math.min(72, Math.max(9, Math.round(size))) : 14,
  };
}
