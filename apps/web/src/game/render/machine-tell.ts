// The two sentences a STOPPED machine gets, split out of `index.ts` so they can be tested
// (item 113).
//
// `index.ts` cannot be imported by a test at all: it reaches `textures.ts`, which imports
// `@/art/manifest.generated` through a Vite alias that vitest runs without. That is the whole
// reason the hover readout has never had a test, and it is how a sentence reading "seasoner
// wants plain chips" — with twelve plain chips in the hopper — survived long enough for item
// 111's verifier to find it by hand. These two functions need `MachineView` and two copy
// helpers and nothing else, so they can live where a test can reach them.
//
// The lamp switch itself stays in `index.ts`: its other branches want `bestSellable`, which
// imports `index.ts` back. Only the two branches that were lying are here.

import {
  LampState,
  MachineKind,
  MachineRole,
  PortFlow,
  RESERVOIR_LOW_PERMILLE,
  ReservoirThrottle,
  TICKS_PER_SECOND,
  machineSpec,
} from '@snack/sim';
import type { ContractView, DepotView, MachineView, ReservoirView } from '@snack/sim';

import { containerFreshnessNote } from '../../hud/freshness';
import { formatEta } from '../../hud/format';
import { itemName } from '../../hud/item-copy';
// `formatWater` and `formatPermille` live in `reports/format.ts` and are IMPORTED rather than
// reimplemented here, which is the whole lesson of `format/money.ts`'s header: five copies of
// cents-to-string accumulated until they disagreed on screen, in a shipping build, about the
// price of a belt. A pond that reads "14.5%" in the ribbon and "15%" on a receipt would be the
// same defect in a unit nobody would think to check.
import { formatPermille, formatWater } from '../../reports/format';
import { liquidName } from './liquids';

/**
 * The RED lamp's sentence — and there are three, because "blocked" has three causes and the one
 * line this replaced described only the first.
 *
 * 1. A FULL BASKET. Unchanged, and still the common case.
 * 2. A BASKET HOLDING LAST FLAVOUR'S CHIPS, with room to spare. New since item 111 gave five
 *    machines more than one recipe: a Seasoner out of peppers, or a Washer with gold potatoes
 *    waiting behind a single washed russet. Calling a basket at 1 of 20 "full" is a plain
 *    falsehood, and the errand is a different one — clear it, rather than wait for it to drain.
 * 3. A FULL OUTLET PORT, whose product is a liquid and so has no `outputItem` at all. This
 *    branch has printed "full of Unknown item" for as long as the soda line has existed; the
 *    liquid was sitting in the port the whole time and nobody had asked it.
 */
export function blockedStatus(name: string, m: MachineView): string {
  if (m.outputItem === 0) {
    const outlet = m.ports.find((port) => port.flow === PortFlow.Outlet);
    const liquid = outlet === undefined ? null : liquidName(outlet.liquid);
    return liquid === null
      ? `${name} full — nothing is taking its output`
      : `${name} full of ${liquid} — nothing is drawing it off`;
  }
  if (m.outputCount >= m.outputCapacity) {
    return `${name} full of ${itemName(m.outputItem)} — take some`;
  }
  return `${name} holding ${itemName(m.outputItem)} — clear the basket to switch`;
}

/**
 * The AMBER lamp's sentence: what this machine is genuinely short of, **and how short**.
 *
 * `wantsItem` is the sim's own answer and it is 0 when the shortage is not an item — see the
 * field on `MachineView`. This used to print `inputItem`, hopper zero's label, which was the
 * right answer for every machine in the game until item 111 gave a Seasoner four hoppers, and
 * which for a piped head with no hoppers at all has always been the literal words "Unknown
 * item".
 *
 * **THREE SENTENCES, BECAUSE "WANTS SODA" IS A LIE ABOUT A HOPPER WITH SODA IN IT** (item 116).
 * `missingInputItem` is a predicate — `count < line.count` — and a predicate read aloud drops the
 * quantity that made it true. A Six-Packer eats six sodas an operation, so a packer holding five
 * of them was starved, correctly, and said *"six packer wants Soda"* at a player who could see
 * five sodas in the hopper. Same for a Composter three Compost into a batch of four.
 *
 *   · nothing in the hopper, one per operation → **"washer wants Russet Potato"**. Untouched, and
 *     it is the sentence thirty-odd machines get: there is no quantity to drop, so there is
 *     nothing to be wrong about.
 *   · nothing in the hopper, several per operation → **"six packer needs 6 Soda"**. True and
 *     newly useful — "wants Soda" sent a player back with one soda and no explanation.
 *   · something in the hopper → **"six packer needs 1 more Soda"**. The reported bug, and the
 *     only branch where the word "more" is earned.
 *
 * The word "more" is a claim about what is already in the hopper, which is why this reads
 * `wantsHeld` rather than inferring from `wantsCount`: a shortfall of 1 is both an empty Washer
 * and a Six-Packer one soda short, and telling an empty machine it needs "1 more" would be a new,
 * smaller version of the same lie.
 *
 * The thirsty branch lets a throttled PORT name its own liquid. The two machines with no
 * `ports` list — the piped head and the Recirculator — are water by spec and by construction,
 * so the fallback names water rather than saying "liquid" and sending the player to look it up.
 */
export function starvedStatus(name: string, m: MachineView): string {
  if (m.wantsItem !== 0) {
    const item = itemName(m.wantsItem);
    if (m.wantsHeld > 0) return `${name} needs ${m.wantsCount} more ${item}`;
    return m.wantsCount > 1 ? `${name} needs ${m.wantsCount} ${item}` : `${name} wants ${item}`;
  }
  const throttled = m.ports.find((port) => port.throttled === 1);
  const liquid = (throttled === undefined ? null : liquidName(throttled.liquid)) ?? 'water';
  return `${name} — not getting enough ${liquid}`;
}

/**
 * The clock in parentheses after the goods it is about, or `''` when there is nothing to say.
 *
 * **PARENTHESES RATHER THAN A TRAILING CLAUSE**, and the harvester dock is why: its shelves line
 * names two piles — *"12 russet potatoes and 6 potato seeds on the shelves"* — and only one of
 * them has a clock. "…on the shelves, 4:12 left" would attach the countdown to whichever noun the
 * reader's eye landed on last, which for a shelf of seeds is a claim that is not merely unhelpful
 * but false. A bracket binds to the thing in front of it, so one form works everywhere and no
 * surface has to own a second phrasing for the two-pile case.
 */
function cargoClock(m: MachineView): string {
  const note = containerFreshnessNote(m.cargoTicksToSpoil, m.cargoFrozen === 1);
  return note === null ? '' : ` (${note})`;
}

/**
 * **WHAT IS IN THE BOX, AND HOW LONG IT HAS** — the ribbon's sentence for a `MachineRole.Storage`
 * machine, or `null` for anything that is not one. Item 114.
 *
 * The ribbon had no branch for a box at all: a Root Cellar has no work cycle, so it answered
 * `LampState.Off` and fell to the bottom of the lamp switch as **"root cellar idle"** — which is
 * true of a shed holding ninety potatoes in the least useful possible way. `pointer.ts` noticed
 * that in item 105 and wrote its own line in the other corner of the screen; this is the ribbon
 * finally saying it too, and saying the half that line still cannot, because `cargoTicksToSpoil`
 * did not exist until now.
 *
 * **GATED ON THE ROLE, NEVER ON THE KIND** — `storageRoomFor`'s law, and the reason the hand cart
 * gets this sentence for free. A kind check here would be a second opinion about what a box is,
 * and it would be wrong on the day a third container ships.
 *
 * An empty box says so and stops. It deliberately does NOT say "frozen": an empty Root Cellar is
 * preserving nothing, and `cargoFrozen` is 0 there for that reason (see `MachineView`).
 */
export function storageStatus(name: string, m: MachineView): string | null {
  const spec = machineSpec(m.kind as MachineKind);
  if (spec === null || spec.role !== MachineRole.Storage) return null;
  if (m.cargoCount <= 0 || m.cargoItem === 0) return `${name} empty`;
  return `${name} — ${m.cargoCount} ${itemName(m.cargoItem)}${cargoClock(m)}`;
}

/**
 * The harvester dock's two shelves, in words — moved out of `index.ts` by item 114 so the clock it
 * now carries can be tested. `null` when both shelves are bare, which hands the dock back to the
 * lamp switch exactly as the inlined version did.
 *
 * **THE PRODUCE SHELF IS A CONTAINER AND ITEM 112 MADE IT ONE IN THE SIM** — it is literally the
 * same `cargo` triple a cellar uses, and an arm drains it onto a belt with nobody clicking
 * anything. So it ages at loose speed, and a full shed with a stalled belt is the exact shape of
 * this item's bug: a pile of produce visibly stacking up while its window runs out unannounced.
 * The seed shelf takes no clock and wants none; seeds are shelf-stable, and `cargoClock` returns
 * nothing for the produce side too whenever what is on it does not spoil.
 */
export function dockShelfStatus(name: string, m: MachineView): string | null {
  const shelved = m.cargoCount > 0 && m.cargoItem !== 0;
  const seeded = m.seedShelfCount > 0 && m.seedShelfItem !== 0;
  const produce = `${m.cargoCount} ${itemName(m.cargoItem)}${cargoClock(m)}`;
  const seeds = `${m.seedShelfCount} ${itemName(m.seedShelfItem)}`;

  if (shelved && seeded) return `${name} — ${produce} and ${seeds} on the shelves`;
  if (shelved) return `${name} — ${produce} on the shelf`;
  if (seeded) return `${name} — ${seeds} on the seed shelf`;
  return null;
}

/**
 * **THE DEPOT FLOOR, AND HOW LONG IT HAS** — moved here from `index.ts` by item 116 so the clock
 * item 115 published can be both worn and tested.
 *
 * Item 115 taught a standing route's floor to spend a freshness window — the sixth fridge, an
 * unbounded warehouse that a route with a run size it could never reach would refrigerate
 * forever — and published `ContractView.stockedFreshTicks` for a HUD that did not yet exist.
 * This is that HUD. Without it the depot line said *"40/60 on the floor"* in identical words from
 * the first potato to the last tick of its window, which is item 110's silent-destruction lesson
 * a third time.
 *
 * **THE FLOOR IS PER-ROUTE AND THE SENTENCE IS PER-DEPOT, SO THE CLOCK IS THE SOONEST AND SAYS
 * SO.** A depot with three routes has three piles and three windows; "40/60 on the floor (4:12
 * left)" would be a true number attached to a noun covering three piles it is false of two of.
 * The word "soonest" appears exactly when there is more than one route to be soonest among —
 * with a single route the clock IS the floor's, and hedging it would be its own small lie.
 *
 * **0 IS "NO CLOCK" AND 1 IS "OUT OF TIME", ONE APART AND OPPOSITE.** `advanceContractSpoilage`
 * clamps at 1 rather than composting, because a route's product is fixed at signing and there is
 * nowhere to write that the floor turned — so a spent floor sits at 1 and still ships at list.
 * Zero means a shelf-stable route, an empty floor, or a grandfathered save. `containerFreshnessNote`
 * reads -1 as its "nothing to say" sentinel, so 0 is mapped to it here rather than being passed
 * through as a countdown that has already finished.
 *
 * The spent floor therefore reads "(0:00 left)" and stays there. That is the honest rendering of
 * a clamp, not a stuck timer: those goods ARE out of time and the game ships them anyway, which
 * is the asymmetry item 115 flagged to item 046 rather than priced. If 046 decides a spent floor
 * should compost, this sentence needs no edit — it will simply stop being reachable.
 */
export function depotStatus(
  name: string,
  depot: DepotView,
  contracts: readonly ContractView[],
): string {
  if (depot.contractIds.length === 0) return `${name} — click to sign a contract`;
  const routes = depot.contractIds.length === 1 ? '1 route' : `${depot.contractIds.length} routes`;
  const floor = `${depot.stocked}/${depot.capacity} on the floor`;

  let soonest = -1;
  for (const contract of contracts) {
    if (contract.depotId !== depot.id) continue;
    // A route with nothing on its floor has no clock to be soonest, whatever number it is
    // carrying — `stockedFreshTicks` is only zeroed when the last of a pile rolls away.
    if (contract.stocked <= 0 || contract.stockedFreshTicks <= 0) continue;
    if (soonest < 0 || contract.stockedFreshTicks < soonest) soonest = contract.stockedFreshTicks;
  }

  const note = containerFreshnessNote(soonest, false);
  if (note === null) return `${name} — ${routes}, ${floor}`;
  const clock = depot.contractIds.length > 1 ? `soonest ${note}` : note;
  return `${name} — ${routes}, ${floor} (${clock})`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
//  THE WATER SENTENCES (item 130)
//
//  The owner asked twice, four days apart, how to boost his pumps — the second time after
//  being told the question was filed. He could feel the shortage and could not see a single
//  number about it, because THE INSTRUMENTS WERE NEVER PLUGGED IN: `MachineView.ticksToEmpty`
//  and `ReservoirView.throttle` are both computed in `view.ts` and, before this file, read
//  NOWHERE in `apps/web/src`. `data.ts:2591` says the Tank is "the only object in the game
//  that shows a net rate and a time-to-empty… it turns 'am I short of water' from a feeling
//  into arithmetic the player can do at a glance". It did not, because nothing rendered it.
//
//  **AND THE ONE SENTENCE THAT DID SHIP WAS A WILD GOOSE CHASE.** Every blue `UtilityMissing`
//  lamp in the game printed "barrel dry — click to refill". That is true of exactly one
//  machine, the hand-filled Barrel Sprinkler. `lampFor` hands the same blue lamp to a dry
//  piped head, a dry Irrigation Hub, an empty Tank and a pump at a dry pond — four machines
//  with no barrel, that no click will refill. A player whose field has gone dry hovers a dead
//  head, is told to click it, clicks it, nothing happens, and reasonably concludes the PUMP is
//  the thing that is wrong. That is item 113's lesson — a name the machine cannot support
//  turns a red lamp into a wild goose chase — repeated on the blue one.
//
//  So these functions answer the four questions in the order a shortage actually raises them:
//  am I in the halved band, what is my net rate, how long have I got, and how full is the
//  pond. The band comes FIRST wherever it is true, because a pump silently running at half
//  its posted rate is indistinguishable from a broken pump, and it is the one fact the player
//  cannot get any other way — the shoreline recedes, but nothing says what the shoreline MEANS.
//
//  Every number below is read straight off the projection. Nothing here recomputes a rate, a
//  threshold or a countdown: §12 says the renderer computes no network state of its own, and
//  a second opinion about when a pump halves is exactly the sort of arithmetic that would end
//  up disagreeing with the sim in the band where being right matters most.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A rate in ml/min, in the units the Shift Report already quotes water in. */
function rate(mlPerMinute: number): string {
  return `${formatWater(Math.abs(mlPerMinute))}/min`;
}

/**
 * The pond a machine draws from, or `null` when the answer is not certain.
 *
 * TWO RULES, AND THE SECOND ONE IS THE HONEST ONE. A pump is placed against a bank —
 * `guardPlacement` refuses one anywhere else — so its source is the reservoir its footprint
 * touches, and rect adjacency finds it exactly. Nothing else in the game is adjacent to
 * anything: a Tank or a piped head is fed through the ledger from wherever the pump is, and
 * the view carries no edge from one to the other.
 *
 * So for those, the pond is named ONLY when there is exactly one in the world — which is the
 * case today (`state.ts` builds one and no command makes another) and is the only case where
 * "the pond" is an unambiguous phrase. On a two-pond lot these sentences go quiet about the
 * source rather than guess, which is the difference between a readout and a rumour.
 */
function pondFor(reservoirs: readonly ReservoirView[], m: MachineView): ReservoirView | null {
  const spec = machineSpec(m.kind as MachineKind);
  if (spec !== null && spec.role === MachineRole.Pump) {
    for (const r of reservoirs) {
      const touches =
        m.tileX <= r.tileX + r.tilesWide &&
        r.tileX <= m.tileX + m.tilesWide &&
        m.tileY <= r.tileY + r.tilesHigh &&
        r.tileY <= m.tileY + m.tilesHigh;
      if (touches) return r;
    }
    return null;
  }
  return reservoirs.length === 1 ? reservoirs[0]! : null;
}

/**
 * The reservoir under a tile, or `null` for dry land. Rect containment against the projected
 * ponds, which is the only way to ask: open water is the one terrain `tileAtView` does not
 * carry, and the list is one entry long today.
 *
 * `pointer.ts`'s `reservoirAtTile` is the BOOLEAN FORM of this same question — it decides
 * whether a click means "dip the can". It is deliberately NOT merged into this one, and not
 * for want of noticing: making it delegate would point the input layer at the render layer,
 * which is backwards from every other edge in the app (`index.ts` imports `pointer.ts`, never
 * the reverse) and would put a cycle one careless import away.
 *
 * So the two rect tests stay separate and are PINNED TOGETHER BY A TEST instead — see
 * "agrees with pointer.ts about where the water is" in `machine-tell.test.ts`. Two copies that
 * agree today and get edited apart later is the shape of every bug `format/money.ts`'s header
 * is about, and a test is the cheap half of that lesson.
 */
export function pondAtTile(
  reservoirs: readonly ReservoirView[],
  tileX: number,
  tileY: number,
): ReservoirView | null {
  for (const r of reservoirs) {
    if (
      tileX >= r.tileX &&
      tileX < r.tileX + r.tilesWide &&
      tileY >= r.tileY &&
      tileY < r.tileY + r.tilesHigh
    ) {
      return r;
    }
  }
  return null;
}

/**
 * **HOW FULL THE POND IS, AND WHAT THAT DOES TO THE PUMPS** — the sentence for a hovered
 * water tile, and the reason the 25% line means anything at all.
 *
 * The threshold is quoted from `RESERVOIR_LOW_PERMILLE` rather than typed as "25%", so the
 * copy cannot outlive the constant. The band itself is `ReservoirThrottle`, decided in the
 * sim by the same function the pumps are throttled by — this file never compares a level to a
 * threshold of its own.
 */
export function pondStatus(r: ReservoirView): string {
  const full = formatPermille(r.levelPermille);
  switch (r.throttle) {
    case ReservoirThrottle.Sip:
      return 'pond empty — pumps get only what it refills, so it always recovers';
    case ReservoirThrottle.Half:
      return `pond low — ${full} full, under ${formatPermille(RESERVOIR_LOW_PERMILLE)}, so pumps run at HALF RATE`;
    default:
      return `pond — ${full} full`;
  }
}

/**
 * **THE PUMP'S REAL RATE, AND WHY IT IS NOT THE POSTED ONE.**
 *
 * `flowMlPerMinute` on a pump is what it ACTUALLY DREW last tick (`pipes.ts:738`), not its
 * rating — so the halved band shows up in the number without this file halving anything. The
 * band is named anyway, because a player reading "300 L/min" has no way to know that is half
 * of something, and "my pump is slower than it says" with no explanation is precisely the
 * report this item was filed under.
 */
function pumpStatus(name: string, m: MachineView, pond: ReservoirView | null): string {
  if (pond === null) return `${name} — ${rate(m.flowMlPerMinute)}`;
  const level = formatPermille(pond.levelPermille);
  switch (pond.throttle) {
    case ReservoirThrottle.Sip:
      return `${name} — pond empty, ${rate(m.flowMlPerMinute)} is all it refills`;
    case ReservoirThrottle.Half:
      return `${name} at HALF RATE — ${rate(m.flowMlPerMinute)}, pond down to ${level}`;
    default:
      // A pump on a healthy pond that is nonetheless drawing nothing has no demand behind it,
      // which is a real and findable state — an unconnected pump, or a network whose heads are
      // all full — and reads as a bug if the sentence just prints "0 L/min" and stops.
      if (m.flowMlPerMinute <= 0) return `${name} idle — nothing on its pipes is asking for water`;
      return `${name} — ${rate(m.flowMlPerMinute)}, pond at ${level}`;
  }
}

/**
 * **THE NET RATE AND THE TIME TO EMPTY** — the two numbers `data.ts:2591` says the Tank exists
 * to show, finally on screen.
 *
 * `ticksToEmpty` is `-1` for "not emptying", which is a different fact from "zero seconds" and
 * is why the falling branch is gated on the sentinel rather than on the sign of the rate. A
 * tank at break-even has no time-to-empty and this sentence does not invent one.
 *
 * The tank is the machine that turns a shortage into a DEADLINE, so when it is draining the
 * clock is the thing the sentence ends on.
 */
function tankStatus(name: string, m: MachineView, pond: ReservoirView | null): string {
  const level = formatPermille(m.tankPermille);

  // AN EMPTY TANK IS A VERDICT, NOT A LEVEL. Its net rate here is near zero by construction —
  // whatever arrives is spent the same tick — so printing the rate would say "0 L/min" at a
  // player whose whole line has stopped. The useful number is the POND's, because an empty
  // buffer over a halved pond and an empty buffer over a full one are two different errands.
  //
  // "EMPTY" IS ASKED OF THE SIM'S OWN BLUE LAMP, not measured here. `MachineView` publishes
  // `tankPermille` and no raw millilitre count, and `permille()` floors — so a tank holding a
  // genuine trickle reads 0.0% and a threshold of my own would call it empty a moment before
  // the sim does. `lampFor` already decides this (`machine.tankMl <= 0` → `UtilityMissing`);
  // one predicate read twice beats two predicates that disagree at the boundary.
  if (m.lamp === LampState.UtilityMissing) {
    if (pond !== null && pond.throttle === ReservoirThrottle.Half) {
      return `${name} EMPTY — pond down to ${formatPermille(pond.levelPermille)}, so the pump is at half rate`;
    }
    if (pond !== null && pond.throttle === ReservoirThrottle.Sip) {
      return `${name} EMPTY — the pond is empty too, and refills slowly`;
    }
    return `${name} EMPTY — the line is spending water faster than the pump brings it`;
  }

  if (m.flowMlPerMinute > 0) return `${name} ${level} — filling, ${rate(m.flowMlPerMinute)} spare`;
  if (m.flowMlPerMinute === 0) return `${name} ${level} — holding steady`;
  // `ticksToEmpty` is `-1` for "not emptying", which is a different fact from "no time left",
  // so the clock is gated on the sentinel rather than on the sign of the rate. Nothing here
  // divides by zero and nothing here invents a deadline for a tank at break-even.
  const clock = m.ticksToEmpty < 0 ? '' : `, empty ${formatEta(m.ticksToEmpty / TICKS_PER_SECOND)}`;
  return `${name} ${level} — losing ${rate(m.flowMlPerMinute)}${clock}`;
}

/**
 * **A HEAD THAT IS DRY OR SHORT, AND WHICH WALL IT HIT** — the sentence that replaces "barrel
 * dry — click to refill" on the two machines that have no barrel.
 *
 * The three endings are three different errands and that is the entire point of splitting them:
 * a pond in the halved band is a POND problem (stop drawing so hard, or wait), an empty pond is
 * a worse version of the same, and a head going short while the pond is FULL is an
 * OVERSUBSCRIPTION problem — too many heads on one pump — which is the one case where the
 * answer is a change to the build rather than patience. Collapsing them into "not getting
 * enough water" is what the game said before, and it sent the owner to the pump three times.
 */
function headStatus(name: string, dry: boolean, pond: ReservoirView | null): string {
  const trouble = dry ? 'DRY' : 'short of water';
  if (pond === null) return `${name} ${trouble} — the network is not feeding it`;
  switch (pond.throttle) {
    case ReservoirThrottle.Sip:
      return `${name} ${trouble} — the pond is empty`;
    case ReservoirThrottle.Half:
      return `${name} ${trouble} — pond down to ${formatPermille(pond.levelPermille)}, pump at half rate`;
    default:
      return `${name} ${trouble} — one pump is not enough for this many heads`;
  }
}

/**
 * **THE WATER LAYER'S OWN SENTENCE, OR `null` FOR A MACHINE THIS DOES NOT SPEAK FOR.**
 *
 * Answered ABOVE the lamp switch, for the reason the vehicles and the boxes are: the lamp has
 * nothing useful to say about any of these three. A pump and a tank have no work cycle, so a
 * healthy one falls to `LampState.Running` and the words "pump running" — true, and silent
 * about the halved band, which is the one thing worth saying. A dry one lands on
 * `LampState.UtilityMissing` and the barrel line, which is worse than silent.
 *
 * A HEALTHY HEAD IS LEFT ALONE. It returns `null` and keeps "sprinkler running", because a
 * working sprinkler has no shortage to explain and a rate on it would be noise on the one
 * machine a player builds forty of.
 */
export function waterStatus(
  name: string,
  m: MachineView,
  reservoirs: readonly ReservoirView[],
): string | null {
  const spec = machineSpec(m.kind as MachineKind);
  if (spec === null) return null;

  if (spec.role === MachineRole.Pump) return pumpStatus(name, m, pondFor(reservoirs, m));
  if (spec.role === MachineRole.Tank) return tankStatus(name, m, pondFor(reservoirs, m));

  if (spec.role === MachineRole.PipedSprinkler) {
    // "Dry" is whatever this machine cannot afford to start, and the two on this role differ —
    // so the flag is taken from the SIM's own blue lamp rather than recomputed from `tankMl`
    // against a floor this file would have to know. `lampFor` already forks on
    // `spec.moistureSensing` to pick that floor; asking it is one predicate instead of two.
    const dry = m.lamp === LampState.UtilityMissing;
    if (!dry && m.throttled !== 1) return null;
    return headStatus(name, dry, pondFor(reservoirs, m));
  }

  return null;
}
