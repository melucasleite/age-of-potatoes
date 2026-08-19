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
  TICKS_PER_SECOND,
  machineSpec,
} from '@snack/sim';
import type { DepotView, MachineView, NetworkView, ReservoirView } from '@snack/sim';

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
 * five sodas in the hopper. Same for any machine that eats several of one thing per batch.
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
 * **WHAT IS IN THE BOX, AND HOW LONG IT HAS** — the ribbon's sentence for a `MachineRole.Storage`
 * machine, or `null` for anything that is not one. Item 114.
 *
 * The ribbon had no branch for a box at all: a Root Cellar has no work cycle, so it answered
 * `LampState.Off` and fell to the bottom of the lamp switch as **"root cellar idle"** — which is
 * true of a shed holding ninety potatoes in the least useful possible way. `pointer.ts` noticed
 * that in item 105 and wrote its own line in the other corner of the screen; this is the ribbon
 * finally saying it too.
 *
 * **GATED ON THE ROLE, NEVER ON THE KIND** — `storageRoomFor`'s law, and the reason the hand cart
 * gets this sentence for free. A kind check here would be a second opinion about what a box is,
 * and it would be wrong on the day a third container ships.
 *
 * An empty box says so and stops.
 */
export function storageStatus(name: string, m: MachineView): string | null {
  const spec = machineSpec(m.kind as MachineKind);
  if (spec === null || spec.role !== MachineRole.Storage) return null;
  if (m.cargoCount <= 0 || m.cargoItem === 0) return `${name} empty`;
  return `${name} — ${m.cargoCount} ${itemName(m.cargoItem)}`;
}

/**
 * The harvester dock's two shelves, in words — moved out of `index.ts` by item 114 so it can be
 * tested. `null` when both shelves are bare, which hands the dock back to the lamp switch exactly
 * as the inlined version did.
 *
 * **THE PRODUCE SHELF IS A CONTAINER AND ITEM 112 MADE IT ONE IN THE SIM** — it is literally the
 * same `cargo` triple a cellar uses, and an arm drains it onto a belt with nobody clicking
 * anything. Both shelves are plain counts: nothing on either of them ages ([[124]]).
 */
export function dockShelfStatus(name: string, m: MachineView): string | null {
  const shelved = m.cargoCount > 0 && m.cargoItem !== 0;
  const seeded = m.seedShelfCount > 0 && m.seedShelfItem !== 0;
  const produce = `${m.cargoCount} ${itemName(m.cargoItem)}`;
  const seeds = `${m.seedShelfCount} ${itemName(m.seedShelfItem)}`;

  if (shelved && seeded) return `${name} — ${produce} and ${seeds} on the shelves`;
  if (shelved) return `${name} — ${produce} on the shelf`;
  if (seeded) return `${name} — ${seeds} on the seed shelf`;
  return null;
}

/**
 * **THE DEPOT FLOOR** — moved here from `index.ts` by item 116 so it can be tested.
 *
 * Without it the depot line said nothing about how full the floor was, and a route backing up
 * looked identical to a route running clean.
 *
 * ⚠️ THIS SENTENCE USED TO CARRY A CLOCK ([[124]] removed it). A standing route's floor spent a
 * freshness window, and the line reported the SOONEST of a depot's routes because one depot can
 * hold three piles with three deadlines. Nothing on a depot floor ages now, so the floor is a
 * plain fraction and the parenthetical is gone.
 */
export function depotStatus(name: string, depot: DepotView): string {
  if (depot.contractIds.length === 0) return `${name} — click to sign a contract`;
  const routes = depot.contractIds.length === 1 ? '1 route' : `${depot.contractIds.length} routes`;
  const floor = `${depot.stocked}/${depot.capacity} on the floor`;

  return `${name} — ${routes}, ${floor}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
//  THE WATER SENTENCES (item 130, rewritten for item 140)
//
//  The owner asked twice, four days apart, how to boost his pumps — the second time after
//  being told the question was filed. He could feel the shortage and could not see a single
//  number about it, because THE INSTRUMENTS WERE NEVER PLUGGED IN. That is still why these
//  functions exist.
//
//  **BUT THE SHORTAGE THEY WERE BUILT TO EXPLAIN IS A DIFFERENT SHORTAGE NOW** (item 140).
//  Every sentence below used to lead with the pond: how full it was, whether it had crossed
//  the 25% mark, how long before it hit bottom. The owner deleted that whole model — a pond is
//  an unlimited source, `RESERVOIR_LOW_PERMILLE` and `ReservoirThrottle` are gone, and a level
//  is not a number any more. Rewriting those lines to read from whatever survived would have
//  produced the exact thing `view.ts` warns about one layer down: **a gauge with one possible
//  value, which reads like information and tells you nothing.**
//
//  **WHAT IS STILL TRUE IS THE THROUGHPUT.** The source is unlimited; the straw is not. So the
//  two questions a thirsty player can still be answered are:
//
//    1. IS THIS PUMP ACTUALLY AT THE WATER? `pumpSupplyMlPerMinute` has exactly two answers —
//       the rated flow on a bank, and zero off it — so "on a bank or not" is the only question
//       left about a pump and a pond, and it is a real one a hand-edited save can still fail.
//    2. IS THE NETWORK KEEPING UP? `NetworkView` publishes `demandMl`, `deliveredMl`,
//       `flowPermille` and `consumerCount`, and none of those has ever been read by a line of
//       this app. THAT is where the old halved band's job went: a head going short is now
//       always an oversubscription — too many machines on one pump — because it can no longer
//       be a drought. One cause, and a number that says how badly.
//
//  So the pond's own sentence counts the straws in it rather than the water, which is the one
//  thing about a pond a player can still change; and a short head names the pump it is sharing
//  and the share it is getting, which is the errand.
//
//  **AND THE ONE SENTENCE THAT DID SHIP WAS A WILD GOOSE CHASE**, which is unchanged and still
//  the reason `waterStatus` sits ABOVE the lamp switch. Every blue `UtilityMissing` lamp in the
//  game printed "barrel dry — click to refill". That is true of exactly one machine, the
//  hand-filled Barrel Sprinkler. `lampFor` hands the same blue lamp to a dry piped head, a dry
//  Irrigation Hub and an empty Tank — three machines with no barrel, that no click will refill.
//
//  Every number below is read straight off the projection. Nothing here recomputes a rate, a
//  share or a countdown: §12 says the renderer computes no network state of its own, and a
//  second opinion about when a line is short is exactly the sort of arithmetic that would end
//  up disagreeing with the sim in the band where being right matters most.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A rate in ml/min, in the units the Shift Report already quotes water in. */
function rate(mlPerMinute: number): string {
  return `${formatWater(Math.abs(mlPerMinute))}/min`;
}

/**
 * The pond a PUMP stands on the bank of, or `null` for a pump standing on dry land.
 *
 * `guardPlacement` refuses a pump anywhere but a bank, so its source is the reservoir its
 * footprint touches and rect adjacency finds it exactly. Nothing else in the game is adjacent
 * to anything: a Tank or a piped head is fed through the ledger from wherever the pump is, and
 * the view carries no edge from one to the other.
 *
 * **IT USED TO ANSWER FOR THOSE TOO, AND THAT BRANCH IS GONE** (item 140). A tank or a head got
 * "the pond" whenever the world held exactly one, so its sentence could quote a level. There
 * are no levels now, nothing downstream of the pump has a question a pond can answer, and the
 * fallback would have been a guess kept alive for nobody. What replaced it for those machines
 * is `networkFor`, which reads an edge the view actually carries.
 */
function pondFor(reservoirs: readonly ReservoirView[], m: MachineView): ReservoirView | null {
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

/**
 * The pipe network a machine is on, or `null` for a machine on none.
 *
 * `MachineView.network` is `0` for "not plumbed", which is a real state and not a missing id —
 * an unconnected pump has one, and so does every machine in the chip line. The lookup is a scan
 * over a list that is one or two entries long on any lot that has pipe at all.
 */
function networkFor(networks: readonly NetworkView[], m: MachineView): NetworkView | null {
  if (m.network === 0) return null;
  for (const n of networks) if (n.id === m.network) return n;
  return null;
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
 * **HOW MANY STRAWS ARE IN THE POND** — the sentence for a hovered water tile.
 *
 * It used to be how full the pond was and which throttle band that put the pumps in. Item 140
 * deleted the level, the capacity and the band, and the honest reading of that is not "print
 * the same sentence with fewer facts in it": a pond has no state left to report, so a sentence
 * about the POND alone could only ever say one thing, and a readout with one possible value is
 * worse than no readout.
 *
 * **SO IT REPORTS THE ONE THING ABOUT A POND A PLAYER CAN STILL CHANGE.** Infinite source,
 * finite throughput: the water in front of them is unlimited and the rate they get out of it is
 * exactly the pumps they have put on its bank. That is a number that moves, that they moved,
 * and that answers the question they hovered the water to ask — which was never "how full is
 * it" but always "why am I not getting more".
 *
 * The zero case earns its own clause because it is the one that is actionable and the one a new
 * player is most likely to be looking at.
 */
export function pondStatus(
  pond: ReservoirView,
  machines: readonly MachineView[],
  reservoirs: readonly ReservoirView[],
): string {
  let pumps = 0;
  let drawing = 0;

  for (const m of machines) {
    const spec = machineSpec(m.kind as MachineKind);
    if (spec === null || spec.role !== MachineRole.Pump) continue;
    // `pondFor` is the SAME adjacency the pump's own sentence uses, asked in the other
    // direction. Two rect tests that could disagree about which bank a pump is on would put a
    // different pump count on the water than on the machine standing in it.
    const source = pondFor(reservoirs, m);
    if (source === null || source.id !== pond.id) continue;
    pumps += 1;
    if (m.flowMlPerMinute > 0) drawing += m.flowMlPerMinute;
  }

  if (pumps === 0) return 'pond — all the water you want, and no pump on the bank to take it';

  const straws = pumps === 1 ? '1 pump' : `${pumps} pumps`;
  if (drawing <= 0) return `pond — ${straws} on the bank, drawing nothing`;
  return `pond — ${straws} on the bank, drawing ${rate(drawing)}`;
}

/**
 * **THE PUMP'S REAL RATE, AND THE THREE THINGS THAT CAN BE WRONG WITH IT.**
 *
 * `flowMlPerMinute` is what it ACTUALLY DREW last tick (`pipes.ts:738`), not its rating, which
 * is why a bare number is not enough on its own: the same "0 L/min" is printed by a pump that
 * nobody has plumbed and by one standing in a field. So the three states are split, and each
 * one is a different errand.
 *
 * **OFF THE BANK IS FIRST AND IT IS NOT DEAD CODE.** `pumpSupplyMlPerMinute` grants a pump on a
 * bank its full rated flow and a pump anywhere else exactly zero — since item 140 that is the
 * WHOLE of what a pond does to a pump, and it is the only question about the two of them left
 * worth asking. `guardPlacement` refuses the placement, so a live lot should never show it; a
 * hand-edited save can, and a pump that is silently drawing nothing with no sentence explaining
 * why is the same defect this item was filed under, one cause over.
 *
 * **FLAT OUT IS THE OLD HALVED BAND'S REPLACEMENT.** A pump cannot be throttled by a drought
 * any more, so a line that wants more water than it is getting has exactly one cause: the pump
 * is already giving everything it has. `flowPermille` is the sim's own delivered-over-demand,
 * read rather than recomputed.
 */
function pumpStatus(
  name: string,
  m: MachineView,
  pond: ReservoirView | null,
  net: NetworkView | null,
): string {
  if (pond === null) return `${name} — not on a bank, so it draws nothing`;

  // A pump at the water that is nonetheless drawing nothing has no demand behind it, which is a
  // real and findable state — an unconnected pump, or a network whose heads are all full — and
  // reads as a bug if the sentence just prints "0 L/min" and stops.
  if (m.flowMlPerMinute <= 0) return `${name} idle — nothing on its pipes is asking for water`;

  if (net !== null && net.demandMl > 0 && net.flowPermille < 1000) {
    return `${name} flat out — ${rate(m.flowMlPerMinute)} is all it has, and the line is asking for more`;
  }
  return `${name} — ${rate(m.flowMlPerMinute)}`;
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
function tankStatus(name: string, m: MachineView): string {
  const level = formatPermille(m.tankPermille);

  // AN EMPTY TANK IS A VERDICT, NOT A LEVEL. Its net rate here is near zero by construction —
  // whatever arrives is spent the same tick — so printing the rate would say "0 L/min" at a
  // player whose whole line has stopped.
  //
  // **AND IT IS NOW A ONE-BRANCH VERDICT** (item 140). This used to fork three ways on the
  // pond, because an empty buffer over a halved pond and an empty buffer over a full one were
  // two different errands. They are the same errand now and there is only one of them: the pond
  // cannot be the reason, so the line outrunning the pump is the reason.
  //
  // "EMPTY" IS ASKED OF THE SIM'S OWN BLUE LAMP, not measured here. `MachineView` publishes
  // `tankPermille` and no raw millilitre count, and `permille()` floors — so a tank holding a
  // genuine trickle reads 0.0% and a threshold of my own would call it empty a moment before
  // the sim does. `lampFor` already decides this (`machine.tankMl <= 0` → `UtilityMissing`);
  // one predicate read twice beats two predicates that disagree at the boundary.
  if (m.lamp === LampState.UtilityMissing) {
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
 * **A HEAD THAT IS DRY OR SHORT, AND HOW BADLY** — the sentence that replaces "barrel dry —
 * click to refill" on the machines that have no barrel.
 *
 * **THREE ENDINGS BECAME ONE, AND THAT IS A FINDING RATHER THAN A SIMPLIFICATION** (item 140).
 * This used to fork on the pond: a halved band was a POND problem (stop drawing so hard, or
 * wait), an empty pond a worse version of it, and a head going short at a FULL pond was an
 * OVERSUBSCRIPTION problem — too many heads on one pump. Two of those three causes no longer
 * exist. A head can only be short because the pump it shares cannot keep up, which means the
 * answer is always a change to the build and never patience.
 *
 * **SO THE SENTENCE CARRIES THE NUMBERS INSTEAD OF THE CAUSE.** `consumerCount` is what
 * `view.ts` calls "3 heads sharing one pump, at one glance", and `flowPermille` is how much of
 * what they asked for actually arrived — both computed in the sim, neither ever read by this
 * app until now. A player told "one pump is not enough for this many heads" still has to go and
 * count them; this says how many and how short, which is the difference between a diagnosis and
 * a hint.
 */
function headStatus(name: string, dry: boolean, net: NetworkView | null): string {
  const trouble = dry ? 'DRY' : 'short of water';
  // No network, or a network nobody is asking anything of, means the head is not plumbed into
  // a working line at all — there is no share to quote and inventing one would be a rumour.
  if (net === null || net.demandMl <= 0)
    return `${name} ${trouble} — the network is not feeding it`;

  // NO SUPPLY AT ALL IS A DIFFERENT ERRAND FROM NOT ENOUGH, and it is the one a player is most
  // likely to have earned by accident: pipe laid, heads placed, no pump at the end of it. A
  // share of zero would be arithmetically true and would send them counting heads.
  if (net.supplyMl <= 0) return `${name} ${trouble} — no pump is feeding this line`;

  // **A DRY HEAD ON A LINE THAT IS MEETING ITS DEMAND IN FULL IS STILL FILLING, AND SAYING
  // ANYTHING ELSE IS A CONTRADICTION.** A head goes blue the moment its buffer is under what an
  // activation costs, which is true for a while after it is plumbed in and every time it has
  // just fired — and on those ticks the network is delivering every millilitre asked of it. The
  // oversubscription sentence below would print "getting 100.0% of what they ask for" directly
  // after the word DRY, which is a sentence arguing with itself and would send a player off to
  // add a pump they do not need. Found by reading the output rather than the types.
  if (net.flowPermille >= 1000) return `${name} ${trouble} — still filling, the line is keeping up`;

  const sharing = net.consumerCount === 1 ? '1 machine' : `${net.consumerCount} machines`;
  return `${name} ${trouble} — ${sharing} on this line, getting ${formatPermille(net.flowPermille)} of what they ask for`;
}

/**
 * **THE WATER LAYER'S OWN SENTENCE, OR `null` FOR A MACHINE THIS DOES NOT SPEAK FOR.**
 *
 * Answered ABOVE the lamp switch, for the reason the vehicles and the boxes are: the lamp has
 * nothing useful to say about any of these three. A pump and a tank have no work cycle, so a
 * healthy one falls to `LampState.Running` and the words "pump running" — true, and silent
 * about the rate, which is the one thing worth saying. A dry one lands on
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
  networks: readonly NetworkView[],
): string | null {
  const spec = machineSpec(m.kind as MachineKind);
  if (spec === null) return null;

  if (spec.role === MachineRole.Pump) {
    return pumpStatus(name, m, pondFor(reservoirs, m), networkFor(networks, m));
  }
  // The tank stopped taking a pond at item 140: its buffer is fed from the ledger, and the
  // source at the far end of that ledger can no longer be the reason it is empty.
  if (spec.role === MachineRole.Tank) return tankStatus(name, m);

  if (spec.role === MachineRole.PipedSprinkler) {
    // "Dry" is whatever this machine cannot afford to start, and the two on this role differ —
    // so the flag is taken from the SIM's own blue lamp rather than recomputed from `tankMl`
    // against a floor this file would have to know. `lampFor` already forks on
    // `spec.moistureSensing` to pick that floor; asking it is one predicate instead of two.
    const dry = m.lamp === LampState.UtilityMissing;
    if (!dry && m.throttled !== 1) return null;
    return headStatus(name, dry, networkFor(networks, m));
  }

  return null;
}
