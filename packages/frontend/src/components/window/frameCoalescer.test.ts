import { describe, expect, test, vi } from 'vitest';
import { createFrameCoalescer, type FrameScheduler } from './frameCoalescer';

function fakeScheduler() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const scheduler: FrameScheduler = {
    request: vi.fn((cb: () => void) => {
      const handle = next++;
      queue.set(handle, cb);
      return handle;
    }),
    cancel: vi.fn((handle: number) => {
      queue.delete(handle);
    }),
  };
  const frame = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    callbacks.forEach((cb) => cb());
  };
  return { scheduler, frame, queued: () => queue.size };
}

describe('createFrameCoalescer', () => {
  test('applies only the latest value, once per frame', () => {
    const { scheduler, frame } = fakeScheduler();
    const apply = vi.fn();
    const c = createFrameCoalescer<number>(apply, scheduler);
    c.push(1);
    c.push(2);
    c.push(3);
    expect(apply).not.toHaveBeenCalled();
    expect(scheduler.request).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(true);
    frame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(3);
    expect(c.pending).toBe(false);
    c.push(4);
    frame();
    expect(apply).toHaveBeenLastCalledWith(4);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test('flush applies the pending value now and unschedules the frame', () => {
    const { scheduler, frame, queued } = fakeScheduler();
    const apply = vi.fn();
    const c = createFrameCoalescer<string>(apply, scheduler);
    c.push('a');
    c.push('b');
    c.flush();
    expect(apply).toHaveBeenCalledWith('b');
    expect(queued()).toBe(0);
    frame();
    expect(apply).toHaveBeenCalledTimes(1);
    c.flush(); // nothing pending: no-op
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test('cancel drops the pending value', () => {
    const { scheduler, frame } = fakeScheduler();
    const apply = vi.fn();
    const c = createFrameCoalescer<number>(apply, scheduler);
    c.push(1);
    c.cancel();
    frame();
    c.flush();
    expect(apply).not.toHaveBeenCalled();
    expect(c.pending).toBe(false);
  });

  test('without a scheduler every push applies synchronously', () => {
    const apply = vi.fn();
    const c = createFrameCoalescer<number>(apply, null);
    c.push(1);
    c.push(2);
    expect(apply.mock.calls).toEqual([[1], [2]]);
    expect(c.pending).toBe(false);
  });
});
