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
import type { MachineView } from '@snack/sim';

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
 * The AMBER lamp's sentence: what this machine is genuinely short of.
 *
 * `wantsItem` is the sim's own answer and it is 0 when the shortage is not an item — see the
 * field on `MachineView`. This used to print `inputItem`, hopper zero's label, which was the
 * right answer for every machine in the game until item 111 gave a Seasoner four hoppers, and
 * which for a piped head with no hoppers at all has always been the literal words "Unknown
 * item".
 *
 * The thirsty branch lets a throttled PORT name its own liquid. The two machines with no
 * `ports` list — the piped head and the Recirculator — are water by spec and by construction,
 * so the fallback names water rather than saying "liquid" and sending the player to look it up.
 */
export function starvedStatus(name: string, m: MachineView): string {
  if (m.wantsItem !== 0) return `${name} wants ${itemName(m.wantsItem)}`;
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
