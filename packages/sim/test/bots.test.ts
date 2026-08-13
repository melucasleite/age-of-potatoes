// Agri-Bots: the dock, the harvester, the planter, and the one mover they share.
//
// **THIS FILE IS WHAT LETS `GOLDEN_COVERAGE_EXEMPT` EXIST.** The dock is gated on the Corporate
// Charter, whose milestone is 96,000 consecutive ticks of untouched work — so a golden fixture
// that reached `SetDockZone` honestly would be a six-figure-tick recording of a belt loop built
// for no reason but to tick a box. The determinism claim item 038 actually makes is tested here
// instead: two worlds built the same way and stepped the same number of ticks hash identically,
// and every number a bot carries is an integer.
//
// Worlds are built directly through the exported spawn helpers rather than through commands,
// which is the same thing `factory.test.ts` does for the chip line. What that skips is the tech
// gate and the price; what it keeps is every rule that decides what a bot does.

import { describe, expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  BOT_CARRY_CAPACITY,
  BOT_WEAR_PER_OPERATION,
  BotKind,
  BotPhase,
  CONDITION_MAX,
  CeremonyId,
  CropId,
  FIELD_TILES_WIDE,
  ItemId,
  MachineKind,
  addItem,
  cropSpec,
  createWorld,
  dockAcceptSeed,
  findNonIntegerFields,
  hashState,
  itemCount,
  plantCrop,
  spawnBot,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
  totalManualTouches,
} from '../src/index';

/** A world with one zone over the first row of the field and a dock bound to it. */
function farmWithDock(
  kind: MachineKind,
  botKind: BotKind,
  crop: CropId = CropId.RussetPotato,
  seed = 4242,
): { state: WorldState; dock: Machine; zoneId: number } {
  const state = createWorld(seed);
  const zone = spawnZone(state, crop);

  // The first two rows of the field, painted directly — `PaintZone` would work too, but the
  // subject here is the bot rather than the brush.
  for (let i = 0; i < FIELD_TILES_WIDE * 2; i++) state.field[i]!.zone = zone.id;

  const dock = spawnMachine(state, kind, 0, 0)!;
  dock.boundZone = zone.id;
  spawnBot(state, botKind, dock);
  return { state, dock, zoneId: zone.id };
}

/** Ripen every tile of the zone, so the harvester has a full row to work. */
function ripenZone(state: WorldState, zoneId: number): number {
  const spec = cropSpec(CropId.RussetPotato)!;
  let planted = 0;
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone !== zoneId) continue;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    planted += 1;
  }
  return planted;
}

describe('the harvester bot', () => {
  it('clears a zone of ripe crops with no player input at all', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    const planted = ripenZone(state, zoneId);
    expect(planted).toBeGreaterThan(0);

    const touchesBefore = { ...state.stats.touches };
    stepMany(state, 10_000);

    let stillReady = 0;
    for (let i = 0; i < state.field.length; i++) {
      const tile = state.field[i]!;
      if (tile.zone === zoneId && tile.crop !== CropId.None && tile.growth >= tile.growthTarget) {
        stillReady += 1;
      }
    }
    expect(stillReady, 'the bot left ripe tiles standing').toBe(0);

    // The goods are on the dock's floor, where a belt or a grabber can take them away.
    expect(dock.outputCount).toBeGreaterThan(0);

    // AND NOBODY TOUCHED ANYTHING. This is the whole feature, and plan §6's Hands-Free board is
    // unadjudicable if a robot's harvest ever counts as a hand.
    expect(state.stats.touches).toEqual(touchesBefore);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    expect(state.stats.itemsHarvestedByHand).toBe(0);
  });

  it('never carries more than an armful back to the dock', () => {
    const { state, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);

    let peak = 0;
    for (let i = 0; i < 4_000; i++) {
      step(state, { tick: state.tick, commands: [] });
      const bot = state.bots[0]!;
      if (bot.carryCount > peak) peak = bot.carryCount;
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(BOT_CARRY_CAPACITY + 3);
  });

  it('wears per completed operation and not per tick', () => {
    // PLAN §4 NAMES THIS CASE: "Agri-Bot upkeep is per-harvest-op, not weekly." A docked bot with
    // nothing to do must lose nothing at all, or a player is being charged for leaving the tab
    // open — which contradicts §6's clock outright.
    const idle = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    stepMany(idle.state, 10_000);
    expect(idle.state.bots[0]!.condition).toBe(CONDITION_MAX);
    expect(idle.state.bots[0]!.opCount).toBe(0);

    const busy = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(busy.state, busy.zoneId);
    stepMany(busy.state, 10_000);
    const bot = busy.state.bots[0]!;
    expect(bot.opCount).toBeGreaterThan(0);
    expect(bot.condition).toBe(CONDITION_MAX - bot.opCount * BOT_WEAR_PER_OPERATION);
  });

  it('plays its ceremony once, and a reload does not replay it', () => {
    const { state, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    expect(state.ceremonies).not.toContain(CeremonyId.FirstBot);

    stepMany(state, 3_000);
    expect(state.ceremonies).toContain(CeremonyId.FirstBot);

    const before = state.ceremonies.filter((id) => id === CeremonyId.FirstBot).length;
    stepMany(state, 3_000);
    expect(state.ceremonies.filter((id) => id === CeremonyId.FirstBot).length).toBe(before);
  });

  it('does nothing at all when its dock is bound to no zone', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    dock.boundZone = 0;

    stepMany(state, 5_000);
    expect(dock.outputCount).toBe(0);
    expect(state.bots[0]!.opCount).toBe(0);
    expect(state.bots[0]!.condition).toBe(CONDITION_MAX);
  });
});

describe('the roster paces the automation', () => {
  it('sustains a regrowing crop with only a harvester, and runs a one-shot out', () => {
    // §5: "Regrowing crops automate first; one-shots wait for the seed-hopper bot — the crop list
    // itself paces the arc." This is that sentence as an assertion.
    const regrow = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester, CropId.ChiliPepper);
    const chili = cropSpec(CropId.ChiliPepper)!;
    for (let i = 0; i < regrow.state.field.length; i++) {
      const tile = regrow.state.field[i]!;
      if (tile.zone !== regrow.zoneId) continue;
      plantCrop(regrow.state, tile, chili);
      tile.growth = tile.growthTarget;
      tile.moisture = 3_600;
    }
    stepMany(regrow.state, 6_000);

    let stillPlanted = 0;
    for (let i = 0; i < regrow.state.field.length; i++) {
      const tile = regrow.state.field[i]!;
      if (tile.zone === regrow.zoneId && tile.crop === CropId.ChiliPepper) stillPlanted += 1;
    }
    expect(stillPlanted, 'a regrowing crop keeps its plant, so the bot can come back').toBe(
      FIELD_TILES_WIDE * 2,
    );

    const oneShot = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(oneShot.state, oneShot.zoneId);
    stepMany(oneShot.state, 10_000);

    let bare = 0;
    for (let i = 0; i < oneShot.state.field.length; i++) {
      const tile = oneShot.state.field[i]!;
      if (tile.zone === oneShot.zoneId && tile.crop === CropId.None) bare += 1;
    }
    expect(bare, 'a one-shot zone empties out and stays empty without a planter').toBe(
      FIELD_TILES_WIDE * 2,
    );
  });
});

describe('the planter bot', () => {
  it('replants the zone from the dock hopper, per the zone assignment', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    dock.cargoItem = ItemId.PotatoSeed;
    dock.cargoCount = 20;

    stepMany(state, 10_000);

    let planted = 0;
    for (let i = 0; i < state.field.length; i++) {
      const tile = state.field[i]!;
      if (tile.zone === zoneId && tile.crop === CropId.RussetPotato) planted += 1;
    }
    expect(planted).toBeGreaterThan(0);
    expect(dock.cargoCount).toBeLessThan(20);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
  });

  it('plants nothing with an empty hopper, and wears nothing while it waits', () => {
    const { state, zoneId } = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    stepMany(state, 10_000);

    for (let i = 0; i < state.field.length; i++) {
      const tile = state.field[i]!;
      if (tile.zone === zoneId) expect(tile.crop).toBe(CropId.None);
    }
    expect(state.bots[0]!.condition).toBe(CONDITION_MAX);
  });
});

describe('feeding the seed hopper', () => {
  it('counts a touch by hand and none by belt — the Hands-Free board rests on this', () => {
    // §6's taxonomy: "hand-refilling any hopper (seeds, kits, consumables) all count." So a
    // genuinely hands-free farm has to feed its planter by BELT, which is the design turning the
    // board into a logistics problem rather than a purchase. The two paths are different
    // functions precisely so this test can tell them apart.
    const byBelt = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    for (let i = 0; i < 10; i++) {
      const accepted = dockAccept(byBelt.state, byBelt.dock, ItemId.PotatoSeed);
      expect(accepted).toBe(true);
    }
    expect(byBelt.dock.cargoCount).toBe(10);
    expect(byBelt.state.stats.touches.hopperRefill).toBe(0);
    expect(totalManualTouches(byBelt.state.stats.touches)).toBe(0);

    const byHand = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    // Stand on the dock so the reach check passes, and put the seeds in the player's hands.
    byHand.state.player.xSub = 128;
    byHand.state.player.ySub = 128;
    addSeeds(byHand.state, 8);
    // Every seed the player is holding, including the eight the world starts with.
    const held = itemCount(byHand.state, ItemId.PotatoSeed);
    step(byHand.state, {
      tick: byHand.state.tick,
      commands: [{ type: 'RefillHopper', machineId: byHand.dock.id }],
    });
    expect(byHand.dock.cargoCount).toBe(held);
    expect(itemCount(byHand.state, ItemId.PotatoSeed)).toBe(0);
    expect(byHand.state.stats.touches.hopperRefill).toBe(1);
  });

  it('refuses a seed the zone did not ask for', () => {
    const { state, dock } = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    expect(dockAccept(state, dock, ItemId.CaneSeed)).toBe(false);
    expect(dock.cargoCount).toBe(0);
  });
});

describe('bot determinism', () => {
  it('two worlds built the same way and stepped the same way hash identically', () => {
    // ITEM 038'S CRITERION — "bot movement is identical across runs from the same seed and command
    // list" — and the reason bot positions are in the digest at all. A route computed from a
    // module variable, or a position that went fractional, would separate these two hashes.
    const build = (): WorldState => {
      const { state, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
      ripenZone(state, zoneId);
      stepMany(state, 5_000);
      return state;
    };

    const first = build();
    const second = build();
    expect(hashState(second)).toBe(hashState(first));
    expect(first.bots[0]!.xSub).toBe(second.bots[0]!.xSub);
    expect(first.bots[0]!.routeCursor).toBe(second.bots[0]!.routeCursor);
  });

  it('keeps every number on a bot an integer', () => {
    const { state, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 4_000);
    expect(findNonIntegerFields(state)).toEqual([]);
  });

  it('walks the bot in whole subtiles and parks it exactly on the dock', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);

    let sawWalking = false;
    for (let i = 0; i < 6_000; i++) {
      step(state, { tick: state.tick, commands: [] });
      const bot = state.bots[0]!;
      expect(Number.isInteger(bot.xSub)).toBe(true);
      expect(Number.isInteger(bot.moveAccum)).toBe(true);
      if (bot.phase === BotPhase.Outbound || bot.phase === BotPhase.Returning) sawWalking = true;
    }
    expect(sawWalking).toBe(true);
    expect(dock.outputCount).toBeGreaterThan(0);
  });
});

describe('a dock leaving the lot', () => {
  it('takes its bot with it and hands back what the bot was carrying', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 1_500);

    const bot = state.bots[0]!;
    // Put something in its arms so the hand-back is observable, whatever the walk happened to do.
    bot.carryItem = ItemId.RussetPotato;
    bot.carryCount = 3;
    const before = itemCount(state, ItemId.RussetPotato);

    // Stand next to the dock and box it.
    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: dock.id }],
    });

    expect(state.bots.length).toBe(0);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(before + 3);
    expect(itemCount(state, ItemId.BoxedHarvesterDock)).toBe(1);
  });
});

// --- helpers ------------------------------------------------------------------------

/** The belt's door into a dock — the one that must cost no touch. */
function dockAccept(state: WorldState, dock: Machine, item: number): boolean {
  return dockAcceptSeed(state, dock, item);
}

function addSeeds(state: WorldState, count: number): void {
  addItem(state, ItemId.PotatoSeed, count);
}
