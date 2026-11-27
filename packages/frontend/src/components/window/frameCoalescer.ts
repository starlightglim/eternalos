/**
 * Coalesce high-frequency updates (pointermove during a window drag/resize)
 * into at most one write per animation frame. Only the latest value is kept;
 * `flush()` applies it immediately (pointerup must commit the final spot),
 * `cancel()` drops it.
 *
 * Without requestAnimationFrame (tests, SSR) every push applies immediately.
 */

export interface FrameScheduler {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

export interface FrameCoalescer<T> {
  /** Remember `value` and schedule one apply for the next frame. */
  push: (value: T) => void;
  /** Apply the pending value now (no-op when nothing is pending). */
  flush: () => void;
  /** Drop the pending value without applying it. */
  cancel: () => void;
  /** True while a value is waiting for its frame. */
  readonly pending: boolean;
}

export function defaultFrameScheduler(): FrameScheduler | null {
  if (typeof requestAnimationFrame !== 'function' || typeof cancelAnimationFrame !== 'function') return null;
  return {
    request: (callback) => requestAnimationFrame(() => callback()),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

export function createFrameCoalescer<T>(
  apply: (value: T) => void,
  scheduler: FrameScheduler | null = defaultFrameScheduler(),
): FrameCoalescer<T> {
  let handle: number | null = null;
  let hasValue = false;
  let latest: T | undefined;

  const take = (): void => {
    handle = null;
    if (!hasValue) return;
    const value = latest as T;
    hasValue = false;
    latest = undefined;
    apply(value);
  };

  return {
    push(value) {
      if (!scheduler) {
        apply(value);
        return;
      }
      latest = value;
      hasValue = true;
      if (handle === null) handle = scheduler.request(take);
    },
    flush() {
      if (handle !== null && scheduler) scheduler.cancel(handle);
      take();
    },
    cancel() {
      if (handle !== null && scheduler) scheduler.cancel(handle);
      handle = null;
      hasValue = false;
      latest = undefined;
    },
    get pending() {
      return hasValue;
    },
  };
}
