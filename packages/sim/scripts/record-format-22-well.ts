// Record `format-22-well.json` under the LAST BUILD THAT HAD AN ARTESIAN WELL (commit 1fef820).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type WorldState,
  ItemId,
  MachineKind,
  TechId,
  addBoxedMachine,
  createWorld,
  hashState,
  machineSpec,
  serialize,
  spawnMachine,
  step,
} from '../src/index';

const SEED = 200_140;

function assert(ok: boolean, why: string): void {
  if (!ok) throw new Error(`record-format-22-well: ${why}`);
}

const state: WorldState = createWorld(SEED);
state.moneyCents = 5_000;
state.unlocked = [TechId.Pumps, TechId.ArtesianWell];

// 1. A BARE well on the pond's north bank, at exactly what one cost new.
const bare = spawnMachine(state, MachineKind.ArtesianWell, 12, 12)!;
bare.investedCents = machineSpec(MachineKind.ArtesianWell)!.priceCents;

// 2. An UPGRADED well, whose invoice is well above list. This is the one a flat refund robs.
const upgraded = spawnMachine(state, MachineKind.ArtesianWell, 11, 13)!;
upgraded.speedLevel = 2;
upgraded.investedCents = 91_500;

// 3. TWO BOXED wells in the bag, with DIFFERENT invoices — one bare, one dear.
addBoxedMachine(state, ItemId.BoxedArtesianWell, {
  speedLevel: 0,
  efficiencyLevel: 0,
  capacityLevel: 0,
  condition: 1_000,
  investedCents: 60_000,
});
addBoxedMachine(state, ItemId.BoxedArtesianWell, {
  speedLevel: 0,
  efficiencyLevel: 1,
  capacityLevel: 0,
  condition: 940,
  investedCents: 78_000,
});

// 4. And a pond DRAWN DOWN, so the level being dropped rather than topped up is visible.
state.reservoirs[0]!.levelMl = 6_000_000;
state.reservoirs[0]!.rechargeAccum = 700;

for (let i = 0; i < 400; i++) step(state, { tick: state.tick, commands: [] });

assert(
  state.machines.filter((m) => m.kind === MachineKind.ArtesianWell).length === 2,
  'wells lost',
);
assert(
  state.reservoirs[0]!.levelMl > 6_000_000,
  'the pond did not recharge, so it is not drawn down',
);
assert(
  state.reservoirs[0]!.levelMl < state.reservoirs[0]!.capacityMl,
  'the pond refilled entirely',
);

const envelope = serialize(state);
assert(envelope.formatVersion === 22, 'this build does not write format 22');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-22-well.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
process.stdout.write(
  `format-22-well.json written: seed ${String(SEED)}, tick ${String(state.tick)}, ` +
    `money ${String(state.moneyCents)}, level ${String(state.reservoirs[0]!.levelMl)}, ` +
    `hash ${hashState(state)}\n`,
);
