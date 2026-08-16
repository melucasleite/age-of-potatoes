// Record the permanent `format-17.json` save fixture: the first save in which a repair drone
// works out of an EMPTY bay.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-17.ts
//
// THE STORY (item 090): the drone bay used to be a supply chain — a hopper of manufactured parts,
// one burned per fix, a Parts Bench feeding it, and a blue lamp when it ran dry. The owner's
// ruling ended that: *"The drone bay shouldn't require parts. It should just fix stuff."*
//
// So the one fact no earlier format can express is a bay whose `cargoItem`/`cargoCount` pair is
// EMPTY while its drone is out on an errand fixing the factory. Under format 16 that state was
// impossible in both directions: an empty bay grounded its drone before a target was even
// picked, and a working drone therefore always had parts on the shelf behind it. This file is
// caught at exactly that impossible moment — drone mid-flight, shelf bare, factory being fixed.
//
// It is also caught mid-SERVICE of a bot dock, which is the owner bug item 090 folded in: a
// dock's own condition never falls (`wearPerOperation` is 0), so a worn Agri-Bot used to be
// invisible to the drone. The session wears one down and lets the drone answer it.
//
// Every command in the session is one the sim accepted, following `record-mid-field.ts`'s
// discipline: every beat asserted before the file is written.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  BotKind,
  BotPhase,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  ItemId,
  MachineKind,
  TECH_NODES,
  createWorld,
  hashState,
  machineWantsService,
  serialize,
  step,
} from '../src/index';
import { type Machine } from '../src/state';

const SEED = 170_090;

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

// The key to the gate and the float. `TechId.Drones` is the tree's capstone — diagnostics AND
// trucking — and the bay is $2,000, so a short recorded session reaches it the way the
// format-14, -15 and -16 recorders reached theirs.
run([{ type: 'Cheat', code: 'klapaucius' }]);
assert(state.unlocked.length === TECH_NODES.length, 'klapaucius left nodes locked');

// A harvester dock with a bot in it, bound to a small zone — the machine the owner's bug was
// about, and a thing a drone had never once flown to before this item.
run([{ type: 'CreateZone', rect: { x: 7, y: 11, w: 3, h: 1 }, crop: CropId.RussetPotato }]);
assert(state.zones.length === 1, 'the zone was refused');
assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.HarvesterDock, tileX: 7, tileY: 12 }),
  'the dock was refused',
);
const dock = machine(MachineKind.HarvesterDock);
assert(apply({ type: 'SetDockZone', machineId: dock.id, zoneId: state.zones[0]!.id }), 'no bind');
const worker = state.bots.find((b) => b.kind === BotKind.Harvester);
assert(worker !== undefined, 'no bot came with the dock');

// The bay. NOTHING GOES INTO IT — there is nothing to put in it, and that is the fixture.
assert(
  apply({ type: 'PlaceMachine', kind: MachineKind.DroneBay, tileX: 2, tileY: 2 }),
  'the drone bay was refused',
);
const bay = machine(MachineKind.DroneBay);
assert(bay.cargoItem === 0 && bay.cargoCount === 0, 'the bay came with cargo');
const drone = state.bots.find((b) => b.kind === BotKind.Repair);
assert(drone !== undefined, 'no drone came with the bay');

// A worn Agri-Bot in a shed of perfect health: the exact trap that hid this from the drone for
// eleven items. The dock cannot express its own ill health, so the bot has to.
worker!.condition = 120;
assert(dock.condition === CONDITION_MAX, 'the shed is somehow worn');
assert(!dock.jammed, 'the shed is somehow jammed');
assert(worker!.condition < CONDITION_EFFECT_THRESHOLD, 'the worker is not wrench-due');
assert(machineWantsService(state, dock), 'a dock with a worn bot does not read as wrench-due');

// Fly. The moment wanted is the drone OUT — off its bay, on an errand, with a bare shelf behind
// it — so the walk is watched rather than waited out.
let waited = 0;
while (drone!.phase !== BotPhase.Outbound && waited < 200) {
  idle(1);
  waited += 1;
}
assert(drone!.phase === BotPhase.Outbound, 'the drone never launched');
assert(drone!.targetTile === dock.id, 'the drone aimed somewhere other than the dock');
idle(12);
assert(drone!.phase === BotPhase.Outbound, 'the drone arrived sooner than the fixture wanted');
assert(drone!.xSub !== 0 || drone!.ySub !== 0, 'the drone has no position');

// THE STATE FORMAT 16 COULD NOT HOLD: an empty bay with its drone away on a paid-for-nothing
// errand, and a dock that wants a wrench because of what is asleep in it.
assert(bay.cargoItem === 0 && bay.cargoCount === 0, 'something got onto the bay shelf');
assert(worker!.condition === 120, 'the worker was serviced before the save');
assert(state.stats.repairKitSpendCents === 0, 'a free service booked a spend');

const envelope = serialize(state);
assert(envelope.formatVersion === 17, 'this build does not write format 17');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-17.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-17.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `drone: phase ${String(drone!.phase)} at ${String(drone!.xSub)},${String(drone!.ySub)} ` +
    `aimed at machine ${String(drone!.targetTile)}; bay shelf ${String(bay.cargoCount)}; ` +
    `worker condition ${String(worker!.condition)}; state hash ${hashState(state)}\n`,
);
