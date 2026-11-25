/**
 * Gathers live desktop facts for bar modules, conky text and the fetch card
 * (utils/riceInfo.ts). Ticks every second when the display needs it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppearanceStore } from '../stores/appearanceStore';
import { useAuthStore } from '../stores/authStore';
import { useDesktopStore } from '../stores/desktopStore';
import { useWindowStore } from '../stores/windowStore';
import { describeAgent, type RiceFacts } from '../utils/riceInfo';
import { tilingFromTokens } from '../utils/tiling';

const STARTED_AT = Date.now();

interface BatteryLike { level: number; charging: boolean; addEventListener: (type: string, cb: () => void) => void; removeEventListener: (type: string, cb: () => void) => void }

export function useRiceInfo(options: { tickSeconds?: boolean; clockFormat?: RiceFacts['clockFormat'] } = {}): RiceFacts {
  const [now, setNow] = useState(() => new Date());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [battery, setBattery] = useState<RiceFacts['battery']>(null);
  const appearance = useAppearanceStore((state) => state.appearance);
  const username = useAuthStore((state) => state.user?.username ?? state.profile?.username ?? 'guest');
  const wallpaper = useAuthStore((state) => state.profile?.wallpaper ?? 'default');
  const windows = useWindowStore((state) => state.windows);
  const items = useDesktopStore((state) => state.items);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), options.tickSeconds ? 1000 : 15000);
    return () => clearInterval(timer);
  }, [options.tickSeconds]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    let manager: BatteryLike | null = null;
    const update = () => { if (manager) setBattery({ level: manager.level, charging: manager.charging }); };
    if (typeof navigator === 'undefined') return;
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
    if (!getBattery) return;
    getBattery.call(navigator).then((m) => {
      manager = m;
      update();
      m.addEventListener('levelchange', update);
      m.addEventListener('chargingchange', update);
    }).catch(() => {});
    return () => {
      manager?.removeEventListener('levelchange', update);
      manager?.removeEventListener('chargingchange', update);
    };
  }, []);

  return useMemo(() => {
    const tokens = appearance.designTokens;
    const visible = windows.filter((w) => !w.minimized);
    const top = [...visible].sort((a, b) => b.zIndex - a.zIndex)[0];
    const nav = (typeof navigator === 'undefined' ? {} : navigator) as Partial<Navigator> & { deviceMemory?: number };
    const agent = describeAgent(nav.userAgent ?? '', nav.platform ?? '');
    const screen = typeof window !== 'undefined' && window.screen ? `${window.screen.width}x${window.screen.height}` : 'unknown';
    return {
      now,
      startedAt: STARTED_AT,
      user: username,
      theme: typeof tokens?.['rice.name'] === 'string' ? String(tokens['rice.name']) : 'custom',
      layout: tilingFromTokens(tokens).mode,
      windows: visible.length,
      activeWindow: top?.title ?? 'desktop',
      apps: items.filter((item) => item.type === 'app' && !item.isTrashed).length,
      items: items.filter((item) => !item.isTrashed).length,
      font: (appearance.systemFont ?? 'Chicago').split(',')[0].replace(/['"]/g, ''),
      accent: appearance.accentColor ?? '#000080',
      wallpaper: wallpaper.startsWith('custom:') ? 'custom image' : wallpaper,
      online,
      battery,
      cores: nav.hardwareConcurrency || null,
      memoryGb: nav.deviceMemory ?? null,
      screen,
      browser: agent.browser,
      os: agent.os,
      clockFormat: options.clockFormat ?? '12h',
    };
  }, [now, appearance, username, wallpaper, windows, items, online, battery, options.clockFormat]);
}
