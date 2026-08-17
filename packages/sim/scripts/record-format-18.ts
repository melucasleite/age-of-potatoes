// Record the permanent `format-18.json` save fixture: the first save in which a BOX IS RUNNING A
// CLOCK.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-18.ts
//
// THE STORY (item 110): storage used to stamp freshness on the way OUT, from the tick the goods
// came back into the player's arms. Sound reasoning — nothing inside a machine ages, so goods
// returning to your hands are loose again — and an exploit the moment the round trip got cheap.
// Item 105's adversarial verifier put it best: *"a round trip through an eighty dollar hand cart
// resets the freshness clock, so I kept ten potatoes alive for three and a half times their
// natural lifespan by clicking twice. Rot is now opt-in."*
//
// So a container now carries `cargoFreshTicks` — how much of the goods' window is left — and the
// two facts no format-17 payload can express are both caught here:
//
//   1. A HAND CART PART-WAY THROUGH SPENDING ITS LOAD'S LIFE. Under format 17 a cart froze its
//      contents and then handed back a full fifteen minutes, so "potatoes in a barrow with four
//      minutes left" was not a state the world could be in, let alone write down.
//   2. A ROOT CELLAR HOLDING A HALF-SPENT WINDOW. The cellar still stops the clock — §4 names it,
//      *"frozen in a Root Cellar"* — but it now freezes the REMAINDER rather than reissuing the
//      whole thing. Under format 17 every cellar was a time machine; here one is a fridge with
//      old potatoes in it, which is a different world and is finally a recordable one.
//
// Every command in the session is one the sim accepted, following `record-format-17.ts`'s
// discipline: every beat asserted before the file is written.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  FRESHNESS_BUCKET_TICKS,
  ItemId,
  MachineKind,
  TECH_NODES,
  addItem,
  createWorld,
  freshnessTicks,
  hashState,
  itemCount,
  serialize,
  step,
  storageAgingPerTick,
} from '../src/index';
import { type Machine } from '../src/state';

const SEED = 180_110;

const state: WorldState = createWorld(SEED);

function run(commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}
function idle(ticks: number): void {
  for (let i = 0; i < ticks; i++) run([]);
}
function assert(fact: boolean, story: string): void {
  if (!fact) throw new Error(`The story broke: ${story}`);
}
function apply(command: Command): boolean {
  const before = state.trace.length;
  run([command]);
  return state.trace.length > before;
}
function machine(kind: MachineKind): Machine {
  const found = state.machines.find((m) => m.kind === kind);
  if (found === undefined) throw new Error(`no ${String(kind)} on the lot`);
  return found;
}

// The Root Cellar sits behind an Agronomy node and $250, so the session buys the tree the way
// every recorder since format 14 has.
run([{ type: 'Cheat', code: 'klapaucius' }]);
assert(state.unlocked.length === TECH_NODES.length, 'klapaucius left nodes locked');

// Both boxes on the yard side of the lot — the field starts at x=4, y=4 and neither of these is
// `fieldPlaceable` — with the player walked onto each in turn so every reach check lands.
function standAt(tileX: number, tileY: number): void {
  state.player.xSub = tileX * 256 + 128;
  state.player.ySub = tileY * 256 + 128;
}
standAt(3, 3);
assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.HandCart, tileX: 3, tileY: 3 }),
  'the hand cart was refused',
);
standAt(2, 2);
assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.RootCellar, tileX: 1, tileY: 1 }),
  'the root cellar was refused',
);
const cart = machine(MachineKind.HandCart);
const cellar = machine(MachineKind.RootCellar);
assert(storageAgingPerTick(cart.kind) === 1, 'the cart stopped being a barrow');
assert(storageAgingPerTick(cellar.kind) === 0, 'the cellar stopped being a fridge');

// An armful, left in the sun for a third of its life before either box sees it. THIS IS THE
// NUMBER THE WHOLE FIXTURE IS ABOUT: the goods are already old when they go in.
const WINDOW = freshnessTicks(ItemId.RussetPotato);
addItem(state, ItemId.RussetPotato, 24);
idle(6_000);
assert(itemCount(state, ItemId.RussetPotato) === 24, 'the armful turned before it was boxed');

// Twelve into the cellar, where the clock stops with a third already gone.
standAt(2, 2);
assert(
  apply({ type: 'LoadMachine', machineId: cellar.id, count: 12, item: ItemId.RussetPotato }),
  'the cellar refused the load',
);
assert(cellar.cargoCount === 12, 'the cellar took the wrong count');
assert(cellar.cargoFreshTicks > 0, 'the cellar took the load without a clock');
assert(cellar.cargoFreshTicks < WINDOW, 'the cellar minted a fresh window');
const frozenAt = cellar.cargoFreshTicks;

// Twelve into the cart, where the clock keeps running.
standAt(3, 3);
assert(
  apply({ type: 'LoadMachine', machineId: cart.id, count: 12, item: ItemId.RussetPotato }),
  'the cart refused the load',
);
assert(cart.cargoCount === 12, 'the cart took the wrong count');
assert(itemCount(state, ItemId.RussetPotato) === 0, 'the armful did not all go into the boxes');

// Walk away for five active minutes. One box spends them and one does not.
idle(5 * 1_200);
assert(cellar.cargoFreshTicks === frozenAt, 'THE CELLAR SPENT TIME — the freeze is broken');
assert(cart.cargoFreshTicks < frozenAt, 'the cart froze its load like the old build did');
assert(cart.cargoCount === 12, 'the cart lost its load early');
assert(cart.cargoItem === ItemId.RussetPotato, 'the cart composted its load early');

// THE STATE FORMAT 17 COULD NOT HOLD: two boxes, one product, one clock each, and the numbers
// disagree — which under the old rule was impossible, because both boxes answered "fifteen
// minutes, from whenever you ask".
assert(cart.cargoFreshTicks !== cellar.cargoFreshTicks, 'both boxes agree; nothing was recorded');
assert(cart.cargoFreshTicks > 0, 'the cart is already spent; the fixture wants it mid-clock');
assert(
  cart.cargoFreshTicks + 5 * 1_200 <= WINDOW,
  'the cart somehow has more life left than a fresh potato',
);
// And the bucket is intact: a remainder is a count of ticks, never a rounded deadline.
assert(FRESHNESS_BUCKET_TICKS > 0, 'the freshness bucket vanished');

const envelope = serialize(state);
assert(envelope.formatVersion === 18, 'this build does not write format 18');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-18.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-18.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `cellar: ${String(cellar.cargoCount)} potatoes frozen at ${String(cellar.cargoFreshTicks)} ticks; ` +
    `cart: ${String(cart.cargoCount)} potatoes running at ${String(cart.cargoFreshTicks)} ticks ` +
    `of a ${String(WINDOW)}-tick window; state hash ${hashState(state)}\n`,
);
