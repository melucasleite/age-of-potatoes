// Record the permanent `format-21.json` save fixture: the first save in which the LAST TWO places
// a good can sit know how old it is.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-format-21.ts
//
// THE STORY (item 115). Format 20 gave a clock to a hopper, an output basket, a claw and a belt,
// and item 112's own adversarial verifier — briefed to map the family rather than re-test the
// doors just closed — refuted the claim at two more.
//
//   **The Truck Depot floor.** A standing route's `stocked` was a bare count. Goods put on the
//   floor with 1,200 ticks left came back from a `CancelContract` with 17,999 of an 18,000-tick
//   window after 72,000 ticks, and the belt-fed version of that loop needed no clicking at all.
//
//   **A stalled bot.** Item 112 decided in writing that a bot's pocket keeps no clock, reasoning
//   that goods can only enter it by harvest. True, and beside the point: a bot that harvests and
//   then cannot deliver holds its armful indefinitely, and the clock had never started.
//
// The three facts no format-20 payload can express are each caught here MID-FLIGHT, because a
// clock at rest proves nothing — an empty floor and an empty robot round-trip perfectly and say
// nothing about the format they were written for:
//
//   1. A DEPOT FLOOR PART-WAY THROUGH ITS WINDOW. A route whose run size it cannot reach, which
//      is therefore the exploit's exact shape: a warehouse that waits forever.
//   2. A LORRY'S LOAD, FROZEN. `inTransitFreshTicks` is deliberately NOT spent while a truck is
//      away — the Delivery Cart's already-taken rule — so this one is caught unchanging, which is
//      the fact, not the absence of one.
//   3. A BOT'S ARMS PART-WAY THROUGH THEIR WINDOW. A harvester stalled against a shelf holding
//      another crop, which is an ordinary factory state rather than an exploit.
//
// A grandfathered route rides along too — stock poked onto a floor with `stockedFreshTicks: 0`,
// which is exactly what migration 20 → 21 writes — so the fixture pins the "0 means no opinion,
// and the heal belongs to the next arrival" rule that formats 18 and 20 both chose.
//
// Every beat is asserted before the file is written, following `record-format-20.ts`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type WorldState,
  BotKind,
  BotPhase,
  ContractPhase,
  CropId,
  FIELD_TILES_WIDE,
  ItemId,
  MachineKind,
  createWorld,
  cropSpec,
  depotAccept,
  freshnessTicks,
  hashState,
  machineSpec,
  plantCrop,
  serialize,
  spawnBot,
  spawnZone,
  step,
} from '../src/index';
import { spawnMachine } from '../src/state';

const SEED = 200_115;

const state: WorldState = createWorld(SEED);

function idle(ticks: number): void {
  for (let i = 0; i < ticks; i++) step(state, { tick: state.tick, commands: [] });
}
function assert(fact: boolean, story: string): void {
  if (!fact) throw new Error(`The story broke: ${story}`);
}

// --- the lot ----------------------------------------------------------------------------
//
// Machines are spawned rather than bought. This is a SAVE-SHAPE fixture, not a golden replay.
const depot = spawnMachine(state, MachineKind.TruckDepot, 10, 10)!;
const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;

/** Sign a route straight onto the world, the way the reducer would. */
function sign(item: ItemId, quantityPerRun: number) {
  const contract = {
    id: state.nextContractId,
    depotId: depot.id,
    item,
    quantityPerRun,
    destination: 'Fixture Row',
    stocked: 0,
    stockedFreshTicks: 0,
    inTransit: 0,
    inTransitFreshTicks: 0,
    phase: ContractPhase.Waiting,
    ticksRemaining: 0,
    runsCompleted: 0,
    grossCents: 0,
  };
  state.contracts.push(contract);
  state.nextContractId += 1;
  return contract;
}

// --- 1. the floor: a route whose run size it will never reach ----------------------------
//
// THE EXPLOIT'S EXACT SHAPE. A run of 90 against a floor nothing else feeds means the goods wait
// forever, which is what made a standing route an unbounded refrigerator.
const waiting = sign(ItemId.RussetPotato, 90);
for (let i = 0; i < 12; i++) {
  assert(depotAccept(state, depot, ItemId.RussetPotato, 11_400), 'the floor refused a potato');
}
assert(waiting.stockedFreshTicks === 11_400, 'the floor did not take the arrivals’ clock');

idle(700);
assert(waiting.stocked === 12, 'the floor shipped when it should have waited');
assert(waiting.stockedFreshTicks < 11_400, 'the floor clock is not running');
assert(waiting.stockedFreshTicks > 0, 'the floor clock ran out — the fixture records a zero');

// --- 2. the grandfathered route: stock on a floor with no clock recorded -----------------
//
// EXACTLY what migration 20 → 21 writes. It must survive the round trip as a 0 rather than being
// helpfully filled in: the heal belongs to the next thing that arrives, not to the loader.
const grandfathered = sign(ItemId.Corn, 80);
grandfathered.stocked = 20;
grandfathered.stockedFreshTicks = 0;
idle(200);
assert(grandfathered.stockedFreshTicks === 0, 'the grandfathered floor was healed too early');
assert(grandfathered.stocked === 20, 'the grandfathered floor lost stock');

// --- 3. the bot: an armful it cannot put down --------------------------------------------
//
// A shelf holding another crop, filled to the brim. `unloadIntoDock` moves nothing and the robot
// stands at the shed — the house "look downstream" stall, and the state that made a bot a fridge.
const zone = spawnZone(state, CropId.RussetPotato);
for (let i = 0; i < FIELD_TILES_WIDE * 2; i++) state.field[i]!.zone = zone.id;
dock.boundZone = zone.id;
const bot = spawnBot(state, BotKind.Harvester, dock)!;

const potato = cropSpec(CropId.RussetPotato)!;
for (let i = 0; i < state.field.length; i++) {
  const tile = state.field[i]!;
  if (tile.zone !== zone.id) continue;
  plantCrop(state, tile, potato);
  tile.growth = tile.growthTarget;
}

dock.cargoItem = ItemId.ChiliPepper;
dock.cargoCount = machineSpec(MachineKind.HarvesterDock)!.outputCapacity;
dock.cargoFreshTicks = 0;

let stalled = false;
for (let i = 0; i < 20_000 && !stalled; i++) {
  idle(1);
  stalled = bot.phase === BotPhase.Returning && bot.carryCount > 0 && bot.carryFreshTicks > 0;
}
assert(stalled, 'the bot never came home holding anything');
assert(bot.carryItem === ItemId.RussetPotato, 'the bot is carrying something unexpected');

const armfulAtHome = bot.carryFreshTicks;
idle(600);
assert(bot.carryCount > 0, 'the bot managed to put its armful down after all');
assert(bot.carryFreshTicks < armfulAtHome, 'the armful clock is not running');
assert(bot.carryFreshTicks > 0, 'the armful turned to compost — the fixture records a zero');
assert(
  bot.carryFreshTicks < freshnessTicks(ItemId.RussetPotato),
  'the armful is holding a full window, which is the bug this format closes',
);

// --- 4. the lorry: a load on the road, with the clock it left holding --------------------
//
// **STAGED LAST, AND THAT IS NOT AN ACCIDENT OF WRITING ORDER.** A run is `DEPOT_LOAD_TICKS` plus
// `DEPOT_RUN_BASE_TICKS` plus distance — about eleven hundred ticks from this depot — and the bot
// above needs a thousand of them to fill its arms and walk home. Staged in reading order, the
// lorry delivered its load and was paid before the file was written, and the fixture recorded
// `0 × 0`: a truck that had been, which is not a truck that is.
const rolling = sign(ItemId.WashedPotato, 5);
for (let i = 0; i < 5; i++) {
  assert(
    depotAccept(state, depot, ItemId.WashedPotato, 4_200),
    'the floor refused a washed potato',
  );
}
idle(140);
assert(rolling.inTransit === 5, 'the lorry never loaded');
assert(rolling.phase === ContractPhase.Rolling, 'the lorry is not on the road');
assert(rolling.stocked === 0, 'the floor kept something back');
assert(
  rolling.stockedFreshTicks === 0,
  'an emptied floor kept a remainder — empty must be one state',
);
const onTheRoad = rolling.inTransitFreshTicks;
assert(onTheRoad === 4_200, 'the lorry did not take the floor’s clock');
idle(200);
assert(
  rolling.inTransitFreshTicks === onTheRoad,
  'THE LORRY CLOCK MOVED — a run is bounded and a road is not a shed (`Contract.inTransitFreshTicks`)',
);

const envelope = serialize(state);
assert(envelope.formatVersion === 21, 'this build does not write format 21');
const path = fileURLToPath(new URL('../test/fixtures/saves/format-21.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

process.stdout.write(`format-21.json written: seed ${String(SEED)}, tick ${String(state.tick)}\n`);
process.stdout.write(
  `waiting floor ${String(waiting.stocked)} × ${String(waiting.stockedFreshTicks)}; ` +
    `lorry ${String(rolling.inTransit)} × ${String(rolling.inTransitFreshTicks)}; ` +
    `grandfathered ${String(grandfathered.stocked)} × ${String(grandfathered.stockedFreshTicks)}; ` +
    `bot ${String(bot.carryItem)} ${String(bot.carryCount)} × ${String(bot.carryFreshTicks)}; ` +
    `state hash ${hashState(state)}\n`,
);
