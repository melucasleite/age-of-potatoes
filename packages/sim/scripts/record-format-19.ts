// Record the permanent `format-19.json` save fixture: the first save in which A MACHINE'S
// OUTPUT BASKET HAS A NAME ON IT.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-19.ts
//
// THE STORY (item 111). Until this format a machine made exactly one thing, so its output buffer
// could be a bare count — `outputCount` — and the identity of what was in it came from the spec.
// That held for the whole life of the file and stopped holding the moment a Seasoner learned four
// recipes and a Washer learned two. `Machine.outputItem` is the name, and the two facts no
// format-18 payload can express are both caught here:
//
//   1. TWO MACHINES OF THE SAME KIND HOLDING DIFFERENT PRODUCTS. Two Seasoners stand side by
//      side; one is holding chili chips and the other plain seasoned chips. Under format 18 both
//      baskets read as "whatever a Seasoner makes", so this world was not merely unrecorded — it
//      was not describable.
//   2. A BASKET THAT HAS TO DRAIN BEFORE IT CAN CHANGE ITS MIND. The chili Seasoner is left with
//      peppers still in its hopper and plain chips still arriving, and it goes on making chili
//      chips because that is what is already in the basket. One product per buffer, saved.
//
// A gold-line Bagger is here too, holding `BaggedGoldChips` — the premium base that runs the same
// five machines — so the fixture pins the alternate-base half of the tier as well as the
// seasoning half.
//
// Every beat is asserted before the file is written, following `record-format-18.ts`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  ItemId,
  MachineKind,
  createWorld,
  hashState,
  hopperIndexFor,
  machineSpec,
  serialize,
  step,
} from '../src/index';
import { type Machine, spawnMachine } from '../src/state';

const SEED = 190_111;

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

/** Put `count` of `item` into whichever hopper of `machine` holds it. */
function load(machine: Machine, item: ItemId, count: number): void {
  const spec = machineSpec(machine.kind)!;
  const hopper = hopperIndexFor(spec, item);
  assert(hopper >= 0, `a ${spec.slug} has nowhere to put ${String(item)}`);
  machine.inputCounts[hopper] = count;
}

/** Run until the machine has something in its basket, and say what it turned out to be. */
function runUntilProduced(machine: Machine, story: string): ItemId {
  for (let i = 0; i < 2_000; i++) {
    idle(1);
    if (machine.outputCount > 0) return machine.outputItem as ItemId;
  }
  throw new Error(`The story broke: ${story}`);
}

// --- the lot: two Seasoners and a Bagger, placed directly ------------------------------
//
// Machines are spawned rather than bought. This fixture is a SAVE-SHAPE fixture, not a golden
// replay — nothing here is asserted against a command trace, and `flavour-line.json` already
// pins the played version of the same story.
const seasonerA = spawnMachine(state, MachineKind.Seasoner, 0, 1)!;
const seasonerB = spawnMachine(state, MachineKind.Seasoner, 3, 1)!;
const bagger = spawnMachine(state, MachineKind.Bagger, 6, 1)!;

// --- 1. one Seasoner runs chili, the other runs salt, from the same kind of machine -----
load(seasonerA, ItemId.PlainChips, 6);
load(seasonerA, ItemId.ChiliPepper, 6);
load(seasonerB, ItemId.PlainChips, 6);

const madeA = runUntilProduced(seasonerA, 'the chili Seasoner never produced');
const madeB = runUntilProduced(seasonerB, 'the plain Seasoner never produced');
assert(madeA === ItemId.ChiliChips, 'the pepper hopper did not decide the product');
assert(madeB === ItemId.SeasonedChips, 'a Seasoner with no pepper stopped making plain chips');
assert(
  seasonerA.outputItem !== seasonerB.outputItem,
  'THE TWO BASKETS AGREE — the fixture records nothing format 18 could not',
);

// --- 2. the basket will not change its mind while it is full ----------------------------
//
// Left running with both hoppers stocked. Every operation goes on being a chili chip, because
// that is what is in the basket — the one-product rule, saved rather than merely asserted.
idle(600);
assert(seasonerA.outputItem === ItemId.ChiliChips, 'the chili basket changed product mid-batch');
assert(seasonerA.outputCount > 1, 'the chili Seasoner stopped after one');

// --- 3. the premium base, at the other end of the same line -----------------------------
load(bagger, ItemId.SeasonedGoldChips, 4);
const madeC = runUntilProduced(bagger, 'the Bagger never bagged the gold chips');
assert(madeC === ItemId.BaggedGoldChips, 'the gold chips came out as something else');
assert(bagger.outputItem === ItemId.BaggedGoldChips, 'the gold bag did not label its basket');

// THE STATE FORMAT 18 COULD NOT HOLD: three machines, three products, and two of the machines
// are the same kind. Under the old rule all three baskets answered to their spec.
assert(
  seasonerA.outputItem !== 0 && seasonerB.outputItem !== 0 && bagger.outputItem !== 0,
  'a basket went unlabelled; there is nothing here for format 19 to carry',
);

const envelope = serialize(state);
assert(envelope.formatVersion === 19, 'this build does not write format 19');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-19.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-19.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `seasoner A: ${String(seasonerA.outputCount)} × item ${String(seasonerA.outputItem)}; ` +
    `seasoner B: ${String(seasonerB.outputCount)} × item ${String(seasonerB.outputItem)}; ` +
    `bagger: ${String(bagger.outputCount)} × item ${String(bagger.outputItem)}; ` +
    `state hash ${hashState(state)}\n`,
);
