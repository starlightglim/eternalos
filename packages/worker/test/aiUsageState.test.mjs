/**
 * Unit tests for the per-account AI usage guard state machine
 * (src/durable-objects/aiUsageState.ts).
 *
 * These run directly under node --test (Node ≥23 strips the erasable-type
 * syntax in the imported .ts), covering the accounting rules end to end
 * without booting a worker: daily budget charge/reject, token accounting,
 * the concurrency cap with lease-backed slots, stale-slot reclamation after
 * a crashed turn, and UTC-day rollover semantics.
 *
 * The higher-level behavior (friendly 429s in the chat stream, the analyze
 * route's HTTP 429, concurrency rejection, slot release after a crash) is
 * covered by the integration suite in worker.integration.test.mjs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAiAcquire,
  applyAiSlotRelease,
  applyAiTokenRecord,
  emptyAiUsageState,
  nextUtcMidnight,
  normalizeAiUsageState,
  pruneExpiredSlots,
  utcDayOf,
} from '../src/durable-objects/aiUsageState.ts';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0); // 2026-11-19T12:00:00Z
const NEXT_MIDNIGHT = Date.UTC(2026, 10, 20); // 2026-11-20T00:00:00Z
const LEASE_MS = 10 * 60_000;

const LIMITS = {
  requestsPerDay: 3,
  tokensPerDay: 1_000,
  concurrentTurns: 2,
  turnLeaseMs: LEASE_MS,
};

let idCounter = 0;
const deterministicId = () => `slot-${++idCounter}`;

function acquire(state, overrides = {}, slot = true) {
  return applyAiAcquire(state, { now: NOW, ...LIMITS, slot, ...overrides }, deterministicId);
}

describe('aiUsageState acquire', () => {
  it('charges one request per admitted turn and tracks the remaining budget', () => {
    const first = acquire(null);
    assert.equal(first.decision.allowed, true);
    assert.equal(first.decision.slotId, 'slot-1');
    assert.equal(first.state.requests, 1);
    assert.equal(first.decision.remainingRequests, 2);
    assert.equal(first.decision.resetAt, NEXT_MIDNIGHT);

    const second = acquire(first.state);
    assert.equal(second.decision.allowed, true);
    assert.equal(second.state.requests, 2);
    assert.equal(second.state.slots.length, 2);
    assert.equal(second.state.slots[1].expiresAt, NOW + LEASE_MS);
  });

  it('rejects with reason budget once the daily request count is reached', () => {
    let state = null;
    for (let i = 0; i < LIMITS.requestsPerDay; i++) {
      // Sequential turns settle: release the slot so the next acquire is
      // only budget-bound (the cap is covered by its own test below).
      const granted = acquire(state);
      assert.equal(granted.decision.allowed, true);
      state = applyAiSlotRelease(granted.state, NOW, granted.decision.slotId);
    }
    assert.equal(state.requests, LIMITS.requestsPerDay);
    assert.equal(state.slots.length, 0);

    const exhausted = acquire(state);
    assert.equal(exhausted.decision.allowed, false);
    assert.equal(exhausted.decision.reason, 'budget');
    assert.equal(exhausted.decision.resetAt, NEXT_MIDNIGHT);
    assert.equal(exhausted.decision.retryAfterSeconds, Math.ceil((NEXT_MIDNIGHT - NOW) / 1000));
    // A rejection never charges.
    assert.equal(exhausted.state.requests, LIMITS.requestsPerDay);
  });

  it('rejects with reason budget when reported tokens exceed the daily token budget', () => {
    const first = acquire(null);
    const charged = applyAiTokenRecord(first.state, NOW, LIMITS.tokensPerDay);
    assert.equal(charged.tokens, LIMITS.tokensPerDay);

    const rejected = acquire(charged);
    assert.equal(rejected.decision.allowed, false);
    assert.equal(rejected.decision.reason, 'budget');
    // The over-budget token record itself is kept.
    assert.equal(rejected.state.tokens, LIMITS.tokensPerDay);
  });

  it('rejects with reason concurrency when all turn slots are in flight', () => {
    const twoInFlight = acquire(acquire(null).state);
    assert.equal(twoInFlight.decision.allowed, true);

    const contended = acquire(twoInFlight.state);
    assert.equal(contended.decision.allowed, false);
    assert.equal(contended.decision.reason, 'concurrency');
    assert.equal(contended.decision.resetAt, NOW + LEASE_MS);
    assert.equal(contended.decision.retryAfterSeconds, Math.ceil(LEASE_MS / 1000));
    // No request charged for a turn that never started.
    assert.equal(contended.state.requests, 2);
  });

  it('slot-less acquires (image analysis) bypass the concurrency cap but still charge the budget', () => {
    let state = null;
    for (let i = 0; i < 5; i++) {
      const next = acquire(state, { requestsPerDay: 10 }, false);
      assert.equal(next.decision.allowed, true);
      assert.equal(next.decision.slotId, null);
      assert.equal(next.state.slots.length, 0);
      state = next.state;
    }
    assert.equal(state.requests, 5);
  });

  it('reclaims a stale slot (crashed turn) once its lease expires', () => {
    const held = acquire(null).state;
    assert.equal(held.slots.length, 1);
    const crashedSlotId = held.slots[0].id;

    // The turn "crashes": no release ever happens; time moves past the lease.
    const afterLease = held.slots[0].expiresAt + 1;
    const nextTurn = applyAiAcquire(
      held,
      { now: afterLease, ...LIMITS, slot: true },
      deterministicId,
    );
    // The stale slot was pruned instead of counted against the cap.
    assert.equal(nextTurn.decision.allowed, true);
    assert.equal(nextTurn.state.slots.length, 1);
    assert.notEqual(nextTurn.state.slots[0].id, crashedSlotId);
    assert.ok(nextTurn.state.slots[0].expiresAt > afterLease);
  });

  it('keeps in-flight slots across the UTC-day rollover while resetting the budget', () => {
    // A lease long enough to still be live after midnight.
    const held = acquire(null, { turnLeaseMs: 24 * 60 * 60_000 }).state;
    const nextDay = NEXT_MIDNIGHT + 5 * 60_000;

    const nextDayAcquire = applyAiAcquire(held, { now: nextDay, ...LIMITS, slot: true }, deterministicId);
    assert.equal(nextDayAcquire.state.day, utcDayOf(nextDay));
    assert.equal(nextDayAcquire.state.requests, 1, 'budget counters reset for the new day');
    // The midnight-crossing turn's slot survives the day roll (the second
    // slot is the new turn's own).
    assert.equal(nextDayAcquire.state.slots.length, 2);
    assert.deepEqual(nextDayAcquire.state.slots[0], held.slots[0]);
    assert.equal(nextDayAcquire.decision.allowed, true);
  });
});

describe('aiUsageState record + release', () => {
  it('records provider-reported tokens into the current day', () => {
    const granted = acquire(null).state;
    const recorded = applyAiTokenRecord(granted, NOW, 250);
    assert.equal(recorded.tokens, 250);
    assert.equal(recorded.requests, 1);
    assert.equal(recorded.slots.length, 1);
  });

  it('ignores non-positive or invalid token reports', () => {
    const granted = acquire(null).state;
    for (const bad of [0, -5, Number.NaN]) {
      assert.deepEqual(applyAiTokenRecord(granted, NOW, bad), granted);
    }
  });

  it('releases a slot by id and ignores unknown or duplicate releases', () => {
    const granted = acquire(null).state;
    const released = applyAiSlotRelease(granted, NOW, granted.slots[0].id);
    assert.equal(released.slots.length, 0);
    // Duplicate release: no-op.
    assert.deepEqual(applyAiSlotRelease(released, NOW, granted.slots[0].id), released);
    // Unknown slot: no-op.
    assert.deepEqual(applyAiSlotRelease(released, NOW, 'never-existed'), released);
  });

  it('release still works when the day rolled since the slot was taken', () => {
    const granted = acquire(null).state;
    const nextDay = NEXT_MIDNIGHT + 60_000;
    const released = applyAiSlotRelease(granted, nextDay, granted.slots[0].id);
    assert.equal(released.slots.length, 0, 'the midnight-crossing slot is released');
    // The day roll normalized the state to the new day (counters reset);
    // the release itself must not resurrect yesterday's counters.
    assert.equal(released.day, utcDayOf(nextDay));
    assert.equal(released.requests, 0);
  });
});

describe('aiUsageState helpers', () => {
  it('prunes only slots whose lease has expired', () => {
    const slots = [
      { id: 'live', expiresAt: NOW + 1 },
      { id: 'dead', expiresAt: NOW },
    ];
    assert.deepEqual(pruneExpiredSlots(slots, NOW), [{ id: 'live', expiresAt: NOW + 1 }]);
  });

  it('normalizes null state to a fresh day with zero counters', () => {
    const fresh = normalizeAiUsageState(null, NOW);
    assert.deepEqual(fresh, { day: utcDayOf(NOW), requests: 0, tokens: 0, slots: [] });
    assert.deepEqual(emptyAiUsageState(NOW), fresh);
  });

  it('computes the next UTC midnight after any intra-day timestamp', () => {
    assert.equal(nextUtcMidnight(NOW), NEXT_MIDNIGHT);
    assert.equal(nextUtcMidnight(NEXT_MIDNIGHT), Date.UTC(2026, 10, 21), 'midnight itself rolls to the next day');
  });
});
