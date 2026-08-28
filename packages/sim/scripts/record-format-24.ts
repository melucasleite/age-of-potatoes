// Record the permanent `format-24.json` save fixture: the first save written after the
// flavour cut.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-24.ts
//
// THE STORY (items 145/146/147; owner rulings 2026-08-26). The flavour tier, the premium
// crops, the Chip Kitchen, the Recirculator, the Root Cellar, the citrus orchard, the
// Maintenance Station, nine research nodes and the Corporate Charter's whole era left the
// game, and the 23 → 24 migration bought every one of them back. What a format-24 save is,
// structurally, is a format-23 save with less in it — so what this fixture records is the
// states whose SPELLING moved, which are exactly what the next migration will have to keep
// straight:
//
//   1. **A WASHER WITH BOTH SURVIVING HOPPERS LOADED, MID-BOTTLE.** Format 23 stored a
//      Washer as three counts — russets, gold potatoes, used bottles — and format 24 stores
//      two, with the bottles at INDEX 1 where the gold used to sit. This machine is caught
//      with russets and used bottles hoppered and the bottle recipe running (bottles wash
//      FIRST — the multi-recipe priority item 145 left behind), so a reader that mistook the
//      old layout for the new would hand the wash to the wrong goods.
//   2. **A ZONE THAT IS PAINT AND A NAME AND NOTHING ELSE.** No `autoReplant`, no
//      `replantCooldown` — gone from the payload, not falsed in it.
//   3. **MACHINES WITH NO UNTOUCHED-WORK CLOCK**, and stats with no high-water mark for one.
//      The Corporate Charter's whole counter chain is out of the digest.
//
// Every beat is asserted before the file is written, following `record-format-23.ts`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type WorldState,
  CropId,
  ItemId,
  MachineKind,
  TechId,
  createWorld,
  hashState,
  serialize,
  spawnMachine,
  step,
} from '../src/index';

const SEED = 200_145;
/** Long enough to finish at least one bottle wash and be caught inside another. */
const A_SHORT_SHIFT = 250;

function assert(ok: boolean, why: string): void {
  if (!ok) throw new Error(`record-format-24: ${why}`);
}

const state: WorldState = createWorld(SEED);
state.moneyCents = 100_000;
state.unlocked = [TechId.WashAndSlice];

// The surviving converter, fed by hand on both hoppers: slot 0 russets, slot 1 used bottles.
const washer = spawnMachine(state, MachineKind.Washer, 14, 8)!;
washer.inputCounts[0] = 6;
washer.inputCounts[1] = 10;

// A zone, so the payload carries one — the row that lost its two auto-replant fields.
step(state, {
  tick: state.tick,
  commands: [
    {
      type: 'CreateZone',
      rect: { x: 4, y: 4, w: 2, h: 2 },
      crop: CropId.RussetPotato,
    },
  ],
});

for (let i = 0; i < A_SHORT_SHIFT; i++) step(state, { tick: state.tick, commands: [] });

// Beat 1: the bottle recipe ran FIRST and is still running — clean bottles in the basket,
// russets untouched in slot 0, bottles drawn down in slot 1, and an operation in flight.
assert(state.zones.length === 1, 'the zone went missing');
assert(washer.inputCounts.length === 2, 'the Washer does not have exactly two hoppers');
assert(washer.inputCounts[0] === 6, 'the russets were washed ahead of the bottles');
assert(washer.inputCounts[1]! > 0 && washer.inputCounts[1]! < 10, 'not caught mid-bottle');
assert(washer.outputItem === ItemId.Bottle, 'the basket does not hold clean bottles');
assert(washer.outputCount > 0, 'no bottle finished washing');
assert(washer.progress > 0, 'not caught inside an operation');

const envelope = serialize(state);
assert(envelope.formatVersion === 24, 'this build does not write format 24');
const flat = JSON.stringify(envelope.payload);
assert(!flat.includes('untouchedTicks'), 'the payload still carries the untouched clock');
assert(
  !flat.includes('longestUntouchedMachineTicks'),
  'the payload still carries its high-water mark',
);
assert(!flat.includes('autoReplant'), 'the payload still carries autoReplant');
assert(!flat.includes('replantCooldown'), 'the payload still carries replantCooldown');

const path = fileURLToPath(new URL('../test/fixtures/saves/format-24.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-24.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `washer hoppers ${JSON.stringify(washer.inputCounts)}; basket ${String(washer.outputCount)} ` +
    `bottles; state hash ${hashState(state)}\n`,
);
