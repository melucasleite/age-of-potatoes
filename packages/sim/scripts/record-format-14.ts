// Record the permanent `format-14.json` save fixture: the first save with a CHEAT in it.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-14.ts
//
// THE STORY (item 075): a young world plays two honest beats of the gardener loop, then the
// owner types `klapaucius` — $100,000 appears, every tech node unlocks, and the hashed
// `cheatsUsed` counter (the one fact no earlier format can express) ticks to 1. The conjured
// money and unlocks are then SPENT where a save can prove they were real: a Pump goes down on
// the pond's north bank (gated behind `fabrication-pumps`, unreachable this early by honest
// play) and the deed to a second parcel is signed. The recorder asserts every beat, including
// the refusal that must leave no mark: an unknown code (`xyzzy`) appends nothing to the trace.
//
// The moment serialized is mid-flight in the one way that matters here: tick 700, kitchen-less
// and quiet, but with `cheatsUsed: 1`, the full 32-node unlock list, and two owned parcels on
// a tick-700 world — a combination no un-cheated save can carry.
//
// Every command in the session is one the sim actually accepted, following the
// `record-mid-field.ts` discipline.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type WorldState,
  CropId,
  MachineKind,
  TECH_NODES,
  createWorld,
  hashState,
  serialize,
  step,
} from '../src/index';

const SEED = 750_750;

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

// Two honest beats first, so the save is a played world rather than a menu screen.
run([{ type: 'PlantTile', tileX: 8, tileY: 11, crop: CropId.RussetPotato }]);
run([{ type: 'WaterTile', tileX: 8, tileY: 11 }]);
idle(50);

// The refusal that must leave no mark: an unknown code is a no-op with no trace entry.
const traceBefore = state.trace.length;
run([{ type: 'Cheat', code: 'xyzzy' }]);
assert(state.trace.length === traceBefore, 'an unknown code entered the trace');
assert(state.stats.cheatsUsed === 0, 'an unknown code counted as a cheat');

// The cheat. Money appears, every node unlocks, and the counter carries the fact.
const moneyBefore = state.moneyCents;
run([{ type: 'Cheat', code: 'klapaucius' }]);
assert(state.moneyCents === moneyBefore + 10_000_000, 'klapaucius did not pay');
assert(state.unlocked.length === TECH_NODES.length, 'klapaucius left nodes locked');
assert(state.stats.cheatsUsed === 1, 'the cheat counter did not move');

// Spend the proceeds where the save can prove them: a tech-gated Pump on the pond's north
// bank, and the deed to parcel 1 — neither reachable at tick ~52 by honest play.
run([{ type: 'PlaceMachine', kind: MachineKind.Pump, tileX: 12, tileY: 12 }]);
assert(
  state.machines.some((m) => m.kind === MachineKind.Pump),
  'the Pump was refused',
);
run([{ type: 'BuyDeed', parcel: 1 }]);
assert(state.ownedParcels.length === 2, 'the deed was refused');

// Let the world breathe, then freeze it.
while (state.tick < 700) idle(1);

const envelope = serialize(state);
const path = fileURLToPath(new URL('../test/fixtures/saves/format-14.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-14.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(`state hash ${hashState(state)}\n`);
