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
  BOT_SEED_POCKET_CAPACITY,
  HARVESTER_SEED_SHELF_CAPACITY,
  BOT_WEAR_PER_OPERATION,
  BeltTier,
  BotKind,
  BotPhase,
  CONDITION_MAX,
  CeremonyId,
  CropId,
  Direction,
  FIELD_TILES_WIDE,
  GrabberTier,
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
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
  takeDockShelf,
  tileAt,
  tillTile,
  totalManualTouches,
  waterAtSubtile,
} from '../src/index';
import { POND_ORIGIN_X, POND_ORIGIN_Y, POND_TILES_WIDE } from '../src/data';

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

    // The goods are on the dock's shelf WITH THEIR NAME ON THEM (item 083): identified cargo,
    // where a belt, a grabber, or a hand can actually take them away. The old `outputCount`
    // buffer had no identity for delivered goods, which stranded every harvest forever.
    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount).toBeGreaterThan(0);
    expect(dock.outputCount).toBe(0);

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
    expect(dock.cargoCount).toBe(0);
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
    expect(dock.cargoCount).toBeGreaterThan(0);
  });
});

describe('a bot meeting the pond (item 080)', () => {
  it('skips a target across the water, stands dry, and never livelocks', () => {
    // A rolling bot's straight line is allowed to be blocked by the pond — what it is not
    // allowed to do is walk on it, or spin the tick loop chasing a tile it can never reach.
    // Dock on the east bank column, one zone tile west of the pond: the line crosses water.
    const state = createWorld(8080);
    const zone = spawnZone(state, CropId.RussetPotato);
    const tilled = tillTile(state, POND_ORIGIN_X - 2, POND_ORIGIN_Y + 1);
    const tile = tilled ?? tileAt(state, POND_ORIGIN_X - 2, POND_ORIGIN_Y + 1)!;
    tile.zone = zone.id;
    const spec = cropSpec(CropId.RussetPotato)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;

    const dock = spawnMachine(
      state,
      MachineKind.HarvesterDock,
      POND_ORIGIN_X + POND_TILES_WIDE,
      POND_ORIGIN_Y + 1,
    )!;
    dock.boundZone = zone.id;
    spawnBot(state, BotKind.Harvester, dock);

    for (let i = 0; i < 2_000; i++) {
      step(state, { tick: state.tick, commands: [] });
      const bot = state.bots[0]!;
      expect(waterAtSubtile(state, bot.xSub, bot.ySub), 'the bot walked on water').toBe(false);
    }
    // The tile across the pond was never harvested: the target is skipped like a blocked
    // one, not fished out of the water. Manual routing (a dock re-site) is the fix, by design.
    expect(tile.crop).toBe(CropId.RussetPotato);
    expect(tile.growth).toBe(tile.growthTarget);
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
    // The shelf comes back too, now that it has an identity (item 083). Under the old
    // anonymous buffer, deconstructing a stocked dock silently DELETED everything on it —
    // the same swallow, one verb further along.
    const shelf = dock.cargoCount;
    expect(shelf).toBeGreaterThan(0);

    // Stand next to the dock and box it.
    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: dock.id }],
    });

    expect(state.bots.length).toBe(0);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(before + 3 + shelf);
    expect(itemCount(state, ItemId.BoxedHarvesterDock)).toBe(1);
  });
});

describe('the dock shelf (item 083)', () => {
  // THE STORY THE OWNER REPORTED, WITH THE ENDING FIXED: bot harvests, returns, unloads —
  // and then a grabber pointed at the dock actually takes the goods and puts them on a belt,
  // which is the half that had been broken since item 038 shipped. The dock's shelf is its
  // CARGO now, so what the bot put down has a name the arm can read.
  it('bot harvests, delivers, and a grabber drains the shelf onto a belt — goods ride away', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 4_000);

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    const shelfBefore = dock.cargoCount;
    expect(shelfBefore).toBeGreaterThan(0);
    // The bot may be standing at a full shed holding leftovers — the stall working — and it
    // will top the shelf back up as the arm makes room, so the books below count its armful.
    const armfulBefore = state.bots[0]!.carryCount;

    // An arm behind the dock, a belt behind the arm. Source (1,1) is the dock's south-east
    // tile; destination (3,1) is the belt's head.
    const belt = spawnBelt(state, BeltTier.Basic, 3, 1, Direction.East, 2)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, 0);
    stepMany(state, 600);

    const grabber = state.grabbers[0]!;
    const riding = belt.items.length;
    expect(riding, 'nothing ever left the dock').toBeGreaterThan(0);
    for (let i = 0; i < belt.items.length; i++) {
      expect(belt.items[i]!.item).toBe(ItemId.RussetPotato);
    }
    // Conservation, one unit per swing: everything that was on the shelf or in the bot's
    // arms is now on the shelf, in the bot's arms, riding the belt, or in the grabber's
    // hand. Nothing vanished at any hand-off.
    const inHand = grabber.held === 0 ? 0 : 1;
    expect(dock.cargoCount + state.bots[0]!.carryCount + riding + inHand).toBe(
      shelfBefore + armfulBefore,
    );
  });

  it('respects the grabber filter: an arm filtered to another item leaves the shelf alone', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 4_000);
    const shelf = dock.cargoCount;
    expect(shelf).toBeGreaterThan(0);

    spawnBelt(state, BeltTier.Basic, 3, 1, Direction.East, 2)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, ItemId.Corn);
    stepMany(state, 400);
    expect(dock.cargoCount, 'a filtered arm took goods its filter refuses').toBe(shelf);

    // Re-aimed at what the shelf actually holds, the same arm starts taking.
    state.grabbers[0]!.filter = ItemId.RussetPotato;
    stepMany(state, 400);
    expect(dock.cargoCount).toBeLessThan(shelf);
  });

  it('hand-unloads like storage: goods come back identified, fresh-stamped, and touch-counted', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 4_000);
    const shelf = dock.cargoCount;
    expect(shelf).toBeGreaterThan(0);

    const before = itemCount(state, ItemId.RussetPotato);
    const carryBefore = state.bots[0]!.carryCount;
    const touchesBefore = state.stats.touches.handCarry;
    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'UnloadMachine', machineId: dock.id, count: 5 }],
    });

    expect(itemCount(state, ItemId.RussetPotato)).toBe(before + 5);
    // The bot may immediately restock the freed space from a stalled armful, so the claim is
    // conservation rather than an exact shelf level: five left the shed system, none vanished.
    expect(dock.cargoCount + state.bots[0]!.carryCount).toBe(shelf + carryBefore - 5);
    expect(state.stats.touches.handCarry).toBe(touchesBefore + 1);

    // Freshness is stamped on the way OUT, from this tick, exactly as the Root Cellar does
    // it: nothing ages inside a machine, and goods back in the player's arms are loose again.
    const slot = state.inventory.find((entry) => entry.item === ItemId.RussetPotato)!;
    expect(slot.stacks.length).toBeGreaterThan(0);
    for (let i = 0; i < slot.stacks.length; i++) {
      expect(slot.stacks[i]!.spoilAtTick).toBeGreaterThan(state.tick);
    }
  });

  it('stalls a bot delivering a different item than the shelf holds — nothing is deleted', () => {
    // The mismatch trip is real: a zone that wilts mid-round sends the same bot home with
    // fresh goods on one trip and Day-Old on the next. The shelf holds one product, so the
    // second trip is the house "look downstream" stall — the bot stands at the shed holding
    // its armful until the shelf drains, and then the held row walks itself in.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 8_000);

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    const shelf = dock.cargoCount;
    expect(shelf).toBeGreaterThan(0);

    const bot = state.bots[0]!;
    bot.carryItem = ItemId.DayOldPotato;
    bot.carryCount = 5;
    bot.phase = BotPhase.Returning;
    stepMany(state, 600);

    // The stall, visibly: the armful is intact, the shelf is unmixed, nothing went anywhere.
    expect(bot.carryItem).toBe(ItemId.DayOldPotato);
    expect(bot.carryCount).toBe(5);
    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount).toBe(shelf);

    // Drain the shelf through its one door, and the stall resolves itself: the held row
    // becomes the shelf's next product. Five in, five on the shelf — nothing was deleted.
    expect(takeDockShelf(dock, shelf)).toEqual({ item: ItemId.RussetPotato, taken: shelf });
    stepMany(state, 600);
    expect(dock.cargoItem).toBe(ItemId.DayOldPotato);
    expect(dock.cargoCount).toBe(5);
    expect(bot.carryCount).toBe(0);
  });

  it('parks the bot when nothing is ripe, and resumes it when the zone ripens again', () => {
    // The other half of the owner's report: "bot idle" once the dock drains is EXPECTED —
    // nothing ripe means parked at the dock — and the claim worth testing is that ripeness
    // wakes it back up rather than that idleness is a bug.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 10_000);

    // The zone out-yields the 40-slot shelf, so the round ends with the bot stalled at a full
    // shed holding leftovers. Drain the shelf through its one door until the bot has parked
    // itself empty-handed — the stall resolving is itself part of the story.
    for (
      let i = 0;
      i < 20 && !(state.bots[0]!.phase === BotPhase.Idle && dock.cargoCount === 0);
      i++
    ) {
      while (takeDockShelf(dock, 40) !== null) {
        /* the one door, swung until the shelf is bare */
      }
      stepMany(state, 200);
    }
    while (takeDockShelf(dock, 40) !== null) {
      /* one last sweep, in case parking dropped a final armful */
    }
    expect(state.bots[0]!.phase).toBe(BotPhase.Idle);
    expect(state.bots[0]!.carryCount).toBe(0);
    expect(dock.cargoCount).toBe(0);

    // Nothing ripe, empty shelf, parked bot: idle is correct, not a bug. Now the wake-up.
    ripenZone(state, zoneId);
    stepMany(state, 6_000);

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount, 'the bot never went back to work').toBeGreaterThan(0);
  });

  it('keeps the planter dock and drone bay grabber-proof: incoming supply is not a source', () => {
    // Their cargo pairs hold what something PAID to put in — seeds and drone parts — and an
    // arm that could siphon a hopper would turn a supply line into a leak. The gate is by
    // kind, in `takeDockShelf` itself, so there is no caller that can forget it.
    const planter = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    planter.dock.boundZone = 0; // park the bot so the hopper level is the test's own
    planter.dock.cargoItem = ItemId.PotatoSeed;
    planter.dock.cargoCount = 12;
    spawnBelt(planter.state, BeltTier.Basic, 3, 1, Direction.East, 2);
    spawnGrabber(planter.state, GrabberTier.Mk1, 2, 1, Direction.East, 0);
    stepMany(planter.state, 600);
    expect(planter.dock.cargoCount, 'an arm siphoned the seed hopper').toBe(12);
    expect(planter.state.grabbers[0]!.held).toBe(0);

    const bayWorld = createWorld(9393);
    const bay = spawnMachine(bayWorld, MachineKind.DroneBay, 0, 0)!;
    bay.cargoItem = ItemId.DronePart;
    bay.cargoCount = 6;
    spawnBelt(bayWorld, BeltTier.Basic, 3, 1, Direction.East, 2);
    spawnGrabber(bayWorld, GrabberTier.Mk1, 2, 1, Direction.East, 0);
    stepMany(bayWorld, 600);
    expect(bay.cargoCount, 'an arm siphoned the parts shelf').toBe(6);
    expect(bayWorld.grabbers[0]!.held).toBe(0);
  });
});

// --- helpers ------------------------------------------------------------------------

/** The belt's door into a dock — the one that must cost no touch. */
// --- the seed comes home (item 088) --------------------------------------------------

/**
 * Every item a harvest put into the world, wherever it landed.
 *
 * The two paths keep their goods in different places by design — a hand fills the pouch, a bot
 * fills its arms and its pocket and then two shelves — so parity is a claim about the BAG, not
 * about the furniture. Everything is counted: pouch, bot, and both shelves, so a test can never
 * pass by losing something into a slot it forgot to look in.
 */
function harvestBag(state: WorldState): Map<number, number> {
  const bag = new Map<number, number>();
  const add = (item: number, count: number): void => {
    if (item === 0 || count <= 0) return;
    bag.set(item, (bag.get(item) ?? 0) + count);
  };
  for (const slot of state.inventory) add(slot.item, slot.count);
  for (const bot of state.bots) {
    add(bot.carryItem, bot.carryCount);
    add(bot.seedItem, bot.seedCount);
  }
  for (const machine of state.machines) {
    if (machine.kind !== MachineKind.HarvesterDock) continue;
    add(machine.cargoItem, machine.cargoCount);
    add(machine.seedShelfItem, machine.seedShelfCount);
  }
  return bag;
}

/** The pouch a fresh world starts with, so a harvest's yield can be read as a delta. */
function bagDelta(after: Map<number, number>, before: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [item, count] of after) {
    const gained = count - (before.get(item) ?? 0);
    if (gained !== 0) out.set(item, gained);
  }
  return out;
}

/** One tile, ripe, at the field's north-west corner, harvested by the player standing on it. */
function handHarvestsOneTile(crop: CropId, seed: number): Map<number, number> {
  const state = createWorld(seed);
  const spec = cropSpec(crop)!;
  const tile = state.field[0]!;
  plantCrop(state, tile, spec);
  tile.growth = tile.growthTarget;

  state.player.xSub = tile.tileX * 256 + 128;
  state.player.ySub = tile.tileY * 256 + 128;
  const before = harvestBag(state);
  step(state, {
    tick: state.tick,
    commands: [{ type: 'HarvestTile', tileX: tile.tileX, tileY: tile.tileY }],
  });
  return bagDelta(harvestBag(state), before);
}

/** The SAME tile in the same world, pulled by a robot instead. */
function botHarvestsOneTile(crop: CropId, seed: number): Map<number, number> {
  const state = createWorld(seed);
  const spec = cropSpec(crop)!;
  const zone = spawnZone(state, crop);
  const tile = state.field[0]!;
  tile.zone = zone.id;
  plantCrop(state, tile, spec);
  tile.growth = tile.growthTarget;

  const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
  dock.boundZone = zone.id;
  spawnBot(state, BotKind.Harvester, dock);

  const before = harvestBag(state);
  // Long enough to walk out, bend down, and walk back — and no longer, so a regrowing crop
  // cannot come round a second time and make the counts a function of the timeout.
  for (let i = 0; i < 3_000 && state.bots[0]!.opCount === 0; i++) {
    step(state, { tick: state.tick, commands: [] });
  }
  step(state, { tick: state.tick, commands: [] });
  return bagDelta(harvestBag(state), before);
}

describe('the seed comes home (item 088)', () => {
  it('PARITY, ONE-SHOT: a bot pull of a tile yields exactly what a hand pull of it yields', () => {
    // The owner's report, as an assertion: "when I harvest manually, the seed always comes
    // back. The AutoHarvester should get the potatoes and the seed automatically." Both worlds
    // are the same seed, the same tile, and the first harvest either has ever rolled — so the
    // yield bonus off the Harvest stream is the same number and the bags must match exactly.
    const hand = handHarvestsOneTile(CropId.RussetPotato, 8801);
    const bot = botHarvestsOneTile(CropId.RussetPotato, 8801);

    expect(bot).toEqual(hand);
    // And the thing that was missing is in there: potatoes AND a seed.
    expect(hand.get(ItemId.RussetPotato)).toBeGreaterThan(0);
    expect(hand.get(ItemId.PotatoSeed)).toBe(1);
    expect(bot.get(ItemId.PotatoSeed)).toBe(1);
  });

  it('PARITY, REGROWING: neither path returns a seed, because you already own the plant', () => {
    // The other half of the property, and the one that would catch an over-eager fix: a
    // regrower keeps its plant, so a seed from it would be a duplication rather than a return.
    const hand = handHarvestsOneTile(CropId.SugarCane, 8802);
    const bot = botHarvestsOneTile(CropId.SugarCane, 8802);

    expect(bot).toEqual(hand);
    expect(hand.get(ItemId.SugarCane)).toBeGreaterThan(0);
    expect(hand.has(ItemId.CaneSeed)).toBe(false);
    expect(bot.has(ItemId.CaneSeed)).toBe(false);
  });

  it('lands the seeds on the dock’s own shelf, beside the produce and under their own name', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    const planted = ripenZone(state, zoneId);
    expect(planted).toBeGreaterThan(0);

    stepMany(state, 6_000);

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount).toBeGreaterThan(0);
    // Two shelves, two names. The seeds did not merge into the produce and did not evict it.
    expect(dock.seedShelfItem).toBe(ItemId.PotatoSeed);
    expect(dock.seedShelfCount).toBeGreaterThan(0);
    // And they are the dock's, not the player's: a robot's seed takes a belt or a hand to move.
    expect(state.stats.itemsHarvestedByHand).toBe(0);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
  });

  it('lets a FILTERED arm take seeds, while an unfiltered one still empties the produce first', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 6_000);
    expect(dock.seedShelfCount).toBeGreaterThan(0);
    const produceBefore = dock.cargoCount;
    const seedsBefore = dock.seedShelfCount;

    // An arm that names the seed takes seeds and leaves the potatoes where they are.
    const belt = spawnBelt(state, BeltTier.Basic, 3, 1, Direction.East, 2)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, ItemId.PotatoSeed);
    stepMany(state, 300);

    expect(dock.seedShelfCount).toBeLessThan(seedsBefore);
    expect(belt.items.some((entry) => entry.item === ItemId.PotatoSeed)).toBe(true);
    expect(belt.items.every((entry) => entry.item === ItemId.PotatoSeed)).toBe(true);

    // The potatoes were not touched: the arm named a seed and took seeds.
    expect(dock.cargoCount).toBe(produceBefore);
  });

  it('keeps the UNFILTERED default produce-first, so an old belt does nothing new', () => {
    // What keeps a belt somebody ran from a dock to a cellar last week doing exactly what it
    // did before this item landed: an arm with no filter empties the produce shelf and reaches
    // the seeds only when there is no produce left.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 6_000);
    expect(dock.cargoCount).toBeGreaterThan(0);
    expect(dock.seedShelfCount).toBeGreaterThan(0);
    const seedsBefore = dock.seedShelfCount;

    // A long belt, so the arm never stalls against a backed-up head and the test measures the
    // arm's choice rather than the belt's length.
    const belt = spawnBelt(state, BeltTier.Basic, 3, 1, Direction.East, 12)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, 0);
    stepMany(state, 300);

    expect(belt.items.length).toBeGreaterThan(0);
    expect(
      belt.items.every((entry) => entry.item === ItemId.RussetPotato),
      'the unfiltered arm reached past the produce for seeds',
    ).toBe(true);
    expect(dock.seedShelfCount).toBe(seedsBefore);
  });

  it('STALLS RATHER THAN DELETING: a full pocket and a full shelf leave the crop standing', () => {
    // The house rule, on the one path where a seed could plausibly go missing. A bot that
    // pulled a tile it had nowhere to put the seed of would have destroyed something the
    // player owned, silently, forever — so it does not pull the tile at all.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    const planted = ripenZone(state, zoneId);
    const bot = state.bots[0]!;

    // Both places a seed could go, filled to the brim before anything moves.
    bot.seedItem = ItemId.PotatoSeed;
    bot.seedCount = BOT_SEED_POCKET_CAPACITY;
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = HARVESTER_SEED_SHELF_CAPACITY;

    stepMany(state, 6_000);

    let stillReady = 0;
    for (const tile of state.field) {
      if (tile.zone === zoneId && tile.crop !== CropId.None && tile.growth >= tile.growthTarget) {
        stillReady += 1;
      }
    }
    // Every tile is exactly where it was: nothing pulled, nothing lost, and a robot standing
    // at a full shed where the player can see it.
    expect(stillReady).toBe(planted);
    expect(dock.cargoCount).toBe(0);
    // Not one seed evaporated on the way to the jam.
    expect(bot.seedCount + dock.seedShelfCount).toBe(
      BOT_SEED_POCKET_CAPACITY + HARVESTER_SEED_SHELF_CAPACITY,
    );
  });

  it('keeps working when only the SEED shelf is full — one jam must not stop the other shelf', () => {
    // The reason the dock unloads its two shelves independently. A seed shelf nobody drains is
    // a small mistake; a seed shelf that also stopped the potatoes would turn it into a total
    // halt and point the player at the wrong belt.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = HARVESTER_SEED_SHELF_CAPACITY;

    stepMany(state, 6_000);
    // The first armful still landed: produce is on its shelf even though the seeds are jammed.
    expect(dock.cargoCount).toBeGreaterThan(0);
    expect(dock.seedShelfCount).toBe(HARVESTER_SEED_SHELF_CAPACITY);
  });

  it('hand-unloads BOTH shelves with one verb, because the player empties a dock, not a slot', () => {
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 6_000);
    const potatoes = dock.cargoCount;
    const seeds = dock.seedShelfCount;
    expect(potatoes).toBeGreaterThan(0);
    expect(seeds).toBeGreaterThan(0);

    const potatoesBefore = itemCount(state, ItemId.RussetPotato);
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);
    state.player.xSub = dock.tileX * 256 + 128;
    state.player.ySub = dock.tileY * 256 + 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'UnloadMachine', machineId: dock.id, count: potatoes + seeds }],
    });

    // Both shelves came off in one armful, each under its own name.
    expect(itemCount(state, ItemId.RussetPotato)).toBe(potatoesBefore + potatoes);
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seedsBefore + seeds);
    // NOT ASSERTED AS ZERO, and the reason is the stall resolving in front of you: commands run
    // before machines within a tick, so a bot that had been standing at a full shed unloads its
    // held armful into the space the player just made, on the very same tick. What the shelves
    // hold afterwards is whatever the robot was carrying, which is less than it was.
    expect(dock.cargoCount).toBeLessThan(potatoes);
    expect(dock.seedShelfCount).toBeLessThan(seeds);
  });

  it('CLOSES THE LOOP HANDS-FREE: harvester seeds ride a belt into a planter’s hopper', () => {
    // The acceptance criterion, and the reason the seeds land on a shelf instead of teleporting
    // into the planter: this is PLAYER-BUILT logistics. Nothing routes seeds across the map —
    // somebody ran a belt.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 6_000);
    expect(dock.seedShelfCount).toBeGreaterThan(0);

    // A planter dock, bound to the same potato zone, with an empty hopper.
    const planter = spawnMachine(state, MachineKind.PlanterDock, 6, 1)!;
    planter.boundZone = zoneId;
    spawnBot(state, BotKind.Planter, planter);
    expect(planter.cargoCount).toBe(0);

    // Dock ──arm(seed-filtered)──▶ belt ──arm──▶ planter hopper.
    spawnBelt(state, BeltTier.Basic, 3, 1, Direction.East, 2);
    spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, ItemId.PotatoSeed);
    spawnGrabber(state, GrabberTier.Mk1, 5, 1, Direction.East, ItemId.PotatoSeed);

    const touchesBefore = { ...state.stats.touches };
    // Watched rather than sampled at the end, because the loop CONSUMES its own evidence: the
    // planter bot takes a seed straight back out of the hopper and puts it in the ground, so a
    // reading taken afterwards can legitimately be zero on both counts.
    let hopperEverHeldSeed = false;
    for (let i = 0; i < 4_000; i++) {
      step(state, { tick: state.tick, commands: [] });
      if (planter.cargoItem === ItemId.PotatoSeed && planter.cargoCount > 0) {
        hopperEverHeldSeed = true;
      }
    }
    expect(hopperEverHeldSeed, 'no seed ever reached the hopper').toBe(true);

    // And the loop closed: ground the harvester cleared is planted again, out of seeds the
    // harvester itself brought home, with nothing but belts in between.
    const replanted = state.field.filter(
      (tile) => tile.zone === zoneId && tile.crop === CropId.RussetPotato,
    ).length;
    expect(replanted, 'the seeds never went back into the ground').toBeGreaterThan(0);

    // Not one hand anywhere in the loop.
    expect(state.stats.touches).toEqual(touchesBefore);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
  });
});

// --- the dock's two doors, looked at before they are opened (item 085) ----------------

describe('an arm at a dock looks before it grabs (item 085)', () => {
  it('THE TRAP ITEM 088 NAMED: a seed arm pointed at a sell bin never closes its claw', () => {
    // Item 088's own note flagged this as the interesting failure: an arm filtered to seeds,
    // taking off a harvester dock's SEED shelf, pointed at a sell bin — which refuses seeds on
    // plan §4's anti-softlock floor. Under the old rule it took a seed, was refused, and stood
    // there holding it forever. It is now unbuildable: the bin's predicate answers no while the
    // seed is still on the shelf.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 6_000);
    expect(dock.seedShelfCount).toBeGreaterThan(0);

    // The dock covers (0,0)-(1,1), so an arm at (2,1) reaches back into it and drops at (3,1).
    spawnMachine(state, MachineKind.SellBin, 3, 1);
    const arm = spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, ItemId.PotatoSeed)!;
    const seedsBefore = dock.seedShelfCount;
    const moneyBefore = state.moneyCents;

    stepMany(state, 1_000);

    expect(arm.held).toBe(0);
    expect(arm.opCount).toBe(0);
    expect(dock.seedShelfCount).toBe(seedsBefore);
    expect(state.moneyCents).toBe(moneyBefore);
    expect(state.stats.itemsSold).toBe(0);

    // CONTROL, so the assertions above are not a rig that was never going to move: the same arm
    // over the same dock into the same bin, filtered to the potatoes instead, sells at once.
    arm.filter = ItemId.RussetPotato;
    stepMany(state, 200);
    expect(state.stats.itemsSold).toBeGreaterThan(0);
    expect(state.moneyCents).toBeGreaterThan(moneyBefore);
  });

  it('leaves the seeds alone when an unfiltered arm runs out of produce a cellar will take', () => {
    // THE OTHER HALF OF THE SAME TRAP, and the one that needed the shelf resolution and the
    // door predicate to agree. An unfiltered arm empties the produce shelf first (item 088's
    // default) and only then considers seeds — so the moment the potatoes run out it is an arm
    // about to offer a seed to a machine that has no line for one. It must stop, not jam.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 6_000);
    expect(dock.cargoCount).toBeGreaterThan(0);
    expect(dock.seedShelfCount).toBeGreaterThan(0);

    // A Chip Kitchen wants potatoes and has no line for a seed.
    spawnMachine(state, MachineKind.ChipKitchen, 3, 1);
    const arm = spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, 0)!;
    const seedsBefore = dock.seedShelfCount;

    stepMany(state, 4_000);

    // The potatoes went where they were wanted; the seeds are untouched and unheld.
    expect(arm.opCount).toBeGreaterThan(0);
    expect(arm.held).toBe(0);
    expect(dock.seedShelfCount).toBe(seedsBefore);
  });

  it("refuses the wrong seed at a planter's hopper without lifting it off the belt", () => {
    // `dockCanAcceptSeed` is the predicate; the arm reads it a swing early. A cane seed aimed at
    // a potato zone's planter used to end up in a claw that could never open.
    const { state, dock } = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    const belt = spawnBelt(state, BeltTier.Basic, 2, 3, Direction.East, 1)!;
    const arm = spawnGrabber(state, GrabberTier.Mk1, 3, 3, Direction.East, 0)!;
    // The dock sits at (0,0) and is two tiles wide, so the arm's drop tile is its east edge.
    dock.tileX = 4;
    dock.tileY = 3;
    belt.items.push({ dist: 0, item: ItemId.CaneSeed });

    stepMany(state, 500);

    expect(arm.held).toBe(0);
    expect(belt.items.map((entry) => entry.item)).toEqual([ItemId.CaneSeed]);
    expect(dock.cargoCount).toBe(0);

    // CONTROL: the seed this zone actually asked for rides the same belt through the same arm
    // into the same hopper. The refusal above is about the seed, not about the plumbing.
    belt.items.length = 0;
    belt.items.push({ dist: 0, item: ItemId.PotatoSeed });
    // Watched rather than read at the end: the planter's own bot eats out of that hopper, so a
    // final count of zero would mean "it worked" and "it never arrived" at the same time.
    let hopperEverHeldSeed = false;
    for (let i = 0; i < 500; i++) {
      step(state, { tick: state.tick, commands: [] });
      if (dock.cargoItem === ItemId.PotatoSeed && dock.cargoCount > 0) hopperEverHeldSeed = true;
    }
    expect(hopperEverHeldSeed, 'the seed the zone asked for never reached the hopper').toBe(true);
    expect(belt.items).toHaveLength(0);
  });
});

function dockAccept(state: WorldState, dock: Machine, item: number): boolean {
  return dockAcceptSeed(state, dock, item);
}

function addSeeds(state: WorldState, count: number): void {
  addItem(state, ItemId.PotatoSeed, count);
}
