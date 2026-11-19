import { beforeEach, expect, test, describe, vi } from 'vitest';

// soundStore uses the persist middleware (localStorage) and the Audio API.
// Stub localStorage for a clean import; the pure state setters below never
// touch Audio (only playSound does, which we don't call). The store also
// PATCHes the sound pack to the profile via the API client — mock it so the
// refused-save paths can be driven deterministically.
vi.hoisted(() => {
  const g = globalThis as unknown as { localStorage?: unknown; window?: unknown };
  const localStorageStub = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  g.localStorage = localStorageStub;
  // zustand's persist middleware resolves its default storage through
  // `window.localStorage`; windowStore (not imported here, but keep the
  // env shape consistent) also expects a `window` global.
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: localStorageStub,
  };
});

vi.mock('../services/api', () => ({
  isApiConfigured: true,
  updateProfile: vi.fn(),
}));

import { useSoundStore, type SoundPack } from './soundStore';
import { updateProfile } from '../services/api';

const updateProfileMock = vi.mocked(updateProfile);

// The forced-failure modes from the Workstream 1 "Good when" acceptance.
const FAILURES = [
  ['offline', () => new TypeError('Failed to fetch')],
  ['401', () => new Error('401 Session expired. Please log in again.')],
  ['429', () => new Error('429 Too many requests')],
  ['500', () => new Error('500 Internal server error')],
] as const;

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

describe('saveCustomSoundPack (profile sync)', () => {
  beforeEach(() => {
    updateProfileMock.mockReset();
    updateProfileMock.mockResolvedValue({ success: true, profile: {} });
  });

  test.each(FAILURES)('%s: a refused profile sync rolls the pack back and resolves false', async (_label, makeError) => {
    updateProfileMock.mockImplementation(() => Promise.reject(makeError()));

    // The pre-edit pack is the rollback target the editor passes in.
    const previous: SoundPack = { name: 'Custom', sounds: { click: '/old.wav' } };
    useSoundStore.setState({ customSoundPack: previous });
    // The edit under test: replace the click mapping.
    useSoundStore.getState().setCustomSoundUrl('click', '/new.wav');

    const saved = await useSoundStore.getState().saveCustomSoundPack(previous);
    expect(saved).toBe(false);
    // The server never recorded the new mapping — the store must not keep
    // it playing/looking set.
    expect(useSoundStore.getState().customSoundPack?.sounds.click).toBe('/old.wav');
    expect(useSoundStore.getState().customSoundPack?.sounds.click).not.toBe('/new.wav');
  });

  test.each(FAILURES)('%s: the PATCH was actually attempted', async (_label, makeError) => {
    updateProfileMock.mockImplementation(() => Promise.reject(makeError()));
    const previous: SoundPack = { name: 'Custom', sounds: { click: '/old.wav' } };
    useSoundStore.setState({ customSoundPack: previous });

    await useSoundStore.getState().saveCustomSoundPack(previous);
    expect(updateProfileMock).toHaveBeenCalledWith({ soundPack: previous });
  });

  test('an acknowledged sync keeps the new pack and resolves true', async () => {
    const previous: SoundPack = { name: 'Custom', sounds: { click: '/old.wav' } };
    useSoundStore.setState({ customSoundPack: previous });
    useSoundStore.getState().setCustomSoundUrl('click', '/new.wav');

    const saved = await useSoundStore.getState().saveCustomSoundPack(previous);
    expect(saved).toBe(true);
    expect(useSoundStore.getState().customSoundPack?.sounds.click).toBe('/new.wav');
  });

  test('an empty pack still syncs (a removed-last-sound mapping is cleared server-side)', async () => {
    useSoundStore.setState({ customSoundPack: null });
    const saved = await useSoundStore.getState().saveCustomSoundPack(null);
    expect(saved).toBe(true);
    expect(updateProfileMock).toHaveBeenCalledWith({ soundPack: { name: 'Custom', sounds: {} } });
  });

  test('a refused sync does not clobber a newer edit of the pack', async () => {
    useSoundStore.setState({ customSoundPack: { name: 'Custom', sounds: { click: '/old.wav' } } });
    const previous = useSoundStore.getState().customSoundPack;

    // The save of the first edit hangs; the user edits again meanwhile.
    let rejectSave!: (error: Error) => void;
    updateProfileMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSave = reject; })
    );
    const pending = useSoundStore.getState().saveCustomSoundPack(previous);
    useSoundStore.getState().setCustomSoundUrl('alert', '/newer.wav');

    rejectSave(new Error('500 Internal server error'));
    expect(await pending).toBe(false);
    // The newer edit stands (it carries the pack forward and gets its own
    // save); the stale failure must not revert underneath it.
    expect(useSoundStore.getState().customSoundPack?.sounds.alert).toBe('/newer.wav');
  });
});
