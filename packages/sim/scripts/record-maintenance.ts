// Re-record the `maintenance` golden fixture from scratch, under the 8-pour can.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-maintenance.ts
//
// WHY THIS EXISTS. The original `maintenance.json` was recorded under the infinite can and
// re-timed by `amend-goldens-for-can.ts`. The amendment's economy ran slower than the
// recording's, so the fixture's one `PlaceMachine` was deferred, never became affordable at
// its recorded moment, and was appended at the very end as a recorded refusal — leaving a
// fixture whose Chip Kitchen is placed on its second-to-last tick. Every feed, jam-whack and
// kit use in it replayed against a machine that did not exist, so the fixture was hash-stable
// but proved nothing about the worn regime it exists to pin (item 034's acceptance criterion:
// "a busy one reaching the effect threshold"). Following the fixtures README, the honest
// repair for a recording whose story has died is a NEW recorded session, not a patched one.
//
// WHAT IT RECORDS, in one played session against `step()` (the trace is dumped afterwards, so
// every command in the fixture is one the sim actually accepted):
//   1. Hand-farm the top field row — plant, water on the 8-pour can with shore-trip refills,
//      harvest — selling potatoes at the bin until the Chip Kitchen is affordable.
//   2. Place the kitchen at (14,4) and feed it batch after batch until wear (5 per operation)
//      drops it below `CONDITION_EFFECT_THRESHOLD`, then keep going: below the line it runs
//      at half speed, jams every `JAM_EVERY_N_OPERATIONS_WHEN_WORN`th operation (whacked out
//      as they happen), and spoils an input on the deterministic waste cadence.
//   3. At `STOP_AT_CONDITION`, buy one $8 repair kit at the bin and spend it standing by the
//      kitchen — one use, whole cell back to full — then let the restored machine run a
//      short tail.
//
// The script asserts the story actually happened (threshold crossed, inputs wasted, jams
// whacked, kit consumed, condition restored) before writing anything, so it cannot record a
// second zombie.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
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
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  machineSpec,
} from '../src/data';
import { type Machine, carriedCount, isTileReady, itemCount, tileAt } from '../src/state';
import { subtilesToTile } from '../src/units';
import { type GoldenFixture, fixturePath, loadFixture } from '../test/goldens';

const SEED = 404040;
const KITCHEN_X = 14;
const KITCHEN_Y = 4;
/** One tile west of the pond — shore, so a `RefillCan` errand aimed here succeeds. */
const SHORE_X = POND_ORIGIN_X - 1;
const SHORE_Y = POND_ORIGIN_Y;
/**
 * Deep enough into the worn regime for the cadence to have visibly cost something (several
 * spoiled inputs, several jams) while staying far from zero — a dead machine is
 * `worn-to-zero.json`'s story, and the two fixtures should not blur.
 */
const STOP_AT_CONDITION = 200;
const MIN_WASTED = 5;
const MIN_JAMS = 3;

const state: WorldState = createWorld(SEED);
let jamsWhacked = 0;
let minCondition = CONDITION_MAX;

function stepEmpty(): void {
  step(state, { tick: state.tick, commands: [] });
}

/** Apply one command on the current tick; report whether the sim accepted it. */
function apply(command: Command): boolean {
  const before = state.trace.length;
  step(state, { tick: state.tick, commands: [command] });
  return state.trace.length > before;
}

function finishIntent(): void {
  let guard = 0;
  while (state.player.intent !== null) {
    stepEmpty();
    guard += 1;
    if (guard > 30_000) throw new Error('errand never completed');
  }
}

/** Issue one walk-to errand and wait it out. Refills the can first when watering dry. */
function errand(action: IntentAction, tileX: number, tileY: number, item = 0, count = 0): boolean {
  finishIntent();
  if (action === IntentAction.Water && state.player.canCharges <= 0) {
    if (!errand(IntentAction.RefillCan, SHORE_X, SHORE_Y)) throw new Error('refill refused');
  }
  const ok = apply({ type: 'WalkAndAct', action, tileX, tileY, item, count });
  if (ok) finishIntent();
  return ok;
}

function kitchen(): Machine | undefined {
  return state.machines.find((m) => m.kind === MachineKind.ChipKitchen);
}

function bin(): Machine {
  const found = state.machines.find((m) => m.kind === MachineKind.SellBin);
  if (found === undefined) throw new Error('no sell bin in the world');
  return found;
}

function sellPotatoes(): void {
  const carried = itemCount(state, ItemId.RussetPotato);
  if (carried <= 0) return;
  const at = bin();
  errand(IntentAction.Sell, at.tileX, at.tileY, ItemId.RussetPotato, carried);
}

/** Deliver carried potatoes: into the kitchen once it exists, otherwise to the bin. */
function deliverPotatoes(): void {
  const carried = itemCount(state, ItemId.RussetPotato);
  if (carried <= 0) return;
  const cook = kitchen();
  if (cook !== undefined) {
    const spec = machineSpec(MachineKind.ChipKitchen)!;
    const room = spec.inputCapacity - cook.inputCounts.reduce((a, b) => a + b, 0);
    const load = Math.min(carried, room);
    if (load > 0) {
      errand(IntentAction.Load, KITCHEN_X, KITCHEN_Y, 0, load);
      return;
    }
  }
  sellPotatoes();
}

/** Empty the kitchen's output into the armful and sell the bags. */
function sellBags(): void {
  const cook = kitchen();
  if (cook === undefined || cook.outputCount <= 0) return;
  const take = Math.min(cook.outputCount, 12 - carriedCount(state));
  if (take <= 0) return;
  errand(IntentAction.Unload, KITCHEN_X, KITCHEN_Y, 0, take);
  const carried = itemCount(state, ItemId.BaggedChips);
  if (carried <= 0) return;
  const at = bin();
  errand(IntentAction.Sell, at.tileX, at.tileY, ItemId.BaggedChips, carried);
}

function whackIfJammed(): void {
  const cook = kitchen();
  if (cook !== undefined && cook.jammed) {
    if (!errand(IntentAction.WhackJam, KITCHEN_X, KITCHEN_Y)) throw new Error('whack refused');
    jamsWhacked += 1;
  }
}

/** One farming pass over the top field row: plant what is empty, water, wait, harvest. */
function farmCycle(): void {
  const row: { x: number; y: number }[] = [];
  for (let i = 0; i < FIELD_TILES_WIDE; i++) {
    row.push({ x: FIELD_ORIGIN_X + i, y: FIELD_ORIGIN_Y });
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      errand(IntentAction.Plant, x, y, CropId.RussetPotato);
    }
    whackIfJammed();
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop !== CropId.None && !isTileReady(tile)) {
      errand(IntentAction.Water, x, y);
    }
    whackIfJammed();
  }
  let waited = 0;
  while (
    waited < 6_000 &&
    !row.every((p) => {
      const tile = tileAt(state, p.x, p.y);
      return tile === null || tile.crop === CropId.None || isTileReady(tile);
    })
  ) {
    stepEmpty();
    waited += 1;
    if (waited % 500 === 0) whackIfJammed();
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile === null || !isTileReady(tile)) continue;
    // Harvest hands back the seed as well as the crop, so the armful fills fast: deliver
    // before the harvest that would be refused for room.
    if (carriedCount(state) >= 10) deliverPotatoes();
    errand(IntentAction.Harvest, x, y);
    whackIfJammed();
  }
  deliverPotatoes();
  sellBags();
  whackIfJammed();
}

// --- Phase 1: farm until the kitchen is affordable -----------------------------------
let guard = 0;
while (state.moneyCents < 10_000 && guard < 40) {
  farmCycle();
  guard += 1;
}
if (state.moneyCents < 10_000) throw new Error('never afforded the kitchen');

if (
  !apply({
    type: 'PlaceMachine',
    kind: MachineKind.ChipKitchen,
    tileX: KITCHEN_X,
    tileY: KITCHEN_Y,
  })
) {
  throw new Error('kitchen placement refused');
}

// --- Phase 2: feed it into the ground -------------------------------------------------
guard = 0;
for (;;) {
  const cook = kitchen()!;
  if (cook.condition < minCondition) minCondition = cook.condition;
  if (
    cook.condition <= STOP_AT_CONDITION &&
    state.stats.inputsWastedByMachine >= MIN_WASTED &&
    jamsWhacked >= MIN_JAMS
  ) {
    break;
  }
  farmCycle();
  guard += 1;
  if (guard > 60) throw new Error(`worn regime never reached (condition ${cook.condition})`);
}

// --- Phase 3: one kit, one trip, whole cell restored ----------------------------------
const till = bin();
if (!errand(IntentAction.Buy, till.tileX, till.tileY, ItemId.RepairKit, 1)) {
  throw new Error('kit purchase refused');
}
// Walk back to the kitchen with the kit, then service the cell from where we stand. The
// walk is held directions, re-aimed each step, exactly what a player does with a toolbox.
finishIntent();
{
  const targetX = KITCHEN_X;
  const targetY = KITCHEN_Y + 2; // just south of the 2x2 footprint — walkable ground
  let walkGuard = 0;
  const closeEnough = (): boolean => {
    const px = subtilesToTile(state.player.xSub);
    const py = subtilesToTile(state.player.ySub);
    const dx = Math.max(KITCHEN_X - px, px - (KITCHEN_X + 1), 0);
    const dy = Math.max(KITCHEN_Y - py, py - (KITCHEN_Y + 1), 0);
    return Math.max(dx, dy) <= 2;
  };
  while (!closeEnough()) {
    walkGuard += 1;
    if (walkGuard > 20_000) throw new Error('walk to the kitchen never arrived');
    const dx = targetX * 256 + 128 - state.player.xSub;
    const dy = targetY * 256 + 128 - state.player.ySub;
    const desired =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.East
          : Direction.West
        : dy >= 0
          ? Direction.South
          : Direction.North;
    if (state.player.moveDir !== desired) {
      apply({ type: 'SetMoveDirection', dir: desired });
    } else {
      stepEmpty();
    }
  }
  if (state.player.moveDir !== Direction.None) {
    apply({ type: 'SetMoveDirection', dir: Direction.None });
  }
}
const hereX = subtilesToTile(state.player.xSub);
const hereY = subtilesToTile(state.player.ySub);
if (!apply({ type: 'UseRepairKit', tileX: hereX, tileY: hereY })) {
  throw new Error('kit use refused');
}

const restored = kitchen()!;
if (restored.condition !== CONDITION_MAX) throw new Error('kit did not restore the kitchen');
if (state.stats.repairKitsUsed !== 1) throw new Error('kit was not consumed');
if (state.stats.repairKitSpendCents !== 800) throw new Error('kit spend not counted at the till');
if (minCondition >= CONDITION_EFFECT_THRESHOLD) throw new Error('threshold never crossed');

// A short tail so the fixture ends with the restored kitchen back at work.
for (let i = 0; i < 400; i++) stepEmpty();

// --- Write the fixture ----------------------------------------------------------------
const old = loadFixture('maintenance');
const fixture: GoldenFixture = {
  name: 'maintenance',
  description:
    'A Chip Kitchen run into the ground and then rescued. Hand-farms the top field row on ' +
    'the 8-pour can, buys the kitchen, and feeds it batch after batch until wear (5 per ' +
    'operation) drops it below the effect threshold — at which point it runs at half speed, ' +
    `jams every tenth operation (${jamsWhacked} whacked out), and spoils an input on the ` +
    `deterministic cadence (${state.stats.inputsWastedByMachine} wasted). Every one of those ` +
    'is a consequence of work done, never a roll. Ends with one $8 repair kit bought at the ' +
    'bin and spent standing by the kitchen, restoring the cell to full in a single use, and ' +
    'a short tail of the restored machine back at work. Re-recorded 2026-08-14 after the ' +
    '8-pour-can amendment zombified the original recording; see scripts/record-maintenance.ts.',
  seed: SEED,
  ticks: state.tick,
  expectedHash: hashState(state),
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('maintenance'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `maintenance re-recorded: ${fixture.ticks} ticks, ${fixture.commands.length} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  minCondition ${minCondition}, wasted ${state.stats.inputsWastedByMachine}, ` +
    `jams whacked ${jamsWhacked}, kit spend ${state.stats.repairKitSpendCents}c, ` +
    `final condition ${restored.condition}`,
);
