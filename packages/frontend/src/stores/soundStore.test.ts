import { beforeEach, expect, test, describe, vi } from 'vitest';

// soundStore uses the persist middleware (localStorage) and the Audio API.
// Stub localStorage for a clean import; the pure state setters below never
// touch Audio (only playSound does, which we don't call).
vi.hoisted(() => {
  (globalThis as unknown as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

import { useSoundStore } from './soundStore';

beforeEach(() => {
  useSoundStore.setState({ enabled: true, volume: 0.5, builtInPack: 'classic', customSoundPack: null });
});

describe('soundStore state setters', () => {
  test('setEnabled toggles sound', () => {
    useSoundStore.getState().setEnabled(false);
    expect(useSoundStore.getState().enabled).toBe(false);
  });

  test('setVolume clamps into [0, 1]', () => {
    const { setVolume } = useSoundStore.getState();
    setVolume(0.3);
    expect(useSoundStore.getState().volume).toBe(0.3);
    setVolume(5);
    expect(useSoundStore.getState().volume).toBe(1);
    setVolume(-5);
    expect(useSoundStore.getState().volume).toBe(0);
  });

  test('setBuiltInPack switches the pack', () => {
    useSoundStore.getState().setBuiltInPack('modern' as never);
    expect(useSoundStore.getState().builtInPack).toBe('modern');
  });

  test('setCustomSoundUrl adds a sound, and removing the last clears the pack', () => {
    const { setCustomSoundUrl } = useSoundStore.getState();
    setCustomSoundUrl('click', '/api/sounds/click.wav');
    expect(useSoundStore.getState().customSoundPack?.sounds.click).toBe('/api/sounds/click.wav');
    // Removing the only custom sound collapses the pack back to null.
    setCustomSoundUrl('click', null);
    expect(useSoundStore.getState().customSoundPack).toBeNull();
  });
});
