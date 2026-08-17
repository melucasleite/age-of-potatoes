// Record the `bottle-return` golden fixture: item 131's loop, played once against `step()`.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-bottle-return.ts
//
// **THE STORY, AND IT IS A CIRCLE.** A bottle is bought at the stand, filled with soda, driven
// off the lot on a delivery cart, and comes back as an empty — which a Washer turns into the
// same `ItemId.Bottle` it started as, and which then goes back into the Bottler it came out of.
// That is the whole of the owner's ask (*"used bottles out of the depot once they come back from
// a delivery and turns them into clean bottles to be used by the bottler"*), and it is the one
// path in the game whose ends meet.
//
// **WHY THIS FIXTURE HAD TO EXIST**, measured rather than assumed. Before it, twenty golden
// fixtures replayed on every push and **not one of them delivered a good with a bottle in it**:
// `depot-run` is the only fixture with a cart and a depot and it ships bagged chips; `soda-line`
// is the only fixture that makes soda and it has no vehicle at all, selling every bottle at the
// bin. So the return leg was driven eight times a suite by unit tests and pinned by nothing —
// which is precisely the shape the wave before this one found bugs hiding in.
//
// **THE GEOMETRY IS `soda-line`'s, DELIBERATELY AND ALMOST TILE FOR TILE.** That fixture already
// proves a five-network liquid build works; re-deriving one here would have been a second
// opinion about plumbing in a fixture that is about glass. What is different is the front and
// the back: `klapaucius` replaces 130,000 ticks of farming for money and research (the climb is
// `factory-line`'s and `soda-line`'s job, and repeating it here would buy nothing but runtime),
// and the tail — cart, wash, re-feed — is the part no other fixture has.
//
// The recorder asserts the whole circle actually closed — soda made, empties returned, glass
// washed, clean bottles back in the Bottler's hopper — before it writes anything, so it cannot
// record a zombie. Every command in the fixture is one the sim accepted.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CropId,
  IntentAction,
  ItemId,
  LiquidId,
  MachineKind,
  createWorld,
  hashState,
  step,
} from '../src/index';
import { FIELD_ORIGIN_X, FIELD_ORIGIN_Y, POND_ORIGIN_X, POND_ORIGIN_Y } from '../src/data';
import { type Machine, isTileReady, itemCount, tileAt } from '../src/state';
import { type GoldenFixture, fixturePath } from '../test/goldens';

const SEED = 131131;

// The north strip, y = 0..3, which is clear of the 8×8 field at (4,4). `soda-line`'s row.
const JUICER_X = 0;
const KETTLE_X = 3;
const MIXER_X = 6;
const BOTTLER_X = 9;
const CARBONATOR_X = 13;
const GRINDER: [number, number] = [0, 2];

/** The Washer, in the gap `soda-line` left between the Grinder and the Kettle. 2×2 at (2,2). */
const WASHER: [number, number] = [2, 2];
/** The cart, west of the field on open ground, with a tile beside it to stand on. */
const CART: [number, number] = [2, 5];
const CART_STAND: [number, number] = [2, 6];

/** One tile north of the pond — the bank, where a pump may stand. */
const PUMP: [number, number] = [POND_ORIGIN_X, POND_ORIGIN_Y - 1];

/** One tile west of the pond — shore, so a `RefillCan` errand aimed here succeeds. */
const SHORE_X = POND_ORIGIN_X - 1;
const SHORE_Y = POND_ORIGIN_Y;

/** Four tiles of cane. One soda needs a few hundred ml of juice; four stalks is plenty. */
const CANE_ROWS = 4;
const CANE_X = FIELD_ORIGIN_X;

/** How many bottles go round the circle. Small on purpose — every tick here is suite runtime. */
const BOTTLES = 4;
/**
 * Kola nuts, and the number is a RATIO rather than a taste: one nut grinds to one powder, one
 * powder is one Syrup Mixer operation, one operation is 250 ml of soda syrup, and 250 ml is
 * exactly what the Bottler drinks per bottle. So the nuts are the thing that decides how many
 * sodas exist — two spare, because a fixture that runs out one bottle short of its own story is
 * a fixture that has to be re-recorded.
 */
const KOLA = BOTTLES + 2;

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

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`refused: ${what}`);
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

/** Step until `done()`, or throw. Every wait in this recorder has a name and a ceiling. */
function waitFor(what: string, limit: number, done: () => boolean): void {
  let waited = 0;
  while (!done()) {
    stepEmpty();
    waited += 1;
    if (waited > limit) throw new Error(`gave up waiting for ${what}`);
  }
}

// --- 1. money and every tech node --------------------------------------------------------
must(apply({ type: 'Cheat', code: 'klapaucius' }), 'the cheat');
const bin = machineOfKind(MachineKind.SellBin);

// --- 2. the plumbing, laid before the machines that drink through it ----------------------
//
// `soda-line`'s order exactly: pipe first, machine second, pump last. `rebuildNetworks` runs on
// every edit either way, and following the proven order keeps this fixture from being a second
// opinion about how networks form.
const pipes: [LiquidId, [number, number][]][] = [
  [
    LiquidId.CaneJuice,
    [
      [2, 0],
      [2, 1],
    ],
  ],
  [
    LiquidId.SimpleSyrup,
    [
      [5, 0],
      [5, 1],
    ],
  ],
  [
    LiquidId.SodaSyrup,
    [
      [8, 0],
      [8, 1],
    ],
  ],
  [
    LiquidId.CarbonatedWater,
    [
      [12, 0],
      [12, 1],
    ],
  ],
  // Water: up the east edge from the pond, west along the headland at y = 3, then one spur to
  // the Carbonator and one to the Syrup Mixer — which needs water of its own, and is the easiest
  // port on the lot to forget.
  [
    LiquidId.Water,
    [
      [13, 12],
      [13, 11],
      [13, 10],
      [13, 9],
      [13, 8],
      [13, 7],
      [13, 6],
      [13, 5],
      [13, 4],
      [13, 3],
      [12, 3],
      [11, 3],
      [10, 3],
      [9, 3],
      [8, 3],
      [7, 3],
      [6, 3],
    ],
  ],
  [LiquidId.Water, [[13, 2]]],
  [LiquidId.Water, [[6, 2]]],
];
for (const [liquid, path] of pipes) {
  must(
    apply({ type: 'PlacePipe', liquid, path: path.map(([x, y]) => ({ x, y })) }),
    `pipe for liquid ${String(liquid)}`,
  );
}

const build: [MachineKind, number, number][] = [
  [MachineKind.Juicer, JUICER_X, 0],
  [MachineKind.Kettle, KETTLE_X, 0],
  [MachineKind.SyrupMixer, MIXER_X, 0],
  [MachineKind.Bottler, BOTTLER_X, 0],
  [MachineKind.Carbonator, CARBONATOR_X, 0],
  [MachineKind.Grinder, GRINDER[0], GRINDER[1]],
  [MachineKind.Washer, WASHER[0], WASHER[1]],
  [MachineKind.Pump, PUMP[0], PUMP[1]],
];
for (const [kind, tileX, tileY] of build) {
  must(apply({ type: 'PlaceMachine', kind, tileX, tileY }), `machine kind ${String(kind)}`);
}

const juicer = machineOfKind(MachineKind.Juicer);
const grinder = machineOfKind(MachineKind.Grinder);
const mixer = machineOfKind(MachineKind.SyrupMixer);
const bottler = machineOfKind(MachineKind.Bottler);
const washer = machineOfKind(MachineKind.Washer);

// --- 3. the shopping: seed, nuts, and the bottles the circle starts with -------------------
must(errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.CaneSeed, CANE_ROWS), 'cane seed');
must(errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.KolaNut, KOLA), 'kola nuts');
must(errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.Bottle, BOTTLES), 'bottles');
const boughtBottles = itemCount(state, ItemId.Bottle);
if (boughtBottles !== BOTTLES) throw new Error('the stand shorted the bottles');

// --- 4. the cane, which is the only thing on this lot that has to be grown -----------------
for (let row = 0; row < CANE_ROWS; row++) {
  const y = FIELD_ORIGIN_Y + row;
  must(errand(IntentAction.Plant, CANE_X, y, CropId.SugarCane), `planting cane at row ${row}`);
  must(errand(IntentAction.Water, CANE_X, y), `watering cane at row ${row}`);
}
for (let row = 0; row < CANE_ROWS; row++) {
  const y = FIELD_ORIGIN_Y + row;
  for (;;) {
    const tile = tileAt(state, CANE_X, y);
    if (tile === null) throw new Error('a planted tile vanished');
    if (isTileReady(tile)) break;
    if (tile.moisture <= 0) {
      must(errand(IntentAction.Water, CANE_X, y), 're-watering cane');
      continue;
    }
    stepEmpty();
  }
  must(errand(IntentAction.Harvest, CANE_X, y), `harvesting cane at row ${row}`);
}
const cane = itemCount(state, ItemId.SugarCane);
if (cane <= 0) throw new Error('the cane paid nothing');

// --- 5. run the line until a soda exists ---------------------------------------------------
must(errand(IntentAction.Load, juicer.tileX, juicer.tileY, ItemId.SugarCane, cane), 'cane in');
must(errand(IntentAction.Load, grinder.tileX, grinder.tileY, ItemId.KolaNut, KOLA), 'kola in');

// **EVERY NUT, NOT THE FIRST ONE.** The first draft waited for `outputCount > 0` and carried one
// powder to the Mixer, which made one soda and then stood there with two full liquid ports and an
// empty hopper for the rest of the session. One kola powder is one Syrup Mixer operation is 250 ml
// of soda syrup is exactly one bottle of soda — so the grind has to finish before the trip.
waitFor('the Grinder to grind every nut', 4_000, () => grinder.outputCount >= KOLA);
must(errand(IntentAction.Unload, grinder.tileX, grinder.tileY, 0, KOLA), 'kola powder out');
const powder = itemCount(state, ItemId.KolaPowder);
if (powder <= 0) throw new Error('the Grinder made no powder');
must(errand(IntentAction.Load, mixer.tileX, mixer.tileY, ItemId.KolaPowder, powder), 'powder in');
must(errand(IntentAction.Load, bottler.tileX, bottler.tileY, ItemId.Bottle, BOTTLES), 'bottles in');

waitFor('the Bottler to fill every bottle', 30_000, () => bottler.outputCount >= BOTTLES);
must(errand(IntentAction.Unload, bottler.tileX, bottler.tileY, 0, BOTTLES), 'soda out');
const sodas = itemCount(state, ItemId.Soda);
if (sodas !== BOTTLES) throw new Error(`the line made ${String(sodas)} sodas, wanted ${BOTTLES}`);

// --- 6. THE DELIVERY, AND THE RETURN -------------------------------------------------------
must(
  apply({ type: 'PlaceMachine', kind: MachineKind.DeliveryCart, tileX: CART[0], tileY: CART[1] }),
  'the delivery cart',
);
const cart = machineOfKind(MachineKind.DeliveryCart);
must(errand(IntentAction.Walk, CART_STAND[0], CART_STAND[1]), 'walking to the cart');
must(apply({ type: 'LoadCart', cartId: cart.id, item: ItemId.Soda, count: sodas }), 'loading');
const bankedBefore = state.moneyCents;
must(apply({ type: 'DispatchCart', cartId: cart.id }), 'dispatching');

waitFor('the cart to come home', 5_000, () => cart.runTicksRemaining === 0);
if (state.moneyCents <= bankedBefore) throw new Error('the run paid nothing');
if (cart.outputItem !== ItemId.UsedBottle) throw new Error('the cart came back with no glass');
if (cart.outputCount !== sodas) {
  throw new Error(`${String(cart.outputCount)} empties back from ${String(sodas)} sodas`);
}

must(errand(IntentAction.Unload, cart.tileX, cart.tileY, 0, sodas), 'empties off the cart');
const empties = itemCount(state, ItemId.UsedBottle);
if (empties !== sodas) throw new Error('the empties did not all reach the bag');

// --- 7. THE WASH, AND THE CIRCLE CLOSING ---------------------------------------------------
must(errand(IntentAction.Load, washer.tileX, washer.tileY, ItemId.UsedBottle, empties), 'wash in');
waitFor('the Washer to clean every empty', 4_000, () => washer.outputCount >= empties);
if (washer.outputItem !== ItemId.Bottle) throw new Error('the Washer made something else');
must(errand(IntentAction.Unload, washer.tileX, washer.tileY, 0, empties), 'clean bottles out');

const washed = itemCount(state, ItemId.Bottle);
if (washed !== empties) throw new Error('the washed bottles did not reach the bag');

// **THE LAST MOVE, AND THE ONE THAT MAKES IT A CIRCLE RATHER THAN A DETOUR.** The glass goes
// back into the machine it came out of, which is the sentence the owner actually asked for.
must(errand(IntentAction.Load, bottler.tileX, bottler.tileY, ItemId.Bottle, washed), 're-feeding');
const bottlerLine = bottler.inputCounts.findIndex((count) => count > 0);
if (bottlerLine < 0) throw new Error('the Bottler is not holding the recycled glass');

// A short tail so the fixture ends with the line standing and the money banked.
for (let i = 0; i < 200; i++) stepEmpty();

// --- Write the fixture ---------------------------------------------------------------------
const fixture: GoldenFixture = {
  name: 'bottle-return',
  description:
    "Item 131's loop, and the only fixture in the set whose ends meet: four bottles are bought " +
    'at the stand, filled with soda by a five-network liquid build (Juicer → Kettle → Syrup ' +
    'Mixer → Bottler, with a Grinder and a pond-fed Carbonator), driven off the lot on a ' +
    'delivery cart, and come home as four used bottles in the cart’s own basket. A Washer ' +
    'turns them back into the same ItemId.Bottle they started as, and they go back into the ' +
    'Bottler. Pins the return leg, the vehicle basket both vehicles now have, the Washer’s ' +
    'third recipe, and the two take-gates that used to refuse a machine whose spec makes ' +
    'nothing. Recorded by `scripts/record-bottle-return.ts`, which asserts every beat of the ' +
    'circle before writing.',
  seed: SEED,
  ticks: state.tick,
  expectedHash: hashState(state),
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('bottle-return'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `bottle-return recorded: ${fixture.ticks} ticks, ${fixture.commands.length} commands, ` +
    `hash ${fixture.expectedHash}`,
);
