// The structural gate for §2's promotion whisper ([[040]]).
//
// The whisper's one hard requirement is that the comparison is COMPUTED — "you
// hand-harvested N this hour; the device would have done X" — and everything about that
// fails quietly:
//
//   · A BASELINE THAT NEVER RESETS turns "this hour" into "since install", and the note
//     inflates forever. The under-claiming discipline (derive-lot.ts's header) breaks in
//     the flattering direction, which is the direction nobody reports.
//   · A BASELINE THAT RESETS EVERY PUBLISH pins the count at zero and the whisper never
//     speaks — invisible, because the Clipboard has plenty else to say.
//   · SPEAKING TO A PLAYER WHO OWNS THE DOCK is the game selling somebody their own car.

import { describe, expect, it } from 'vitest';
import { ItemId, MachineKind, listPriceCents } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { HarvestPace, botCatchUpPhrase, createMachineCounts, deriveClipboard } from './derive';
import { formatCents } from './format';

function clipView(options: {
  harvested?: number;
  hour?: number;
  tick?: number;
  dock?: boolean;
}): WorldView {
  return {
    tick: options.tick ?? 0,
    moneyCents: 0,
    field: { crop: [], ready: [], dry: [] },
    inventory: [],
    machines: options.dock === true ? [{ kind: MachineKind.HarvesterDock }] : [],
    stats: {
      totalManualTouches: 0,
      longestHandsFreeTicks: 0,
      lifetimeNetEarningsCents: 0,
      itemsHarvestedByHand: options.harvested ?? 0,
      hours: [{ hour: options.hour ?? 0 }],
    },
  } as unknown as WorldView;
}

function whisperIn(view: WorldView, pace: HarvestPace): string | null {
  const notes = deriveClipboard(view, createMachineCounts(), pace);
  const note = notes.find((n) => n.id === 'bot-pace');
  return note === undefined ? null : note.text;
}

describe('the promotion whisper', () => {
  it('is silent on first sight of a world — the baseline is the current count', () => {
    const pace = new HarvestPace();
    expect(whisperIn(clipView({ harvested: 40 }), pace)).toBeNull();
  });

  it('speaks once a real hour of hand harvesting is on the books, with both computed halves', () => {
    const pace = new HarvestPace();
    whisperIn(clipView({ harvested: 40 }), pace);
    const text = whisperIn(clipView({ harvested: 55, tick: 100 }), pace);

    expect(text).not.toBeNull();
    expect(text).toContain('15 crops');
    expect(text).toContain('Harvester Dock');
    // The device's half is a computed duration, not a gesture at one.
    expect(text).toMatch(/in about .+ (seconds|minutes)/);
  });

  it('re-baselines when the hour rolls over — "this hour" means this hour', () => {
    const pace = new HarvestPace();
    whisperIn(clipView({ harvested: 0 }), pace);
    whisperIn(clipView({ harvested: 55, tick: 100 }), pace);
    // Dawn ledger closes the hour; the pulls belong to the closed page now.
    expect(whisperIn(clipView({ harvested: 55, hour: 1, tick: 200 }), pace)).toBeNull();
  });

  it('says nothing to a player who already owns the dock', () => {
    const pace = new HarvestPace();
    whisperIn(clipView({ harvested: 0 }), pace);
    expect(whisperIn(clipView({ harvested: 55, tick: 100, dock: true }), pace)).toBeNull();
  });

  it('does not compare a machine to four potatoes', () => {
    const pace = new HarvestPace();
    whisperIn(clipView({ harvested: 0 }), pace);
    expect(whisperIn(clipView({ harvested: 4, tick: 100 }), pace)).toBeNull();
  });

  it('resets across a world reload — backwards ticks discard the baseline', () => {
    const pace = new HarvestPace();
    whisperIn(clipView({ harvested: 0, tick: 50_000 }), pace);
    whisperIn(clipView({ harvested: 55, tick: 50_100 }), pace);
    // A different world loads at tick 10 with a big lifetime count: no inherited delta.
    expect(whisperIn(clipView({ harvested: 90, tick: 10 }), pace)).toBeNull();
  });
});

describe('botCatchUpPhrase', () => {
  it('speaks seconds for a small hour and minutes for a big one', () => {
    expect(botCatchUpPhrase(15)).toMatch(/about .+ seconds/);
    expect(botCatchUpPhrase(600)).toMatch(/about .+ minutes/);
  });

  it('is monotonic — more crops never takes less time', () => {
    // Coarse, but it is the failure a unit typo produces.
    const small = botCatchUpPhrase(12);
    const big = botCatchUpPhrase(1200);
    expect(big).toMatch(/minutes/);
    expect(small).toMatch(/seconds/);
  });
});

// The Clipboard's other computed line, and the one item 111 broke by adding products.
//
// It counted `BaggedChips` and multiplied by a literal 2000, which is two ways to be wrong
// the moment there is a second bag: a pocket full of chili chips is worth $24.50 each and was
// reported as no bags at all, and a gold bag would have been priced as a plain one. Neither
// failure raises anything — the note simply does not appear, or appears with a smaller number
// than the truth, on the surface whose whole job is telling the player what they have.
describe('the chips-in-your-pocket note', () => {
  function pocketView(rows: readonly { item: number; count: number }[]): WorldView {
    const view = clipView({});
    view.inventory = rows.map((row) => ({
      item: row.item,
      count: row.count,
      sellable: 1,
      boxedMachineKind: 0,
      boxes: [],
      ticksToSpoil: -1,
      spoilingCount: 0,
    })) as unknown as WorldView['inventory'];
    return view;
  }

  function chipsNote(view: WorldView): string | null {
    const note = deriveClipboard(view, createMachineCounts(), new HarvestPace()).find(
      (n) => n.id === 'chips',
    );
    return note === undefined ? null : note.text;
  }

  it('counts every kind of bag, not only the plain one', () => {
    const text = chipsNote(
      pocketView([
        { item: ItemId.BaggedChips, count: 2 },
        { item: ItemId.BaggedChiliChips, count: 3 },
      ]),
    );
    expect(text).not.toBeNull();
    expect(text).toContain('five bags');
  });

  it('speaks at all for a pocket holding no plain chips whatsoever', () => {
    expect(chipsNote(pocketView([{ item: ItemId.BaggedChiliChips, count: 4 }]))).not.toBeNull();
  });

  it('values each bag at its own list price rather than at the plain one', () => {
    // A chili bag is a plain bag plus the flavour premium; two of them are not $40.
    const plain = listPriceCents(ItemId.BaggedChips);
    const chili = listPriceCents(ItemId.BaggedChiliChips);
    expect(chili).toBeGreaterThan(plain);

    const text = chipsNote(pocketView([{ item: ItemId.BaggedChiliChips, count: 2 }]))!;
    expect(text).toContain(formatCents(chili * 2));
    expect(text).not.toContain(formatCents(plain * 2));
  });
});
