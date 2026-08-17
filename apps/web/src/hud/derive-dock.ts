// WorldView → the dock card: what the bot dock you are standing at has been told, or — for the
// one dock that is told nothing — what its robot is doing anyway.
//
// TWO SUBJECTS, ONE CARD, AND THE SPLIT IS THE POINT ([[107]]). A Harvester Dock and a Planter
// Dock are configured by pointing them at a rectangle; a Drone Bay is not configured at all. Both
// are `isBotDockKind`, both are machines you walk up to, and for three items this file used that
// one predicate to decide who got a ZONE PICKER — so the bay asked for an instruction its robot
// would never read. `dockTakesZone` below is the narrower question, and it is the one the picker
// is actually asking.
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

import {
  MachineKind,
  cropSpec,
  distanceSquaredSubtiles,
  isBotDockKind,
  machineSpec,
} from '@snack/sim';
import type { CropId, MachineView, WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, for the reason `derive-inventory.ts` states at length:
// that path is a tsconfig resolution vitest cannot follow, and this module has a test.
import { HAND_REACH_SQUARED, centreXSub, centreYSub } from './derive-tech';
import { itemName } from './item-copy';
import { machineLabel } from './tech-copy';
import type { DockZoneOption } from './types';

/**
 * DOES THIS DOCK TAKE A ZONE — which is not the same question as "is this a dock" ([[107]]).
 *
 * **THE CONFLATION, AND WHY IT SHOWED UP AS A BUG THE OWNER COULD SEE.** `isBotDockKind` is true
 * for all three dock kinds and is right to be: it means *a bot sleeps here*, which is what
 * placement wants (`applyPlaceMachine` spawns the bot off it), what the bots' own geometry wants,
 * and what item 088's seed-shelf gate wants. This card gated its ZONE PICKER on that predicate —
 * and a picker is an answer to a different question. A Drone Bay has no zone and cannot have one:
 * `advanceRepairDrone` chooses its next errand by scanning every machine on the lot for a wrench
 * (`nextServiceTarget`) and never once reads `boundZone`. So the bay drew a rectangle-picker and
 * a "No zone. Its bot has nothing to do" line over a drone that was working perfectly, which
 * reads exactly like a machine idling until it is told something.
 *
 * The two farm docks are the whole of the yes: a zone IS a harvester's and a planter's entire
 * instruction set (`bots.ts` returns early on `dock.boundZone === 0` for both).
 *
 * ⚠️ **HANDOFF — THE SIM HAS THE SAME CONFLATION AND IT IS NOT THIS LANE.** `applySetDockZone`
 * (`tick.ts` ~1372) gates on `isBotDockKind` too, so it will happily accept a `SetDockZone`
 * aimed at a Drone Bay and write a `boundZone` that nothing will ever read — a legal command
 * that changes the hash and means nothing. Nothing dispatches it once this card stops offering
 * one, so it is a latent trap rather than a live bug, but the honest fix is for this predicate
 * to live beside `isBotDockKind` in `data.ts` and for the reducer to ask it. `packages/sim` is
 * another agent's lane this run, so the predicate lives here and the sim's half is reported.
 */
export function dockTakesZone(kind: MachineKind): boolean {
  return kind === MachineKind.HarvesterDock || kind === MachineKind.PlanterDock;
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
  takesZone: number;
  boundZone: number;
  boundName: string;
  botPhase: number;
  botConditionPermille: number;
  serviceDue: number;
  zones: DockZoneOption[];
}

export function createDockFields(): DockFields {
  return {
    machineId: 0,
    kind: 0,
    label: '',
    planter: 0,
    takesZone: 0,
    boundZone: 0,
    boundName: '',
    botPhase: -1,
    botConditionPermille: 0,
    serviceDue: 0,
    zones: [],
  };
}

function clear(out: DockFields): DockFields {
  out.machineId = 0;
  out.kind = 0;
  out.label = '';
  out.planter = 0;
  out.takesZone = 0;
  out.boundZone = 0;
  out.boundName = '';
  out.botPhase = -1;
  out.botConditionPermille = 0;
  out.serviceDue = 0;
  out.zones = [];
  return out;
}

/**
 * The dock the player is standing at, and — for the two that take one — every zone it could be
 * pointed at.
 *
 * Nearest-within-reach, which is `deriveBench`'s rule and uses `deriveBench`'s exported helpers —
 * one mirror of the sim's reach geometry in this package is a mirror that can be checked, and two
 * are two that can disagree.
 *
 * **THE SUBJECT IS STILL ALL THREE DOCKS; THE ZONE LIST IS NOT** ([[107]]). The bay is a machine
 * the player walks up to and it should say something when they do, so it keeps the card and the
 * reach rule. What it does not keep is the picker, and the list is left empty rather than filled
 * and hidden: an empty list is what the store already compares cheaply, and a bay that carried
 * eight zone options it would never offer would be one refactor away from offering them again.
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
  const takesZone = dockTakesZone(best.kind as MachineKind);
  // Read straight off the projection since [[107]]: `MachineView.boundZone` is published by
  // `projectMachines` and 0 is the sim's own "no orders". The defensive `dockZoneOf` read that
  // stood here was written against a build where the field had not landed yet, and it had been
  // out of date for three items. A bay's value is not read at all — a legacy save can carry a
  // non-zero one, because the reducer used to accept the command this card used to offer, and
  // it means exactly as much now as it meant then, which is nothing.
  const boundZone = best.boundZone;

  const zones: DockZoneOption[] = [];
  let boundName = '';
  for (const zone of takesZone ? view.zones : []) {
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

  // WHAT THE BAY'S CARD IS ABOUT INSTEAD OF ZONES: how much of the lot is waiting for a wrench.
  //
  // `MachineView.wrenchDue` is the sim's OWN answer — `view.ts` sets it from the same clause
  // `machineWantsService` uses, jam included — so this is a count of the projection rather than a
  // second opinion about when a machine is due. It is the drone's actual queue: `nextServiceTarget`
  // scans exactly these machines. Counted only for the bay, because a harvester dock's card has no
  // room for it and no use for it.
  let serviceDue = 0;
  if (!takesZone) {
    for (const machine of view.machines) {
      if (machine.wrenchDue === 1) serviceDue += 1;
    }
  }

  out.machineId = best.id;
  out.kind = best.kind;
  out.label = machineLabel(best.kind);
  // Which of the two ZONE docks this is, asked of the sim's own spec rather than of the kind: the
  // planter is the one with a seed hopper, and `inputCapacity` is where that fact already lives.
  //
  // ⚠️ THE `takesZone` GUARD IS NOT BELT AND BRACES ([[107]]). The Drone Bay's `inputCapacity` is
  // 12 — frozen balance data from the parts hopper item 090 retired, deliberately left in the
  // table so a boxed bay still prices — so the spec question alone answers "yes, a hopper" about
  // a machine with no door. Asking it only of the docks the flag is about is what keeps a stale
  // number from quietly becoming a claim.
  out.planter = takesZone && spec !== null && spec.inputCapacity > 0 ? 1 : 0;
  out.takesZone = takesZone ? 1 : 0;
  out.serviceDue = serviceDue;
  out.boundZone = boundZone;
  out.boundName = boundName;
  out.botPhase = botPhase;
  out.botConditionPermille = botConditionPermille;
  out.zones = zones;
  return out;
}
