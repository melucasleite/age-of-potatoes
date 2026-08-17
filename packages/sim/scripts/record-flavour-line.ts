// Record the `flavour-line` golden fixture: item 111's story, played once against `step()`.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-flavour-line.ts
//
// THE STORY. One lot builds one chip line and runs THREE different products down it, which is
// the whole claim of item 111 — the line is the same, the decision is what you feed it:
//
//   1. Build Washer → Slicer → Fryer → Seasoner → Bagger with four grabber arms between them,
//      and grow a field of russets, chilis and gold potatoes.
//   2. **Plain**, first and deliberately: russets in at the Washer, bagged chips out at the
//      Bagger, with nothing else in any hopper. This is the non-negotiable — the plain line
//      must work exactly as it did before the tier existed — and it is pinned here as the
//      opening move rather than as an afterthought.
//   3. **Chili**: peppers loaded into the Seasoner's second hopper while the chips keep
//      coming. The Seasoner switches to `ChiliChips` and the Bagger to `BaggedChiliChips`,
//      with no mode, no dropdown and no setting anywhere — only what is in the hopper.
//   4. **Gold**: gold potatoes into the Washer's second hopper. The premium base runs the same
//      five machines to `BaggedGoldChips`, which is the half of the fork that could not have
//      been a seasoning.
//   5. Sell all three at the bin, so the fixture pins the prices as well as the recipes.
//
// It also pins the one-product-per-basket rule by construction: every machine in the line has
// to drain before it can switch products, so the three batches come out cleanly separated
// rather than interleaved.
//
// The recorder asserts the whole story actually happened — all three bags made, all three
// sold, each at its own price — before writing anything, so it cannot record a zombie. Every
// command in the fixture is one the sim accepted (the trace is dumped, not the attempts),
// following `record-maintenance.ts` and `record-the-till.ts`.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CropId,
  Direction,
  GrabberTier,
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
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  listPriceCents,
} from '../src/data';
import { type Machine, isTileReady, itemCount, tileAt } from '../src/state';
import { type GoldenFixture, fixturePath } from '../test/goldens';

const SEED = 111111;

/** The line, west to east along the top of the lot. Machines are 2×2; arms are 1×1 between. */
const LINE_Y = 1;
const WASHER_X = 0;
const ARM_A_X = 2;
const SLICER_X = 3;
const ARM_B_X = 5;
const FRYER_X = 6;
const ARM_C_X = 8;
const SEASONER_X = 9;
const ARM_D_X = 11;
const BAGGER_X = 12;

/** One tile west of the pond — shore, so a `RefillCan` errand aimed here succeeds. */
const SHORE_X = POND_ORIGIN_X - 1;
const SHORE_Y = POND_ORIGIN_Y;

/** Three columns of the starting field, one crop each. */
const RUSSET_X = FIELD_ORIGIN_X;
const CHILI_X = FIELD_ORIGIN_X + 1;
const GOLD_X = FIELD_ORIGIN_X + 2;
/**
 * Two tiles per crop, and the number is a BUDGET rather than a taste. Every fixture in the set
 * is replayed twice by `golden.test.ts`'s stability check, so a fixture's tick count is a cost
 * the whole suite pays — and almost all of this one's ticks are the farmer walking to the pond
 * and back, which pins nothing this fixture is about. Two rows grow enough of each crop to run
 * all three products and keeps the session under ten thousand ticks.
 */
const ROWS = 2;

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

function machineOfKind(kind: MachineKind): Machine {
  const found = state.machines.find((m) => m.kind === kind);
  if (found === undefined) throw new Error(`no ${String(kind)} on the lot`);
  return found;
}

// --- 1. money, research, and the line ---------------------------------------------------
//
// `klapaucius` is the house cheat: $100,000 and every tech node. The fixture is about the
// recipes, not about earning the machines a second time — `factory-line` already pins the
// long climb, and repeating it here would buy nothing but ticks.
if (!apply({ type: 'Cheat', code: 'klapaucius' })) throw new Error('the cheat was refused');

const build: [MachineKind, number][] = [
  [MachineKind.Washer, WASHER_X],
  [MachineKind.Slicer, SLICER_X],
  [MachineKind.Fryer, FRYER_X],
  [MachineKind.Seasoner, SEASONER_X],
  [MachineKind.Bagger, BAGGER_X],
];
for (const [kind, tileX] of build) {
  if (!apply({ type: 'PlaceMachine', kind, tileX, tileY: LINE_Y })) {
    throw new Error(`placing machine kind ${String(kind)} was refused`);
  }
}
for (const tileX of [ARM_A_X, ARM_B_X, ARM_C_X, ARM_D_X]) {
  if (
    !apply({
      type: 'PlaceGrabber',
      tier: GrabberTier.Mk1,
      tileX,
      tileY: LINE_Y,
      dir: Direction.East,
      filter: 0,
    })
  ) {
    throw new Error(`placing the arm at ${String(tileX)} was refused`);
  }
}

const bin = machineOfKind(MachineKind.SellBin);
const washer = machineOfKind(MachineKind.Washer);
const seasoner = machineOfKind(MachineKind.Seasoner);
const bagger = machineOfKind(MachineKind.Bagger);

// --- 2. the field: russets, chilis and gold potatoes ------------------------------------
if (!errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.ChiliSeed, ROWS))
  throw new Error('no chili seed');
if (!errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.GoldPotatoSeed, ROWS))
  throw new Error('no gold seed');
if (!errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.PotatoSeed, ROWS))
  throw new Error('no potato seed');

const plots: [number, CropId][] = [
  [RUSSET_X, CropId.RussetPotato],
  [CHILI_X, CropId.ChiliPepper],
  [GOLD_X, CropId.GoldPotato],
];
for (const [x, crop] of plots) {
  for (let row = 0; row < ROWS; row++) {
    const y = FIELD_ORIGIN_Y + row;
    if (!errand(IntentAction.Plant, x, y, crop)) throw new Error(`planting ${String(crop)} failed`);
    if (!errand(IntentAction.Water, x, y)) throw new Error('watering failed');
  }
}

/** Wait for a column to ripen, keeping it watered, then harvest every tile of it. */
function growAndHarvest(x: number): void {
  for (let row = 0; row < ROWS; row++) {
    const y = FIELD_ORIGIN_Y + row;
    let waited = 0;
    for (;;) {
      const tile = tileAt(state, x, y);
      if (tile === null) throw new Error('a planted tile vanished');
      if (isTileReady(tile)) break;
      if (tile.moisture <= 0) {
        if (!errand(IntentAction.Water, x, y)) throw new Error('re-watering failed');
        continue;
      }
      stepEmpty();
      waited += 1;
      if (waited > 60_000) throw new Error('a crop never ripened');
    }
    if (!errand(IntentAction.Harvest, x, y)) throw new Error('harvest refused');
  }
}

for (const [x] of plots) growAndHarvest(x);

const russets = itemCount(state, ItemId.RussetPotato);
const chilis = itemCount(state, ItemId.ChiliPepper);
const golds = itemCount(state, ItemId.GoldPotato);
if (russets <= 0 || chilis <= 0 || golds <= 0) throw new Error('the field paid nothing');

/** Run the line until the Bagger has something, then carry it home. */
function drainBagger(label: string): ItemId {
  let waited = 0;
  while (bagger.outputCount <= 0) {
    stepEmpty();
    waited += 1;
    if (waited > 40_000) throw new Error(`the line never produced ${label}`);
  }
  const made = bagger.outputItem as ItemId;
  // Let the batch finish arriving before emptying, so the basket is drained in one trip and
  // the next product has a clean buffer to start in.
  for (let i = 0; i < 300; i++) stepEmpty();
  if (!errand(IntentAction.Unload, bagger.tileX, bagger.tileY, 0, 20)) {
    throw new Error(`unloading ${label} was refused`);
  }
  return made;
}

// --- 3. plain, with nothing else in any hopper ------------------------------------------
if (!errand(IntentAction.Load, washer.tileX, washer.tileY, ItemId.RussetPotato, 2)) {
  throw new Error('loading russets was refused');
}
const plain = drainBagger('plain chips');
if (plain !== ItemId.BaggedChips) throw new Error(`plain line made ${String(plain)}`);

// --- 4. chili: the same line, one hopper different --------------------------------------
if (!errand(IntentAction.Load, seasoner.tileX, seasoner.tileY, ItemId.ChiliPepper, 2)) {
  throw new Error('loading peppers was refused');
}
if (!errand(IntentAction.Load, washer.tileX, washer.tileY, ItemId.RussetPotato, 2)) {
  throw new Error('loading more russets was refused');
}
const chili = drainBagger('chili chips');
if (chili !== ItemId.BaggedChiliChips) throw new Error(`chili line made ${String(chili)}`);

// --- 5. gold: the premium base, down the same five machines -----------------------------
if (!errand(IntentAction.Load, washer.tileX, washer.tileY, ItemId.GoldPotato, 2)) {
  throw new Error('loading gold potatoes was refused');
}
const gold = drainBagger('gold chips');
if (gold !== ItemId.BaggedGoldChips) throw new Error(`gold line made ${String(gold)}`);

// --- 6. sell all three, at three different prices ---------------------------------------
const sold: [ItemId, number][] = [];
for (const item of [ItemId.BaggedChips, ItemId.BaggedChiliChips, ItemId.BaggedGoldChips]) {
  const held = itemCount(state, item);
  if (held <= 0) throw new Error(`nothing to sell of ${String(item)}`);
  if (!errand(IntentAction.Sell, bin.tileX, bin.tileY, item, held))
    throw new Error('the bin refused a bag');
  sold.push([item, held]);
}
if (sold.length !== 3) throw new Error('three products go in, three come out');
if (listPriceCents(ItemId.BaggedGoldChips) <= listPriceCents(ItemId.BaggedChips)) {
  throw new Error('the premium bag is not priced above the plain one');
}

// A short tail so the fixture ends with the line standing and the money banked.
for (let i = 0; i < 200; i++) stepEmpty();

// --- Write the fixture -------------------------------------------------------------------
const fixture: GoldenFixture = {
  name: 'flavour-line',
  description:
    "Item 111's flavour tier: one chip line — Washer → Slicer → Fryer → Seasoner → Bagger " +
    'with four grabber arms — runs three different products without a single setting being ' +
    'changed on any machine. Russets alone make plain bagged chips; peppers loaded into the ' +
    "Seasoner's second hopper turn the same line into chili chips; gold potatoes loaded into " +
    "the Washer's second hopper run a premium base down all five machines to a gold bag. All " +
    'three sell at the bin at three different prices. Pins multi-recipe machines, the ' +
    'first-satisfied-recipe rule, one product per output basket, and the hopper list being ' +
    'wider than the recipe.',
  seed: SEED,
  ticks: state.tick,
  expectedHash: hashState(state),
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('flavour-line'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `flavour-line recorded: ${fixture.ticks} ticks, ${fixture.commands.length} commands, ` +
    `hash ${fixture.expectedHash}`,
);
