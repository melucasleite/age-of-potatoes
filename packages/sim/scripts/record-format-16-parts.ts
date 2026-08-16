// Record `format-16-parts.json`: **the last save this game will ever produce with a Parts
// Bench standing on the lot.**
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-16-parts.ts
//
// WHY A SECOND FORMAT-16 FILE EXISTS, when the rule in `fixtures/saves/README.md` is one real
// save per released format. Item 090 retires the parts economy: repair drones fix machines for
// free, the Parts Bench leaves the build catalogue, and the 16 → 17 migration hands every
// placed bench back as a box and every stocked bay's parts back to the bag. The claim that
// migration makes — *nothing a player owned is deleted* — can only be tested against a save
// that actually contains the things being handed back, and `format-16.json` contains neither.
//
// It could never be made later, either. After 090 lands, no build can place a Parts Bench, so
// a fixture recorded tomorrow would have to be a payload someone typed — precisely the thing
// the README says is worthless ("a hand-written fixture tests the migration you imagined").
// So this file is recorded on the last day it is possible to record it, by the code that
// shipped the bench, and it is never edited again.
//
// THE MOMENT, and every part of it is chosen to be something the migration must carry:
//   * A Parts Bench with a **Speed dial bought** (so its invoice is more than its list price),
//     **worn** by the operations it ran, holding **bottles and kola powder in its two recipe
//     lines** and **finished drone parts in its output buffer** — three separate piles of
//     player property on one machine, plus an invoice that decides what its box scraps for.
//   * A Drone Bay with **parts on its hopper shelf**, hand-loaded, which is the second pile
//     the migration has to return rather than delete.
//   * A repair drone in the bay, because a bay's bot outlives its bay's cargo.
//
// Every command below is one the sim accepted — the script asserts each beat and refuses to
// write the file if the story broke, following `record-mid-field.ts`'s discipline.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  BotKind,
  CONDITION_MAX,
  IntentAction,
  ItemId,
  MachineKind,
  TECH_NODES,
  UpgradeDial,
  createWorld,
  hashState,
  serialize,
  step,
} from '../src/index';
import { type Machine, itemCount } from '../src/state';

const SEED = 160_090;

/** West of the field, north of the stand: three clear 2×2 pads inside the starting parcel. */
const GRINDER_X = 0;
const GRINDER_Y = 0;
const BENCH_X = 0;
const BENCH_Y = 2;
const BAY_X = 0;
const BAY_Y = 5;

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
/** Apply one command on the current tick; report whether the sim accepted it. */
function apply(command: Command): boolean {
  const before = state.trace.length;
  run([command]);
  return state.trace.length > before;
}
function finishIntent(): void {
  let guard = 0;
  while (state.player.intent !== null) {
    idle(1);
    guard += 1;
    if (guard > 30_000) throw new Error('errand never completed');
  }
}
/** One walk-to errand, waited out. The only way this session moves the player. */
function errand(action: number, tileX: number, tileY: number, item = 0, count = 0): boolean {
  finishIntent();
  const ok = apply({ type: 'WalkAndAct', action, tileX, tileY, item, count });
  if (ok) finishIntent();
  return ok;
}
function machine(kind: MachineKind): Machine {
  const found = state.machines.find((m) => m.kind === kind);
  if (found === undefined) throw new Error(`no ${String(kind)} on the lot`);
  return found;
}

// The key to the gate and the float to pay for it. `TechId.Drones` sits behind diagnostics and
// trucking, and the bench alone is $800 — the cheat is how a short recorded session reaches the
// capstone, exactly as the format-14, -15 and -16 recorders reached theirs.
run([{ type: 'Cheat', code: 'klapaucius' }]);
assert(state.unlocked.length === TECH_NODES.length, 'klapaucius left nodes locked');
assert(state.moneyCents > 400_000, 'the cheat did not pay for the capstone');

const bin = machine(MachineKind.SellBin);

// --- kola powder, the hard half of the recipe -----------------------------------------
//
// A drone part is a Bottle and a Kola Powder. The bottle is store-bought; the powder is NOT
// purchasable at any price (§4: flavours are manufactured), so this session has to grind it,
// which is the whole reason the parts economy was a logistics problem in the first place.

assert(errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.KolaNut, 20), 'kola nuts refused');
assert(errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.Bottle, 20), 'bottles refused');
assert(itemCount(state, ItemId.KolaNut) === 20, 'the nuts did not arrive');
assert(itemCount(state, ItemId.Bottle) === 20, 'the bottles did not arrive');

assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.Grinder, tileX: GRINDER_X, tileY: GRINDER_Y }),
  'the grinder was refused',
);
const grinder = machine(MachineKind.Grinder);
assert(
  errand(IntentAction.Load, GRINDER_X, GRINDER_Y, ItemId.KolaNut, 20),
  'the grinder refused the nuts',
);
idle(4_000);
assert(grinder.outputCount >= 16, 'the grinder ground nothing');
assert(
  errand(IntentAction.Unload, GRINDER_X, GRINDER_Y, 0, grinder.outputCount),
  'the powder would not come off the grinder',
);
const powder = itemCount(state, ItemId.KolaPowder);
assert(powder >= 16, 'no kola powder in the bag');

// --- the bench ------------------------------------------------------------------------

assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.PartsBench, tileX: BENCH_X, tileY: BENCH_Y }),
  'the parts bench was refused',
);
const bench = machine(MachineKind.PartsBench);
const benchList = bench.investedCents;

// A dial, so the box this bench becomes is worth more than a bare one — the invoice is what
// `boxedMachineScrapCents` reads, and a migration that dropped it would quietly rob the player.
assert(
  apply({ type: 'UpgradeMachine', machineId: bench.id, dial: UpgradeDial.Speed }),
  'the speed dial was refused',
);
assert(bench.speedLevel === 1, 'the dial did not turn');
assert(bench.investedCents > benchList, 'the invoice did not grow with the dial');

// Both recipe lines, named — the Parts Bench is one of the two machines in the game that eats
// two different solids, so "the hopper" here is genuinely two piles.
assert(
  errand(IntentAction.Load, BENCH_X, BENCH_Y, ItemId.Bottle, 20),
  'the bench refused the bottles',
);
assert(
  errand(IntentAction.Load, BENCH_X, BENCH_Y, ItemId.KolaPowder, powder),
  'the bench refused the powder',
);
assert((bench.inputCounts[0] ?? 0) > 0, 'no bottles in line 0');
assert((bench.inputCounts[1] ?? 0) > 0, 'no powder in line 1');

// Run it part-way: some parts made, some ingredients still in the hopper, some wear on the
// machine. A bench caught at rest with empty buffers would round-trip perfectly and prove
// nothing about what the migration has to carry.
idle(200);
assert(bench.outputCount > 0, 'the bench made no parts');
assert((bench.inputCounts[0] ?? 0) > 0, 'the bench ate every bottle');
assert(bench.condition < CONDITION_MAX, 'the bench never wore');

// --- the bay, stocked ------------------------------------------------------------------

assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.DroneBay, tileX: BAY_X, tileY: BAY_Y }),
  'the drone bay was refused',
);
const bay = machine(MachineKind.DroneBay);
assert(
  state.bots.some((b) => b.kind === BotKind.Repair && b.dockId === bay.id),
  'no drone came with the bay',
);

// Parts off the bench and onto the bay's shelf, by hand. `RefillHopper` is the door item 090
// closes; this is the last session that can walk through it.
const partsToShelve = bench.outputCount;
assert(
  errand(IntentAction.Unload, BENCH_X, BENCH_Y, 0, partsToShelve),
  'the parts would not come off the bench',
);
assert(itemCount(state, ItemId.DronePart) === partsToShelve, 'the parts are not in the bag');
assert(errand(IntentAction.RefillHopper, BAY_X, BAY_Y), 'the bay refused the parts');
assert(bay.cargoItem === ItemId.DronePart, 'the bay hopper does not name parts');
assert(bay.cargoCount === partsToShelve, 'the bay did not take the parts');

// Let the bench run on a little after the hand leaves, so the file is caught mid-everything:
// work banked in the accumulator, ingredients in both lines, finished parts on the shelf.
idle(120);
assert(bench.outputCount > 0, 'the bench shelf emptied itself');

const envelope = serialize(state);
assert(envelope.formatVersion === 16, 'this build no longer writes format 16');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-16-parts.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(
  `format-16-parts.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`,
);
process.stdout.write(
  `bench: invoice ${String(bench.investedCents)}, condition ${String(bench.condition)}, ` +
    `lines ${String(bench.inputCounts[0])}/${String(bench.inputCounts[1])}, ` +
    `shelf ${String(bench.outputCount)} parts; ` +
    `bay: ${String(bay.cargoCount)} parts; state hash ${hashState(state)}\n`,
);
