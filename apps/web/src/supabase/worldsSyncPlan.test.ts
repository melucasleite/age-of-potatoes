// The picker reconciliation's decisions ([[143]]), pinned where they can fail quietly.
//
// What this file is FOR: the reconciliation's network shell is thin on purpose, and every
// choice that could misfile a farm funnels through these three functions. A wrong
// `planWorldRowSync` silently overwrites a further-along save in one direction or the
// other; a wrong `chooseLegacyAdoptionTarget` files the pre-143 shared row under somebody
// else's lot. Both are invisible from the outside — every world still loads — which is
// exactly the kind of thing worth a test with no network anywhere near it.

import { describe, expect, it } from 'vitest';

import { chooseLegacyAdoptionTarget, planLegacyRowMerge, planWorldRowSync } from './worldsSyncPlan';

describe('planWorldRowSync', () => {
  it('does nothing when neither side has a save', () => {
    expect(planWorldRowSync(null, null)).toBe('none');
  });

  it('pulls when only the cloud has one — the new-device case', () => {
    expect(planWorldRowSync(null, 4_800)).toBe('pull');
  });

  it('pushes when only this device has one — the lot the cloud never saw', () => {
    expect(planWorldRowSync(2_400, null)).toBe('push');
  });

  it('pushes when local is further along', () => {
    expect(planWorldRowSync(9_600, 1_200)).toBe('push');
  });

  it('pulls when the cloud is further along', () => {
    expect(planWorldRowSync(1_200, 9_600)).toBe('pull');
  });

  it('keeps local on a tie — same lineage, same moment, no churn', () => {
    expect(planWorldRowSync(7_200, 7_200)).toBe('none');
  });

  it('treats tick zero as a real local save, not as nothing', () => {
    // A lot saved at tick 0 exists; only `null` means "no envelope at all".
    expect(planWorldRowSync(0, null)).toBe('push');
    expect(planWorldRowSync(0, 100)).toBe('pull');
  });
});

describe('chooseLegacyAdoptionTarget', () => {
  const lots = [
    { id: 'aaaa1111', seed: 42, summaryTick: 5_000 },
    { id: 'bbbb2222', seed: 7, summaryTick: 100 },
  ];

  it('matches the row to the lot with the same seed', () => {
    expect(chooseLegacyAdoptionTarget({ worldSeed: 7, tick: 90 }, lots)).toBe('bbbb2222');
  });

  it('answers null when no lot carries the seed — the row stays put', () => {
    expect(chooseLegacyAdoptionTarget({ worldSeed: 999, tick: 90 }, lots)).toBe(null);
  });

  it('answers null for an empty picker', () => {
    expect(chooseLegacyAdoptionTarget({ worldSeed: 42, tick: 90 }, [])).toBe(null);
  });

  it('breaks a duplicate-seed tie by the nearest saved tick — same lineage, nearest moment', () => {
    const twins = [
      { id: 'old-copy', seed: 42, summaryTick: 1_000 },
      { id: 'new-copy', seed: 42, summaryTick: 8_000 },
    ];
    expect(chooseLegacyAdoptionTarget({ worldSeed: 42, tick: 7_500 }, twins)).toBe('new-copy');
    expect(chooseLegacyAdoptionTarget({ worldSeed: 42, tick: 1_200 }, twins)).toBe('old-copy');
  });
});

describe('planLegacyRowMerge', () => {
  it('takes the slot when the world has no row of its own yet', () => {
    expect(planLegacyRowMerge(5_000, null)).toBe('replace-slot');
  });

  it('takes the slot when the legacy copy is further along', () => {
    expect(planLegacyRowMerge(9_000, 5_000)).toBe('replace-slot');
  });

  it('only parks when the slot row is ahead — the newer save keeps its seat', () => {
    expect(planLegacyRowMerge(5_000, 9_000)).toBe('park-only');
  });

  it('only parks on a tie — same lineage at the same moment, and the slot row is already home', () => {
    expect(planLegacyRowMerge(5_000, 5_000)).toBe('park-only');
  });
});
