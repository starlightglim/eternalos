/**
 * Debounced autosave with one save in flight at a time.
 *
 * `schedule()` (re)starts the quiet-period timer; when it fires, `save()`
 * runs. If a save is already running, another one runs right after it
 * finishes, so typing during a slow save is never left unsaved. `flush()`
 * saves now (Cmd+S, blur); `cancel()` drops the pending timer and any
 * queued re-run (a save already running finishes).
 */
export interface Autosave {
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
}

export function createAutosave(save: () => Promise<void>, delayMs: number): Autosave {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let again = false;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const run = (): Promise<void> => {
    clear();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await save();
        } while (again);
      } finally {
        running = null;
        // A save requested while a failing save ran still gets its turn.
        if (again) {
          again = false;
          void run().catch(() => {});
        }
      }
    })();
    return running;
  };

  return {
    schedule() {
      clear();
      timer = setTimeout(() => { void run().catch(() => {}); }, delayMs);
    },
    flush: run,
    cancel() {
      clear();
      again = false;
    },
  };
}
