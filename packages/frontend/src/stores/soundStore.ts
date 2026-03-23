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

// Sound types available in the system
export type SoundType =
  | 'click'
  | 'windowOpen'
  | 'windowClose'
  | 'folderOpen'
  | 'drop'
  | 'trash'
  | 'emptyTrash'
  | 'alert'
  | 'error'
  | 'startup'
  | 'select';

/** Sound pack — maps sound types to custom audio file URLs */
export interface SoundPack {
  name: string;
  sounds: Partial<Record<SoundType, string>>;
}

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
        const current = customSoundPack || { name: 'Custom', sounds: {} };

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
