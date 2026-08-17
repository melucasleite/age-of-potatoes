// Maintenance, on the card of the machine you are standing at ([[129]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS FILE EXISTS AT ALL: RIGHT-CLICK STOPPED BEING THE REPAIR KEY.
//
//  Until item 129 the only manual route to maintenance in the whole game was the right mouse
//  button (`pointer.ts`'s second rung: jammed → `WhackJam`, otherwise `RepairMachine`). That
//  button now tears down, and the owner ruled where repair goes instead, verbatim:
//
//    *"Make it teardown, maintenance by bots or clicking the machine has a maintenance at the
//    top with a dollar cost."*
//
//  Two homes, and NEITHER IS A KEYBINDING. The automated one already existed — the Maintenance
//  Station and the repair drone ([[039]], [[090]]) — and needed nothing built. This is the
//  manual one: the first row of the machine's own card, with the price ON the button, so the
//  player decides with the number in front of them instead of watching money leave.
//
//  THE TWO VERBS, AND WHY BOTH ARE HERE RATHER THAN ONE.
//
//    · **The hand.** `RepairMachine` — one pulse, `REPAIR_PER_TOUCH` of condition, and **free
//      forever** (`tick.ts`: *"Hold-to-repair is free and always available. Hand tools never rot
//      (plan §1)"*). This is the verb right-click used to carry, moved rather than changed. A
//      jam turns it into `WhackJam`, the same branch and in the same order.
//    · **The kit.** `UseRepairKit` — one Repair Kit, everything within `REPAIR_KIT_RADIUS_TILES`
//      restored to full at once, jams included. This is the ONE priced maintenance verb the sim
//      has, and its price is the kit's own list price, read from `itemSpec` rather than restated.
//
//  ⚠️ **THE DOLLAR COST IS THE KIT'S, AND IT COULD NOT HAVE COME FROM ANYWHERE ELSE.** The
//  ruling asks for a price on the maintenance button; the sim charges nothing for hand repair
//  and says so in as many words. Inventing a cash price for `RepairMachine` would have meant a
//  sim change on a rule plan §3 states twice — so the priced button is the kit, which is a real
//  purchase at a real price the stand really charges, and the free button says "free" instead of
//  pretending otherwise. Both numbers come from the sim. Neither is a second table.
//
//  WHOSE CARD, AND WHEN IT EXISTS. Nearest machine inside hand reach — `deriveBench`'s rule and
//  `deriveBench`'s exported helpers, because a HUD with two ideas about which machine the player
//  is standing at is a HUD that labels one card with the other's subject. It appears when
//  maintenance MEANS something there: the machine wears (`wearPerOperation > 0`), or the sim's
//  own `wrenchDue` is up. That second clause is what puts the card on a DOCK — a dock never
//  wears, its Agri-Bots do, and repairing the shed repairs what sleeps in it
//  (`repairBotsAtDock`). It is item 090's owner bug read from the HUD's side, off the very field
//  the renderer draws the wrench from.
//
//  SO A TANK, A PUMP, A BELT JUNCTION AND THE SELL BIN GET NO CARD, and that is the decluttered
//  answer rather than an oversight: their `wearPerOperation` is 0, they cannot degrade, and a
//  maintenance row on one would be a control with nothing behind it.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Pure, like every `derive-*` in this folder: a `WorldView` in, plain fields out, no DOM. The
// scratch object is reused between frames for the reason `derive-tech.ts` gives — this runs on
// every publish and a fresh object per frame is garbage the HUD does not need to make.

import {
  CONDITION_MAX,
  ItemId,
  LampState,
  MachineKind,
  REPAIR_KIT_RADIUS_TILES,
  distanceSquaredSubtiles,
  itemSpec,
  machineSpec,
  permille,
  tileCentreSubtiles,
} from '@snack/sim';
import type { Command, MachineView, WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, for the reason `derive-inventory.ts` states at length:
// that path is a tsconfig resolution vitest cannot follow, and this module has a test.
import { HAND_REACH_SQUARED, centreXSub, centreYSub } from './derive-tech';
import { machineLabel } from './tech-copy';

/**
 * Full condition, in the units the view publishes.
 *
 * Derived rather than typed as 1000 for the reason `UpgradeBench` gives about its own threshold:
 * condition and permille happen to share a scale today, and a HUD that quietly depends on that
 * starts lying the day someone rescales condition, with no error anywhere.
 */
const FULL_PERMILLE = permille(CONDITION_MAX, CONDITION_MAX);

/** The mutable scratch `hudStore` keeps between frames. Frozen into `ServiceSlice` on change. */
export interface ServiceFields {
  machineId: number;
  label: string;
  conditionPermille: number;
  jammed: number;
  wrenchDue: number;
  botsWanting: number;
  kitTileX: number;
  kitTileY: number;
  kitPriceCents: number;
  kitsHeld: number;
  handUseful: number;
}

export function createServiceFields(): ServiceFields {
  return {
    machineId: 0,
    label: '',
    conditionPermille: 0,
    jammed: 0,
    wrenchDue: 0,
    botsWanting: 0,
    kitTileX: 0,
    kitTileY: 0,
    kitPriceCents: 0,
    kitsHeld: 0,
    handUseful: 0,
  };
}

/**
 * The free hand verb, and it is `maintenanceCommand`'s body to the branch ([[129]]).
 *
 * Moved here from `pointer.ts` when the right button stopped carrying it. Kept as a function
 * rather than inlined into the component so the rule has one home and a test can hold it to
 * "a jam is whacked before it is tightened" — which is the whole of it, and was the whole of it
 * on the mouse button too.
 */
export function serviceCommand(machineId: number, jammed: boolean): Command {
  return jammed ? { type: 'WhackJam', machineId } : { type: 'RepairMachine', machineId };
}

/**
 * Does maintenance mean anything for this machine?
 *
 * TWO SIM FACTS, NEVER A LIST OF KINDS. `wearPerOperation > 0` is "this kind can degrade", which
 * is what makes the row discoverable on a healthy Fryer instead of appearing only once it is
 * already limping. `wrenchDue` is the sim's own live answer — condition under the threshold, or
 * a docked bot that wants a wrench — and it is the clause that puts the card on an Agri-Bot dock,
 * whose own wear is 0 and whose robots' is not.
 */
export function serviceable(machine: MachineView): boolean {
  const spec = machineSpec(machine.kind as MachineKind);
  if (spec === null) return false;
  return spec.wearPerOperation > 0 || machine.wrenchDue === 1;
}

/**
 * The machine tile the kit is spent on: the one NEAREST THE PLAYER, not the origin corner.
 *
 * `applyUseRepairKit` reach-gates the TILE, and a 2×2 machine reaches further than a hand does:
 * stand at the far corner of a Fryer and its origin tile is a tile and a half past arm's length,
 * so a button quoting $8.00 would have been refused on arrival with no message. The nearest
 * footprint tile is inside hand reach whenever the machine is — which is exactly the condition
 * this card already exists under — and every tile of a footprint is well inside
 * `REPAIR_KIT_RADIUS_TILES` of every other, so the cell it services is the same cell either way.
 */
function nearestFootprintTile(
  view: WorldView,
  machine: MachineView,
): { tileX: number; tileY: number } {
  let bestX = machine.tileX;
  let bestY = machine.tileY;
  let best = Number.POSITIVE_INFINITY;
  for (let y = machine.tileY; y < machine.tileY + machine.tilesHigh; y++) {
    for (let x = machine.tileX; x < machine.tileX + machine.tilesWide; x++) {
      const distance = distanceSquaredSubtiles(
        view.player.xSub,
        view.player.ySub,
        tileCentreSubtiles(x),
        tileCentreSubtiles(y),
      );
      if (distance >= best) continue;
      best = distance;
      bestX = x;
      bestY = y;
    }
  }
  return { tileX: bestX, tileY: bestY };
}

/** How many bots sleeping in this dock are below full condition. Zero for anything else. */
function botsWantingAt(view: WorldView, machineId: number): number {
  let count = 0;
  for (let i = 0; i < view.bots.length; i++) {
    const bot = view.bots[i]!;
    if (bot.dockId !== machineId) continue;
    if (bot.condition < CONDITION_MAX) count += 1;
  }
  return count;
}

function kitsHeld(view: WorldView): number {
  for (let i = 0; i < view.inventory.length; i++) {
    const row = view.inventory[i]!;
    if (row.item === ItemId.RepairKit) return row.count;
  }
  return 0;
}

/** How far a kit reaches, so the card can say what the $8.00 actually buys. */
export const KIT_RADIUS_TILES = REPAIR_KIT_RADIUS_TILES;

export function deriveService(view: WorldView, out: ServiceFields): ServiceFields {
  let best: MachineView | null = null;
  let bestDistance = HAND_REACH_SQUARED + 1;

  for (const machine of view.machines) {
    if (!serviceable(machine)) continue;
    const distance = distanceSquaredSubtiles(
      view.player.xSub,
      view.player.ySub,
      centreXSub(machine),
      centreYSub(machine),
    );
    if (distance > HAND_REACH_SQUARED || distance >= bestDistance) continue;
    bestDistance = distance;
    best = machine;
  }

  if (best === null) {
    out.machineId = 0;
    out.label = '';
    out.conditionPermille = 0;
    out.jammed = 0;
    out.wrenchDue = 0;
    out.botsWanting = 0;
    out.kitTileX = 0;
    out.kitTileY = 0;
    out.kitPriceCents = 0;
    out.kitsHeld = 0;
    out.handUseful = 0;
    return out;
  }

  const tile = nearestFootprintTile(view, best);
  const bots = botsWantingAt(view, best.id);

  out.machineId = best.id;
  out.label = machineLabel(best.kind);
  out.conditionPermille = best.conditionPermille;
  // Read through the LAMP because that is where the projection publishes the jam, and it is the
  // same field `teardownTargetAt` reads it from — one fact, one source, on both sides of a
  // gesture that now has a teardown and a repair pointing at the same machine.
  out.jammed = best.lamp === LampState.Jammed ? 1 : 0;
  out.wrenchDue = best.wrenchDue;
  out.botsWanting = bots;
  out.kitTileX = tile.tileX;
  out.kitTileY = tile.tileY;
  // The stand's own number for a kit. NOT `REPAIR_KIT_PRICE_CENTS` directly: the shop charges
  // `listPriceCents`, and quoting the constant would be a second copy of one price — the exact
  // failure `derive-tech.ts` has a tombstone for.
  out.kitPriceCents = itemSpec(ItemId.RepairKit)?.listPriceCents ?? 0;
  out.kitsHeld = kitsHeld(view);
  // A MIRROR OF THE REDUCER'S REFUSAL, not a second opinion. `applyRepairMachine` returns false
  // when the machine is already at full condition and no docked bot wanted anything — so the
  // button goes quiet on exactly those, and says why, rather than being a live control that does
  // nothing. A jam always has something to whack.
  out.handUseful = out.jammed === 1 || best.conditionPermille < FULL_PERMILLE || bots > 0 ? 1 : 0;

  return out;
}
