import { describe, expect, it, vi } from 'vitest';
import { whenLoaded } from './registerServiceWorker';

function fakeWindow() {
  const listeners: Array<() => void> = [];
  return {
    target: { addEventListener: (_type: string, fn: () => void) => listeners.push(fn) } as unknown as Window,
    fire: () => listeners.forEach((fn) => fn()),
    listeners,
  };
}

describe('whenLoaded', () => {
  it('runs immediately when load already fired', () => {
    const fn = vi.fn();
    const win = fakeWindow();
    whenLoaded(fn, win.target, { readyState: 'complete' });
    expect(fn).toHaveBeenCalledOnce();
    expect(win.listeners).toHaveLength(0);
  });

  it('waits for load while the page is still loading', () => {
    const fn = vi.fn();
    const win = fakeWindow();
    whenLoaded(fn, win.target, { readyState: 'interactive' });
    expect(fn).not.toHaveBeenCalled();
    win.fire();
    expect(fn).toHaveBeenCalledOnce();
  });
});
