import { expect, test, vi } from 'vitest';
import { addUnloadGuard, interceptWindowClose, setCloseGuard, setContentTypeCloseGuard } from './useUnsavedGuard';

test('beforeunload is blocked only while dirty, and the guard detaches', () => {
  const target = new EventTarget();
  let dirty = true;
  const remove = addUnloadGuard(target, () => dirty);

  const blocked = new Event('beforeunload', { cancelable: true });
  target.dispatchEvent(blocked);
  expect(blocked.defaultPrevented).toBe(true);

  dirty = false;
  const clean = new Event('beforeunload', { cancelable: true });
  target.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);

  dirty = true;
  remove();
  const after = new Event('beforeunload', { cancelable: true });
  target.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test('a window without a guard closes normally', () => {
  expect(interceptWindowClose('none', vi.fn())).toBe(false);
});

test('a close guard can hold the close and later proceed without re-asking', () => {
  let proceed: (() => void) | null = null;
  const guard = vi.fn((next: () => void) => { proceed = next; return true; });
  const remove = setCloseGuard('w1', guard);

  // closeWindow re-enters itself through proceed(); the guard must not ask again.
  const closed: string[] = [];
  const close = vi.fn(() => { if (!interceptWindowClose('w1', close)) closed.push('w1'); });

  expect(interceptWindowClose('w1', close)).toBe(true);
  expect(close).not.toHaveBeenCalled();
  (proceed as unknown as () => void)();
  expect(close).toHaveBeenCalledTimes(1);
  expect(closed).toEqual(['w1']);
  expect(guard).toHaveBeenCalledTimes(1);

  // Still guarded after the bypass ends.
  expect(interceptWindowClose('w1', vi.fn())).toBe(true);
  remove();
  expect(interceptWindowClose('w1', vi.fn())).toBe(false);
});

test('a guard that returns false lets the close through', () => {
  const remove = setCloseGuard('w2', () => false);
  expect(interceptWindowClose('w2', vi.fn())).toBe(false);
  remove();
});

test('a content-type guard covers every window of that type, even with no viewer mounted', () => {
  const remove = setContentTypeCloseGuard('appearance', () => true);
  expect(interceptWindowClose('any-id', vi.fn(), 'appearance')).toBe(true);
  expect(interceptWindowClose('any-id', vi.fn(), 'text')).toBe(false);
  remove();
});

test('removing a stale guard does not drop a newer one for the same window', () => {
  const removeOld = setCloseGuard('w3', () => true);
  const removeNew = setCloseGuard('w3', () => true);
  removeOld();
  expect(interceptWindowClose('w3', vi.fn())).toBe(true);
  removeNew();
});
