// Re-time the golden fixtures for the eight-pour watering can (item 009, 2026-08-13 ruling).
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/amend-goldens-for-can.ts
//
// WHY A FIXTURE AMENDER EXISTS AT ALL. The fixtures' command lists were recorded when the can
// was infinite. Under the restored 8-pour can, every recorded session runs dry on its ninth
// pour and the rest of the recording collapses — no water, no crops, no money, no factory —
// which turns fixtures that guard belts, contracts, and the soda line into fixtures that
// guard a farmer clicking refusals. That is exactly the situation commit `c8f877d` resolved
// for the armful cap, and this follows its precedent: **re-timed, not replaced** — the same
// verbs at the same targets in the same order, plus the shore trips the new rule demands.
//
// WHAT IT DOES, mechanically, per fixture:
//   1. Replays the recorded commands in order, each on its recorded tick plus the drift the
//      amendments have accumulated so far — so every recorded wait (for growth, for a
//      machine cycle, for a wilting window) is preserved or lengthened, never shortened.
//   2. Before any pour with an empty can, walks the player to the shore (held directions,
//      computed live against the actual world), refills, and records those commands.
//   3. Before any reach-gated direct command the player has drifted out of reach of, walks
//      back within reach the same way. Held directions the recording had in flight are
//      restored afterwards, so recorded locomotion keeps its duration.
//   4. Writes the fixture back with the amended command list, the stretched tick count, and
//      the replayed hash.
//
// The script is committed rather than thrown away because it is the provenance of the 14
// amended files — the fixtures README's history table points here.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CropId,
  Direction,
  IntentAction,
  ItemId,
  MachineKind,
  createWorld,
  hashState,
  step,
} from '../src/index';
import {
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_WIDE,
  HAND_REACH_SUBTILES_SQUARED,
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  POND_TILES_HIGH,
  POND_TILES_WIDE,
} from '../src/data';
import { isTileReady, itemCount, machineById, machineCentreSubtiles, tileAt } from '../src/state';
import { reservoirAdjacentToTile } from '../src/water';
import { subtilesToTile, tileCentreSubtiles } from '../src/units';
import { type FixtureCommand, type GoldenFixture, fixturePath, loadFixture } from '../test/goldens';

/** Fixtures whose sessions water more than one canful and therefore need shore trips. */
const AMEND: readonly string[] = [
  'rng-streams',
  'all-verbs',
  'factory-line',
  'water-works',
  'walk-errands',
  'idle-wear',
  'maintenance',
  'soda-line',
  'rotate-and-box',
  'land-deeds',
  'depot-run',
  'the-farm',
];

/**
 * Arc-critical verbs that may be retried later when the amended timeline reaches them short
 * of money or a milestone. The recordings earned on a schedule; shore trips slow it down, so
 * a Charter bought at minute N may only be affordable at minute N+2. Deferring is the honest
 * repair: the same command, later, once the same economy has caught up.
 */
const DEFERRABLE = new Set<Command['type']>([
  'ResearchTech',
  'PlaceMachine',
  'PlaceBelt',
  'PlaceGrabber',
  'CreateContract',
  'CancelContract',
  'LoadCart',
  'DispatchCart',
  'BuyDeed',
]);

interface Session {
  state: WorldState;
  out: FixtureCommand[];
  refills: number;
  correctiveWalks: number;
  refused: string[];
  deferred: Command[];
}

function stepEmpty(session: Session): void {
  step(session.state, { tick: session.state.tick, commands: [] });
}

/** Apply one command on the current tick, recording it and whether the sim accepted it. */
function apply(session: Session, command: Command, injected: boolean): boolean {
  const before = session.state.trace.length;
  session.out.push({ tick: session.state.tick, command });
  step(session.state, { tick: session.state.tick, commands: [command] });
  const applied = session.state.trace.length > before;
  if (!applied) {
    // An INJECTED refusal is amender noise and is dropped. A refused RECORDED command stays
    // in the list, exactly as the recordings kept theirs: it replays to the same refusal,
    // and the coverage gate counts the attempt.
    if (injected) session.out.pop();
    else session.refused.push(`t${session.state.tick - 1} ${command.type}`);
  }
  return applied;
}

/** Retry deferred arc commands, in order, stopping at the first that still refuses. */
function retryDeferred(session: Session): void {
  while (session.deferred.length > 0) {
    const command = session.deferred[0]!;
    const point = reachPoint(session.state, command);
    if (
      point !== null &&
      distSq(session.state, point.xSub, point.ySub) > HAND_REACH_SUBTILES_SQUARED
    ) {
      // Do not chase reach for a deferred command between entries; wait for a quiet moment.
      return;
    }
    if (!apply(session, command, true)) return;
    session.deferred.shift();
  }
}

function stepTo(session: Session, tick: number): void {
  while (session.state.tick < tick) stepEmpty(session);
}

function finishIntent(session: Session): void {
  let guard = 0;
  while (session.state.player.intent !== null) {
    stepEmpty(session);
    guard += 1;
    if (guard > 5_000) throw new Error('errand never completed');
  }
}

function playerTile(state: WorldState): { x: number; y: number } {
  return { x: subtilesToTile(state.player.xSub), y: subtilesToTile(state.player.ySub) };
}

function distSq(state: WorldState, xSub: number, ySub: number): number {
  const dx = state.player.xSub - xSub;
  const dy = state.player.ySub - ySub;
  return dx * dx + dy * dy;
}

/**
 * Dead-reckon toward a point with held directions until `reached` says stop. Every tick is
 * re-aimed against the live world, so the walk cannot drift — it ends because the actual
 * condition the next command needs is actually true.
 */
function walkUntil(
  session: Session,
  reached: () => boolean,
  aim: () => { xSub: number; ySub: number },
): void {
  const state = session.state;
  if (reached()) return;
  session.correctiveWalks += 1;
  let guard = 0;
  while (!reached()) {
    guard += 1;
    if (guard > 20_000) throw new Error('walk never arrived');
    const target = aim();
    const dx = target.xSub - state.player.xSub;
    const dy = target.ySub - state.player.ySub;
    const desired =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.East
          : Direction.West
        : dy >= 0
          ? Direction.South
          : Direction.North;
    if (state.player.moveDir !== desired) {
      apply(session, { type: 'SetMoveDirection', dir: desired }, true);
    } else {
      stepEmpty(session);
    }
  }
  if (state.player.moveDir !== Direction.None) {
    apply(session, { type: 'SetMoveDirection', dir: Direction.None }, true);
  }
}

/** The pond's centre, in subtiles — where a thirsty walk aims. */
function pondCentre(): { xSub: number; ySub: number } {
  return {
    xSub: tileCentreSubtiles(POND_ORIGIN_X + Math.floor(POND_TILES_WIDE / 2)),
    ySub: tileCentreSubtiles(POND_ORIGIN_Y + Math.floor(POND_TILES_HIGH / 2)),
  };
}

function atShore(state: WorldState): boolean {
  const tile = playerTile(state);
  return reservoirAdjacentToTile(state, tile.x, tile.y) !== null;
}

/** Walk to the shore and refill. The beat plan §2's Gardener circuit names. */
function refillTrip(session: Session): void {
  finishIntent(session);
  walkUntil(session, () => atShore(session.state), pondCentre);
  apply(session, { type: 'RefillCan' }, true);
  session.refills += 1;
  if (session.state.player.canCharges <= 0) throw new Error('refill did not fill the can');
}

function needsCharges(command: Command): boolean {
  if (command.type === 'WaterTile') return true;
  return command.type === 'WalkAndAct' && command.action === IntentAction.Water;
}

/** Where a direct command needs the player standing, or null for positionless verbs. */
function reachPoint(state: WorldState, command: Command): { xSub: number; ySub: number } | null {
  switch (command.type) {
    case 'WaterTile':
    case 'PlantTile':
    case 'HarvestTile':
    case 'SwingScythe':
    case 'ApplyFertilizer':
    case 'UseRepairKit':
      return { xSub: tileCentreSubtiles(command.tileX), ySub: tileCentreSubtiles(command.tileY) };
    case 'LoadMachine':
    case 'UnloadMachine':
    case 'RefillHopper':
    case 'RepairMachine':
    case 'WhackJam':
    case 'UpgradeMachine':
    case 'DeconstructMachine': {
      const machine = machineById(state, command.machineId);
      return machine === null ? null : machineCentreSubtiles(machine);
    }
    case 'HitchCart':
    case 'LoadCart':
    case 'DispatchCart': {
      const cart = machineById(state, command.cartId);
      return cart === null ? null : machineCentreSubtiles(cart);
    }
    case 'SellItem':
    case 'BuyItem': {
      let best: { xSub: number; ySub: number } | null = null;
      let bestD = Infinity;
      for (const machine of state.machines) {
        if (machine.kind !== MachineKind.SellBin) continue;
        const centre = machineCentreSubtiles(machine);
        const d = distSq(state, centre.xSub, centre.ySub);
        if (d < bestD) {
          bestD = d;
          best = centre;
        }
      }
      return best;
    }
    case 'RotateGrabber': {
      const grabber = state.grabbers.find((g) => g.id === command.grabberId);
      return grabber === undefined
        ? null
        : { xSub: tileCentreSubtiles(grabber.tileX), ySub: tileCentreSubtiles(grabber.tileY) };
    }
    default:
      return null;
  }
}

/** Issue one walk-to errand and wait for it to finish. Returns whether it was accepted. */
function errand(
  session: Session,
  action: IntentAction,
  tileX: number,
  tileY: number,
  item = 0,
  count = 0,
): boolean {
  finishIntent(session);
  if (action === IntentAction.Water && session.state.player.canCharges <= 0) {
    refillTrip(session);
  }
  const ok = apply(session, { type: 'WalkAndAct', action, tileX, tileY, item, count }, true);
  if (ok) finishIntent(session);
  return ok;
}

function sellPotatoes(session: Session): void {
  const carried = itemCount(session.state, ItemId.RussetPotato);
  if (carried <= 0) return;
  const bin = session.state.machines.find((m) => m.kind === MachineKind.SellBin);
  if (bin === undefined) return;
  errand(session, IntentAction.Sell, bin.tileX, bin.tileY, ItemId.RussetPotato, carried);
}

/**
 * Keep playing the gardener loop — plant, water, refill, harvest, sell — until the deferred
 * purchases are affordable and applied. This is the honest version of "the session came up
 * short": the player farms a while longer, exactly as they would have.
 *
 * Ends by stocking the Chip Kitchens with potatoes, so a fixture whose hands-off window is
 * the whole point (depot-run) still has goods flowing through the line while nobody touches
 * anything.
 */
function tailFarm(session: Session): void {
  const state = session.state;
  const row: { x: number; y: number }[] = [];
  for (let i = 0; i < FIELD_TILES_WIDE; i++) {
    row.push({ x: FIELD_ORIGIN_X + i, y: FIELD_ORIGIN_Y });
  }
  const start = state.tick;

  while (session.deferred.length > 0 && state.tick - start < 250_000) {
    for (const { x, y } of row) {
      const tile = tileAt(state, x, y);
      if (tile !== null && tile.crop === CropId.None) {
        errand(session, IntentAction.Plant, x, y, CropId.RussetPotato);
      }
    }
    for (const { x, y } of row) {
      const tile = tileAt(state, x, y);
      if (tile !== null && tile.crop !== CropId.None && !isTileReady(tile)) {
        errand(session, IntentAction.Water, x, y);
      }
    }
    let waited = 0;
    while (
      waited < 4_000 &&
      !row.every((p) => {
        const tile = tileAt(state, p.x, p.y);
        return tile === null || tile.crop === CropId.None || isTileReady(tile);
      })
    ) {
      stepEmpty(session);
      waited += 1;
    }
    for (const { x, y } of row) {
      const tile = tileAt(state, x, y);
      if (tile !== null && isTileReady(tile)) {
        errand(session, IntentAction.Harvest, x, y);
        if (itemCount(state, ItemId.RussetPotato) >= 8) sellPotatoes(session);
      }
    }
    sellPotatoes(session);
    finishIntent(session);
    retryDeferred(session);
  }

  if (session.deferred.length > 0) return;

  // Stock the line for the hands-off window: the window that follows must contain a
  // departure, the road, and the payout, with nobody touching anything. That needs the
  // standing route held one bag short of a truck AND the grabber-fed kitchen holding enough
  // potatoes to push it over — so farm, feed, and watch, and stop the moment both are true
  // with no errand left in flight.
  const kitchens = state.machines.filter((m) => m.kind === MachineKind.ChipKitchen);
  if (kitchens.length === 0) return;
  const grabberAdjacent = kitchens.filter((kitchen) =>
    state.grabbers.some(
      (g) =>
        g.tileX >= kitchen.tileX - 1 &&
        g.tileX <= kitchen.tileX + 2 &&
        g.tileY >= kitchen.tileY - 1 &&
        g.tileY <= kitchen.tileY + 2,
    ),
  );
  const line = grabberAdjacent.length > 0 ? grabberAdjacent[0]! : kitchens[0]!;

  const settled = (): boolean => {
    const route = state.contracts[0];
    if (route === undefined) return true;
    const fed = line.inputCounts.reduce((a, b) => a + b, 0);
    return route.stocked >= route.quantityPerRun - 1 && fed >= 3;
  };

  let guard = 0;
  while (guard < 400_000) {
    if (settled()) {
      if (session.state.player.intent === null) break;
      stepEmpty(session);
      guard += 1;
      continue;
    }
    const fed = line.inputCounts.reduce((a, b) => a + b, 0);
    if (fed <= 1) {
      growPotatoes(session, 12);
      const carried = itemCount(state, ItemId.RussetPotato);
      if (carried > 0) {
        errand(session, IntentAction.Load, line.tileX, line.tileY, 0, carried);
      }
      finishIntent(session);
    } else {
      stepEmpty(session);
      guard += 1;
    }
  }
}

/** Plant, water, and harvest the top field row until the armful holds `target` potatoes. */
function growPotatoes(session: Session, target: number): void {
  const state = session.state;
  const row: { x: number; y: number }[] = [];
  for (let i = 0; i < FIELD_TILES_WIDE; i++) {
    row.push({ x: FIELD_ORIGIN_X + i, y: FIELD_ORIGIN_Y });
  }
  const start = state.tick;
  while (itemCount(state, ItemId.RussetPotato) < target && state.tick - start < 30_000) {
    for (const { x, y } of row) {
      const tile = tileAt(state, x, y);
      if (tile !== null && tile.crop === CropId.None) {
        errand(session, IntentAction.Plant, x, y, CropId.RussetPotato);
      }
    }
    for (const { x, y } of row) {
      const tile = tileAt(state, x, y);
      if (tile !== null && tile.crop !== CropId.None && !isTileReady(tile)) {
        errand(session, IntentAction.Water, x, y);
      }
    }
    let waited = 0;
    while (
      waited < 4_000 &&
      !row.some((p) => {
        const tile = tileAt(state, p.x, p.y);
        return tile !== null && isTileReady(tile);
      })
    ) {
      stepEmpty(session);
      waited += 1;
    }
    for (const { x, y } of row) {
      if (itemCount(state, ItemId.RussetPotato) >= target) break;
      const tile = tileAt(state, x, y);
      if (tile !== null && isTileReady(tile)) {
        errand(session, IntentAction.Harvest, x, y);
      }
    }
  }
}

function amend(name: string): void {
  const preserveReplacement = name === 'walk-errands';
  const fixture = loadFixture(name);
  const session: Session = {
    state: createWorld(fixture.seed),
    out: [],
    refills: 0,
    correctiveWalks: 0,
    refused: [],
    deferred: [],
  };
  let shift = 0;
  let heldDir: Direction = Direction.None;

  for (const entry of fixture.commands) {
    const command = entry.command;
    stepTo(session, entry.tick + shift);

    let injectedHere = false;

    // A recorded errand normally waits its turn. The recordings were spaced so each errand
    // had finished before the next was issued; amendment skews walk lengths (a farmer fresh
    // from the pond starts further away), and without this wait a delayed errand would be
    // REPLACED by the next one mid-walk, silently dropping its verb and cascading — a
    // harvest that never happened leaves a tile the next plant refuses. `walk-errands` is
    // exempt because deliberate mid-walk replacement is one of the four endings it guards.
    if (command.type === 'WalkAndAct' && !preserveReplacement) {
      finishIntent(session);
    }

    if (needsCharges(command) && session.state.player.canCharges <= 0) {
      refillTrip(session);
      injectedHere = true;
    }

    const point = reachPoint(session.state, command);
    if (
      point !== null &&
      distSq(session.state, point.xSub, point.ySub) > HAND_REACH_SUBTILES_SQUARED
    ) {
      finishIntent(session);
      // Stop just inside reach rather than at the target: 300 of 384 subtiles leaves margin
      // for the ~52-subtile granularity of a held-direction step.
      walkUntil(
        session,
        () => distSq(session.state, point.xSub, point.ySub) <= 300 * 300,
        () => point,
      );
      injectedHere = true;
    }

    // An injected trip cancelled whatever direction the recording had in flight; put it
    // back so the recorded segment keeps its shape until its own recorded stop.
    if (injectedHere && heldDir !== Direction.None && command.type !== 'SetMoveDirection') {
      apply(session, { type: 'SetMoveDirection', dir: heldDir }, true);
    }

    if (DEFERRABLE.has(command.type)) {
      if (!apply(session, command, true)) {
        session.deferred.push(command);
        session.refused.push(`t${session.state.tick} ${command.type} (deferred)`);
      }
    } else {
      apply(session, command, false);
    }
    if (command.type === 'SetMoveDirection') heldDir = command.dir;
    shift = session.state.tick - entry.tick - 1;
    if (shift < 0) shift = 0;

    if (session.deferred.length > 0) retryDeferred(session);
  }

  // Whatever is still owed at the end of the recording gets earned honestly: the farmer
  // keeps working the gardener loop — plant, water (refilling the can), harvest, sell —
  // until the deferred purchases become affordable, exactly as a player short of a depot
  // would. Fixtures whose economies were already dead before this change (see the report
  // in the item log) stall immediately and give up rather than farming for an hour.
  if (session.deferred.length > 0 && name === 'depot-run') {
    tailFarm(session);
  } else {
    let stalls = 0;
    while (session.deferred.length > 0 && stalls < 3) {
      const moneyBefore = session.state.moneyCents;
      const owedBefore = session.deferred.length;
      finishIntent(session);
      retryDeferred(session);
      if (session.deferred.length === owedBefore) {
        for (let i = 0; i < 2_000; i++) stepEmpty(session);
        if (session.state.moneyCents === moneyBefore) stalls += 1;
      }
    }
  }
  if (session.deferred.length > 0) {
    session.refused.push(`UNRESOLVED deferred: ${session.deferred.map((c) => c.type).join(',')}`);
    // Put the unresolved commands back into the record as the refusals they are: attempted
    // once more, refused, and kept in the list so the session still says what was asked —
    // the same shape the original zombie recordings had — and the coverage gate still sees
    // the verb.
    for (const command of session.deferred) {
      const attemptTick = session.state.tick;
      if (!apply(session, command, true)) {
        session.out.push({ tick: attemptTick, command });
        stepTo(session, attemptTick + 1);
      }
    }
    session.deferred.length = 0;
  }

  // For a fixture with a hands-off window, the window keeps its original length and starts
  // after the last thing the amended session did. Everything else keeps its recorded tail.
  let ticks = Math.max(fixture.ticks + shift, session.state.tick);
  const amended: GoldenFixture = {
    ...fixture,
    ticks,
    expectedHash: '00000000',
    commands: session.out,
  };
  if (fixture.handsOffFromTick !== undefined) {
    const windowLength = fixture.ticks - fixture.handsOffFromTick;
    const handsOff = Math.max(fixture.handsOffFromTick + shift, session.state.tick);
    amended.handsOffFromTick = handsOff;
    ticks = handsOff + windowLength;
    amended.ticks = ticks;
  }
  stepTo(session, ticks);
  amended.expectedHash = hashState(session.state);

  writeFileSync(fixturePath(name), `${JSON.stringify(amended, null, 2)}\n`);
  console.log(
    `  ${name}: +${session.refills} refills, ${session.correctiveWalks} walks, ` +
      `ticks ${fixture.ticks} -> ${ticks}, hash ${fixture.expectedHash} -> ${amended.expectedHash}` +
      (session.refused.length > 0 ? `, refused: ${session.refused.join(' | ')}` : ''),
  );
}

for (const name of AMEND) amend(name);
console.log('\nDone. Run `yarn goldens:regen` to confirm the written hashes replay.');
