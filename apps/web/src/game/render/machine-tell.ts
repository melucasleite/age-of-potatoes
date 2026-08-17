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

import { MachineKind, MachineRole, PortFlow, machineSpec } from '@snack/sim';
import type { ContractView, DepotView, MachineView } from '@snack/sim';

import { containerFreshnessNote } from '../../hud/freshness';
import { itemName } from '../../hud/item-copy';
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
