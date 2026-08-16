// Record the permanent `format-15.json` save fixture: the first save with an IDENTIFIED
// dock shelf in it.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-15.ts
//
// THE STORY (item 083): format 14's harvester dock swallowed its harvest — a bot's delivery
// landed in an anonymous `outputCount` whose identity came from a spec that honestly says the
// dock makes nothing, so no grabber and no hand could ever take it back out. Format 15 makes
// the shelf the dock's CARGO, and the one fact no earlier format can express is a harvester
// dock whose `cargoItem`/`cargoCount` pair names what the robot brought home.
//
// So this session earns exactly that moment, by commands the sim actually accepted: the owner
// types `klapaucius` (the dock sits behind the Corporate Charter, unreachable in a short honest
// session — the same gate `record-format-14.ts` walked through with the same key), paints a
// three-tile Grow Zone, plants and waters it by hand, places a Harvester Dock, binds it, and
// then TOUCHES NOTHING while the bot does the one chore nothing in this game had ever done for
// the player — and, this time, is able to hand it over.
//
// The moment serialized is mid-flight in the way that matters: the shelf holds the bot's
// harvest UNDER ITS OWN NAME, which is precisely the state format 14 could not write down.
// Every command in the session is one the sim accepted, following the `record-mid-field.ts`
// discipline: every beat asserted before the file is written.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  CropId,
  ItemId,
  MachineKind,
  TECH_NODES,
  createWorld,
  hashState,
  serialize,
  step,
} from '../src/index';

const SEED = 830_083;

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

// The key to the gate. The dock needs `automation-agri-bots`, which sits behind the Corporate
// Charter's 96,000 untouched ticks — the cheat is how a short recorded session reaches it,
// exactly as the format-14 recorder did.
run([{ type: 'Cheat', code: 'klapaucius' }]);
assert(state.unlocked.length === TECH_NODES.length, 'klapaucius left nodes locked');

// Three tiles of the starter field become a potato zone. One drag, one command.
run([{ type: 'CreateZone', rect: { x: 7, y: 11, w: 3, h: 1 }, crop: CropId.RussetPotato }]);
assert(state.zones.length === 1, 'the zone was refused');
const zoneId = state.zones[0]!.id;

// Plant and water the row by hand — the honest half of the loop the bot then closes.
for (let x = 7; x <= 9; x++) {
  run([{ type: 'PlantTile', tileX: x, tileY: 11, crop: CropId.RussetPotato }]);
  run([{ type: 'WaterTile', tileX: x, tileY: 11 }]);
}
assert(
  state.field.filter((t) => t.zone === zoneId && t.crop === CropId.RussetPotato).length === 3,
  'the row was not planted',
);

// The shed, south of the field, bound to the zone. Placing it spawns the bot.
run([{ type: 'PlaceMachine', kind: MachineKind.HarvesterDock, tileX: 7, tileY: 12 }]);
const dock = state.machines.find((m) => m.kind === MachineKind.HarvesterDock);
assert(dock !== undefined, 'the dock was refused');
assert(state.bots.length === 1, 'no bot came with the dock');
run([{ type: 'SetDockZone', machineId: dock!.id, zoneId }]);
assert(dock!.boundZone === zoneId, 'the binding was refused');

// Keep the row wet while it grows; touch nothing else. The growth target is ~1,800 ticks
// with ±15% jitter, and a pour outlasts the row's drain comfortably.
for (let i = 0; i < 4; i++) {
  idle(700);
  run([
    { type: 'WaterTile', tileX: 7, tileY: 11 },
    { type: 'WaterTile', tileX: 8, tileY: 11 },
    { type: 'WaterTile', tileX: 9, tileY: 11 },
  ]);
}

// Let the bot work. The beat this fixture exists for: the shelf holds the harvest, NAMED.
let waited = 0;
while (dock!.cargoCount === 0 && waited < 6_000) {
  idle(1);
  waited += 1;
}
assert(dock!.cargoItem === ItemId.RussetPotato, 'the shelf does not name the harvest');
assert(dock!.cargoCount > 0, 'the bot delivered nothing');
assert(dock!.outputCount === 0, 'the anonymous buffer is back');
assert(state.stats.itemsHarvestedByHand === 0, "the bot's harvest counted as a hand");

const envelope = serialize(state);
const path = fileURLToPath(new URL('../test/fixtures/saves/format-15.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-15.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `shelf: item ${String(dock!.cargoItem)} x ${String(dock!.cargoCount)}; state hash ${hashState(state)}\n`,
);
