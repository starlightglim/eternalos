/**
 * .estheme preview session — the Keep / Revert flow behind theme import.
 *
 * Importing a theme (drag-drop onto the desktop, or the Appearance panel's
 * file picker) applies it as an UNSAVED PREVIEW of the live desktop:
 *
 *   beginImport() → build the validated plan, upload the bundle's cursor and
 *     sound files to the user's own R2 prefix (the only way a cursor/sound can
 *     actually render — same uploads, same route limits, as a manual cursor or
 *     sound edit), paint the composed appearance through updateAppearance
 *     (unsaved: hasUnsavedChanges goes true, nothing is PATCHed), and switch
 *     the sound pack locally (soundStore.setCustomSoundPack does not persist).
 *
 *   keep() → every layer saves through its NORMAL save path — appearance via
 *     saveAppearance (so refused saves surface and cleared fields become null
 *     tombstones exactly like a manual edit), sounds via saveCustomSoundPack
 *     (its own rollback), wallpaper via uploadWallpaper + setWallpaperMode
 *     (their own optimistic rollback). No bespoke persistence exists here.
 *
 *   revert() (also the banner's close affordance — closing without choosing
 *     IS Revert) → restore the exact pre-preview appearance/sound state. The
 *     cursor and sound files uploaded for the preview are best-effort deleted,
 *     mirroring the manual remove flows, so a reverted preview leaves no
 *     orphaned assets.
 */

import { create } from 'zustand';
import {
  buildEsthemeImportPlan,
  composePreviewAppearance,
  mimeForAsset,
  type EsthemeImportPlan,
} from './importEstheme';
import { useAppearanceStore, type CustomAppearance } from '../stores/appearanceStore';
import { useSoundStore, type SoundPack } from '../stores/soundStore';
import { useAuthStore } from '../stores/authStore';
import { uploadCursor, uploadSound, deleteCursor, deleteSound, getCursorUrl } from '../services/assets';
import { uploadWallpaper } from '../services/appearance';
import { isApiConfigured } from '../services/transport';

/** What the banner shows about the theme being previewed. */
export interface EsthemePreviewInfo {
  id: string;
  name: string;
  author: string;
  version: string;
  description?: string;
  forkedFrom?: { id: string; name?: string; author: string; version?: string };
  /** Machine layer names; the banner maps them to friendly labels. */
  appliedLayers: string[];
  warnings: string[];
}

export type EsthemePreviewStatus = 'idle' | 'importing' | 'active' | 'keeping';

interface PreviewSession {
  plan: EsthemeImportPlan;
  snapshot: {
    appearance: CustomAppearance;
    wasUnsaved: boolean;
    soundPack: SoundPack | null;
  };
  /** Cursor/sound assets this preview uploaded (best-effort deleted on revert). */
  uploadedCursorIds: string[];
  uploadedSoundIds: string[];
  /** True when the preview changed the local sound pack. */
  packChanged: boolean;
}

interface EsthemePreviewState {
  status: EsthemePreviewStatus;
  info: EsthemePreviewInfo | null;
  /** Import/parse failure, or the list of layers a Keep could not save. */
  error: string | null;

  /**
   * Import `source` (.estheme Blob/ArrayBuffer) and start an unsaved preview.
   * Resolves true when the preview is active; false (with `error` set) when
   * the bundle was rejected. A preview already in flight is reverted first.
   */
  beginImport: (source: Blob | ArrayBuffer) => Promise<boolean>;
  /** Keep the previewed theme (normal save paths). True when fully saved. */
  keep: () => Promise<boolean>;
  /** Revert to the exact pre-preview state. Safe when idle. */
  revert: () => Promise<void>;
  /** Banner close: Revert when previewing, dismiss when showing an error. */
  dismiss: () => void;
  /** Clear a shown error (error banner's OK). */
  clearError: () => void;
}

function toInfo(plan: EsthemeImportPlan, warnings: string[]): EsthemePreviewInfo {
  const { manifest } = plan;
  return {
    id: manifest.id,
    name: manifest.name,
    author: manifest.author,
    version: manifest.version,
    description: manifest.description,
    forkedFrom: manifest.forkedFrom,
    appliedLayers: plan.appliedLayers,
    warnings,
  };
}

export const useEsthemePreviewStore = create<EsthemePreviewState>((set, get) => {
  /** The active preview session; null when idle. Kept out of the UI shape. */
  let session: PreviewSession | null = null;

  const revertSession = async (active: PreviewSession) => {
    const { appearance, wasUnsaved, soundPack } = active.snapshot;
    useAppearanceStore.getState().restoreAppearanceSnapshot(appearance, wasUnsaved);
    useSoundStore.getState().setCustomSoundPack(soundPack);
    useSoundStore.getState().preloadCustomSounds().catch(() => {
      // Preloading touches Audio, which SSR/test hosts may not have; the
      // restored pack mapping itself is already correct.
    });
    // Best-effort cleanup of the assets the preview uploaded — mirrors the
    // manual cursor/sound remove flows. A failed delete leaves an orphaned
    // (inert) file, never a wrong mapping.
    for (const cursorId of active.uploadedCursorIds) {
      deleteCursor(cursorId).catch(() => {});
    }
    for (const soundId of active.uploadedSoundIds) {
      deleteSound(soundId).catch(() => {});
    }
  };

  return {
    status: 'idle',
    info: null,
    error: null,

    beginImport: async (source) => {
      if (get().status === 'importing' || get().status === 'keeping') {
        set({ error: 'A theme import is already in progress.' });
        return false;
      }
      // Previewing a second theme replaces the first: revert the live preview
      // (restoring the user's exact pre-preview state) before applying the
      // new one, so every preview reverts to the same user rice.
      if (get().status === 'active' && session) {
        await revertSession(session);
        session = null;
      }
      set({ status: 'importing', info: null, error: null });

      try {
        const plan = await buildEsthemeImportPlan(source);
        const warnings = [...plan.warnings];

        // Snapshot the exact live state (which may itself be unsaved).
        const appearanceState = useAppearanceStore.getState();
        const snapshot: PreviewSession['snapshot'] = {
          appearance: { ...appearanceState.appearance },
          wasUnsaved: appearanceState.hasUnsavedChanges,
          soundPack: useSoundStore.getState().customSoundPack,
        };
        const uploadedCursorIds: string[] = [];
        const uploadedSoundIds: string[] = [];

        // --- upload cursor/sound assets so the preview actually renders ---
        const cursorTokens: Partial<Record<string, string>> = {};
        if (plan.cursors.length > 0) {
          if (!isApiConfigured) {
            warnings.push('cursors: skipped — cursor images need a connected account');
          } else {
            for (const cursor of plan.cursors) {
              try {
                const mime = mimeForAsset('cursor', cursor.filename) ?? 'image/png';
                const file = new File([cursor.blob], cursor.filename, { type: mime });
                const result = await uploadCursor(file, cursor.state, cursor.hotspotX, cursor.hotspotY);
                uploadedCursorIds.push(result.asset.cursorId);
                cursorTokens[cursor.state] =
                  `${getCursorUrl(result.asset.url)}|${cursor.hotspotX}|${cursor.hotspotY}`;
              } catch (e) {
                warnings.push(
                  `cursors: could not upload "${cursor.filename}" (${e instanceof Error ? e.message : 'upload failed'}) — your current cursor for that slot is kept`,
                );
              }
            }
          }
        }

        let packChanged = false;
        if (plan.sounds.length > 0) {
          if (!isApiConfigured) {
            warnings.push('sounds: skipped — sound files need a connected account');
          } else {
            const sounds: Record<string, string> = {};
            for (const sound of plan.sounds) {
              try {
                const mime = mimeForAsset('sound', sound.filename) ?? 'audio/mpeg';
                const file = new File([sound.blob], sound.filename, { type: mime });
                const result = await uploadSound(file, sound.type);
                uploadedSoundIds.push(result.asset.soundId);
                sounds[sound.type] = result.asset.url;
              } catch (e) {
                warnings.push(
                  `sounds: could not upload "${sound.filename}" (${e instanceof Error ? e.message : 'upload failed'})`,
                );
              }
            }
            if (Object.keys(sounds).length > 0) {
              useSoundStore.getState().setCustomSoundPack({ name: plan.manifest.name, sounds });
              useSoundStore.getState().preloadCustomSounds().catch(() => {});
              packChanged = true;
            }
          }
        }

        // --- paint the unsaved preview ---
        // Compose on the snapshot (the user's rice at import time), not on
        // whatever may have changed while the uploads ran.
        const composed = composePreviewAppearance(snapshot.appearance, plan, cursorTokens);
        useAppearanceStore.getState().updateAppearance(composed);

        if (plan.wallpaper && !isApiConfigured) {
          warnings.push('wallpaper: applies when you Keep (needs a connected account to upload)');
        }

        session = { plan, snapshot, uploadedCursorIds, uploadedSoundIds, packChanged };
        set({ status: 'active', info: toInfo(plan, warnings), error: null });
        return true;
      } catch (e) {
        session = null;
        set({
          status: 'idle',
          info: null,
          error: e instanceof Error ? e.message : 'This file is not a valid .estheme bundle.',
        });
        return false;
      }
    },

    keep: async () => {
      if (get().status !== 'active' || !session) return false;
      const active = session;
      set({ status: 'keeping' });
      const failures: string[] = [];

      // 1. Appearance (tokens, CSS, variants, cursor tokens, lineage) — the
      //    normal save path: refused saves throw and leave the edit unsaved.
      try {
        await useAppearanceStore.getState().saveAppearance();
      } catch {
        failures.push('appearance');
      }

      // 2. Sounds — the normal sound-pack save, rolling back on refusal.
      if (active.packChanged) {
        const saved = await useSoundStore.getState().saveCustomSoundPack(active.snapshot.soundPack);
        if (!saved) failures.push('sounds');
      }

      // 3. Wallpaper — the normal wallpaper save path: upload, then the
      //    optimistic profile PATCH (which rolls back on refusal).
      if (active.plan.wallpaper && isApiConfigured) {
        try {
          const wallpaper = active.plan.wallpaper;
          const mime = mimeForAsset('wallpaper', wallpaper.filename) ?? 'image/png';
          const file = new File([wallpaper.blob], wallpaper.filename, { type: mime });
          const response = await uploadWallpaper(file);
          const applied = await useAuthStore.getState().setWallpaper(response.wallpaper);
          if (!applied) {
            failures.push('wallpaper');
          } else if (wallpaper.mode) {
            const modeApplied = await useAuthStore.getState().setWallpaperMode(wallpaper.mode);
            if (!modeApplied) failures.push('wallpaper');
          }
        } catch {
          failures.push('wallpaper');
        }
      }

      if (failures.length > 0) {
        // The theme stays painted as an unsaved preview — exactly like a
        // refused manual save — so the user can retry or Revert.
        set({
          status: 'active',
          error: `Could not save: ${failures.join(', ')}. The preview is still active — retry, or revert.`,
        });
        return false;
      }

      session = null;
      set({ status: 'idle', info: null, error: null });
      return true;
    },

    revert: async () => {
      if (get().status !== 'active' || !session) {
        set({ status: 'idle', info: null });
        return;
      }
      const active = session;
      session = null;
      set({ status: 'idle', info: null, error: null });
      await revertSession(active);
    },

    dismiss: () => {
      const { status } = get();
      if (status === 'active') {
        // Closing without choosing is Revert.
        void get().revert();
      } else {
        set({ error: null });
      }
    },

    clearError: () => set({ error: null }),
  };
});
