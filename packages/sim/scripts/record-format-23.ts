// Record the permanent `format-23.json` save fixture: the first save written after the pond
// stopped being a stock.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-23.ts
//
// THE STORY (item 140; owner ruling 2026-08-17: *"I want the ponds to have infinite water. Get
// rid of the artisan well and just have the pond have an unlimited supply of water."*).
//
// Format 3 gave a reservoir a level, a capacity and a recharge accumulator, and every format
// since has carried all three. Format 23 takes them out: a pond is a footprint and an id, and
// how much water there is stopped being a question. It also retires the Artesian Well, which
// existed for exactly one day — see `format-22-well.json`, which is what a player who owned one
// was holding, and the 22 → 23 test that buys it back.
//
// **WHAT THIS FIXTURE IS FOR IS THE NEXT MIGRATION**, so what it records is the facts a
// format-22 payload could not express:
//
//   1. **A POND WITH NOTHING IN IT TO RECORD.** The absence is the point: `levelMl`,
//      `capacityMl` and `rechargeAccum` are gone from the payload, not zeroed in it.
//   2. **A WORLD THAT HAS DRAWN MORE WATER THAN THE OLD POND COULD EVER HAVE HELD.** Caught past
//      20,000,000 ml — the format-22 pond's entire capacity — from a pond that is still there and
//      still answering in full. Under the old rules this pump would have spent the run halved and
//      then sipping.
//   3. **A NETWORK WITH NO THROTTLE BAND TO BE IN**, caught at the exact instant that used to be
//      the game's worst: a spent tank, an amber head part-way through its buffer, and a pump at
//      its full rating anyway. Under format 22 this world had a drained pond, and the pump was
//      halved and then sipping. The tank being empty is now a fact about the PUMP — demand
//      outruns 600,000 ml/min — rather than a fact about the water.
//
// Every beat is asserted before the file is written, following `record-format-22.ts`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type WorldState,
  LiquidId,
  MachineKind,
  PUMP_RATE_ML_PER_MINUTE,
  TechId,
  createWorld,
  hashState,
  machineSpec,
  rebuildNetworks,
  serialize,
  spawnMachine,
  spawnPipe,
  step,
} from '../src/index';

const SEED = 200_143;
/** Long enough to draw more than the old pond's whole capacity, and a quarter again. */
const A_LONG_DRINK = 50_000;
/** What the format-22 pond held, in full. Frozen here because the constant is gone. */
const FORMAT_22_POND_CAPACITY_ML = 20_000_000;

function assert(ok: boolean, why: string): void {
  if (!ok) throw new Error(`record-format-23: ${why}`);
}

const state: WorldState = createWorld(SEED);
state.moneyCents = 1_000_000;
state.unlocked = [TechId.Pumps, TechId.PipedSprinklers, TechId.IrrigationHub];

// The chain: pond → pump on its north bank → a run west and north → a tank and three consumers.
// THREE, deliberately: two dumb heads and a Hub want more than 600,000 ml/min between them, so
// the network is permanently starved and the pump is asked for everything it has on every tick.
const pump = spawnMachine(state, MachineKind.Pump, 12, 12)!;
for (let x = 11; x >= 3; x--) spawnPipe(state, x, 12, LiquidId.Water);
for (let y = 11; y >= 4; y--) spawnPipe(state, 3, y, LiquidId.Water);
const tank = spawnMachine(state, MachineKind.Tank, 1, 10)!;
const head = spawnMachine(state, MachineKind.PipedSprinkler, 2, 8)!;
spawnMachine(state, MachineKind.PipedSprinkler, 4, 13);
spawnMachine(state, MachineKind.IrrigationHub, 1, 4);
rebuildNetworks(state);

for (let i = 0; i < A_LONG_DRINK; i++) step(state, { tick: state.tick, commands: [] });

assert(state.reservoirs.length === 1, 'the pond went missing');
assert(
  state.stats.waterDrawnMl > FORMAT_22_POND_CAPACITY_ML,
  'this world has not out-drunk a format-22 pond, so it proves nothing',
);
assert(
  pump.flowMlPerMinute === PUMP_RATE_ML_PER_MINUTE,
  'the pump is not at its full rating, so something is still throttling it',
);
// A SPENT tank, and it has to be spent for a reason: this network's demand outruns its pump, so
// the buffer went into the consumers and stayed there. A brim-full tank would mean the network
// was in surplus, which is the comfortable case and proves nothing about a pump at its ceiling.
assert(tank.tankMl === 0, 'the tank still holds water, so the network is not actually starved');
assert(head.throttled, 'nothing is amber, so nobody asked for more than they got');
assert(head.opCount > 0, 'the head never watered anything');
assert(
  head.tankMl > 0 && head.tankMl < machineSpec(MachineKind.PipedSprinkler)!.tankCapacityMl,
  'the head is not caught part-way through its own buffer',
);

const envelope = serialize(state);
assert(envelope.formatVersion === 23, 'this build does not write format 23');
assert(
  !JSON.stringify(envelope.payload.reservoirs).includes('levelMl'),
  'the payload still carries a pond level',
);
const path = fileURLToPath(new URL('../test/fixtures/saves/format-23.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-23.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `drawn ${String(state.stats.waterDrawnMl)} ml (old pond held ${String(FORMAT_22_POND_CAPACITY_ML)}); ` +
    `pump ${String(pump.flowMlPerMinute)} ml/min; tank ${String(tank.tankMl)}; ` +
    `head ops ${String(head.opCount)}; state hash ${hashState(state)}\n`,
);
