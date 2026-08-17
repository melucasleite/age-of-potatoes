// Record the permanent `format-20.json` save fixture: the first save in which EVERY PLACE A
// GOOD CAN SIT KNOWS HOW OLD IT IS.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-20.ts
//
// THE STORY (item 112). Format 18 gave a CONTAINER the clock its cargo runs on, and item 110's
// own adversarial verifier found within the hour that the bug had not died — it had moved. A
// machine holds goods in a hopper, in an output basket and in a claw, and a factory holds them on
// belts, and not one of those four had anywhere to record how old anything was. So a Seasoner
// nobody could start became a free refrigerator, and `cellar → arm → belt → arm → cellar` minted a
// full window with no player at all.
//
// The four facts no format-19 payload can express are each caught here, mid-flight, because a
// clock at rest proves nothing:
//
//   1. A HOPPER PART-WAY THROUGH ITS WINDOW. The Seasoner is the exploit's exact shape: peppers
//      in a machine with no chips, which can therefore never run and is boxable forever.
//   2. A BASKET PART-WAY THROUGH ITS WINDOW. The Washer's washed potatoes were made at a tick
//      this file remembers and have been sitting since.
//   3. A CLAW HOLDING A CLOCKED GOOD. An arm stalled against a full destination, holding one
//      potato with a number on it — the gap every other clock in the feature has to cross.
//   4. BELT ITEMS ON THREE DIFFERENT CLOCKS. Loaded from three sources at three moments, riding
//      one belt, which is the state item 035's ruling made unrepresentable.
//
// A grandfathered container rides along too — a cart poked full with `cargoFreshTicks: 0`, which
// is what migration 17 → 18 writes — so the fixture also pins the heal-on-first-take rule that
// turned "a full window per armful" into "one window in total".
//
// Every beat is asserted before the file is written, following `record-format-19.ts`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  BeltTier,
  Direction,
  GrabberTier,
  ItemId,
  MachineKind,
  createWorld,
  freshnessTicks,
  hashState,
  hopperIndexFor,
  machineSpec,
  serialize,
  step,
} from '../src/index';
import { type Machine, beltInsert, spawnBelt, spawnGrabber, spawnMachine } from '../src/state';

const SEED = 200_112;

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

/** Put `count` of `item` into whichever hopper of `machine` holds it, with a real clock on it. */
function load(machine: Machine, item: ItemId, count: number, freshTicks: number): void {
  const spec = machineSpec(machine.kind)!;
  const hopper = hopperIndexFor(spec, item);
  assert(hopper >= 0, `a ${spec.slug} has nowhere to put ${String(item)}`);
  machine.inputCounts[hopper] = count;
  machine.inputFreshTicks[hopper] = freshTicks;
}

// --- the lot ----------------------------------------------------------------------------
//
// Machines are spawned rather than bought. This is a SAVE-SHAPE fixture, not a golden replay.
const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 1)!;
const washer = spawnMachine(state, MachineKind.Washer, 4, 1)!;
const cart = spawnMachine(state, MachineKind.HandCart, 8, 1)!;
const grandfathered = spawnMachine(state, MachineKind.HandCart, 10, 1)!;
const belt = spawnBelt(state, BeltTier.Basic, 12, 1, Direction.East, 6)!;
// An arm aimed at the cart it can never fill, so it stalls with the goods in its claw.
const stalledArm = spawnGrabber(state, GrabberTier.Mk1, 5, 4, Direction.East, 0)!;
const stalledSource = spawnMachine(state, MachineKind.RootCellar, 3, 4)!;
const stalledDest = spawnMachine(state, MachineKind.HandCart, 6, 4)!;

// --- 1. the hopper: the starved Seasoner, which is the bug ------------------------------
load(seasoner, ItemId.ChiliPepper, 14, 5_400);
assert(
  seasoner.inputCounts.every((c) => c === 0 || c === 14),
  'the Seasoner took a second line',
);

// --- 2. the basket: a Washer that made its potatoes and has been holding them ------------
load(washer, ItemId.RussetPotato, 12, freshnessTicks(ItemId.RussetPotato));
let made = false;
for (let i = 0; i < 2_000 && !made; i++) {
  idle(1);
  made = washer.outputCount > 0;
}
assert(made, 'the Washer never washed anything');
const madeAt = washer.outputFreshTicks;
idle(900);
assert(
  washer.outputFreshTicks < madeAt,
  'the basket clock did not run — there is nothing here format 19 could not hold',
);

// --- 3. the claw: an arm holding one potato against a destination it cannot use ----------
//
// **THE DESTINATION HAS TO FILL UP MID-SWING**, and getting that wrong is instructive: item 085
// made an arm ask its destination BEFORE it closes its claw, so an arm aimed at a full cart
// never picks anything up at all and there is no stall to record. The one remaining stall is the
// one item 085 left standing — the cart fills while the arm is already swinging — so that is
// what this stages, by topping the cart up the moment the claw closes.
stalledSource.cargoItem = ItemId.RussetPotato;
stalledSource.cargoCount = 8;
stalledSource.cargoFreshTicks = 9_600;
stalledDest.cargoItem = ItemId.RussetPotato;
stalledDest.cargoCount = 1;
stalledDest.cargoFreshTicks = 4_800;

let grabbed = false;
for (let i = 0; i < 200 && !grabbed; i++) {
  idle(1);
  grabbed = stalledArm.held !== 0;
}
assert(grabbed, 'the arm never picked anything up');
assert(stalledArm.held === ItemId.RussetPotato, 'the arm grabbed something unexpected');
assert(stalledArm.heldFreshTicks > 0, 'the arm is holding a potato with no clock on it');
stalledDest.cargoCount = machineSpec(MachineKind.HandCart)!.inputCapacity;

const clawAtGrab = stalledArm.heldFreshTicks;
idle(120);
assert(stalledArm.held === ItemId.RussetPotato, 'the arm managed to put it down after all');
assert(stalledArm.heldFreshTicks < clawAtGrab, 'the claw clock is not running');

// --- 4. the belt: three items, three clocks, one belt ------------------------------------
beltInsert(belt, 0, ItemId.RussetPotato, 12_000);
idle(40);
beltInsert(belt, 0, ItemId.Corn, 7_500);
idle(40);
beltInsert(belt, 0, ItemId.ChiliPepper, 2_100);
idle(40);
const clocks = belt.items.map((entry) => entry.freshTicks);
assert(belt.items.length === 3, 'the belt did not keep all three');
assert(new Set(clocks).size === 3, 'THE THREE CLOCKS AGREE — the fixture records nothing new');

// --- 5. the loaded cart, and the grandfathered one beside it ----------------------------
cart.cargoItem = ItemId.PotatoSlices;
cart.cargoCount = 9;
cart.cargoFreshTicks = 3_300;
// EXACTLY what migration 17 → 18 writes: goods with no clock recorded at all. It must survive
// the round trip as a 0 rather than being helpfully filled in, because the heal belongs to the
// first person who touches it, not to the loader.
grandfathered.cargoItem = ItemId.RussetPotato;
grandfathered.cargoCount = 15;
grandfathered.cargoFreshTicks = 0;

idle(120);
assert(cart.cargoFreshTicks < 3_300, 'the cart clock stopped');
assert(grandfathered.cargoFreshTicks === 0, 'the grandfathered cart was healed too early');
assert(
  seasoner.inputFreshTicks.some((t) => t > 0 && t < 5_400),
  'the hopper clock stopped',
);
assert(seasoner.outputCount === 0, 'the starved Seasoner ran, which it must never be able to do');

const envelope = serialize(state);
assert(envelope.formatVersion === 20, 'this build does not write format 20');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-20.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-20.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `seasoner hopper ${JSON.stringify(seasoner.inputFreshTicks)}; ` +
    `washer basket ${String(washer.outputCount)} × ${String(washer.outputFreshTicks)}; ` +
    `claw ${String(stalledArm.held)} @ ${String(stalledArm.heldFreshTicks)}; ` +
    `belt ${JSON.stringify(clocks)}; ` +
    `state hash ${hashState(state)}\n`,
);
