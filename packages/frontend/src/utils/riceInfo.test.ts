import { describe, expect, test } from 'vitest';
import { barFromTokens, conkyFromTokens, describeAgent, fillTemplate, formatClock, formatUptime } from './riceInfo';

describe('rice info', () => {
  test('clocks, uptime and agents', () => {
    const t = new Date(2026, 10, 25, 21, 5, 9);
    expect(formatClock(t, '12h')).toBe('9:05 PM');
    expect(formatClock(t, '24h')).toBe('21:05');
    expect(formatClock(t, 'seconds')).toBe('21:05:09');
    expect(formatUptime(65 * 60_000)).toBe('1h 5m');
    expect(formatUptime(26 * 3_600_000)).toBe('1d 2h');
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36')).toEqual({ browser: 'Chrome', os: 'macOS' });
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toEqual({ browser: 'Firefox', os: 'Linux' });
  });

  test('templates fill known placeholders and leave others', () => {
    expect(fillTemplate('{user}@eternalos {nope} {time}', { user: 'ana', time: '9:05' })).toBe('ana@eternalos {nope} 9:05');
  });

  test('bar and conky settings are sanitized', () => {
    expect(barFromTokens(undefined)).toEqual({ modules: ['bazaar', 'clock'], style: 'classic', clockFormat: '12h', text: '' });
    expect(barFromTokens({ 'bar.modules': 'layout, evil ,clock,layout', 'bar.style': 'floating', 'bar.clockFormat': 'seconds' }).modules).toEqual(['layout', 'clock']);
    const conky = conkyFromTokens({ 'conky.enabled': true, 'conky.size': 500, 'conky.position': 'nowhere' });
    expect(conky).toMatchObject({ enabled: true, size: 72, position: 'top-right' });
    expect(conkyFromTokens({}).enabled).toBe(false);
  });
});
