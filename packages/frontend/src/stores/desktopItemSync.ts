// Server-acknowledged item state and pending-mutation bookkeeping for the
// desktop store (CORE-ROADMAP Workstream 1, item 4).
//
// The store's data slice holds the *displayed* items — optimistic values
// applied immediately so the UI stays responsive. This module owns the two
// other kinds of state that used to be mixed in with it:
//
//   1. The acknowledged snapshot — the last value the server confirmed for
//      each item. Every failed write rolls the displayed item back to this,
//      so a forced 401/429/500/network failure can never leave an item
//      looking saved when the server never recorded it.
//   2. Pending-mutation bookkeeping — the per-item write queue
//      (`persistItemMutation`) that preserves per-item write order and
//      cancels writes queued under a previous session (account switch).
//
// Nothing here is reactive: the store consults it while applying mutations
// and rollbacks, and tests assert on it directly.

import type { DesktopItem } from '../types';

// ---------------------------------------------------------------------------
// Session versioning
// ---------------------------------------------------------------------------

// Bumped on logout / account switch / reset. Writes captured under an old
// version must not touch the new session's state.
let desktopSessionVersion = 0;

export function bumpDesktopSession(): void {
  desktopSessionVersion += 1;
}

export function currentDesktopSession(): number {
  return desktopSessionVersion;
}

// ---------------------------------------------------------------------------
// Per-item write queue
// ---------------------------------------------------------------------------

const itemWriteQueues = new Map<string, Promise<boolean>>();

// Serialize all server writes for one item so they reach the server in the
// order the user made them. A rejected write never blocks the queue; a write
// queued under an old session resolves `false` without running.
export async function persistItemMutation(
  id: string,
  operation: () => Promise<unknown>
): Promise<boolean> {
  const version = desktopSessionVersion;
  const previous = itemWriteQueues.get(id) ?? Promise.resolve(true);
  const pending = previous.catch(() => false).then(async () => {
    if (version !== desktopSessionVersion) return false;
    await operation();
    return version === desktopSessionVersion;
  });
  itemWriteQueues.set(id, pending);
  try {
    return await pending;
  } finally {
    if (itemWriteQueues.get(id) === pending) itemWriteQueues.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Acknowledged snapshot
// ---------------------------------------------------------------------------

// id -> last server-known value.
const acknowledgedItems = new Map<string, DesktopItem>();

/** The last server-confirmed value for an item (defensive copy). */
export function getAcknowledgedItem(id: string): DesktopItem | undefined {
  const item = acknowledgedItems.get(id);
  return item ? { ...item } : undefined;
}

/**
 * Replace the whole acknowledged snapshot. Called when the server is the
 * source of truth: a desktop fetch/reconcile. Optimistic items the server
 * has not confirmed yet lose their entry, so a later failed write for them
 * has nothing (wrong) to roll back to.
 */
export function noteServerItems(items: readonly DesktopItem[]): void {
  acknowledgedItems.clear();
  for (const item of items) {
    acknowledgedItems.set(item.id, { ...item });
  }
}

/** The server confirmed a create; `item` is exactly what it now knows. */
export function noteAcknowledgedCreate(item: DesktopItem): void {
  acknowledgedItems.set(item.id, { ...item });
}

/**
 * The server confirmed a write. Merges the written fields into the last
 * acknowledged value — never the displayed item, which may already hold
 * newer optimistic changes the server has not seen.
 */
export function noteAcknowledgedWrite(id: string, updates: Partial<DesktopItem>): void {
  const previous = acknowledgedItems.get(id);
  if (!previous) return;
  acknowledgedItems.set(id, { ...previous, ...updates });
}

/** The server confirmed a delete; the snapshot forgets the item. */
export function forgetAcknowledgedItems(ids: readonly string[]): void {
  for (const id of ids) {
    acknowledgedItems.delete(id);
  }
}

/** Drop all bookkeeping of the old session (logout / account switch). */
export function resetItemSync(): void {
  acknowledgedItems.clear();
  itemWriteQueues.clear();
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

function fieldValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Roll the fields of a failed optimistic write back to the acknowledged
 * snapshot. Returns the reverted item, or `null` when nothing should change.
 *
 * Only fields still showing the attempted value are considered for revert:
 * if a newer interaction changed a field since (a second rename, a drag,
 * …), that newer value wins and the failed write must not clobber it. When
 * every attempted field is still showing the attempted value the whole
 * write is un-superseded and reverts; when a guard field was superseded the
 * write leaves the item alone.
 *
 * `guardFields` narrows the staleness check to those keys only. A paste of
 * `{ parentId, position }` reverts as one unit guarded on the parenting,
 * matching the pre-split move-rollback behavior.
 */
export function rollbackAttemptedFields(
  displayed: DesktopItem,
  attempted: Partial<DesktopItem>,
  guardFields?: ReadonlyArray<keyof DesktopItem>
): DesktopItem | null {
  const acknowledged = acknowledgedItems.get(displayed.id);
  if (!acknowledged) return null;
  const attemptedKeys = Object.keys(attempted) as Array<keyof DesktopItem>;
  if (attemptedKeys.length === 0) return null;
  const keysToGuard = guardFields ?? attemptedKeys;
  const stillAttempted = (key: keyof DesktopItem) =>
    fieldValuesEqual(displayed[key], attempted[key]);
  if (!keysToGuard.every(stillAttempted)) return null;

  const revertedFields: Partial<DesktopItem> = {};
  let changed = false;
  for (const key of attemptedKeys) {
    if (!fieldValuesEqual(displayed[key], acknowledged[key])) {
      Object.assign(revertedFields, { [key]: acknowledged[key] });
      changed = true;
    }
  }
  // Only the attempted fields move back to the acknowledged value; anything
  // else on the displayed item (a newer optimistic change, updatedAt) stays.
  return changed ? { ...displayed, ...revertedFields } : null;
}
