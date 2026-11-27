/**
 * Sound Store - Manages desktop sound effects for EternalOS
 *
 * Supports:
 * - Built-in synthesized sound packs (Classic, Sci-Fi, Typewriter)
 * - Custom audio file sounds uploaded by the user
 * - Visitor mode: load another user's sound pack when visiting /@username
 *
 * Fallback chain: Custom sound URL → Built-in synthesized → Silence
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { updateProfile, isApiConfigured } from '../services/api';
import {
  BUILTIN_PACKS,
  playSynthSound,
  type BuiltInPackId,
  type SynthSoundType,
} from '../sounds/builtInPacks';
import {
  preloadSounds,
  playPreloadedAudio,
  releasePreloadedAudio,
  type PreloadedAudioMap,
} from '../sounds/audioPreloader';

import type { SoundType, SoundPack } from '@eternalos/contracts';

// Sound slots and packs are shared with the worker (@eternalos/contracts).
export type { SoundType, SoundPack };

interface SoundState {
  enabled: boolean;
  volume: number; // 0-1
  builtInPack: BuiltInPackId;
  customSoundPack: SoundPack | null;

  // Actions
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  playSound: (type: SoundType) => void;

  // Built-in pack selection
  setBuiltInPack: (pack: BuiltInPackId) => void;

  // Custom sound management
  setCustomSoundUrl: (type: SoundType, url: string | null) => void;
  setCustomSoundPack: (pack: SoundPack | null) => void;
  /**
   * PATCH the current custom pack to the profile (the mapping visitors and
   * reloads restore from). Resolves true when the server acknowledged it;
   * resolves false after rolling the pack back to `previous` — the pack as
   * it was before the edit that prompted this save — so a refused save
   * (offline / 401 / 429 / 500) never leaves the new sounds playing and
   * looking set when the server never recorded them.
   */
  saveCustomSoundPack: (previous: SoundPack | null) => Promise<boolean>;
  preloadCustomSounds: () => Promise<void>;

  // Visitor mode
  loadVisitorSounds: (pack: SoundPack | null) => Promise<void>;
  clearVisitorSounds: () => void;
}

// Audio context (lazy initialization)
let audioContext: AudioContext | null = null;
type WindowWithWebkitAudio = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioContext) {
    try {
      const audioContextCtor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
      if (!audioContextCtor) {
        console.warn('Web Audio API not supported');
        return null;
      }
      audioContext = new audioContextCtor();
    } catch {
      console.warn('Web Audio API not supported');
      return null;
    }
  }
  return audioContext;
}

// Preloaded custom audio elements (not persisted — rebuilt on load)
let preloadedAudio: PreloadedAudioMap = new Map();
// Visitor sounds (separate from user's own sounds)
let visitorPreloadedAudio: PreloadedAudioMap = new Map();
let isVisitorMode = false;

export const useSoundStore = create<SoundState>()(
  persist(
    (set, get) => ({
      enabled: true,
      volume: 0.5,
      builtInPack: 'classic' as BuiltInPackId,
      customSoundPack: null,

      setEnabled: (enabled) => set({ enabled }),

      setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),

      setBuiltInPack: (pack) => set({ builtInPack: pack }),

      setCustomSoundUrl: (type, url) => {
        const { customSoundPack } = get();
        // Clone before mutating: the pack object a caller captured before
        // this edit (the rollback target for saveCustomSoundPack) must not
        // be corrupted in place.
        const current: SoundPack = customSoundPack
          ? { name: customSoundPack.name, sounds: { ...customSoundPack.sounds } }
          : { name: 'Custom', sounds: {} };

        if (url) {
          current.sounds[type] = url;
        } else {
          delete current.sounds[type];
        }

        // If no custom sounds left, clear the pack
        const hasAnySounds = Object.keys(current.sounds).length > 0;
        set({ customSoundPack: hasAnySounds ? { ...current } : null });
      },

      setCustomSoundPack: (pack) => set({ customSoundPack: pack }),

      saveCustomSoundPack: async (previous) => {
        const pack = get().customSoundPack;
        // Demo mode: no server to refuse the change; the local pack stands.
        if (!isApiConfigured) return true;

        try {
          await updateProfile({ soundPack: pack || { name: 'Custom', sounds: {} } });
          return true;
        } catch (error) {
          console.error('Failed to sync sound pack to profile:', error);
          // The server never recorded this pack. Revert the local mapping
          // unless the user already made another edit — that edit carries
          // the pack forward and gets its own save.
          if (get().customSoundPack === pack) {
            set({ customSoundPack: previous });
          }
          return false;
        }
      },

      preloadCustomSounds: async () => {
        const { customSoundPack } = get();
        releasePreloadedAudio(preloadedAudio);

        if (customSoundPack?.sounds) {
          preloadedAudio = await preloadSounds(customSoundPack.sounds);
        }
      },

      loadVisitorSounds: async (pack) => {
        isVisitorMode = true;
        releasePreloadedAudio(visitorPreloadedAudio);

        if (pack?.sounds) {
          visitorPreloadedAudio = await preloadSounds(pack.sounds);
        }
      },

      clearVisitorSounds: () => {
        isVisitorMode = false;
        releasePreloadedAudio(visitorPreloadedAudio);
      },

      playSound: (type) => {
        const { enabled, volume, builtInPack, customSoundPack } = get();
        if (!enabled || volume === 0) return;

        // Determine which audio map to use
        const activeAudioMap = isVisitorMode ? visitorPreloadedAudio : preloadedAudio;
        const activePack = isVisitorMode ? null : customSoundPack;

        // 1. Try custom audio file first
        const customAudio = activeAudioMap.get(type);
        if (customAudio) {
          playPreloadedAudio(customAudio, volume);
          return;
        }

        // 2. If there's a custom URL but it's not preloaded, try to play inline
        //    (this handles the case where preloading hasn't finished yet)
        const customUrl = activePack?.sounds?.[type];
        if (customUrl) {
          try {
            const audio = new Audio(customUrl);
            audio.volume = volume;
            audio.play().catch(() => {});
          } catch {
            // Fall through to synthesized
          }
          return;
        }

        // 3. Fall back to built-in synthesized sound
        const ctx = getAudioContext();
        if (!ctx) return;

        if (ctx.state === 'suspended') {
          ctx.resume();
        }

        const pack = BUILTIN_PACKS[builtInPack];
        const definition = pack[type as SynthSoundType];
        if (definition) {
          playSynthSound(ctx, definition, volume);
        }
      },
    }),
    {
      name: 'eternalos-sound-prefs',
      partialize: (state) => ({
        enabled: state.enabled,
        volume: state.volume,
        builtInPack: state.builtInPack,
        // Don't persist customSoundPack — it's loaded from the profile/API
      }),
    }
  )
);

// Convenience hook for playing sounds
export function useSound() {
  const playSound = useSoundStore((state) => state.playSound);
  return playSound;
}
