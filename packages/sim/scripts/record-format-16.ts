// Record the permanent `format-16.json` save fixture: the first save in which the seed came
// home.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-16.ts
//
// THE STORY (item 088): a hand harvest of a one-shot crop has always handed a seed back — plan
// §4's anti-softlock floor, the rule that a world can always plant. The auto-harvester went
// through the same `takeHarvest` and dropped it, so every tile a robot pulled cost a seed the
// player would have kept. Format 16 gives the bot a POCKET and the harvester dock a SEED SHELF,
// and the one fact no earlier format can express is a dock whose `seedShelfItem`/
// `seedShelfCount` pair names seeds a robot carried back from the field.
//
// This is `record-format-15.ts`'s session, played one beat further: the same cheat through the
// Corporate Charter's gate, the same three-tile potato zone, the same shed — and then the bot
// is left alone until BOTH shelves have something on them. The moment serialized is a dock
// holding a named harvest on one shelf and named seeds on the other, which is exactly the state
// format 15 wrote as a harvest and a silence.
//
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

const SEED = 880_088;

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
// exactly as the format-14 and format-15 recorders did.
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

// The seed count BEFORE the robot works, so "the bot's seeds are not the player's" is a fact
// this recorder checks rather than a claim it makes: three seeds went into the ground by hand
// and nothing put any back into the pouch.
const pouchSeedsBefore =
  state.inventory.find((slot) => slot.item === ItemId.PotatoSeed)?.count ?? 0;

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

// Let the bot work. The beat this fixture exists for: the SEED shelf holds seeds, NAMED.
let waited = 0;
while (dock!.seedShelfCount === 0 && waited < 8_000) {
  idle(1);
  waited += 1;
}
assert(dock!.seedShelfItem === ItemId.PotatoSeed, 'the seed shelf does not name the seeds');
assert(dock!.seedShelfCount > 0, 'the bot brought no seed home');
// And the produce shelf still works exactly as format 15 left it: two shelves, both named.
assert(dock!.cargoItem === ItemId.RussetPotato, 'the produce shelf lost its name');
assert(dock!.cargoCount > 0, 'the bot delivered no potatoes');
assert(dock!.outputCount === 0, 'the anonymous buffer is back');
// The seeds are on the shelf, not in the player's pouch: a robot's seed is the robot's to
// hand over, and it takes a belt or a hand to move it. That is the whole point of the shelf.
const pouchSeedsAfter = state.inventory.find((slot) => slot.item === ItemId.PotatoSeed)?.count ?? 0;
assert(pouchSeedsAfter === pouchSeedsBefore, 'seeds teleported into the pouch');
assert(state.stats.itemsHarvestedByHand === 0, "the bot's harvest counted as a hand");

const envelope = serialize(state);
const path = fileURLToPath(new URL('../test/fixtures/saves/format-16.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-16.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `shelves: ${String(dock!.cargoItem)} x ${String(dock!.cargoCount)} produce, ` +
    `${String(dock!.seedShelfItem)} x ${String(dock!.seedShelfCount)} seed; ` +
    `state hash ${hashState(state)}\n`,
);
