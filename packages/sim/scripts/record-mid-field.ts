// Record the `mid-field` golden fixture: item 067's story, played once against `step()`.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-mid-field.ts
//
// THE STORY (item 067's golden-fixture instruction): earn the $150 honestly on the gardener
// loop — plant, water, harvest, fry, sell, exactly `economy-walk.ts`'s beats — then WALK to
// the middle of the field on a no-op walk errand (item 070's action, absorbed here rather
// than given a fixture of its own), hand-water the centre tile, stand a barrel sprinkler ON
// it, fill the barrel at the pond, watch the cycles water all 24 farm neighbours and never
// the machine's own feet, box the sprinkler back up, and replant the freed tile. The
// recorder asserts every beat — and asserts the REFUSALS (crop tile, non-flagged machine)
// before recording, which never enter the trace because a refused command appends nothing.
//
// RE-RECORDED 2026-08-16 for item 097, over item 086's re-recording of the same morning. A
// charge is an ACTIVATION again — one charge waters the whole 5×5 — so the three hauls of ten,
// ten and four collapse back into ONE haul and one cycle. What the story keeps from 086 is the
// half that outlived it: the cycle AFTER, which finds all 24 tiles wet, spends nothing and
// marks nothing. Section 5 carries the details.
//
// Every command in the fixture is one the sim actually accepted, following
// `record-the-till.ts`.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CropId,
  IntentAction,
  ItemId,
  MOISTURE_MAX,
  MachineKind,
  createWorld,
  hashState,
  itemCount,
  step,
} from '../src/index';
import { FIELD_ORIGIN_X, FIELD_ORIGIN_Y, SPRINKLER_PERIOD_TICKS, machineSpec } from '../src/data';
import { isTileReady, machineAt, tileAt } from '../src/state';
import { type GoldenFixture, fixturePath } from '../test/goldens';

const SEED = 670670;
const SPRINKLER_CENTS = machineSpec(MachineKind.Sprinkler)!.priceCents;
/** Sprinkler money plus a margin for seeds, so the story never runs itself broke. */
const TARGET_CENTS = SPRINKLER_CENTS + 1_500;

/** Dead centre of the starting field: a 5×5 around it is 24 farm neighbours, all inside. */
const CENTRE = { x: 7, y: 7 };
/** The neighbour that carries a crop, to prove placement refuses it and watering serves it. */
const CROPPED = { x: 8, y: 7 };

const state: WorldState = createWorld(SEED);

let kitchenTile: { x: number; y: number } | null = null;

function run(commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}
function idle(ticks: number): void {
  for (let i = 0; i < ticks; i++) run([]);
}
function waitIntent(): void {
  let guard = 0;
  while (state.player.intent !== null) {
    run([]);
    guard += 1;
    if (guard > 30_000) throw new Error('an errand never completed');
  }
}
/** Apply one command on the current tick; report whether the sim accepted it. */
function apply(command: Command): boolean {
  const before = state.trace.length;
  run([command]);
  return state.trace.length > before;
}
function errand(action: IntentAction, x: number, y: number, item = 0, count = 0): boolean {
  waitIntent();
  const ok = apply({ type: 'WalkAndAct', action, tileX: x, tileY: y, item, count });
  if (ok) waitIntent();
  return ok;
}

// --- 1. Earn the $150 on the gardener loop (economy-walk's beats, compressed) -----------
const row: { x: number; y: number }[] = [];
for (let i = 0; i < 8; i++) row.push({ x: FIELD_ORIGIN_X + i, y: FIELD_ORIGIN_Y });
const binTile = { x: FIELD_ORIGIN_X - 2, y: FIELD_ORIGIN_Y + 8 };
const shoreTile = { x: 12, y: 12 };
const kitchenPrice = machineSpec(MachineKind.ChipKitchen)!.priceCents;

function sellAll(item: ItemId): void {
  const carried = itemCount(state, item);
  if (carried > 0) errand(IntentAction.Sell, binTile.x, binTile.y, item, carried);
}

while (state.moneyCents < TARGET_CENTS) {
  if (state.tick > 150_000) throw new Error('the economy walk never reached the sprinkler');

  if (kitchenTile === null && state.moneyCents >= kitchenPrice + 1_000) {
    run([{ type: 'PlaceMachine', kind: MachineKind.ChipKitchen, tileX: 0, tileY: 0 }]);
    kitchenTile = { x: 0, y: 0 };
  }

  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      errand(IntentAction.Plant, x, y, CropId.RussetPotato);
    }
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile === null || tile.crop === CropId.None) continue;
    if (state.player.canCharges <= 0) errand(IntentAction.RefillCan, shoreTile.x, shoreTile.y);
    errand(IntentAction.Water, x, y);
  }

  let waited = 0;
  while (
    waited < 4_000 &&
    state.moneyCents < TARGET_CENTS &&
    !row.some((p) => {
      const tile = tileAt(state, p.x, p.y);
      return tile !== null && isTileReady(tile);
    })
  ) {
    run([]);
    waited += 1;
  }

  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && isTileReady(tile)) errand(IntentAction.Harvest, x, y);
  }

  if (kitchenTile === null) {
    sellAll(ItemId.RussetPotato);
  } else {
    const kitchen = state.machines.find((m) => m.kind === MachineKind.ChipKitchen);
    let potatoes = itemCount(state, ItemId.RussetPotato);
    while (kitchen !== undefined && potatoes > 0 && state.moneyCents < TARGET_CENTS) {
      errand(IntentAction.Load, kitchenTile.x, kitchenTile.y, 0, potatoes);
      let cycles = 0;
      while (cycles < 3_000 && kitchen.outputCount === 0) {
        run([]);
        cycles += 1;
      }
      if (kitchen.outputCount > 0) {
        errand(IntentAction.Unload, kitchenTile.x, kitchenTile.y, 0, kitchen.outputCount);
        sellAll(ItemId.BaggedChips);
      }
      potatoes = itemCount(state, ItemId.RussetPotato);
    }
  }
}
if (state.moneyCents < SPRINKLER_CENTS) throw new Error('arithmetic lied about the target');

// --- 2. The no-op walk (item 070): click empty mid-field ground and just go there -------
if (!errand(IntentAction.Walk, CENTRE.x, CENTRE.y + 1)) {
  throw new Error('the walk to the field centre was refused');
}

// --- 3. A crop on one neighbour: the refusal witness, and later a watering customer ------
// Two seeds owed from here: one for the witness, one for the replant at the end. The loop
// above may have planted every last one, so the stand tops us up — the margin in
// `TARGET_CENTS` exists for exactly this.
const seedsShort = 2 - itemCount(state, ItemId.PotatoSeed);
if (seedsShort > 0) {
  if (!errand(IntentAction.Buy, binTile.x, binTile.y, ItemId.PotatoSeed, seedsShort)) {
    throw new Error('buying the story seeds was refused');
  }
}
if (itemCount(state, ItemId.PotatoSeed) <= 0) throw new Error('no seed left for the witness');
if (!errand(IntentAction.Plant, CROPPED.x, CROPPED.y, CropId.RussetPotato)) {
  throw new Error('planting the witness neighbour was refused');
}

// Wet ground under the future machine, so "deconstruct hands moisture back" is provable.
if (state.player.canCharges <= 0) errand(IntentAction.RefillCan, shoreTile.x, shoreTile.y);
if (!errand(IntentAction.Water, CENTRE.x, CENTRE.y)) throw new Error('the centre pour refused');

const before = tileAt(state, CENTRE.x, CENTRE.y)!;
const bornSoil = before.soil;
const bornFertility = before.fertility;

// --- 4. The refusals, asserted and deliberately NOT in the trace ------------------------
if (
  apply({ type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX: CROPPED.x, tileY: CROPPED.y })
) {
  throw new Error('a sprinkler squatted a growing crop');
}
const kitchen = state.machines.find((m) => m.kind === MachineKind.ChipKitchen);
if (kitchen !== undefined) {
  if (apply({ type: 'MoveMachine', machineId: kitchen.id, tileX: 5, tileY: 6 })) {
    throw new Error('a non-flagged machine moved onto farmland');
  }
}

// --- 5. Place mid-field, fill once, and watch ONE charge do the whole patch --------------
//
// ONE HAUL, ONE CYCLE, TWENTY-FOUR TILES (item 097, owner ruling 2026-08-16: "when they spend
// a charge, they should water everything in a 5x5"). A charge is an ACTIVATION, priced at the
// full-patch pour — `SPRINKLER_PATCH_TILES × SPRINKLER_POUR_ML`, the 36,000 ml this barrel
// used to hold in total — so ten charges are ten patches and the barrel cannot stop halfway.
// Item 086 briefly made a charge one tile's pour, which turned this beat into three hauls of
// ten, ten and four and needed a resuming scan cursor to keep the back row from starving; both
// are gone, because a cycle a barrel can afford is a cycle it can finish.
//
// THE SECOND CYCLE IS THE ONE 086 EARNED AND KEPT: the same 24 tiles, now soaked, looked at
// and passed over for no water, no pour mark, and no wear. A sensing head walking past its own
// work is the thing worth having in a golden trace.
if (
  !apply({ type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX: CENTRE.x, tileY: CENTRE.y })
) {
  throw new Error('the mid-field placement was refused');
}
const sprinkler = machineAt(state, CENTRE.x, CENTRE.y);
if (sprinkler === null) throw new Error('the sprinkler is not standing where it was placed');

// Counted BEFORE the refill: the pour can fire on the very tick the barrel fills — the refill
// errand arrives, the tank fills in the command phase, and the machine advance of that same
// tick spends the charge it just received.
const chargesBefore = sprinkler.opCount;
if (!errand(IntentAction.RefillHopper, CENTRE.x, CENTRE.y)) {
  throw new Error('filling the barrel was refused');
}
let waited = 0;
while (sprinkler.opCount === chargesBefore) {
  run([]);
  waited += 1;
  if (waited > 1_000) throw new Error('the sprinkler never watered');
}
if (sprinkler.opCount - chargesBefore !== 1) throw new Error('one patch cost more than one charge');
if (sprinkler.wateredCount !== 24) {
  throw new Error(`one charge watered ${String(sprinkler.wateredCount)} tiles, not 24`);
}

const own = tileAt(state, CENTRE.x, CENTRE.y)!;
if (own.moisture >= MOISTURE_MAX) throw new Error('the head watered its own feet');
if (own.moisture <= 0) throw new Error('the hand pour under the machine was lost');
// The pour signal, not raw moisture: a tick of ordinary decay may already have passed by the
// time the loop above notices the cycle fired.
if (tileAt(state, CROPPED.x, CROPPED.y)!.lastPouredTick <= 0) {
  throw new Error('the cropped neighbour went unwatered');
}

// The free cycle: the whole patch is wet, so the next activation is not an activation.
const heldMl = sprinkler.tankMl;
const skippedBefore = sprinkler.skippedCount;
for (let i = 0; i < 2 * SPRINKLER_PERIOD_TICKS && sprinkler.skippedCount === skippedBefore; i++) {
  run([]);
}
if (sprinkler.skippedCount - skippedBefore !== 24) {
  throw new Error('the sensing head did not walk its whole patch, or counted its own tile');
}
if (sprinkler.tankMl !== heldMl) throw new Error('a cycle over wet ground still spent a charge');
if (sprinkler.opCount - chargesBefore !== 1) throw new Error('a skipped cycle counted as work');

// --- 6. Deconstruct: the ground comes back exactly as it stood --------------------------
if (!errand(IntentAction.Deconstruct, CENTRE.x, CENTRE.y)) {
  throw new Error('boxing the sprinkler was refused');
}
if (machineAt(state, CENTRE.x, CENTRE.y) !== null) throw new Error('the sprinkler is still here');
if (itemCount(state, ItemId.BoxedSprinkler) !== 1) throw new Error('the box never arrived');
const freed = tileAt(state, CENTRE.x, CENTRE.y);
if (freed === null) throw new Error('the freed tile vanished');
if (freed.soil !== bornSoil) throw new Error('deconstruction changed the soil');
if (freed.fertility !== bornFertility) throw new Error('deconstruction changed fertility');
if (freed.moisture <= 0 || freed.moisture >= MOISTURE_MAX) {
  throw new Error('the moisture under the machine was reset rather than kept');
}

// --- 7. Replant the freed tile ----------------------------------------------------------
if (itemCount(state, ItemId.PotatoSeed) <= 0) throw new Error('no seed left to replant');
if (!errand(IntentAction.Plant, CENTRE.x, CENTRE.y, CropId.RussetPotato)) {
  throw new Error('replanting the freed tile was refused');
}

// A short tail so the fixture ends with the replant standing.
idle(200);

// --- Write the fixture ------------------------------------------------------------------
const fixture: GoldenFixture = {
  name: 'mid-field',
  description:
    'Machines on farm tiles (item 067): the gardener loop earns $150, the farmer walks to ' +
    'the field centre on a no-op walk errand (item 070), a barrel sprinkler stands ON a ' +
    'hand-watered farm tile, and ONE haul from the pond buys ONE charge that waters all 24 ' +
    'farm neighbours in a single cycle — including a growing crop, and never the machine’s ' +
    'own tile — after which the next cycle looks at the same 24 soaked tiles and spends ' +
    'nothing at all. Deconstruction hands the tile back with its soil, fertility, and ' +
    'decayed moisture untouched, and the freed ground takes a seed again. Pins the ' +
    'fieldPlaceable footprint rule, the occupied-tile watering skip, item 097’s ' +
    'charge-per-activation barrel with item 086’s thirst rule inside it, and ' +
    'IntentAction.Walk in the trace and the save shape.',
  seed: SEED,
  ticks: state.tick,
  expectedHash: hashState(state),
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('mid-field'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `mid-field recorded: ${fixture.ticks} ticks, ${fixture.commands.length} commands, ` +
    `hash ${fixture.expectedHash}`,
);
