import { describe, expect, test } from 'vitest';
import type { UserProfile } from '../types';
import { mergeServerProfile } from './serverProfile';

const cached: UserProfile = {
  uid: 'u1',
  username: 'alice',
  displayName: 'Alice',
  createdAt: 1,
  wallpaper: 'custom:u1/wallpaper/old.jpg',
  wallpaperMode: 'tile',
  bio: 'old bio',
  accentColor: '#ff0000',
  customCSS: '.window { color: red }',
};

describe('mergeServerProfile', () => {
  test('a wallpaper cleared on the server stays cleared (server wins)', () => {
    const server: UserProfile = { uid: 'u1', username: 'alice', displayName: 'Alice', createdAt: 1 };
    const merged = mergeServerProfile(cached, server);
    expect(merged.wallpaper).toBeUndefined();
    expect('wallpaper' in merged).toBe(false);
    expect(merged.customCSS).toBeUndefined();
    expect(merged.accentColor).toBeUndefined();
  });

  test('copies every server-owned field, not just a hand-picked list', () => {
    const server: UserProfile = {
      uid: 'u1',
      username: 'alice2',
      displayName: 'Alice B',
      createdAt: 1,
      wallpaper: 'stars',
      wallpaperMode: 'center',
      bio: 'new bio',
      profileLinks: [{ title: 'Site', url: 'https://example.com' }],
      soundPack: { name: 'Pack', sounds: { click: '/api/sounds/x' } },
      designTokens: { 'menuBar.background': '#000' },
      variants: { 'window.chrome': 'flat' },
    };
    expect(mergeServerProfile(cached, server)).toEqual(server);
  });

  test('works when nothing is cached', () => {
    const server: UserProfile = { uid: 'u1', username: 'alice', displayName: 'Alice', createdAt: 5, wallpaper: 'stars' };
    expect(mergeServerProfile(null, server)).toEqual(server);
  });

  test('fields with an in-flight optimistic write keep the local value', () => {
    const server: UserProfile = { uid: 'u1', username: 'alice', displayName: 'Alice', createdAt: 1, wallpaper: 'old', bio: 'srv' };
    const merged = mergeServerProfile({ ...cached, wallpaper: 'just-picked' }, server, ['wallpaper']);
    expect(merged.wallpaper).toBe('just-picked');
    expect(merged.bio).toBe('srv');
  });

  test('a missing displayName falls back to the cached one, then the username', () => {
    const server = { uid: 'u1', username: 'alice', createdAt: 1 } as UserProfile;
    expect(mergeServerProfile(cached, server).displayName).toBe('Alice');
    expect(mergeServerProfile(null, server).displayName).toBe('alice');
  });

  test('never carries cached values across accounts', () => {
    const server = { uid: 'u2', username: 'bob', createdAt: 2 } as UserProfile;
    const merged = mergeServerProfile({ ...cached, wallpaper: 'mine' }, server, ['wallpaper']);
    expect(merged.wallpaper).toBeUndefined();
    expect(merged.displayName).toBe('bob');
  });
});
