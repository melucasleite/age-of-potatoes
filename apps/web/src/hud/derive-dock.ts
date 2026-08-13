// WorldView → the dock card: which Grow Zone the Agri-Bot dock you are standing at is working.
//
// WHY THIS EXISTS AT ALL. `SetDockZone` has been in the sim since the bots landed and **no
// surface in the game issued it** ([[038]]'s last gap), so a player could buy a $600 harvester
// dock, watch its bot stand in the doorway forever, and have no way to tell it where to go. The
// zone is the bot's entire instruction set — one dock, one zone, and item 018 already built the
// surface that says what should be growing where — so the only thing missing was a way to point
// at it. This file is the reading half of that; `DockCard.tsx` is the pointing half.
//
// WHY IT IS NOT PART OF THE BENCH, since `UpgradeBench.tsx` is already the at-the-machine card
// and a dock is a machine you stand at. `deriveBench` picks its subject with `acceptsUpgrades`,
// which is `workPerOperation > 0` — and a dock's is 0, in the sim's own spec, because a dock does
// no work: its BOT does. So a dock could only get into the bench by widening that predicate, and
// then the bench would be drawing three dials it cannot price, a progress-derived "boxable"
// mirror off a lamp that never turns green, and a condition bar for a machine whose
// `wearPerOperation` is 0 while the wear it actually has lives on an entity the bench has never
// heard of. Four special cases in a file whose whole argument is that every dial states its
// trade. The two cards cannot collide — `acceptsUpgrades` and `isBotDockKind` are disjoint by
// construction — so they share the same corner and the same reach rule, and exactly one of them
// is ever on screen. Same interaction, different subject: the bench asks what a machine is worth
// making better, and this asks what a machine has been told to do.
//
// NOTHING HERE DECIDES ANYTHING THE SIM DECIDES. The zone list is `view.zones` in the world's own
// order, the counts are the projection's, whether a crop regrows is `CropSpec.regrowTicks` read
// rather than a list of crop ids kept here ([[038]]'s instruction 4), and the reach test is the
// bench's own exported mirror rather than a second copy of the geometry.

import { cropSpec, distanceSquaredSubtiles, isBotDockKind, machineSpec } from '@snack/sim';
import type { CropId, MachineKind, MachineView, WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, for the reason `derive-inventory.ts` states at length:
// that path is a tsconfig resolution vitest cannot follow, and this module has a test.
import { HAND_REACH_SQUARED, centreXSub, centreYSub } from './derive-tech';
import { itemName } from './item-copy';
import { machineLabel } from './tech-copy';
import type { DockZoneOption } from './types';

/**
 * What `dockZoneOf` returns when the projection does not carry a dock's orders.
 *
 * **-1 IS NOT A ZONE AND IS NOT "UNBOUND" — IT IS "THE VIEW DID NOT SAY".** Zero already means
 * something specific and load-bearing in the sim (`Machine.boundZone === 0` is a dock with no
 * orders, whose bot parks), so a third state was needed rather than folding the unknown into it:
 * a card that printed "no zone" over a working dock would be contradicting a robot the player can
 * see walking across the field.
 */
export const ZONE_UNKNOWN = -1;

/**
 * The dock's bound zone, when the projection publishes it.
 *
 * ⚠️ **HANDOFF, AND IT IS THE ONE THING THIS FEATURE IS STILL SHORT.** `Machine.boundZone` is
 * real world state — it is in `state.ts`, in the hash, in the canonical save payload, and in the
 * format-11 migration — but `MachineView` does not carry it and `projectMachines` never reads it.
 * `GrabberView.filter` publishes exactly this kind of fact for exactly this kind of panel, so the
 * omission looks like an oversight rather than a decision. This lane is `apps/web/src/hud/**` and
 * `packages/sim/src/view.ts` belongs to another agent this run, so it is reported rather than
 * reached for — the same call the render lane made about `BotView` not being exported.
 *
 * The read is written so the field can land with **no edit here**: an unpublished field reports
 * `ZONE_UNKNOWN` and the card shows a picker with no claim about the present, and the moment
 * `boundZone: number` appears on `MachineView` the card starts naming the zone and saying "no
 * orders" when there are none. The cast goes through `unknown` deliberately — a typed optional
 * property would become a `number` the day the field lands, and `x === undefined` on a `number`
 * is a compile error, so the honest-looking version is the one that breaks the build later.
 */
export function dockZoneOf(machine: MachineView): number {
  const published = (machine as unknown as { readonly boundZone?: unknown }).boundZone;
  return typeof published === 'number' ? published : ZONE_UNKNOWN;
}

/**
 * The colour the ground is painted in this zone — the eight tints from `render/zones.ts`, copied.
 *
 * **A ZONE IS CALLED "Zone 3" UNTIL SOMEBODY RENAMES IT** (`state.ts` mints the default), so the
 * name on a button is frequently useless for the one question the player has: *which rectangle is
 * that?* The colour is the answer, because it is the same colour the overlay paints on the field.
 *
 * COPIED RATHER THAN IMPORTED, which is `item-art.ts`'s call about `render/textures.ts` made
 * again for the same reason: `render/zones.ts` imports `./textures`, whose first line imports
 * `pixi.js` and whose second reaches the generated atlas manifest through the `@/` alias. Pulling
 * that into a server-rendered React panel would drag a GPU context into the HUD tree, and it is
 * the exact import that makes a module unloadable by vitest. Eight hex strings and a modulo are
 * the small half; the rule that a colour is `(id - 1) % count` is the part that would actually
 * matter if it drifted, and it is pinned by a test on this side.
 *
 * ⚠️ HANDOFF: the honest fix is for the palette to live in one pixi-free module both lanes
 * import. That module would be in `apps/web/src/game/render/`, which is not this lane.
 */
const ZONE_TINTS: readonly string[] = [
  '#6fc0e8', // sky
  '#e8b53d', // amber
  '#8fd45a', // lime
  '#d2617f', // rose
  '#a98be8', // violet
  '#4bd2b0', // teal
  '#e8804b', // ember
  '#d8d8d8', // chalk
];

export function zoneSwatch(zoneId: number): string {
  if (zoneId <= 0) return '#6d5c4d';
  return ZONE_TINTS[(zoneId - 1) % ZONE_TINTS.length]!;
}

/** The mutable scratch the store fills each publish, mirroring `DockSlice` minus its version. */
export interface DockFields {
  machineId: number;
  kind: number;
  label: string;
  planter: number;
  boundZone: number;
  boundName: string;
  botPhase: number;
  botConditionPermille: number;
  zones: DockZoneOption[];
}

export function createDockFields(): DockFields {
  return {
    machineId: 0,
    kind: 0,
    label: '',
    planter: 0,
    boundZone: ZONE_UNKNOWN,
    boundName: '',
    botPhase: -1,
    botConditionPermille: 0,
    zones: [],
  };
}

function clear(out: DockFields): DockFields {
  out.machineId = 0;
  out.kind = 0;
  out.label = '';
  out.planter = 0;
  out.boundZone = ZONE_UNKNOWN;
  out.boundName = '';
  out.botPhase = -1;
  out.botConditionPermille = 0;
  out.zones = [];
  return out;
}

/**
 * The dock the player is standing at, and every zone it could be pointed at.
 *
 * Nearest-within-reach, which is `deriveBench`'s rule and uses `deriveBench`'s exported helpers —
 * one mirror of the sim's reach geometry in this package is a mirror that can be checked, and two
 * are two that can disagree.
 */
export function deriveDock(view: WorldView, out: DockFields): DockFields {
  let best: MachineView | null = null;
  let bestDistance = HAND_REACH_SQUARED + 1;

  for (const machine of view.machines) {
    // The view carries plain numbers by rule — no enums across the boundary (§12) — so the kind
    // widens on the way out and narrows here, exactly as the bench does.
    if (!isBotDockKind(machine.kind as MachineKind)) continue;
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

  if (best === null) return clear(out);

  const spec = machineSpec(best.kind as MachineKind);
  const boundZone = dockZoneOf(best);

  const zones: DockZoneOption[] = [];
  let boundName = '';
  for (const zone of view.zones) {
    const crop = cropSpec(zone.crop as CropId);
    zones.push({
      id: zone.id,
      name: zone.name,
      // A zone with no crop assigned is a legal state — item 018's zones are "a plan, not a
      // machine" and an unassigned one is a rectangle somebody has painted and not filled in.
      cropName: crop === null ? '' : itemName(crop.yieldItem),
      // READ, NEVER LISTED. §5 paces the whole feature on this one flag: a harvester alone
      // sustains a regrowing crop forever and empties a one-shot zone once. A table of crop ids
      // kept on this side would be a second opinion about balance data, and it would be wrong the
      // first time a crop was added.
      regrows: crop !== null && crop.regrowTicks > 0 ? 1 : 0,
      tiles: zone.tiles,
      planted: zone.planted,
      mature: zone.mature,
    });
    if (zone.id === boundZone) boundName = zone.name;
  }

  // The bot is found THROUGH the dock rather than by taking the first one, so a lot with two
  // docks describes the robot that belongs to the one you are standing at — the same reasoning
  // the renderer's ceremony uses to halo the right shed.
  let botPhase = -1;
  let botConditionPermille = 0;
  for (const bot of view.bots) {
    if (bot.dockId !== best.id) continue;
    botPhase = bot.phase;
    botConditionPermille = bot.conditionPermille;
    break;
  }

  out.machineId = best.id;
  out.kind = best.kind;
  out.label = machineLabel(best.kind);
  // Which dock this is, asked of the sim's own spec rather than of the kind: the planter is the
  // one with a seed hopper, and `inputCapacity` is where that fact already lives.
  out.planter = spec !== null && spec.inputCapacity > 0 ? 1 : 0;
  out.boundZone = boundZone;
  out.boundName = boundName;
  out.botPhase = botPhase;
  out.botConditionPermille = botConditionPermille;
  out.zones = zones;
  return out;
}
