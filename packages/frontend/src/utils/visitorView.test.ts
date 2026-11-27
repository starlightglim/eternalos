import { describe, expect, test } from 'vitest';
import { mergeLiveProfile, stableStringify, visitorLookKey, visitorSocketUrl, visitorUsernameFrom } from './visitorView';
import { applyMetaTags, type MetaElementLike, type MetaHead } from '../hooks/useDocumentMeta';

describe('visitorSocketUrl', () => {
  const loc = { protocol: 'https:', host: 'eternalos.test' };

  test('derives ws(s) from the API URL', () => {
    expect(visitorSocketUrl('http://localhost:8787', 'bob', loc)).toBe('ws://localhost:8787/api/ws/bob');
    expect(visitorSocketUrl('https://api.example.test/', 'bob', loc)).toBe('wss://api.example.test/api/ws/bob');
  });

  test('falls back to the current host', () => {
    expect(visitorSocketUrl('', 'bob', loc)).toBe('wss://eternalos.test/api/ws/bob');
    expect(visitorSocketUrl('', 'bob', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/ws/bob');
  });

  test('encodes the username so it cannot change the path', () => {
    expect(visitorSocketUrl('', '../auth?x=1#y', loc)).toBe('wss://eternalos.test/api/ws/..%2Fauth%3Fx%3D1%23y');
  });
});

describe('visitorUsernameFrom', () => {
  test('prefers the route param', () => {
    expect(visitorUsernameFrom('bob', '/@alice')).toBe('bob');
  });

  test('decodes the pathname and drops trailing slashes', () => {
    expect(visitorUsernameFrom(undefined, '/@bob/')).toBe('bob');
    expect(visitorUsernameFrom(undefined, '/@j%C3%B6')).toBe('jö');
    expect(visitorUsernameFrom(undefined, '/@%E0%A4')).toBe('%E0%A4');
    expect(visitorUsernameFrom(undefined, '/@')).toBeUndefined();
  });
});

describe('mergeLiveProfile', () => {
  const look = ['customCSS', 'designTokens'];

  test('keeps fields the push lacks, but drops cleared look fields', () => {
    const prev = { username: 'bob', bio: 'hi', customCSS: '.window{}', designTokens: { a: 1 } };
    const next = { username: 'bob', designTokens: { a: 2 } } as typeof prev;
    expect(mergeLiveProfile(prev, next, look)).toEqual({ username: 'bob', bio: 'hi', designTokens: { a: 2 } });
  });

  test('takes the push as-is when nothing is on screen', () => {
    const next = { username: 'bob' };
    expect(mergeLiveProfile(null, next, look)).toBe(next);
  });
});

describe('visitorLookKey', () => {
  test('equal looks give equal keys regardless of key order', () => {
    const a = { accentColor: '#f00', designTokens: { 'bar.style': 'floating', 'layout.gap': 8 } };
    const b = { designTokens: { 'layout.gap': 8, 'bar.style': 'floating' }, accentColor: '#f00' };
    expect(visitorLookKey(a)).toBe(visitorLookKey(b));
  });

  test('a real change gives a new key', () => {
    expect(visitorLookKey({ accentColor: '#f00' })).not.toBe(visitorLookKey({ accentColor: '#0f0' }));
  });

  test('undefined fields are ignored and the key round-trips', () => {
    expect(visitorLookKey({ a: 1, b: undefined })).toBe(visitorLookKey({ a: 1 }));
    const look = { customCSS: '.window { color: red }', variants: { chrome: 'glass' }, list: [1, 'x', null] };
    expect(JSON.parse(stableStringify(look))).toEqual(look);
  });
});

function fakeHead() {
  const nodes: Array<MetaElementLike & { attrs: Record<string, string> }> = [];
  const head: MetaHead = {
    querySelector(selector) {
      const m = /^meta\[(\w+)="([^"]+)"\]$/.exec(selector);
      if (!m) return null;
      return nodes.find((n) => n.attrs[m[1]] === m[2]) ?? null;
    },
    appendChild(node) {
      nodes.push(node as (typeof nodes)[number]);
    },
  };
  const create = () => {
    const node = {
      attrs: {} as Record<string, string>,
      content: '',
      setAttribute(name: string, value: string) {
        node.attrs[name] = value;
      },
      remove() {
        nodes.splice(nodes.indexOf(node), 1);
      },
    };
    return node;
  };
  return { head, create, nodes };
}

describe('applyMetaTags', () => {
  test('removes tags it created and restores tags that already existed', () => {
    const { head, create, nodes } = fakeHead();
    const existing = create();
    existing.setAttribute('name', 'description');
    existing.content = 'Site description';
    head.appendChild(existing);

    const restore = applyMetaTags(head, create, {
      title: "@bob's Desktop",
      description: 'Bob page',
      ogImage: 'https://x.test/og.png',
      twitterCard: 'summary_large_image',
    });
    expect(existing.content).toBe('Bob page');
    expect(head.querySelector('meta[property="og:image"]')?.content).toBe('https://x.test/og.png');
    expect(nodes.length).toBeGreaterThan(1);

    restore();
    expect(nodes).toEqual([existing]);
    expect(existing.content).toBe('Site description');
  });
});
