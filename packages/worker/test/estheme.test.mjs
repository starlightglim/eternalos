/**
 * Unit tests for the worker-side .estheme manifest mirror
 * (src/utils/estheme.ts).
 *
 * These run in plain Node (type-stripped TS import, no wrangler — same
 * technique as intent.test.mjs). They exist to pin the PARTIAL-slot-map
 * semantics of the cursors/sounds/icons layers across zod majors:
 *
 * On zod 3, `z.record(z.enum(...), v)` was already partial (missing keys
 * allowed). On zod 4, `z.record(z.enum(...), v)` became EXHAUSTIVE (every
 * enum key required), so the mirror must spell those layers
 * `z.partialRecord(...)`. If a future edit regresses that (or a zod upgrade
 * changes record semantics again), the "overrides only some slots" cases
 * below fail loudly instead of silently rejecting valid themes — the exact
 * bug the frontend mirror hit when it moved to zod 4 first.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasAnyLayer,
  validateManifest,
  validateManifestAgainstFiles,
} from '../src/utils/estheme.ts';

/** A minimal valid manifest, layers swapped per test. */
function manifestWithLayers(layers) {
  return {
    formatVersion: 1,
    id: 'partial-slots-theme',
    name: 'Partial Slots',
    version: '1.0.0',
    author: '@themist',
    layers,
  };
}

describe('estheme manifest mirror (worker, zod 4)', () => {
  describe('partial slot maps (the zod 4 record(enum) trap)', () => {
    it('accepts a cursors layer overriding only some cursor states', () => {
      // 2 of the 8 CURSOR_STATES — exhaustive record would demand all 8.
      const result = validateManifest(manifestWithLayers({
        cursors: { default: 'cursors/default.png', text: 'cursors/text.png' },
      }));
      assert.ok(result.ok, `partial cursors layer must validate: ${JSON.stringify(result.ok ? null : result.errors)}`);
    });

    it('accepts a sounds layer overriding only some events', () => {
      const result = validateManifest(manifestWithLayers({
        sounds: { click: 'sounds/click.mp3' },
      }));
      assert.ok(result.ok, `partial sounds layer must validate: ${JSON.stringify(result.ok ? null : result.errors)}`);
    });

    it('accepts an icons layer overriding only some slots', () => {
      const result = validateManifest(manifestWithLayers({
        icons: { folder: 'icons/folder.svg', app: 'icons/app.svg' },
      }));
      assert.ok(result.ok, `partial icons layer must validate: ${JSON.stringify(result.ok ? null : result.errors)}`);
    });

    it('still accepts a layer overriding every slot (full maps unchanged)', () => {
      const result = validateManifest(manifestWithLayers({
        cursors: {
          default: 'cursors/default.png',
          pointer: 'cursors/pointer.png',
          grab: 'cursors/grab.png',
          grabbing: 'cursors/grabbing.png',
          text: 'cursors/text.png',
          wait: 'cursors/wait.png',
          move: 'cursors/move.png',
          'nwse-resize': 'cursors/nwse-resize.png',
        },
      }));
      assert.ok(result.ok, `full cursors layer must validate: ${JSON.stringify(result.ok ? null : result.errors)}`);
    });

    it('rejects unknown slot keys instead of silently dropping them', () => {
      const result = validateManifest(manifestWithLayers({
        cursors: { spinning: 'cursors/spin.png' },
      }));
      assert.ok(!result.ok, 'an unknown cursor state must be rejected');
      assert.ok(
        result.errors.some((error) => error.path.startsWith('layers.cursors')),
        `error should name the cursors layer: ${JSON.stringify(result.errors)}`,
      );
    });

    it('rejects a declared-but-empty slot layer (the refine survives the migration)', () => {
      const result = validateManifest(manifestWithLayers({ cursors: {} }));
      assert.ok(!result.ok, 'an empty cursors layer must be rejected');
      assert.ok(
        result.errors.some((error) => error.message.includes('cursors layer declared but empty')),
        `error should name the empty-layer rule: ${JSON.stringify(result.errors)}`,
      );
    });
  });

  describe('cross-checks against the bundle file index', () => {
    it('checks the declared files of a partial layer, per overridden slot', () => {
      const manifest = manifestWithLayers({
        cursors: { default: 'cursors/default.png', text: 'cursors/text.png' },
      });

      const complete = validateManifestAgainstFiles(manifest, new Set([
        'cursors/default.png',
        'cursors/text.png',
      ]));
      assert.ok(complete.ok, `all declared cursor files present: ${JSON.stringify(complete.ok ? null : complete.errors)}`);

      const missing = validateManifestAgainstFiles(manifest, new Set(['cursors/default.png']));
      assert.ok(!missing.ok, 'a missing declared file must fail the cross-check');
      assert.ok(
        missing.errors.some((error) => error.path === 'layers.cursors.text'),
        `the missing slot should be named: ${JSON.stringify(missing.errors)}`,
      );
    });

    it('hasAnyLayer still sees partial slot layers as meaningful', () => {
      const result = validateManifest(manifestWithLayers({
        icons: { folder: 'icons/folder.svg' },
      }));
      assert.ok(result.ok);
      assert.equal(hasAnyLayer(result.manifest), true);
    });
  });
});
