// What a clicked grabber has to say for itself, and what it could plausibly be told to grab.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THERE IS A CARD AT ALL ([[099]]). `SetGrabberFilter` has been in the command union,
//  the reducer and the trace since belts landed, `GrabberView.filter` has been published all
//  along, and `pointer.ts`'s placement path says in as many words that a placed arm is
//  unfiltered because *"retuning a filtered arm is `SetGrabberFilter`, which belongs to the
//  machine card rather than to the act of placing one"*. The card was never built, so the
//  command had NO CALLER and the Mk2's one distinguishing feature — the thing it costs $12.00
//  for over a $5.00 Mk1 — was unreachable in play. The owner found it the way you would
//  expect: *"sometimes I'm having issues where it's picking the wrong thing"*.
//
//  PURE, AND SEPARATE FROM THE SEAM IT IS PUBLISHED THROUGH, which is exactly the split
//  `build-menu.ts` and `build-panel.ts` already run on: this file is a read of `WorldView`
//  with no module-scope state, so every rule below is a plain function call in a test, and
//  `grabber-panel.ts` holds the selection and the subscription.
// ────────────────────────────────────────────────────────────────────────────────────
//
// THE CANDIDATE RULE, WHICH IS THE ONLY INTERESTING DESIGN HERE. A filter grid of the whole
// `ItemId` table is a wall of fifty sprites, most of which cannot physically arrive at this
// arm — so the list is built from the arm's SOURCE: what is riding the belt behind it, what
// the machine behind it makes, or what is on a harvester dock's two shelves. A source that
// is momentarily empty (and a belt is empty most of the time) falls back to the LOT's own
// roster rather than to nothing, because "nothing to choose from" is indistinguishable from
// a broken panel and the player would never learn which they were looking at.
//
// NOTHING HERE DECIDES WHETHER A FILTER IS LEGAL. `GrabberSpec.filterable` is the sim's, the
// reducer refuses a non-zero filter on a Mk1 (`applySetGrabberFilter`), and this reports that
// flag so the card can EXPLAIN it. A UI that worked around the rule — offering the grid and
// silently dropping the command — would be the worst of both.

import {
  MachineKind,
  directionStepX,
  directionStepY,
  grabberSpec,
  itemSpec,
  machineKindForBoxedItem,
  machineRecipes,
  machineSpec,
} from '@snack/sim';
import type { Direction, GrabberTier, GrabberView, ItemId, WorldView } from '@snack/sim';

import { beltAtView, grabberAtView, tileAtView } from './picking';
import { ToolMode } from './tools';

/**
 * Where an arm's candidate list came from.
 *
 * PLAIN NUMBERS, because the card owns the words. `machineLabel` lives in `hud/tech-copy.ts`
 * — the HUD's naming table — and an input-layer module that started spelling machine names
 * would be a second place for "Harvester Dock" to be written down and to drift.
 */
export const ArmSource = {
  /** Bare ground, water, the edge of the world: nothing behind the arm to take from. */
  Nothing: 0,
  Belt: 1,
  Machine: 2,
} as const;
export type ArmSource = (typeof ArmSource)[keyof typeof ArmSource];

/** One clicked arm, reduced. Everything the card draws and nothing it does not. */
export interface GrabberCard {
  readonly grabberId: number;
  readonly tier: number;
  /** The way goods flow: the arm takes from `-dir` and puts down toward `dir`. */
  readonly dir: number;
  /** `ItemId` this arm is tuned to, or 0 for "anything". */
  readonly filter: number;
  /** The sim's own tier rule (`GrabberSpec.filterable`). False for the Mk1. */
  readonly filterable: boolean;
  readonly source: ArmSource;
  /** `MachineKind` when `source` is `Machine`, else 0. */
  readonly sourceKind: number;
  /** `ItemId`s, ascending. Never contains 0 — "anything" is a verb, not a candidate. */
  readonly candidates: readonly number[];
}

/**
 * The card for one arm, or `null` when there is no such arm in this projection.
 *
 * NULL IS HOW A TORN-DOWN ARM CLOSES ITS OWN CARD. The player can rip out the grabber they
 * are configuring — the teardown tool does not care that a panel is open — and the honest
 * answer to "what is the filter on grabber 7" once grabber 7 is in the bag is not a stale
 * copy of the last one, it is nothing at all.
 *
 * WHAT IS DELIBERATELY NOT ON IT: what the claw is holding. It changes every swing, it would
 * re-render the card a few times a second through a seam whose whole discipline is publishing
 * only on change, and the arm itself is on screen holding the thing.
 */
export function grabberCard(view: WorldView | null, grabberId: number): GrabberCard | null {
  if (view === null || grabberId === 0) return null;

  let arm: GrabberView | null = null;
  for (let i = 0; i < view.grabbers.length; i++) {
    const g = view.grabbers[i]!;
    if (g.id === grabberId) {
      arm = g;
      break;
    }
  }
  if (arm === null) return null;

  const spec = grabberSpec(arm.tier as GrabberTier);
  // A tier this build has never heard of reads as unfilterable and one tile long: the card
  // then shows the Mk1's explanation, which is the safe half of the fork — offering a picker
  // whose command the reducer would refuse is the failure worth ruling out.
  const found = sourceItems(view, arm, spec?.reachTiles ?? 1);

  return {
    grabberId: arm.id,
    tier: arm.tier,
    dir: arm.dir,
    filter: arm.filter,
    filterable: spec?.filterable ?? false,
    source: found.source,
    sourceKind: found.sourceKind,
    candidates: found.items,
  };
}

/**
 * The tile this arm reaches back into, and what is on it right now.
 *
 * THE ARITHMETIC IS THE SIM'S AND IS COPIED RATHER THAN CALLED, for the reason
 * `render/grabber-facing.ts` states beside its own copy: `grabberSourceTile` takes a sim-side
 * `Grabber` and this lane has a `GrabberView`. The rule itself — take from `-dir`, put down
 * toward `+dir`, `reachTiles` away — is two lines and is pinned by a test that walks all four
 * facings, which is the part that would actually hurt if it drifted a quarter-turn.
 */
function sourceItems(
  view: WorldView,
  arm: GrabberView,
  reachTiles: number,
): { items: number[]; source: ArmSource; sourceKind: number } {
  const sx = arm.tileX - directionStepX(arm.dir as Direction) * reachTiles;
  const sy = arm.tileY - directionStepY(arm.dir as Direction) * reachTiles;

  // A BELT FIRST, because a belt and a machine cannot share a tile and the belt is the
  // overwhelmingly common source. Every item riding the SEGMENT counts, not only the ones
  // over the reached tile: goods move, and a list that flickered as a potato slid past the
  // claw would be unusable as a picker.
  const belt = beltAtView(view, sx, sy);
  if (belt !== null) {
    const riding: number[] = [];
    for (let i = 0; i < belt.itemCount; i++) push(riding, belt.itemType[i] ?? 0);
    return { items: sorted(riding), source: ArmSource.Belt, sourceKind: 0 };
  }

  const machine = tileAtView(view, sx, sy).machine;
  if (machine === null) return { items: [], source: ArmSource.Nothing, sourceKind: 0 };

  const items: number[] = [];
  // THE HARVESTER DOCK'S TWO SHELVES (item 088), which are the whole reason a filter is worth
  // a panel: produce on one, the seeds the bot brought home on the other, and an arm pointed
  // at a planter that keeps taking potatoes is precisely the complaint this item was filed
  // about. `outputItem` is 0 on a dock — its spec honestly makes nothing — so without this
  // branch the one machine where the choice matters most would offer no choice at all.
  if (machine.kind === MachineKind.HarvesterDock) {
    push(items, machine.cargoItem);
    push(items, machine.seedShelfItem);
  } else {
    push(items, machine.outputItem);
    // EVERY FLAVOUR THIS MACHINE CAN MAKE, not only the one in the basket right now (item
    // 111). `machine.outputItem` is the truthful basket item and falls back to the spec's
    // ordinary product when the basket is empty — so a Bagger between batches offered plain
    // bags and nothing else, and an arm could only be tuned to chili bags by catching the
    // machine mid-basket and clicking fast. A filter is a standing instruction about a
    // machine that has not run yet; it has to name things that have not come out yet.
    machineOutputs(machine.kind, items);
    // What a Fryer hands over first is its BURNT chips, and `grabberSource` filters on what is
    // actually next out of the buffer rather than on what the machine makes on a good day. So
    // the overcooked twin is a real thing to filter FOR (an arm that only carries seconds to
    // the bin) and to filter AGAINST, and it belongs on the grid either way. It is a product
    // tier, not a clock — [[124]] left it alone on purpose.
    push(items, machine.overcookedItem);
  }

  return { items: sorted(items), source: ArmSource.Machine, sourceKind: machine.kind };
}

/**
 * Everything this lot currently holds that an arm could conceivably be handed — the fallback.
 *
 * DELIBERATELY THE LOT RATHER THAN THE ITEM TABLE. An arm whose source is an empty belt is
 * the ordinary case, not an edge case, and its answer has to be useful: what the player has
 * BUILT is a short, honest list that grows with the factory, where `ITEM_SPECS` is fifty-odd
 * entries including boxed machines and every crop the player has not unlocked.
 */
export function lotItems(view: WorldView | null): number[] {
  if (view === null) return [];
  const items: number[] = [];
  for (let i = 0; i < view.machines.length; i++) {
    const m = view.machines[i]!;
    push(items, m.outputItem);
    machineOutputs(m.kind, items);
    push(items, m.overcookedItem);
    push(items, m.cargoItem);
    push(items, m.seedShelfItem);
  }
  for (let i = 0; i < view.belts.length; i++) {
    const belt = view.belts[i]!;
    for (let j = 0; j < belt.itemCount; j++) push(items, belt.itemType[j] ?? 0);
  }
  return sorted(items);
}

/**
 * **THE GRID ONLY EVER GROWS WHILE ONE ARM STAYS SELECTED**, and that is the difference
 * between a picker and a strobe.
 *
 * A belt's contents are the truth for one tick, not for the second a player spends aiming at
 * a cell: potatoes ride past, the segment empties, the honest momentary answer swings from
 * `[Potato]` to the lot's whole roster and back twice a second, and every cell moves under
 * the cursor each time. So the seam keeps the union of everything this arm's source has
 * offered since the card opened. It cannot grow without bound — the source is one belt or one
 * machine — and it is discarded wholesale the moment the selection changes.
 *
 * The arm's CURRENT filter is always in it, whatever the source says. Without that, an arm
 * tuned to potatoes over a belt carrying only chips would draw a grid with no lit cell: the
 * panel silently disagreeing with the machine standing next to it, which is the one thing a
 * card must never do.
 */
export function mergeCandidates(
  kept: readonly number[],
  fresh: readonly number[],
  filter: number,
): number[] {
  const out = kept.slice();
  for (let i = 0; i < fresh.length; i++) push(out, fresh[i]!);
  push(out, filter);
  return sorted(out);
}

/**
 * Everything a machine of this kind can produce, appended in recipe order.
 *
 * Read from `machineRecipes` rather than from `spec.outputItem`, which is the one thing that
 * machine makes on an ordinary day — the distinction item 111 introduced and the reason a
 * four-flavour Bagger only ever advertised one bag. A machine with no flavours adds the
 * single output it already had, and `push` dedupes it against the basket item, so this is a
 * no-op for the thirty-five machines that make one thing.
 */
function machineOutputs(kind: number, items: number[]): void {
  const spec = machineSpec(kind as MachineKind);
  if (spec === null) return;
  const recipes = machineRecipes(spec);
  for (let i = 0; i < recipes.length; i++) {
    const output = recipes[i]!.output;
    if (output !== null) push(items, output);
  }
}

/** Real items only, once each. 0 is "nothing here", never a thing to filter for. */
function push(items: number[], item: number): void {
  if (item === 0 || items.includes(item)) return;
  // A save from the future, or an id nothing names. The bag draws these as a letter chip and
  // so would the grid, but a filter the player cannot read is not a choice they can make.
  if (itemSpec(item as ItemId) === null) return;
  // Boxed machines cannot ride a belt or sit in an output buffer — nothing in the sim ever
  // puts one there — so one appearing here would mean something upstream is wrong, and
  // offering it would tune an arm to an item that can never arrive.
  if (machineKindForBoxedItem(item as ItemId) !== null) return;
  items.push(item);
}

/** Ascending by id, which is roughly the order the game introduces things. */
function sorted(items: number[]): number[] {
  return items.sort((a, b) => a - b);
}

/**
 * The arm a click would open the card on, or 0 — the sibling of `counterPanelFor`.
 *
 * HAND ONLY, exactly as the sell bin's panel is. Every other tool has a verb for the tile it
 * is over, and a placement tool clicking an occupied tile is already answered by the sim's
 * refusal; hijacking those clicks to open paperwork would make the tools feel unreliable.
 *
 * NO REACH TEST, AND THAT IS THE SIM'S OWN RULING RATHER THAN A SHORTCUT.
 * `applySetGrabberFilter` is the one grabber command that is NOT reach-gated, and `tick.ts`
 * says why in the comment above `applyRotateGrabber`: *"Retuning a filter is paperwork — a
 * dropdown on a panel that names an arm. Rotating one is the player reaching out and shoving
 * it."* So the card opens on the arm you clicked, wherever it is, and the two verbs stay
 * distinct: R is a shove and wants the player standing there, the picker is paperwork.
 */
export function grabberCardTarget(
  view: WorldView,
  tile: { tileX: number; tileY: number },
  tool: ToolMode,
): number {
  if (tool !== ToolMode.Hand) return 0;
  const arm = grabberAtView(view, tile.tileX, tile.tileY);
  return arm === null ? 0 : arm.id;
}
