// The hourly ledger behind the Shift Report.
//
// WHY THE ARITHMETIC IS DIFFERENCES AND NOT COUNTING. Every figure on a receipt is
// `lifetime accumulator now − lifetime accumulator at the last hour boundary`. The
// accumulators are monotone integers that live inside `WorldState` and inside `hashState()`
// (see the header of `packages/sim/src/stats.ts` — that placement is a one-way door, and
// this file exists partly so nobody is ever tempted to move them out for tidiness).
// Differencing them means the buckets TELESCOPE: however the sampling cadence lands
// relative to an hour boundary, the buckets always sum to the lifetime total exactly. A
// ledger that counted its own sale events instead would drift a little every hour, and a
// drifting ledger teaches the player something false about their own factory — which is
// worse than no ledger at all, because they will believe it.
//
// TWO BRANCHES, AND THE FIRST ONE WINS. Work item 033 wants these buckets inside
// `WorldStats`, in the hash, where they survive a reload for free and where a later
// refactor cannot silently change what a receipt says. That is the right home and it is not
// this one. So the moment `view.stats.hours` exists, `read()` adopts it and NOTHING BELOW
// RUNS — the same two-branch shape `hud/rate.ts` uses, written by the same constraint:
// another agent owns `packages/sim` and is expanding it right now.
//
// Until then this is a display-side reconstruction of sim-owned quantities, keyed by SIM
// TICK and never by wall clock, so two machines running the same world at different frame
// rates bucket the same earnings into the same hour.
//
// ONE ATTRIBUTION ERROR, STATED. The hour boundary is noticed at the next publish, up to
// five ticks late, so at most a quarter-second of earnings lands in the hour that just
// closed rather than the one that just opened. Five ticks in seventy-two thousand. The
// totals still telescope exactly; only the boundary is fuzzy, and it stops being fuzzy the
// day branch one lights up.

import { TICKS_PER_ACTIVE_HOUR } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { MIN_RATE_SPAN_TICKS, centsPerActiveHour } from './rate';
import { readGrossAndSpend, readHourBuckets } from './sim-contract';
import { ZERO_BUCKET } from './types';
import type { ShiftBucket } from './types';

/**
 * Closed hours kept. Bounded on purpose: work item 033's constraint is that bucket arrays
 * are capped the way `netWorthSamples` is, because unbounded arrays in a persisted payload
 * are exactly how a local-first game grows a 40 MB save one quiet afternoon at a time.
 */
export const SHIFT_HISTORY_LIMIT = 24;

/** What survives a reload. Written to IndexedDB by `persist.ts`, keyed to the world. */
export interface PersistedLedger {
  readonly hour: number;
  readonly markTick: number;
  readonly markNetCents: number;
  readonly markEarnedCents: number;
  readonly markSpentCents: number;
  readonly markWaterMl: number;
  readonly markItemsSold: number;
  readonly history: readonly ShiftBucket[];
  readonly bestCentsPerHour: number;
}

export class ShiftLedger {
  private hour = -1;
  private markTick = 0;
  private markNetCents = 0;
  private markEarnedCents = 0;
  private markSpentCents = 0;
  private markWaterMl = 0;
  private markItemsSold = 0;

  private history: ShiftBucket[] = [];
  private best = 0;
  private currentBucket: ShiftBucket = ZERO_BUCKET;
  private adopted = false;
  private revision = 0;

  get current(): ShiftBucket {
    return this.currentBucket;
  }

  get closed(): readonly ShiftBucket[] {
    return this.history;
  }

  /**
   * Bumped whenever `closed` gains or loses an entry.
   *
   * `closed` hands back the SAME array every call, because the ledger mutates it in place —
   * which means a store comparing it by reference would never see an hour close. The
   * revision is how the store knows to take a fresh copy, and it exists because the
   * alternative (allocating a copy on every read) allocates twenty-four objects seven times
   * a second to detect a change that happens once an hour.
   */
  get historyRevision(): number {
    return this.revision;
  }

  get bestCentsPerHour(): number {
    return this.best;
  }

  /** 1 once the sim projects its own buckets and this class has stopped computing. */
  get simOwned(): boolean {
    return this.adopted;
  }

  /** A new world, or a host handing the store over. Forget everything. */
  reset(): void {
    this.hour = -1;
    this.markTick = 0;
    this.markNetCents = 0;
    this.markEarnedCents = 0;
    this.markSpentCents = 0;
    this.markWaterMl = 0;
    this.markItemsSold = 0;
    this.history = [];
    this.best = 0;
    this.currentBucket = ZERO_BUCKET;
    this.adopted = false;
    this.revision += 1;
  }

  /**
   * Restore from storage.
   *
   * The saved marks are only adopted when the world is still on the hour they were taken
   * in. Restored into a different hour they would attribute somebody else's earnings to the
   * current bucket, and a receipt that is wrong is worth less than a receipt that is
   * missing. A mismatch keeps the closed history — which is still true — and re-marks the
   * hour in progress from wherever the world actually is.
   */
  hydrate(saved: PersistedLedger, currentTick: number): void {
    this.history = saved.history.slice(-SHIFT_HISTORY_LIMIT);
    this.best = saved.bestCentsPerHour;
    this.revision += 1;

    const hourNow = Math.floor(currentTick / TICKS_PER_ACTIVE_HOUR);
    if (saved.hour === hourNow && saved.markTick <= currentTick) {
      this.hour = saved.hour;
      this.markTick = saved.markTick;
      this.markNetCents = saved.markNetCents;
      this.markEarnedCents = saved.markEarnedCents;
      this.markSpentCents = saved.markSpentCents;
      this.markWaterMl = saved.markWaterMl;
      this.markItemsSold = saved.markItemsSold;
    } else {
      this.hour = -1;
    }
  }

  toPersisted(): PersistedLedger {
    return {
      hour: this.hour,
      markTick: this.markTick,
      markNetCents: this.markNetCents,
      markEarnedCents: this.markEarnedCents,
      markSpentCents: this.markSpentCents,
      markWaterMl: this.markWaterMl,
      markItemsSold: this.markItemsSold,
      history: this.history,
      bestCentsPerHour: this.best,
    };
  }

  /**
   * Fold one world reading in. Returns true when something a panel renders actually moved,
   * so the store can skip rebuilding a slice nobody would see change.
   */
  read(view: WorldView): boolean {
    const provided = readHourBuckets(view);
    if (provided !== null) return this.adopt(provided);

    const stats = view.stats;
    const tick = view.tick;
    const hour = Math.floor(tick / TICKS_PER_ACTIVE_HOUR);

    const net = stats.lifetimeNetEarningsCents;
    const split = readGrossAndSpend(view);
    const earned = split === null ? 0 : split.earned;
    const spent = split === null ? 0 : split.spent;

    // A rewound world — a restored save, a fresh seed — resets rather than spanning the
    // gap, and so does a jump of more than one hour, which no live tick loop can produce.
    if (this.hour < 0 || tick < this.markTick || hour > this.hour + 1) {
      this.mark(hour, tick, net, earned, spent, stats.waterDrawnMl, stats.itemsSold);
      return this.rebuild(
        tick,
        net,
        earned,
        spent,
        stats.waterDrawnMl,
        stats.itemsSold,
        split !== null,
      );
    }

    if (hour > this.hour) {
      this.close(tick, net, earned, spent, stats.waterDrawnMl, stats.itemsSold, split !== null);
      this.mark(hour, tick, net, earned, spent, stats.waterDrawnMl, stats.itemsSold);
      return true;
    }

    return this.rebuild(
      tick,
      net,
      earned,
      spent,
      stats.waterDrawnMl,
      stats.itemsSold,
      split !== null,
    );
  }

  /** Branch 1: the sim owns the buckets. Nothing in the fallback path runs again. */
  private adopt(buckets: readonly HourBucketLike[]): boolean {
    this.adopted = true;
    const closed: ShiftBucket[] = [];
    let current = ZERO_BUCKET;
    let best = 0;

    for (let i = 0; i < buckets.length; i++) {
      const raw = buckets[i]!;
      const complete = raw.ticks >= TICKS_PER_ACTIVE_HOUR ? 1 : 0;
      const bucket: ShiftBucket = Object.freeze({
        hour: raw.hour,
        netCents: raw.grossCents - raw.spendCents,
        grossCents: raw.grossCents,
        spendCents: raw.spendCents,
        split: 1,
        waterMl: raw.waterMl,
        itemsSold: raw.itemsSold,
        ticks: raw.ticks,
        complete,
      });
      if (complete === 1) {
        closed.push(bucket);
        const rate = centsPerActiveHour(bucket.netCents, bucket.ticks);
        if (rate > best) best = rate;
      } else {
        current = bucket;
      }
    }

    const changed =
      current.netCents !== this.currentBucket.netCents ||
      current.hour !== this.currentBucket.hour ||
      closed.length !== this.history.length ||
      best !== this.best;

    if (closed.length !== this.history.length) this.revision += 1;
    this.history = closed.slice(-SHIFT_HISTORY_LIMIT);
    this.currentBucket = current;
    this.best = best;
    return changed;
  }

  private mark(
    hour: number,
    tick: number,
    net: number,
    earned: number,
    spent: number,
    waterMl: number,
    itemsSold: number,
  ): void {
    this.hour = hour;
    this.markTick = tick;
    this.markNetCents = net;
    this.markEarnedCents = earned;
    this.markSpentCents = spent;
    this.markWaterMl = waterMl;
    this.markItemsSold = itemsSold;
  }

  private close(
    tick: number,
    net: number,
    earned: number,
    spent: number,
    waterMl: number,
    itemsSold: number,
    split: boolean,
  ): void {
    const bucket = this.bucket(tick, net, earned, spent, waterMl, itemsSold, split, 1);
    this.history.push(bucket);
    while (this.history.length > SHIFT_HISTORY_LIMIT) this.history.shift();
    this.revision += 1;

    // Only a bucket wide enough to mean something can set a record. An hour that began
    // three minutes ago because the player reloaded is not a $9,000/hr shift, and a board
    // that says it is has spent its credibility on a rounding artefact.
    if (bucket.ticks >= MIN_RATE_SPAN_TICKS) {
      const rate = centsPerActiveHour(bucket.netCents, bucket.ticks);
      if (rate > this.best) this.best = rate;
    }
  }

  private rebuild(
    tick: number,
    net: number,
    earned: number,
    spent: number,
    waterMl: number,
    itemsSold: number,
    split: boolean,
  ): boolean {
    const next = this.bucket(tick, net, earned, spent, waterMl, itemsSold, split, 0);
    const previous = this.currentBucket;
    if (
      previous.hour === next.hour &&
      previous.netCents === next.netCents &&
      previous.grossCents === next.grossCents &&
      previous.spendCents === next.spendCents &&
      previous.waterMl === next.waterMl &&
      previous.itemsSold === next.itemsSold
    ) {
      // The tick moved but no money did. Keeping the old object means the store keeps the
      // old slice, which means React does nothing — the whole point of the version dance.
      return false;
    }
    this.currentBucket = next;
    return true;
  }

  private bucket(
    tick: number,
    net: number,
    earned: number,
    spent: number,
    waterMl: number,
    itemsSold: number,
    split: boolean,
    complete: number,
  ): ShiftBucket {
    return Object.freeze({
      hour: this.hour,
      netCents: net - this.markNetCents,
      grossCents: split ? earned - this.markEarnedCents : 0,
      spendCents: split ? spent - this.markSpentCents : 0,
      split: split ? 1 : 0,
      waterMl: waterMl - this.markWaterMl,
      itemsSold: itemsSold - this.markItemsSold,
      ticks: tick - this.markTick,
      complete,
    });
  }
}

/** Structural, so `adopt()` does not import a named type it only reads five fields from. */
interface HourBucketLike {
  readonly hour: number;
  readonly grossCents: number;
  readonly spendCents: number;
  readonly waterMl: number;
  readonly itemsSold: number;
  readonly ticks: number;
}
