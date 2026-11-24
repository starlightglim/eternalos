// The assistant's changeAppearance tool offers wallpaper and font ids the
// frontend actually knows. Both lists live in the frontend; this fails when
// a wallpaper or font is added or renamed there but not in
// src/utils/appearanceOptions.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { WALLPAPER_IDS, FONT_IDS, describeAppearanceChanges } = await import('../src/utils/appearanceOptions.ts');

const frontend = (file) => fs.readFileSync(new URL(`../../frontend/src/${file}`, import.meta.url), 'utf8');

describe('appearance options match the frontend', () => {
  it('wallpaper ids match WALLPAPER_OPTIONS', () => {
    const block = frontend('components/desktop/Desktop.tsx').split('WALLPAPER_OPTIONS = [')[1].split('] as const')[0];
    const ids = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...WALLPAPER_IDS], ids);
  });

  it('font ids match FONT_CATALOG', () => {
    const block = frontend('utils/fontCatalog.ts').split('FONT_CATALOG: Record<string, FontEntry> = {')[1].split('\n};')[0];
    const ids = [...block.matchAll(/^\s+([A-Za-z0-9]+):\s+\{/gm)].map((m) => m[1]);
    assert.deepEqual([...FONT_IDS], ids);
  });

  it('describes changes in plain words', () => {
    assert.equal(
      describeAppearanceChanges({ accentColor: '#fff', fontSmoothing: true, customCSS: null }),
      'accent #fff, font smoothing on, removes the current custom theme CSS',
    );
  });
});
