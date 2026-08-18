// Record the permanent `format-22.json` save fixture: the first save written after NOTHING ROTS.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-22.ts
//
// THE STORY (item 124; owner ruling 2026-08-17: *"I want fertility to not be a feature at all,
// and I want wasting to not be a feature at all, like these old day potatoes and the compost. I
// want all of that gone."*).
//
// Formats 18 through 21 are one long argument, and every one of them added a clock: a container's
// cargo, a hopper line, an output basket, a belt item, a claw, a depot floor, a lorry's load, a
// robot's arms. Format 22 takes all of them out again, along with `readyAge`, the fertility pair,
// and the per-slot `stacks` list — and with them the seven item ids at both ends of plan §4's
// waste loop.
//
// **THE HARD PART OF A DELETION IS PROVING IT DELETED NOTHING ELSE**, so what this fixture is
// FOR is the next migration rather than this one: 22 → 23 needs a real world written under the
// new rules to start from. What it records is therefore the three facts a format-22 payload can
// express that a format-21 one could not:
//
//   1. **A RIPE CROP THAT HAS STOOD FOR A SIMULATED DAY AND IS STILL THE SAME CROP.** Under
//      format 21 this tile would have drooped at 36,000 ticks, turned Day-Old at 42,000, and
//      collapsed into compost at 54,000. It is caught here past all three, whole.
//   2. **A LOADED CONTAINER AND A LOADED HOPPER WITH NO CLOCK BESIDE THEM.** The absence is the
//      point: the fields are gone from the payload, not zeroed in it.
//   3. **A HARVEST PAID AT `HARVEST_BASE_COUNT`**, on ground that carries no fertility to scale
//      it — the balance decision the deletion forced, caught as goods in a bag.
//
// Every beat is asserted before the file is written, following `record-format-21.ts`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type WorldState,
  CropId,
  HARVEST_BASE_COUNT,
  ItemId,
  MachineKind,
  createWorld,
  cropSpec,
  hashState,
  itemCount,
  machineSpec,
  plantCrop,
  putStorage,
  serialize,
  spawnMachine,
  step,
} from '../src/index';

const SEED = 200_124;
/** A simulated day and then some — past every clock format 21 would have run on this tile. */
const A_LONG_TIME = 60_000;

function assert(ok: boolean, why: string): void {
  if (!ok) throw new Error(`record-format-22: ${why}`);
}

const state: WorldState = createWorld(SEED);
state.moneyCents = 1_000_000;

function idle(ticks: number): void {
  for (let i = 0; i < ticks; i++) step(state, { tick: state.tick, commands: [] });
}

function standOn(tileX: number, tileY: number): void {
  state.player.xSub = tileX * 256 + 128;
  state.player.ySub = tileY * 256 + 128;
}

// --- 1. a ripe crop, left standing far past every clock that used to eat it -----------------
const spec = cropSpec(CropId.RussetPotato)!;
const waiting = state.field.find((tile) => tile.tileX === 6 && tile.tileY === 6)!;
plantCrop(state, waiting, spec);
waiting.growth = waiting.growthTarget;

// --- 2. a second tile, harvested by hand, so the new yield is in the books -------------------
const pulled = state.field.find((tile) => tile.tileX === 7 && tile.tileY === 6)!;
plantCrop(state, pulled, spec);
pulled.growth = pulled.growthTarget;
standOn(7, 6);
const potatoesBefore = itemCount(state, ItemId.RussetPotato);
step(state, { tick: state.tick, commands: [{ type: 'HarvestTile', tileX: 7, tileY: 6 }] });
const picked = itemCount(state, ItemId.RussetPotato) - potatoesBefore;
assert(
  picked >= HARVEST_BASE_COUNT && picked <= HARVEST_BASE_COUNT + 1,
  `a harvest paid ${String(picked)}, not HARVEST_BASE_COUNT + a 0-or-1 coin`,
);

// --- 3. a stocked container and a stocked hopper, neither of them running anything ----------
const cellar = spawnMachine(state, MachineKind.RootCellar, 10, 10)!;
const cellarSpec = machineSpec(MachineKind.RootCellar)!;
assert(putStorage(cellar, cellarSpec, ItemId.RussetPotato, 12) === 12, 'the cellar refused a load');
// **BLOCKED, NOT MERELY STOCKED**, and the difference is the whole reason the beat is here. A
// Seasoner with chips in it and room in its basket RUNS, which is the machine working and not
// this fixture's subject. Filling the basket to capacity is §5's demand-pull stall — the "look
// downstream" state — so the hopper holds its line for the whole day without anything consuming
// it, which is what makes "the line did not shrink" mean "nothing rotted" rather than "nothing
// ran".
const seasoner = spawnMachine(state, MachineKind.Seasoner, 12, 12)!;
const seasonerSpec = machineSpec(MachineKind.Seasoner)!;
seasoner.inputCounts[0] = 5;
seasoner.outputItem = ItemId.SeasonedChips;
seasoner.outputCount = seasonerSpec.outputCapacity;

// --- 4. and then a day passes, and NOTHING HAPPENS TO ANY OF IT -----------------------------
const cellarCount = cellar.cargoCount;
const hopperCount = seasoner.inputCounts[0] ?? 0;
const bagCount = itemCount(state, ItemId.RussetPotato);
idle(A_LONG_TIME);

assert(waiting.crop === CropId.RussetPotato, 'THE RIPE TILE TURNED INTO SOMETHING — nothing rots');
assert(waiting.growth >= waiting.growthTarget, 'the ripe tile stopped being ripe');
assert(cellar.cargoCount === cellarCount, 'the cellar lost part of its load');
assert(cellar.cargoItem === ItemId.RussetPotato, 'the cellar relabelled its load');
assert((seasoner.inputCounts[0] ?? 0) === hopperCount, 'the hopper lost part of its line');
assert(itemCount(state, ItemId.RussetPotato) === bagCount, 'the bag lost potatoes');

const envelope = serialize(state);
assert(envelope.formatVersion === 22, 'this build does not write format 22');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-22.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-22.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `ripe tile still ${String(waiting.crop)}; cellar ${String(cellar.cargoCount)}; ` +
    `hopper ${String(seasoner.inputCounts[0] ?? 0)}; bag ${String(bagCount)}; ` +
    `harvest paid ${String(picked)}; state hash ${hashState(state)}\n`,
);
