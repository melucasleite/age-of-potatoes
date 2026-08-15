// Record the `the-till` golden fixture: the till tool's story, played once against `step()`.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-the-till.ts
//
// THE STORY (item 066's golden-fixture instruction, verbatim): till, plant, water, harvest,
// un-till — plus a re-till, because the fixture that pins the till tool should also pin its
// one non-negotiable promise: a re-tilled position gets back exactly the ground it had. The
// session breaks a 4×1 strip of grass north of the starting field, farms one of the new
// tiles through a full potato cycle on the 8-pour can, returns an empty neighbour to grass,
// and tills it again. The recorder asserts the whole story actually happened — the strip
// exists, the harvest paid, the un-tilled tile is gone, the re-tilled soil is identical —
// before writing anything, so it cannot record a zombie.
//
// Every command in the fixture is one the sim actually accepted (the trace is dumped, not
// the attempts), following `record-maintenance.ts`.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CropId,
  IntentAction,
  ItemId,
  TillMode,
  createWorld,
  hashState,
  step,
} from '../src/index';
import { POND_ORIGIN_X, POND_ORIGIN_Y } from '../src/data';
import { isTileReady, soilMemoryAt, tileAt, worldTileKey } from '../src/state';
import { type GoldenFixture, fixturePath } from '../test/goldens';

const SEED = 660660;

/** The strip of grass to break: north of the starting field, well inside parcel 0. */
const STRIP_X = 4;
const STRIP_Y = 2;
const STRIP_W = 4;
/** The new tile that gets the full farm cycle. */
const FARM_X = 5;
const FARM_Y = STRIP_Y;
/** The new tile that goes back to grass and then comes back. */
const RETILL_X = 6;
const RETILL_Y = STRIP_Y;

const SHORE_X = POND_ORIGIN_X - 1;
const SHORE_Y = POND_ORIGIN_Y;

const state: WorldState = createWorld(SEED);

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

// --- 1. till: a strip of grass becomes farmland, in one drag ---------------------------
if (
  !apply({
    type: 'TillTile',
    rect: { x: STRIP_X, y: STRIP_Y, w: STRIP_W, h: 1 },
    mode: TillMode.Till,
  })
) {
  throw new Error('the till drag was refused');
}
for (let i = 0; i < STRIP_W; i++) {
  if (tileAt(state, STRIP_X + i, STRIP_Y) === null) throw new Error('a strip tile is missing');
}
const bornSoil = tileAt(state, RETILL_X, RETILL_Y)!.soil;
const bornFertility = tileAt(state, RETILL_X, RETILL_Y)!.fertility;

// --- 2–4. plant, water, harvest: the new dirt farms exactly like the old ---------------
if (!errand(IntentAction.Plant, FARM_X, FARM_Y, CropId.RussetPotato)) {
  throw new Error('planting the tilled tile was refused');
}
if (!errand(IntentAction.Water, FARM_X, FARM_Y)) throw new Error('watering was refused');

let waited = 0;
for (;;) {
  const tile = tileAt(state, FARM_X, FARM_Y);
  if (tile === null) throw new Error('the farmed tile vanished');
  if (isTileReady(tile)) break;
  if (tile.moisture <= 0) {
    if (!errand(IntentAction.Water, FARM_X, FARM_Y)) throw new Error('re-watering was refused');
    continue;
  }
  stepEmpty();
  waited += 1;
  if (waited > 60_000) throw new Error('the potato never ripened');
}
if (!errand(IntentAction.Harvest, FARM_X, FARM_Y)) throw new Error('harvest was refused');
if (state.stats.itemsHarvestedByHand <= 0) throw new Error('the harvest paid nothing');

// --- 5. un-till: an empty neighbour goes back to grass ---------------------------------
if (
  !apply({
    type: 'TillTile',
    rect: { x: RETILL_X, y: RETILL_Y, w: 1, h: 1 },
    mode: TillMode.Untill,
  })
) {
  throw new Error('the un-till was refused');
}
if (tileAt(state, RETILL_X, RETILL_Y) !== null) throw new Error('the un-tilled tile survived');
if (soilMemoryAt(state, worldTileKey(RETILL_X, RETILL_Y)) === null) {
  throw new Error('the ledger forgot the un-tilled position');
}

// A short pause, so the un-till and the re-till are separate moments in the trace.
for (let i = 0; i < 40; i++) stepEmpty();

// --- 6. re-till: the same ground comes back, provably ----------------------------------
if (
  !apply({
    type: 'TillTile',
    rect: { x: RETILL_X, y: RETILL_Y, w: 1, h: 1 },
    mode: TillMode.Till,
  })
) {
  throw new Error('the re-till was refused');
}
const back = tileAt(state, RETILL_X, RETILL_Y);
if (back === null) throw new Error('the re-tilled tile is missing');
if (back.soil !== bornSoil) throw new Error('re-tilling changed the soil — roll-once is broken');
if (back.fertility !== bornFertility) {
  throw new Error('re-tilling changed fertility — the ledger is broken');
}

// A short tail so the fixture ends with the re-tilled strip standing.
for (let i = 0; i < 200; i++) stepEmpty();

// --- Write the fixture -----------------------------------------------------------------
const fixture: GoldenFixture = {
  name: 'the-till',
  description:
    'The till tool (item 066): a 4×1 strip of grass north of the starting field is broken ' +
    'in one drag, one of the new tiles is planted, watered on the 8-pour can, and harvested ' +
    'exactly as an original field tile would be, an empty neighbour is un-tilled back to ' +
    'grass, and the same position is tilled again — coming back with the identical soil and ' +
    'fertility, because the roll-once ledger remembers every position ever broken. Pins the ' +
    'keyed farmland collection, the position-keyed soil roll, and the TillTile command in ' +
    'both modes.',
  seed: SEED,
  ticks: state.tick,
  expectedHash: hashState(state),
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('the-till'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `the-till recorded: ${fixture.ticks} ticks, ${fixture.commands.length} commands, ` +
    `hash ${fixture.expectedHash}`,
);
