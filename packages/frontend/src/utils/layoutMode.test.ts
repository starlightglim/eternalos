import { describe, expect, test } from 'vitest';
import { decideMobileLayout, LAYOUT_HYSTERESIS, MOBILE_BREAKPOINT } from './layoutMode';

const desk = { height: 900, coarsePointer: false };

describe('decideMobileLayout', () => {
  test('first decision uses the plain breakpoint', () => {
    expect(decideMobileLayout({ ...desk, width: MOBILE_BREAKPOINT - 1 })).toBe(true);
    expect(decideMobileLayout({ ...desk, width: MOBILE_BREAKPOINT })).toBe(false);
  });

  test('a small resize near the breakpoint does not flip the layout', () => {
    // Desktop shrinking just under 768 stays desktop…
    expect(decideMobileLayout({ ...desk, width: MOBILE_BREAKPOINT - 10, previous: false })).toBe(false);
    // …and mobile growing just over 768 stays mobile.
    expect(decideMobileLayout({ ...desk, width: MOBILE_BREAKPOINT + 10, previous: true })).toBe(true);
  });

  test('a clear move past the breakpoint does flip it', () => {
    expect(decideMobileLayout({ ...desk, width: MOBILE_BREAKPOINT - LAYOUT_HYSTERESIS - 1, previous: false })).toBe(true);
    expect(decideMobileLayout({ ...desk, width: MOBILE_BREAKPOINT + LAYOUT_HYSTERESIS, previous: true })).toBe(false);
  });

  test('a phone stays mobile when rotated to landscape', () => {
    expect(decideMobileLayout({ width: 932, height: 430, coarsePointer: true, previous: true })).toBe(true);
    expect(decideMobileLayout({ width: 932, height: 430, coarsePointer: true })).toBe(true);
  });

  test('a tablet follows the width rules', () => {
    expect(decideMobileLayout({ width: 1024, height: 768, coarsePointer: true })).toBe(false);
  });
});
