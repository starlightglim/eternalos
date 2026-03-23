/**
 * Audio Preloader for EternalOS Custom Sounds
 *
 * Preloads custom sound URLs as HTMLAudioElement objects for instant playback.
 * Handles errors gracefully — failed loads are silently skipped (fall back to synthesized).
 */

type SoundType = string;

/** Map of preloaded audio elements keyed by sound type */
export type PreloadedAudioMap = Map<SoundType, HTMLAudioElement>;

/**
 * Preload a set of sound URLs into HTMLAudioElement objects.
 * Returns a Map of successfully preloaded audio elements.
 *
 * @param soundUrls - Map of sound type → URL to preload
 * @param apiBase - Base URL for resolving relative paths (e.g., 'https://api.eternalos.app')
 */
export async function preloadSounds(
  soundUrls: Record<string, string>,
  apiBase?: string
): Promise<PreloadedAudioMap> {
  const audioMap: PreloadedAudioMap = new Map();
  const entries = Object.entries(soundUrls);

  if (entries.length === 0) return audioMap;

  const loadPromises = entries.map(async ([soundType, url]) => {
    try {
      const resolvedUrl = url.startsWith('http') ? url : `${apiBase || ''}${url}`;
      const audio = new Audio();

      // Wait for enough data to play
      await new Promise<void>((resolve, reject) => {
        const onCanPlay = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`Failed to load sound: ${resolvedUrl}`));
        };
        const cleanup = () => {
          audio.removeEventListener('canplaythrough', onCanPlay);
          audio.removeEventListener('error', onError);
        };

        audio.addEventListener('canplaythrough', onCanPlay);
        audio.addEventListener('error', onError);
        audio.preload = 'auto';
        audio.src = resolvedUrl;
        audio.load();

        // Timeout after 5 seconds
        setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout loading sound: ${resolvedUrl}`));
        }, 5000);
      });

      audioMap.set(soundType, audio);
    } catch (error) {
      // Silent failure — will fall back to synthesized sound
      console.warn(`[EternalOS] Failed to preload sound "${soundType}":`, error);
    }
  });

  await Promise.allSettled(loadPromises);
  return audioMap;
}

/**
 * Play a preloaded audio element.
 * Clones the audio node so multiple rapid plays don't interrupt each other.
 *
 * @param audio - The preloaded HTMLAudioElement
 * @param volume - Master volume (0-1)
 */
export function playPreloadedAudio(audio: HTMLAudioElement, volume: number): void {
  try {
    // Clone the audio so rapid-fire sounds can overlap
    const clone = audio.cloneNode(true) as HTMLAudioElement;
    clone.volume = Math.max(0, Math.min(1, volume));
    clone.play().catch(() => {
      // Autoplay policy may block this — that's fine
    });
  } catch {
    // Silent failure
  }
}

/**
 * Release all preloaded audio elements.
 */
export function releasePreloadedAudio(audioMap: PreloadedAudioMap): void {
  for (const [, audio] of audioMap) {
    audio.src = '';
    audio.load();
  }
  audioMap.clear();
}
