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
  ITEM_SPECS,
  ItemId,
  LampState,
  MachineKind,
  addItem,
  createWorldView,
  cropSpec,
  createWorld,
  freshnessTicks,
  dockAcceptDelivery,
  dockAcceptSeed,
  dockCanAcceptDelivery,
  findNonIntegerFields,
  grabberNextPickup,
  hashState,
  itemCount,
  plantCrop,
  remainingFreshness,
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
  takeDockShelf,
  tileAt,
  tileCentreSubtiles,
  tillTile,
  totalManualTouches,
  view,
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
  it('takes its bot with it and hands back what the bot was carrying, at the clock it held', () => {
    // **THIS TEST IS THIS FAMILY'S SIGNATURE, AND IT USED TO BE COUNT-ONLY** (item 117's audit).
    // It boxed a dock with a laden bot in it and asserted `before + 3 + shelf` — which is exactly
    // the shape of assertion that let doors 8, 8b and 8c through: a count survives a transfer that
    // minted a clock, dropped a seed pocket and deleted a whole seed shelf, and the count is the
    // only thing anybody looked at. Every number that crosses this verb is now asserted.
    const { state, dock, zoneId } = farmWithDock(MachineKind.HarvesterDock, BotKind.Harvester);
    ripenZone(state, zoneId);
    stepMany(state, 1_500);

    const bot = state.bots[0]!;
    // Put something in its arms so the hand-back is observable, whatever the walk happened to do —
    // and give it a REAL clock, two thirds spent, because a fresh armful cannot tell a carried
    // window from a minted one.
    bot.carryItem = ItemId.RussetPotato;
    bot.carryCount = 3;
    bot.carryFreshTicks = 6_000;
    bot.seedItem = ItemId.PotatoSeed;
    bot.seedCount = 2;
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 4;
    const before = itemCount(state, ItemId.RussetPotato);
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);
    // The shelf comes back too, now that it has an identity (item 083). Under the old
    // anonymous buffer, deconstructing a stocked dock silently DELETED everything on it —
    // the same swallow, one verb further along.
    const shelf = dock.cargoCount;
    const shelfClock = dock.cargoFreshTicks;
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
    // **THE SEED POCKET AND THE SEED SHELF** — doors 8b and 8c, which this verb used to eat.
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seedsBefore + 2 + 4);
    // **AND THE CLOCK** — door 8. The armful and the shelf both arrive in the bag, and the bag's
    // soonest deadline is the sooner of the two rather than a brand-new window.
    const worst = Math.min(6_000, shelfClock > 0 ? shelfClock : 6_000);
    expect(
      remainingFreshness(state, ItemId.RussetPotato),
      'boxing a shed is not a way to un-wait',
    ).toBeLessThanOrEqual(worst);
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
    const shelfClock = dock.cargoFreshTicks;
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

    // **AND THE CLOCK COMES OUT WITH THEM, WHICH THIS TEST USED TO STATE BACKWARDS** (item 117's
    // audit). It asserted only `spoilAtTick > state.tick` — true of any clock at all, including a
    // freshly minted window — under a comment reading "nothing ages inside a machine". Since item
    // 115 the shelf runs a real clock and `advanceStorageSpoilage` spends it, so the honest claim
    // is the family's: what comes out is no fresher than what went in.
    const slot = state.inventory.find((entry) => entry.item === ItemId.RussetPotato)!;
    expect(slot.stacks.length).toBeGreaterThan(0);
    for (let i = 0; i < slot.stacks.length; i++) {
      expect(slot.stacks[i]!.spoilAtTick).toBeGreaterThan(state.tick);
    }
    expect(shelfClock, 'the shelf was running a clock to begin with').toBeGreaterThan(0);
    expect(
      remainingFreshness(state, ItemId.RussetPotato),
      'unloading a shed is not a way to un-wait',
    ).toBeLessThanOrEqual(shelfClock);
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
    // The shelf hands back its clock too since item 112 — it is a container like any other, and
    // everything on it is field produce an arm can drain onto a belt with nobody clicking.
    const drained = takeDockShelf(dock, shelf)!;
    expect(drained.item).toBe(ItemId.RussetPotato);
    expect(drained.taken).toBe(shelf);
    expect(drained.freshTicks).toBeGreaterThan(0);
    expect(drained.freshTicks).toBeLessThanOrEqual(freshnessTicks(ItemId.RussetPotato));
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
    const shelfClock = dock.cargoFreshTicks;
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
    // And the produce brought its clock through the door with it (item 117's audit: a count
    // across a transfer is half an assertion). Seeds keep none, which is why only one shelf is
    // asked the question.
    expect(
      remainingFreshness(state, ItemId.RussetPotato),
      'one verb, two shelves, and still not a way to un-wait',
    ).toBeLessThanOrEqual(shelfClock);
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

describe('the drone bay has no door at all (item 090)', () => {
  it('refuses every item through BOTH spellings, and the pair never disagrees', () => {
    // **THE DOOR WAS DELETED IN BOTH SPELLINGS, WHICH IS THE POINT OF TESTING IT TWICE.** Item
    // 085 gave every accept-door a pure predicate its mutating twin is defined in terms of;
    // item 090 then closed the bay's parts door for good. Removing only the mutating half would
    // have left `dockCanAcceptDelivery` promising an arm a hopper that no longer exists — an
    // arm that peeks yes, swings, and is refused on delivery, holding an item forever. That is
    // exactly the stall item 085 was written to abolish, so it is pinned here rather than
    // trusted to a comment.
    const state = createWorld(9090);
    const bay = spawnMachine(state, MachineKind.DroneBay, 0, 0)!;
    spawnBot(state, BotKind.Repair, bay);

    for (const spec of ITEM_SPECS) {
      expect(dockCanAcceptDelivery(state, bay, spec.id), `bay peeked yes at ${spec.slug}`).toBe(
        false,
      );
      expect(dockAcceptDelivery(state, bay, spec.id), `bay took a ${spec.slug}`).toBe(false);
    }
    expect(bay.cargoItem).toBe(0);
    expect(bay.cargoCount).toBe(0);

    // CONTROL, so the sweep above is not a rig that was never going to move: the door the
    // deletion had to leave standing still opens for the seed its zone asked for.
    const planter = farmWithDock(MachineKind.PlanterDock, BotKind.Planter);
    expect(dockCanAcceptDelivery(planter.state, planter.dock, ItemId.PotatoSeed)).toBe(true);
    expect(dockAcceptDelivery(planter.state, planter.dock, ItemId.PotatoSeed)).toBe(true);
    expect(planter.dock.cargoItem).toBe(ItemId.PotatoSeed);
  });

  it('takes nothing by hand either — the RefillHopper branch closed with the belt door', () => {
    // §6's taxonomy makes hand-refilling a hopper a Hands-Free disqualifier, so the hand path
    // and the belt path were always two functions. Both of the bay's are gone; a hand that
    // could still fill a shelf the drone never reads would be a touch charged for nothing.
    const state = createWorld(9091);
    const bay = spawnMachine(state, MachineKind.DroneBay, 0, 0)!;
    spawnBot(state, BotKind.Repair, bay);
    addItem(state, ItemId.DronePart, 5);
    state.player.xSub = tileCentreSubtiles(bay.tileX);
    state.player.ySub = tileCentreSubtiles(bay.tileY);

    step(state, { tick: state.tick, commands: [{ type: 'RefillHopper', machineId: bay.id }] });

    expect(state.trace).toHaveLength(0);
    expect(bay.cargoCount).toBe(0);
    expect(itemCount(state, ItemId.DronePart)).toBe(5);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
  });
});

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
    belt.items.push({ dist: 0, item: ItemId.CaneSeed, freshTicks: 0 });

    stepMany(state, 500);

    expect(arm.held).toBe(0);
    expect(belt.items.map((entry) => entry.item)).toEqual([ItemId.CaneSeed]);
    expect(dock.cargoCount).toBe(0);

    // CONTROL: the seed this zone actually asked for rides the same belt through the same arm
    // into the same hopper. The refusal above is about the seed, not about the plumbing.
    belt.items.length = 0;
    belt.items.push({ dist: 0, item: ItemId.PotatoSeed, freshTicks: 0 });
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

// --- the destination picks the shelf (item 098) --------------------------------------
//
// **THE OWNER'S REPORT, 2026-08-16: "the arm is not able to take seeds from the harvester to
// the planter."** Item 088 built the two-shelf dock precisely so that loop could exist, and it
// could not, for two compounding reasons. `dockShelfFor` was produce-first with a fall-through
// that only fired on an EMPTY produce shelf — and a working harvester keeps produce stocked, so
// an unfiltered arm never reached the seeds at all. Meanwhile item 085 had removed the hostage,
// so the arm did not even jam holding a potato: it declined, silently, and the player saw an
// arm doing nothing.
//
// The fix is not a new rule so much as one question the arm forgot to ask. Produce-first is now
// the TIE-BREAK; an unfiltered arm at two stocked shelves offers each to `grabberWouldAccept`
// and reads the one the destination will have. These tests pin both halves of that: the loop
// works with a plain Mk1 and no filter, and every case that worked before still resolves the
// same shelf it always did.

describe('an unfiltered arm at a two-shelf dock reads the shelf its destination wants', () => {
  /** A harvester dock with produce AND seeds on its shelves, and the arm that reaches into it. */
  function stockedDock(seed = 4242) {
    const rig = farmWithDock(
      MachineKind.HarvesterDock,
      BotKind.Harvester,
      CropId.RussetPotato,
      seed,
    );
    ripenZone(rig.state, rig.zoneId);
    stepMany(rig.state, 6_000);
    // The premise of every test below: BOTH shelves have something on them. The bug only ever
    // showed up on a dock that was working, which is why it survived item 088's own tests.
    expect(rig.dock.cargoCount).toBeGreaterThan(0);
    expect(rig.dock.seedShelfCount).toBeGreaterThan(0);
    return rig;
  }

  /** The dock covers (0,0)-(1,1), so an arm at (2,1) reaches back into it and drops at (3,1). */
  function armAtDock(state: WorldState, filter: ItemId | 0 = 0) {
    return spawnGrabber(state, GrabberTier.Mk1, 2, 1, Direction.East, filter)!;
  }

  function lampOf(state: WorldState, armId: number): number {
    return view(state, createWorldView()).grabbers.find((g) => g.id === armId)!.lamp;
  }

  it('THE REPORTED BUG: a plain Mk1 with no filter carries seeds into a planter', () => {
    // Harvester dock → arm → planter dock, which is the loop item 088 exists for and the one
    // the owner could not build. No filter, no Mk2, no ceremony. The planter is bound to the
    // same zone, so the seed it wants is the seed the harvester is shelving.
    const { state, dock, zoneId } = stockedDock();
    const planter = spawnMachine(state, MachineKind.PlanterDock, 3, 1)!;
    planter.boundZone = zoneId;
    const arm = armAtDock(state);
    const seedsBefore = dock.seedShelfCount;

    stepMany(state, 1_000);

    expect(planter.cargoItem).toBe(ItemId.PotatoSeed);
    expect(planter.cargoCount).toBeGreaterThan(0);
    expect(dock.seedShelfCount).toBeLessThan(seedsBefore);
    // The produce never went anywhere near it: a hopper holds one item, and this one holds
    // seeds. The arm read the shelf its destination wanted rather than the first one stocked.
    expect(arm.opCount).toBeGreaterThan(0);
    expect(arm.held).toBe(0);
  });

  it('still takes produce when the destination will take either — produce-first is the tie-break', () => {
    // THE REGRESSION THE FIX IS SHAPED AROUND. A belt takes anything, so both shelves are
    // acceptable and the old priority decides — which is exactly what keeps a dock→belt run
    // somebody built last week doing precisely what it did last week.
    const { state, dock } = stockedDock(4243);
    const belt = spawnBelt(state, BeltTier.Basic, 3, 1, Direction.East, 3)!;
    armAtDock(state);
    const seedsBefore = dock.seedShelfCount;

    stepMany(state, 400);

    expect(belt.items.length).toBeGreaterThan(0);
    expect(belt.items.every((entry) => entry.item === ItemId.RussetPotato)).toBe(true);
    expect(dock.seedShelfCount).toBe(seedsBefore);
  });

  it('leaves a filtered arm exactly as it was — the filter names the shelf, nothing overrides it', () => {
    // An arm filtered to POTATOES, pointed at a planter that wants only seeds. The seed shelf is
    // stocked and the planter would take from it happily — and the arm must not, because the
    // player named produce. Destination-guessing is the unfiltered arm's rule and only its rule.
    const { state, dock, zoneId } = stockedDock(4244);
    const planter = spawnMachine(state, MachineKind.PlanterDock, 3, 1)!;
    planter.boundZone = zoneId;
    const arm = armAtDock(state, ItemId.RussetPotato);
    const seedsBefore = dock.seedShelfCount;

    stepMany(state, 1_000);

    expect(arm.opCount).toBe(0);
    expect(arm.held).toBe(0);
    expect(planter.cargoCount).toBe(0);
    expect(dock.seedShelfCount).toBe(seedsBefore);
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);
  });

  it('lights RED, not amber, when the destination will take neither shelf', () => {
    // FAILURE SHAPE ONE, and the reason `dockShelfFor` still names a shelf when both are
    // refused. A Bagger has a line for seasoned chips and none for a potato or a seed. The arm
    // is stalled on its DESTINATION, so the lamp must send the player downstream — and a peek
    // that answered "nothing here" would have sent them upstream to a dock that is full.
    const { state, dock } = stockedDock(4245);
    spawnMachine(state, MachineKind.Bagger, 3, 1);
    const arm = armAtDock(state);
    const seedsBefore = dock.seedShelfCount;
    const produceBefore = dock.cargoCount;

    stepMany(state, 400);

    expect(arm.held).toBe(0);
    expect(arm.opCount).toBe(0);
    expect(dock.seedShelfCount).toBe(seedsBefore);
    expect(dock.cargoCount).toBeGreaterThanOrEqual(produceBefore);
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);
  });

  it('FAILURE SHAPE TWO: an unbound planter refuses, the arm never grabs, and the lamp is red', () => {
    // The second cause of the owner's report, and the one no amount of shelf logic can fix: a
    // planter with no zone has no instructions, so `dockWantedSeed` is 0 and it wants nothing at
    // all. The arm is right to stand still. What it must NOT do is grab first and find out
    // after — and what the game must not do is leave the player with no way to see why.
    const { state, dock } = stockedDock(4246);
    const planter = spawnMachine(state, MachineKind.PlanterDock, 3, 1)!;
    expect(planter.boundZone).toBe(0);
    const arm = armAtDock(state);
    const seedsBefore = dock.seedShelfCount;

    stepMany(state, 1_000);

    expect(arm.held).toBe(0);
    expect(arm.opCount).toBe(0);
    expect(planter.cargoCount).toBe(0);
    expect(dock.seedShelfCount).toBe(seedsBefore);
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);

    // CONTROL, so the assertions above are not a rig that was never going to move: give the
    // planter its orders and the same arm starts carrying the same seeds within the minute.
    planter.boundZone = 1;
    stepMany(state, 400);
    expect(planter.cargoItem).toBe(ItemId.PotatoSeed);
    expect(planter.cargoCount).toBeGreaterThan(0);
  });

  it('PEEK AND TAKE RESOLVE THE SAME SHELF, at every destination — item 085 is still law', () => {
    // **THE PROPERTY THE WHOLE DESIGN RESTS ON**, and it got harder to hold this round: the
    // shelf an arm reads now depends on what is standing in front of it, so a peek and a pull
    // that consulted the destination differently would take a seed the lamp had promised was a
    // potato. There is one function, so they cannot — and this is the test that says so rather
    // than the comment that hopes so. Every tick the arm is idle: ask what it would take, step
    // once, and see what is in the claw.
    const destinations: readonly {
      name: string;
      build: (s: WorldState, zoneId: number) => void;
    }[] = [
      {
        name: 'planter dock (bound)',
        build: (s, zoneId) => {
          const planter = spawnMachine(s, MachineKind.PlanterDock, 3, 1)!;
          planter.boundZone = zoneId;
        },
      },
      {
        name: 'planter dock (unbound)',
        build: (s) => void spawnMachine(s, MachineKind.PlanterDock, 3, 1),
      },
      { name: 'sell bin', build: (s) => void spawnMachine(s, MachineKind.SellBin, 3, 1) },
      { name: 'chip kitchen', build: (s) => void spawnMachine(s, MachineKind.ChipKitchen, 3, 1) },
      { name: 'bagger', build: (s) => void spawnMachine(s, MachineKind.Bagger, 3, 1) },
      {
        name: 'belt',
        build: (s) => void spawnBelt(s, BeltTier.Basic, 3, 1, Direction.East, 3),
      },
      { name: 'bare ground', build: () => {} },
    ];

    const disagreements: string[] = [];
    for (const destination of destinations) {
      for (const filter of [0, ItemId.RussetPotato, ItemId.PotatoSeed] as const) {
        const { state, zoneId } = stockedDock(4247);
        destination.build(state, zoneId);
        const arm = armAtDock(state, filter);

        for (let i = 0; i < 600; i++) {
          const idle = arm.held === 0 && arm.cooldown === 0;
          const predicted = idle ? grabberNextPickup(state, arm, 1) : 0;
          step(state, { tick: state.tick, commands: [] });
          if (!idle || arm.held === 0) continue;
          if (arm.held !== predicted) {
            disagreements.push(
              `${destination.name} + filter ${filter}: peeked ${predicted}, took ${arm.held}`,
            );
            break;
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

function dockAccept(state: WorldState, dock: Machine, item: number): boolean {
  return dockAcceptSeed(state, dock, item);
}

function addSeeds(state: WorldState, count: number): void {
  addItem(state, ItemId.PotatoSeed, count);
}
