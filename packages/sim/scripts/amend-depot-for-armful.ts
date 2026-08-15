// Re-time the `depot-run` golden fixture for the removed armful cap (item 068).
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/amend-depot-for-armful.ts
//
// WHY. `depot-run` was recorded under the twelve-item armful. With the cap removed, its early
// harvest errands all succeed on the spot, the crop timeline shifts under the recorded
// watering rhythm, and the session reaches its Chip Kitchen purchase at tick 10,214 about
// $20 short — the placement refuses, every later machine id shifts out from under the trace,
// and the 5,000-tick hands-off window at the end goes silent. The world is fine; the
// *schedule* is wrong. So this follows `amend-goldens-for-can.ts`'s precedent exactly:
// arc-critical commands that refuse are DEFERRED — the same command, later, once the same
// economy has caught up — retried in recorded order at quiet moments so machine ids land
// exactly as recorded; and reach-gated arc commands get a corrective walk first when the
// diverged session left the farmer standing elsewhere. Farm-verb refusals (a pour at a crop
// that ripened early, a plant into a tile still occupied) stay refusals: harmless no-ops
// in replay, exactly as the can amender left them.
//
// Committed rather than thrown away because it is the provenance of the amended file — the
// fixtures README's history table points here.

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
import { HAND_REACH_SUBTILES_SQUARED, POND_ORIGIN_X, POND_ORIGIN_Y } from '../src/data';
import {
  type Machine,
  isTileReady,
  itemCount,
  machineById,
  machineCentreSubtiles,
} from '../src/state';
import { type GoldenFixture, fixturePath, loadFixture } from '../test/goldens';

const fixture = loadFixture('depot-run');
const state: WorldState = createWorld(fixture.seed);

/** Arc-critical commands: ids, tech, contracts, and the cart run. Order must survive. */
function isArc(command: Command): boolean {
  switch (command.type) {
    case 'PlaceMachine':
    case 'PlaceGrabber':
    case 'ResearchTech':
    case 'LoadCart':
    case 'DispatchCart':
    case 'CreateContract':
    case 'CancelContract':
      return true;
    default:
      return false;
  }
}

/** The machine a reach-gated arc command needs the farmer beside, or null. */
function reachMachine(command: Command): number | null {
  if (command.type === 'LoadCart' || command.type === 'DispatchCart') return command.cartId;
  return null;
}

function apply(command: Command): boolean {
  const before = state.trace.length;
  step(state, { tick: state.tick, commands: [command] });
  return state.trace.length > before;
}

function stepEmpty(): void {
  step(state, { tick: state.tick, commands: [] });
}

function withinReachOf(machine: Machine): boolean {
  const centre = machineCentreSubtiles(machine);
  const dx = state.player.xSub - centre.xSub;
  const dy = state.player.ySub - centre.ySub;
  return dx * dx + dy * dy <= HAND_REACH_SUBTILES_SQUARED;
}

let correctiveWalks = 0;

/** Dead-reckon to within hand reach of a machine with held directions, then let go. */
function walkWithinReach(machineId: number): void {
  const machine = machineById(state, machineId);
  if (machine === null || withinReachOf(machine)) return;
  correctiveWalks += 1;
  let guard = 0;
  for (;;) {
    const live = machineById(state, machineId);
    if (live === null) return;
    if (withinReachOf(live)) break;
    guard += 1;
    if (guard > 20_000) throw new Error('a corrective walk never arrived');
    const centre = machineCentreSubtiles(live);
    const dx = centre.xSub - state.player.xSub;
    const dy = centre.ySub - state.player.ySub;
    const desired =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.East
          : Direction.West
        : dy >= 0
          ? Direction.South
          : Direction.North;
    if (state.player.moveDir !== desired) apply({ type: 'SetMoveDirection', dir: desired });
    else stepEmpty();
  }
  if (state.player.moveDir !== Direction.None) {
    apply({ type: 'SetMoveDirection', dir: Direction.None });
  }
}

/** Try one arc command where the farmer stands, walking over first when reach demands it. */
function tryArc(command: Command): boolean {
  const target = reachMachine(command);
  if (target !== null && machineById(state, target) !== null) walkWithinReach(target);
  return apply(command);
}

const deferred: Command[] = [];
let deferrals = 0;

/** Retry deferred arc commands, in recorded order, stopping at the first still refusing. */
function retryDeferred(): void {
  while (deferred.length > 0) {
    if (!tryArc(deferred[0]!)) return;
    deferred.shift();
  }
}

for (let i = 0; i < fixture.commands.length; i++) {
  const entry = fixture.commands[i]!;
  while (state.tick < entry.tick) {
    stepEmpty();
    // A quiet tick between recorded beats is where a deferred command gets another look —
    // but never while a held direction is mid-run, so recorded locomotion keeps its shape.
    if (deferred.length > 0 && state.player.moveDir === Direction.None) retryDeferred();
  }

  if (isArc(entry.command)) {
    // Recorded order IS id order. While anything is deferred, everything arc queues behind it.
    if (deferred.length > 0 || !tryArc(entry.command)) {
      deferred.push(entry.command);
      deferrals += 1;
    }
    continue;
  }
  apply(entry.command); // A refused farm verb is a harmless stale beat; the replay shrugs too.
}

// Drain whatever is still deferred, past the recorded session. Idle ticks alone cannot mint
// money — and the deferred tail here is money-gated (Trucking at $600, the Depot at $400) in
// a world whose diverged early economy ran about $400 behind the recording — so the drain
// EARNS: it sells the surplus goods the un-capped session accumulated in the farmer's arms,
// and then runs ordinary gardener passes (plant, water on the can, harvest, sell) against
// the same field with the same verbs the session used all along, retrying the deferred
// commands between beats until every one of them lands.
function findIntentless(): void {
  let guard = 0;
  while (state.player.intent !== null) {
    stepEmpty();
    guard += 1;
    if (guard > 10_000) throw new Error('an earn-phase errand never completed');
  }
}
function earnErrand(action: IntentAction, x: number, y: number, item = 0, count = 0): boolean {
  findIntentless();
  const ok = apply({ type: 'WalkAndAct', action, tileX: x, tileY: y, item, count });
  if (ok) findIntentless();
  return ok;
}
const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
const shore = { x: POND_ORIGIN_X, y: POND_ORIGIN_Y - 1 };
function sellSurplus(): void {
  for (const item of [ItemId.BaggedChips, ItemId.RussetPotato, ItemId.Compost]) {
    const held = itemCount(state, item);
    if (held > 0) earnErrand(IntentAction.Sell, bin.tileX, bin.tileY, item, held);
  }
}

let passes = 0;
while (deferred.length > 0) {
  retryDeferred();
  if (deferred.length === 0) break;
  passes += 1;
  if (passes > 30) {
    throw new Error(
      `still deferred after ${String(passes)} passes: ${JSON.stringify(deferred[0])}`,
    );
  }

  sellSurplus();
  retryDeferred();
  if (deferred.length === 0) break;

  // One gardener pass over the original field: harvest what stands, replant, water, wait.
  for (const tile of [...state.field]) {
    if (isTileReady(tile) || tile.compost > 0)
      earnErrand(IntentAction.Harvest, tile.tileX, tile.tileY);
  }
  sellSurplus();
  for (const tile of [...state.field]) {
    if (tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      earnErrand(IntentAction.Plant, tile.tileX, tile.tileY, CropId.RussetPotato);
    }
  }
  for (const tile of [...state.field]) {
    if (tile.crop === CropId.None) continue;
    if (state.player.canCharges <= 0) earnErrand(IntentAction.RefillCan, shore.x, shore.y);
    earnErrand(IntentAction.Water, tile.tileX, tile.tileY);
  }
  let ripening = 0;
  while (ripening < 6_000 && !state.field.some((tile) => isTileReady(tile))) {
    stepEmpty();
    ripening += 1;
  }
  for (const tile of [...state.field]) {
    if (isTileReady(tile)) earnErrand(IntentAction.Harvest, tile.tileX, tile.tileY);
  }
  sellSurplus();
}

// The hands-off window: five thousand silent ticks past the last command actually issued.
const lastCommandTick = state.trace[state.trace.length - 1]!.tick;
const boundary = Math.max(fixture.handsOffFromTick!, lastCommandTick + 66);
while (state.tick < boundary) stepEmpty();

const moneyBefore = state.moneyCents;
const runsBefore = state.contracts.map((c) => c.runsCompleted);
for (let i = 0; i < 5_000; i++) stepEmpty();

// --- The story, asserted before anything is written -------------------------------------
if (state.contracts.length !== 1) {
  throw new Error(`expected the one surviving contract, found ${String(state.contracts.length)}`);
}
if (state.moneyCents <= moneyBefore) throw new Error('the hands-off window earned nothing');
if (state.contracts[0]!.runsCompleted < (runsBefore[0] ?? 0) + 2) {
  throw new Error('the depot did not complete two runs in the window');
}
for (const entry of state.trace) {
  if (entry.tick >= boundary) throw new Error('a command leaked past the hands-off boundary');
}

const amended: GoldenFixture = {
  name: fixture.name,
  description: fixture.description,
  seed: fixture.seed,
  ticks: state.tick,
  expectedHash: hashState(state),
  handsOffFromTick: boundary,
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('depot-run'), `${JSON.stringify(amended, null, 2)}\n`);
console.log(
  `depot-run amended: ${String(deferrals)} deferral(s), ${String(correctiveWalks)} corrective ` +
    `walk(s), ${String(amended.ticks)} ticks, ${String(amended.commands.length)} commands, ` +
    `hash ${fixture.expectedHash} -> ${amended.expectedHash}`,
);
