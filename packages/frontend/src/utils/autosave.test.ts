import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAutosave } from './autosave';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('saves once after typing stops', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const autosave = createAutosave(save, 1000);
  autosave.schedule();
  await vi.advanceTimersByTimeAsync(600);
  autosave.schedule();
  await vi.advanceTimersByTimeAsync(600);
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400);
  expect(save).toHaveBeenCalledTimes(1);
});

test('flush saves now and cancels the pending timer', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const autosave = createAutosave(save, 1000);
  autosave.schedule();
  await autosave.flush();
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(1);
});

test('cancel drops the pending save', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const autosave = createAutosave(save, 1000);
  autosave.schedule();
  autosave.cancel();
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).not.toHaveBeenCalled();
});

test('a save requested during a slow save runs right after it, never concurrently', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const resolvers: (() => void)[] = [];
  const save = vi.fn(() => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve) => resolvers.push(() => { inFlight -= 1; resolve(); }));
  });
  const autosave = createAutosave(save, 1000);
  const first = autosave.flush();
  const second = autosave.flush();
  expect(save).toHaveBeenCalledTimes(1);
  resolvers.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(2);
  resolvers.shift()!();
  await Promise.all([first, second]);
  expect(maxInFlight).toBe(1);
});

test('a save requested during a failing save still runs afterwards', async () => {
  let reject!: (e: Error) => void;
  const save = vi.fn()
    .mockImplementationOnce(() => new Promise<void>((_, r) => { reject = r; }))
    .mockResolvedValue(undefined);
  const autosave = createAutosave(save, 1000);
  const first = autosave.flush();
  void autosave.flush().catch(() => {});
  reject(new Error('offline'));
  await expect(first).rejects.toThrow('offline');
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(2);
});

test('cancel also drops a queued re-run', async () => {
  let resolve!: () => void;
  const save = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
  const autosave = createAutosave(save, 1000);
  const first = autosave.flush();
  void autosave.flush();
  autosave.cancel();
  resolve();
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(1);
});

test('a failing save rejects flush but the next save still runs', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const autosave = createAutosave(save, 1000);
  await expect(autosave.flush()).rejects.toThrow('offline');
  await autosave.flush();
  expect(save).toHaveBeenCalledTimes(2);
});
