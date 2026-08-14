// The cheap structural gates for the reports layer.
//
// Verification here is deliberately light (AGENTS.md: "if it works, it works"), so this pins
// only the things that fail QUIETLY — where the game keeps running and a number on a receipt
// is simply wrong, which is the one failure mode this whole feature cannot afford:
//
//   · THE DAY CONSTANTS AGREE WITH THE RENDERER'S. `day.ts` restates `TICKS_PER_DAY` and the
//     phase offset rather than importing them, because the module that owns them also loads
//     Pixi and these render outside the `ssr: false` boundary. Restating invites drift, so
//     the drift is converted into a test failure: if somebody retunes the day length in one
//     place, this goes red instead of the Dawn Report firing at three in the afternoon.
//   · THE LEDGER TELESCOPES. Bucket sums must equal the lifetime total exactly, whatever the
//     sampling cadence did at the hour boundary. This is the property the whole design rests
//     on and it is invisible when it breaks — the numbers stay plausible and stop adding up.
//   · FIRST TEN FREEZES. Plan §7 ruling 4 makes it "lifetime net earnings AT ten active
//     hours"; a First Ten that keeps climbing afterwards is the Dynasty board with a longer
//     name, and nothing on screen would say so.
//   · BOUTIQUE'S ENTRY FLOOR HOLDS. A one-machine world topping a per-machine board by
//     arithmetic is exactly the failure §6's floor exists to prevent.
//
// Everything under test is pure. No DOM, no React, no IndexedDB.

import { describe, expect, it } from 'vitest';
import { TICKS_PER_ACTIVE_HOUR, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { TICKS_PER_DAY, dawnCount, dayNumber, dayPhase } from './day';
import {
  BOUTIQUE_MIN_MACHINES,
  deriveBoards,
  emptyBests,
  foldBests,
  readBoardValues,
} from './boards';
import { centsPerActiveHour } from './rate';
import { ShiftLedger } from './shift';

// The module that actually owns the day. Importing it pulls Pixi, which is fine in a test
// and is the entire reason `day.ts` does not do it in the bundle.
import {
  TICKS_PER_DAY as RENDER_TICKS_PER_DAY,
  dayPhase as renderDayPhase,
} from '../game/render/pixel';

describe('the day agrees with the renderer', () => {
  it('has the same day length', () => {
    expect(TICKS_PER_DAY).toBe(RENDER_TICKS_PER_DAY);
  });

  it('has the same phase at every point across two days', () => {
    for (let tick = 0; tick < TICKS_PER_DAY * 2; tick += 37) {
      expect(dayPhase(tick)).toBeCloseTo(renderDayPhase(tick), 10);
    }
  });

  it('puts dawn at 06:00', () => {
    // The first dawn is the first tick the count moves. Its phase must be a quarter of the
    // way through the day — midnight is 0, midday is 0.5, so 06:00 is 0.25.
    let firstDawn = -1;
    for (let tick = 1; tick < TICKS_PER_DAY * 2; tick++) {
      if (dawnCount(tick) > dawnCount(tick - 1)) {
        firstDawn = tick;
        break;
      }
    }
    expect(firstDawn).toBeGreaterThan(0);
    expect(dayPhase(firstDawn)).toBeCloseTo(0.25, 6);
  });

  it('numbers the dawn the same day the on-screen clock is showing', () => {
    // `render/hud.ts`'s clock says "day N"; the Dawn Report's heading must not contradict
    // the clock sitting beside it on the same screen.
    for (let dawn = 1; dawn <= 6; dawn++) {
      let tick = -1;
      for (let t = 1; t < TICKS_PER_DAY * 8; t++) {
        if (dawnCount(t) === dawn && dawnCount(t - 1) === dawn - 1) {
          tick = t;
          break;
        }
      }
      expect(tick).toBeGreaterThan(0);
      expect(dayNumber(tick)).toBe(dawn);
    }
  });
});

/** A projection with just the stats fields the ledger and the boards read. */
function viewWith(fields: {
  tick: number;
  netCents?: number;
  waterMl?: number;
  itemsSold?: number;
  peakNetWorthCents?: number;
  bestTrailingFiveHourGainCents?: number;
  machines?: number;
}): WorldView {
  const view = createWorldView();
  // The sim's view buffer now always carries `stats.hours` (item 062), and `read()` adopts
  // them the moment they exist. These tests pin the display-side fallback, which only runs
  // while the projection provides none — so the buffer's empty array is stripped here.
  (view as { stats: { hours?: unknown } }).stats.hours = undefined;
  view.tick = fields.tick;
  view.stats.lifetimeNetEarningsCents = fields.netCents ?? 0;
  view.stats.waterDrawnMl = fields.waterMl ?? 0;
  view.stats.itemsSold = fields.itemsSold ?? 0;
  view.stats.peakNetWorthCents = fields.peakNetWorthCents ?? 0;
  view.stats.bestTrailingFiveHourGainCents = fields.bestTrailingFiveHourGainCents ?? 0;
  view.stats.centiActiveHours = Math.floor((fields.tick * 100) / TICKS_PER_ACTIVE_HOUR);
  view.machines = [];
  for (let i = 0; i < (fields.machines ?? 0); i++) {
    // Kind 4 (Washer) rather than 1 (SellBin): the bin was a gift and Boutique excludes it.
    //
    // Cast rather than a full literal, deliberately. `readBoardValues` reads exactly one
    // field off a machine — its kind — so pinning `MachineView`'s entire shape here would
    // buy nothing and would break this test every time another agent adds a projection
    // field, which is happening in this repository right now.
    view.machines.push({ id: i + 1, kind: 4 } as unknown as (typeof view.machines)[number]);
  }
  return view;
}

describe('the shift ledger', () => {
  it('telescopes: the buckets always sum to the lifetime total', () => {
    const ledger = new ShiftLedger();

    // Three hours of earnings, sampled on a cadence that never lands on an hour boundary —
    // which is the realistic case and the one a counting ledger gets wrong.
    let earned = 0;
    const perStep = 137;
    // The bound overshoots the third boundary deliberately: an hour closes on the first
    // reading PAST it, and a loop that stops exactly on the boundary never delivers one.
    for (let tick = 0; tick <= TICKS_PER_ACTIVE_HOUR * 3 + 100; tick += 7) {
      earned += perStep;
      ledger.read(viewWith({ tick, netCents: earned }));
    }

    let summed = 0;
    for (const bucket of ledger.closed) summed += bucket.netCents;
    summed += ledger.current.netCents;

    // Every cent that entered the world is in exactly one bucket. Not approximately.
    expect(summed).toBe(earned - perStep);
    expect(ledger.closed.length).toBe(3);
  });

  it('starts a fresh bucket rather than spanning a rewound world', () => {
    const ledger = new ShiftLedger();
    ledger.read(viewWith({ tick: 5_000, netCents: 90_000 }));
    ledger.read(viewWith({ tick: 5_100, netCents: 95_000 }));
    expect(ledger.current.netCents).toBe(5_000);

    // A restored save, or a new seed: the tick goes backwards. Spanning the gap would
    // attribute a whole previous session's earnings to the first ten seconds of this one.
    ledger.read(viewWith({ tick: 40, netCents: 0 }));
    expect(ledger.current.netCents).toBe(0);
  });

  it('does not let a three-minute hour set the rolling best', () => {
    const ledger = new ShiftLedger();
    // Join late in hour 0 with a big number, then cross into hour 1. The closed bucket is
    // real but far too short to quote a rate from — an hour that began three minutes ago is
    // not a $9,000/hr shift.
    ledger.read(viewWith({ tick: TICKS_PER_ACTIVE_HOUR - 600, netCents: 0 }));
    ledger.read(viewWith({ tick: TICKS_PER_ACTIVE_HOUR + 10, netCents: 500_000 }));
    expect(ledger.bestCentsPerHour).toBe(0);
  });
});

describe('the boards', () => {
  it('freezes First Ten at ten active hours', () => {
    const atTen = TICKS_PER_ACTIVE_HOUR * 10;
    const before = readBoardValues(viewWith({ tick: atTen - 1, netCents: 500_000 }), -1);
    expect(before.firstTenFinal).toBe(0);

    const crossing = readBoardValues(viewWith({ tick: atTen, netCents: 500_000 }), -1);
    expect(crossing.firstTenFinal).toBe(1);
    expect(crossing.firstTenCents).toBe(500_000);

    // Two hours later, with the frozen value passed back in as the store does: the score
    // must not have moved, or First Ten is just Dynasty with a longer name (§7 ruling 4).
    const later = readBoardValues(
      viewWith({ tick: atTen + TICKS_PER_ACTIVE_HOUR * 2, netCents: 9_000_000 }),
      500_000,
    );
    expect(later.firstTenCents).toBe(500_000);
  });

  it('reads lifetime net earnings and never cash on hand', () => {
    const view = viewWith({ tick: TICKS_PER_ACTIVE_HOUR * 10, netCents: 12_345 });
    // Cash on hand is deliberately set to something else entirely. Reading it would be
    // §7 ruling 4's exact mistake and would reward a player for sitting on their money.
    view.moneyCents = 999_999;
    expect(readBoardValues(view, -1).firstTenCents).toBe(12_345);
  });

  it('holds Boutique behind its entry floor', () => {
    const gain = 1_000_000;
    const tiny = readBoardValues(
      viewWith({ tick: 1000, bestTrailingFiveHourGainCents: gain, machines: 1 }),
      -1,
    );
    expect(tiny.boutiqueCentsPerHour).toBe(0);
    expect(deriveBoards(tiny, emptyBests()).find((r) => r.id === 'boutique')?.eligible).toBe(0);

    // A one-machine world must not be able to set the record either — the floor has to hold
    // in `foldBests`, not only in the display, or the board remembers a score nobody scored.
    const bests = emptyBests();
    foldBests(bests, tiny);
    expect(bests.boutiqueCentsPerHour).toBe(0);

    const full = readBoardValues(
      viewWith({
        tick: 1000,
        bestTrailingFiveHourGainCents: gain,
        machines: BOUTIQUE_MIN_MACHINES,
      }),
      -1,
    );
    expect(full.boutiqueCentsPerHour).toBeGreaterThan(0);
  });

  it('only records a First Ten that is final', () => {
    const bests = emptyBests();
    const early = readBoardValues(viewWith({ tick: 60_000, netCents: 800_000 }), -1);
    foldBests(bests, early);
    expect(bests.firstTenCents).toBe(0);
  });
});

describe('there is one $/hour function', () => {
  it('scales a gain to a full active hour', () => {
    expect(centsPerActiveHour(1000, TICKS_PER_ACTIVE_HOUR)).toBe(1000);
    expect(centsPerActiveHour(1000, TICKS_PER_ACTIVE_HOUR / 2)).toBe(2000);
  });

  it('returns zero for an empty span rather than infinity', () => {
    // An `Infinity` reaching a DOM node renders as the word "Infinity" in a receipt.
    expect(centsPerActiveHour(1000, 0)).toBe(0);
  });
});

// --- the store, driven across a dawn ------------------------------------------------
//
// The Dawn Report is the one piece of this feature whose trigger a person cannot reasonably
// sit and wait for — dawn is seven real minutes into a fresh world — so it is driven here
// instead. What is being pinned is the behaviour that would be embarrassing rather than
// merely wrong: a card that fires on the first publish of a restored save (nine days of
// backlog at once), a card that never clears, and a flag that accuses a machine which was
// never running of costing money it never could have made.

import { reportsStore } from './store';
import { DAWN_TICK_IN_DAY } from './day';

/** A machine view with the four fields `IdleWatch` actually reads. */
function machine(id: number, kind: number, lamp: number, progressPermille: number): unknown {
  return { id, kind, lamp, progressPermille };
}

function publish(token: object, view: WorldView): void {
  reportsStore.publishWorld(token, view);
}

describe('the reports store across a dawn', () => {
  it('does not fire a card on the first publish of a world that is already past dawn', () => {
    const token = {};
    reportsStore.claim(token, 12345);
    // A save restored mid-afternoon on day nine. Firing here would open the session with a
    // report about a day the player did not play.
    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY * 9 + 500, netCents: 100_000 }));
    expect(reportsStore.getSnapshot().dawn.card).toBeNull();
    reportsStore.release(token);
  });

  it('fires once at dawn and clears itself five seconds later', () => {
    const token = {};
    reportsStore.claim(token, 4242);

    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY - 60, netCents: 10_000 }));
    expect(reportsStore.getSnapshot().dawn.card).toBeNull();

    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY + 3, netCents: 34_000 }));
    const card = reportsStore.getSnapshot().dawn.card;
    expect(card).not.toBeNull();
    // The day's earnings are the difference since the session's mark, to the cent.
    expect(card?.netCents).toBe(24_000);
    expect(card?.day).toBe(1);

    // Four seconds later it is still up; five seconds later it is gone. Counted in ticks by
    // the store, from the loop that is already running — there is no timer anywhere.
    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY + 83, netCents: 34_000 }));
    expect(reportsStore.getSnapshot().dawn.card).not.toBeNull();
    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY + 110, netCents: 34_000 }));
    expect(reportsStore.getSnapshot().dawn.card).toBeNull();

    reportsStore.release(token);
  });

  it('dismisses early, for free, without touching the world', () => {
    const token = {};
    reportsStore.claim(token, 77);
    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY - 60 }));
    publish(token, viewWith({ tick: DAWN_TICK_IN_DAY + 3 }));
    expect(reportsStore.getSnapshot().dawn.card).not.toBeNull();
    reportsStore.dismissDawn();
    expect(reportsStore.getSnapshot().dawn.card).toBeNull();
    reportsStore.release(token);
  });

  it('flags the idle machine in cash, and only after a minute of it', () => {
    const token = {};
    reportsStore.claim(token, 909);

    // A Fryer (kind 6) that ran, completed operations, and then starved. Progress falling is
    // how an operation is counted; the lamp is how idleness is.
    const withFryer = (tick: number, lamp: number, progress: number): WorldView => {
      const view = viewWith({ tick });
      view.machines = [machine(1, 6, lamp, progress) as (typeof view.machines)[number]];
      return view;
    };

    let tick = 0;
    publish(token, withFryer(tick, 1, 0));
    // Sixty seconds of real work: twenty operations, each seen as progress falling.
    for (let op = 0; op < 20; op++) {
      publish(token, withFryer((tick += 30), 1, 900));
      publish(token, withFryer((tick += 30), 1, 100));
    }
    // Then starved, for well over the sixty seconds plan §5 requires before saying anything.
    const beforeThreshold = tick + 600;
    publish(token, withFryer(beforeThreshold, 2, 100));
    // Half a minute in, the game says nothing. That restraint is the design.
    expect(reportsStore.getSnapshot().dawn.card).toBeNull();

    // Cross a dawn with the machine still starved for two minutes.
    const dawn = DAWN_TICK_IN_DAY;
    publish(token, withFryer(dawn - 1, 2, 100));
    publish(token, withFryer(dawn + 3, 2, 100));

    const flag = reportsStore.getSnapshot().dawn.card?.flag;
    expect(flag).not.toBeNull();
    expect(flag?.text).toContain('Fryer A');
    // Priced at what it actually earned while running, not at its rated throughput — see
    // the header of `idle.ts` for why the rated figure is wrong by an order of magnitude.
    expect(flag?.costCents).toBeGreaterThan(0);

    reportsStore.release(token);
  });

  it('ignores a publish from a host that no longer owns the store', () => {
    const live = {};
    const stale = {};
    reportsStore.claim(live, 1);
    publish(stale, viewWith({ tick: DAWN_TICK_IN_DAY + 3, netCents: 999_999 }));
    // A StrictMode-orphaned host publishing into the live store is the bug the token dance
    // exists to prevent, and it would show up as somebody else's numbers on your receipt.
    expect(reportsStore.getSnapshot().dawn.card).toBeNull();
    reportsStore.release(live);
  });
});
