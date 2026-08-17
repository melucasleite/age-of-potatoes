// The factory half: the production line, belts and arms, zones, withering, and the tree.
//
// These are cheap structural checks, in the spirit of the repo's deliberately light
// verification bar. Each one pins a RULING from the design document rather than an
// implementation detail — the Fryer's 2:1 ratio, Day-Old at exactly half, "nothing ever
// vanishes", "a drag is one command", and the anti-double-dip split between tech nodes and
// upgrade dials. If one of these goes red, a decision was reversed, not a function renamed.

import { describe, expect, it } from 'vitest';

import { runClockCrossings } from './clock-crossings';

import {
  type BuildRefusal as BuildRefusalCode,
  type Command,
  type LiquidPortSpec,
  type Machine,
  type WorldState,
  BELT_ITEM_SPACING_SUBTILES,
  BOXED_MACHINE_ROWS,
  BeltTier,
  BuildRefusal,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CHILI_PREMIUM_CENTS,
  CROP_SPECS,
  COMPOST_AFTER_TICKS,
  CropId,
  Direction,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  GrabberTier,
  ITEM_SPECS,
  IntentAction,
  ItemId,
  LampState,
  LiquidId,
  GOLD_POTATO_PREMIUM_CENTS,
  MACHINE_SPECS,
  MachineKind,
  SWEETCORN_PREMIUM_CENTS,
  PIPE_MAX_PATH_TILES,
  PortFlow,
  OVERCOOK_BLOCKED_TICKS,
  REPAIR_PER_TOUCH,
  SUBTILE,
  TECH_NODES,
  TechId,
  UPGRADE_MAX_LEVEL,
  UpgradeDial,
  WILT_GRACE_TICKS,
  WILT_WINDOW_TICKS,
  WiltStage,
  addBoxedMachine,
  addItem,
  beltInsert,
  boxedItemForMachine,
  computeNetWorthCents,
  createWorld,
  divFloor,
  createWorldView,
  dayOldPriceCents,
  effectiveInputCapacity,
  machineHoppers,
  machineRecipes,
  effectiveWastePeriod,
  effectiveWear,
  effectiveWorkRate,
  grabberWouldAccept,
  TICKS_PER_IN_GAME_DAY,
  hashState,
  acceptsUpgrades,
  isBoxedMachineItem,
  isSellable,
  itemCount,
  itemSpec,
  machineKindForBoxedItem,
  liquidPlacementRefusal,
  listPriceCents,
  machineSpec,
  nextOutputItem,
  pipePathRefusal,
  rebuildNetworks,
  removeItem,
  rusticStylePriceCents,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  spawnPipe,
  spawnReservoir,
  step,
  stepMany,
  takeOneOutput,
  tileAt,
  upgradeCostCents,
  view,
  wiltStageForAge,
} from '../src/index';
import { type GoldenFixture, loadFixture, replay } from './goldens';

function run(state: WorldState, commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

/** Put the player on a tile so hand verbs are in reach. Position is not a command. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

function ticksPerOperation(kind: MachineKind): number {
  const spec = machineSpec(kind)!;
  return spec.workPerOperation / spec.workRatePerTick;
}

// --- the production line ------------------------------------------------------------

describe('the chip line', () => {
  it('chains potato → washed → slices → plain → seasoned → bagged', () => {
    const chain: [MachineKind, ItemId, ItemId][] = [
      [MachineKind.Washer, ItemId.RussetPotato, ItemId.WashedPotato],
      [MachineKind.Slicer, ItemId.WashedPotato, ItemId.PotatoSlices],
      [MachineKind.Fryer, ItemId.PotatoSlices, ItemId.PlainChips],
      [MachineKind.Seasoner, ItemId.PlainChips, ItemId.SeasonedChips],
      [MachineKind.Bagger, ItemId.SeasonedChips, ItemId.BaggedChips],
    ];

    for (const [kind, input, output] of chain) {
      const spec = machineSpec(kind)!;
      expect(spec.inputs).toEqual([{ item: input, count: 1 }]);
      expect(spec.outputItem).toBe(output);
      // Plan §4: each processing step adds more absolute value than the last.
      expect(listPriceCents(output)).toBeGreaterThan(listPriceCents(input));
    }
  });

  it('keeps the Fryer at half the throughput of its neighbours', () => {
    // Plan §5's canonical 1:1:2:1:1. "Build a second Fryer" is the first ratio lesson in the
    // game and it only exists if this number stays exactly double. Do not "optimise" it.
    const fryer = ticksPerOperation(MachineKind.Fryer);
    for (const kind of [
      MachineKind.Washer,
      MachineKind.Slicer,
      MachineKind.Seasoner,
      MachineKind.Bagger,
    ]) {
      expect(fryer).toBe(ticksPerOperation(kind) * 2);
    }
  });

  it('leaves the monolithic Chip Kitchen buildable with no research at all', () => {
    // Every v0.1 save has one, and the v0.1 loop has to keep working untouched.
    const spec = machineSpec(MachineKind.ChipKitchen)!;
    expect(spec.requiresTech).toBeNull();
    expect(spec.inputs).toEqual([{ item: ItemId.RussetPotato, count: 1 }]);
    expect(spec.outputItem).toBe(ItemId.BaggedChips);
  });

  it('stops a converter dead when its output buffer is full rather than eating inputs', () => {
    // Demand-pull (plan §7 ruling 6): an idle machine teaches the ratio, a compost pile does
    // not. A blocked Slicer must not consume one more washed potato.
    const state = createWorld(3);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    const spec = machineSpec(MachineKind.Washer)!;
    washer.inputCounts[0] = 5;
    washer.outputCount = spec.outputCapacity;

    stepMany(state, 200);
    expect(washer.inputCounts[0]!).toBe(5);
    expect(washer.outputCount).toBe(spec.outputCapacity);
  });
});

// --- the flavour tier (item 111) ------------------------------------------------------

/** Run a machine until it has finished one operation, or give up. Returns what it made. */
function runOneOperation(state: WorldState, machine: Machine): ItemId | 0 {
  for (let i = 0; i < 400; i++) {
    stepMany(state, 1);
    if (machine.outputCount > 0) return machine.outputItem;
  }
  return 0;
}

describe('the flavour tier', () => {
  it('gives corn, chili and the gold potato a recipe that consumes them', () => {
    // THE WHOLE POINT OF ITEM 111, pinned as a rule rather than as three separate examples.
    // Before it, these three appeared nowhere in `src/` outside their own data rows: they grew,
    // they sold, and nothing in the game wanted them. If this goes red, a crop went back to
    // being decoration.
    for (const crop of [ItemId.Corn, ItemId.ChiliPepper, ItemId.GoldPotato]) {
      const eaten = MACHINE_SPECS.some((spec) =>
        machineRecipes(spec).some((recipe) => recipe.consumes.some((line) => line.item === crop)),
      );
      expect(eaten).toBe(true);
    }
  });

  it('leaves the plain line making plain chips, fed nothing but chips', () => {
    // The non-negotiable: plain chips work end to end exactly as before. A Seasoner with three
    // empty hoppers it never asked for must still reach the plain recipe every time.
    const state = createWorld(11);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    seasoner.inputCounts[0] = 4;

    expect(runOneOperation(state, seasoner)).toBe(ItemId.SeasonedChips);
  });

  it('makes chili chips when a pepper is in the hopper, and falls back to salt when it is not', () => {
    const state = createWorld(12);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    const pepper = machineHoppers(machineSpec(MachineKind.Seasoner)!).findIndex(
      (line) => line.item === ItemId.ChiliPepper,
    );
    seasoner.inputCounts[0] = 2;
    seasoner.inputCounts[pepper] = 1;

    expect(runOneOperation(state, seasoner)).toBe(ItemId.ChiliChips);
    expect(seasoner.inputCounts[pepper]).toBe(0);

    // One pepper, one chip. The second chip has nothing to be seasoned with, so the line does
    // not stop — it goes back to salt. Drain the basket first, because a basket holds one
    // product at a time.
    seasoner.outputCount = 0;
    seasoner.outputItem = 0;
    expect(runOneOperation(state, seasoner)).toBe(ItemId.SeasonedChips);
  });

  it('turns corn into sweetcorn chips', () => {
    const state = createWorld(13);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    const corn = machineHoppers(machineSpec(MachineKind.Seasoner)!).findIndex(
      (line) => line.item === ItemId.Corn,
    );
    seasoner.inputCounts[0] = 1;
    seasoner.inputCounts[corn] = 1;

    expect(runOneOperation(state, seasoner)).toBe(ItemId.SweetcornChips);
  });

  it('will not mix two products in one basket', () => {
    // `Machine.outputItem`'s rule, and the reason the field exists at all: a Seasoner holding
    // plain chips finishes them before it starts a chili batch. Without this the basket would
    // be a count with no name and a grabber could not say what it was pulling.
    const state = createWorld(14);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    const pepper = machineHoppers(machineSpec(MachineKind.Seasoner)!).findIndex(
      (line) => line.item === ItemId.ChiliPepper,
    );
    seasoner.outputCount = 1;
    seasoner.outputItem = ItemId.SeasonedChips;
    seasoner.inputCounts[0] = 4;
    seasoner.inputCounts[pepper] = 4;

    stepMany(state, 120);
    // It kept working — it just kept making the thing already in the basket, and did not touch
    // a pepper to do it.
    expect(seasoner.outputItem).toBe(ItemId.SeasonedChips);
    expect(seasoner.outputCount).toBeGreaterThan(1);
    expect(seasoner.inputCounts[pepper]).toBe(4);
  });

  it('runs a gold potato down the same five machines to a premium bag', () => {
    // The alternate BASE, which is the half of the fork that could not be a seasoning: a gold
    // potato is a potato, and the only honest thing to do with it is wash it and fry it.
    const state = createWorld(15);
    const chain: [MachineKind, ItemId, ItemId][] = [
      [MachineKind.Washer, ItemId.GoldPotato, ItemId.WashedGoldPotato],
      [MachineKind.Slicer, ItemId.WashedGoldPotato, ItemId.GoldPotatoSlices],
      [MachineKind.Fryer, ItemId.GoldPotatoSlices, ItemId.GoldChips],
      [MachineKind.Seasoner, ItemId.GoldChips, ItemId.SeasonedGoldChips],
      [MachineKind.Bagger, ItemId.SeasonedGoldChips, ItemId.BaggedGoldChips],
    ];

    let x = 0;
    for (const [kind, input, output] of chain) {
      const machine = spawnMachine(state, kind, x, 0)!;
      x += 3;
      const hopper = machineHoppers(machineSpec(kind)!).findIndex((line) => line.item === input);
      expect(hopper).toBeGreaterThanOrEqual(0);
      machine.inputCounts[hopper] = 1;
      expect(runOneOperation(state, machine)).toBe(output);
    }
  });

  it('keeps hopper zero where every save on disk already put it', () => {
    // A SAVE-COMPATIBILITY RULE, not a style one. `machine.inputCounts` is parallel to the
    // hoppers and is stored that way in every save; a new hopper that landed anywhere but the
    // end would silently re-read every stocked machine in the world.
    for (const spec of MACHINE_SPECS) {
      const hoppers = machineHoppers(spec);
      for (let i = 0; i < spec.inputs.length; i++) {
        expect(hoppers[i]).toEqual(spec.inputs[i]);
      }
      // And every recipe line has somewhere to be held.
      for (const recipe of machineRecipes(spec)) {
        for (const line of recipe.consumes) {
          expect(hoppers.some((h) => h.item === line.item)).toBe(true);
        }
      }
    }
  });

  it('prices every new product off its input, and never off vibes', () => {
    // Item 111's balance non-negotiable, checked as arithmetic rather than as literals: each
    // flavoured rung is its plain counterpart plus 150% of the extra ingredient.
    expect(listPriceCents(ItemId.ChiliChips)).toBe(
      listPriceCents(ItemId.SeasonedChips) + CHILI_PREMIUM_CENTS,
    );
    expect(listPriceCents(ItemId.BaggedChiliChips)).toBe(
      listPriceCents(ItemId.BaggedChips) + CHILI_PREMIUM_CENTS,
    );
    expect(listPriceCents(ItemId.SweetcornChips)).toBe(
      listPriceCents(ItemId.SeasonedChips) + SWEETCORN_PREMIUM_CENTS,
    );
    expect(listPriceCents(ItemId.BaggedSweetcornChips)).toBe(
      listPriceCents(ItemId.BaggedChips) + SWEETCORN_PREMIUM_CENTS,
    );

    // The gold line is the plain line shifted by ONE constant, which is what stops the premium
    // being multiplied five times over on its way down the belt.
    const gold: [ItemId, ItemId][] = [
      [ItemId.WashedGoldPotato, ItemId.WashedPotato],
      [ItemId.GoldPotatoSlices, ItemId.PotatoSlices],
      [ItemId.GoldChips, ItemId.PlainChips],
      [ItemId.SeasonedGoldChips, ItemId.SeasonedChips],
      [ItemId.BaggedGoldChips, ItemId.BaggedChips],
    ];
    for (const [premium, plain] of gold) {
      expect(listPriceCents(premium)).toBe(listPriceCents(plain) + GOLD_POTATO_PREMIUM_CENTS);
    }
  });

  it('does not let the flavour tier out-earn the plain line per tile-second', () => {
    // THE ANTI-ACCELERATION CHECK, and the one that would catch a well-meaning rebalance. Item
    // 046 inherits an economy already paying ~5× too fast; this tier adds a decision, not a
    // multiplier. A gold bag is worth more than a plain one — but the potato takes twice as
    // long to grow, so per second of field it must NOT win.
    const russet = CROP_SPECS.find((spec) => spec.yieldItem === ItemId.RussetPotato)!;
    const goldCrop = CROP_SPECS.find((spec) => spec.yieldItem === ItemId.GoldPotato)!;

    const plainPerTick = listPriceCents(ItemId.BaggedChips) / russet.growthTicks;
    const goldPerTick = listPriceCents(ItemId.BaggedGoldChips) / goldCrop.growthTicks;
    expect(goldPerTick).toBeLessThan(plainPerTick);

    // What it DOES buy is more value per machine operation — five ops either way, more money
    // out of them. That is the trade the player is being offered.
    expect(listPriceCents(ItemId.BaggedGoldChips)).toBeGreaterThan(
      listPriceCents(ItemId.BaggedChips),
    );
  });
});

// --- overcooking --------------------------------------------------------------------

// --- the soda line ------------------------------------------------------------------

/**
 * Stand a whole soda line up directly, with pipes, and no economy in the way.
 *
 * The layout is the golden fixture's, one row along the top of the lot with a two-tile run of
 * pipe between each pair of machines, because that is the arrangement a player actually builds
 * and the one the port typing has to survive.
 */
function sodaLine(seed: number): WorldState {
  const state = createWorld(seed);
  spawnMachine(state, MachineKind.Juicer, 0, 0);
  spawnMachine(state, MachineKind.Kettle, 3, 0);
  spawnMachine(state, MachineKind.SyrupMixer, 6, 0);
  spawnMachine(state, MachineKind.Bottler, 9, 0);
  spawnMachine(state, MachineKind.Carbonator, 13, 0);

  const runs: [LiquidId, number][] = [
    [LiquidId.CaneJuice, 2],
    [LiquidId.SimpleSyrup, 5],
    [LiquidId.SodaSyrup, 8],
    [LiquidId.CarbonatedWater, 12],
  ];
  for (const [liquid, x] of runs) {
    spawnPipe(state, x, 0, liquid);
    spawnPipe(state, x, 1, liquid);
  }
  // The water main, underneath, reaching up to the only two machines that drink.
  for (let x = 6; x <= 13; x++) spawnPipe(state, x, 3, LiquidId.Water);
  spawnPipe(state, 13, 2, LiquidId.Water);
  spawnPipe(state, 6, 2, LiquidId.Water);
  rebuildNetworks(state);
  return state;
}

function machineOf(state: WorldState, kind: MachineKind): Machine {
  return state.machines.find((machine) => machine.kind === kind)!;
}

/** The one liquid line of a spec that matches this liquid and direction. */
function portSpec(kind: MachineKind, liquid: LiquidId, flow: PortFlow): LiquidPortSpec {
  const spec = machineSpec(kind)!;
  return spec.ports.find((port) => port.liquid === liquid && port.flow === flow)!;
}

describe('the soda line', () => {
  it('chains cane → juice → syrup → soda, and a bottle sells for about $16', () => {
    // Plan §4: "cane→juice→simple syrup; … syrup + carbonated water + bottle → soda (~$16)".
    const juicer = machineSpec(MachineKind.Juicer)!;
    expect(juicer.inputs).toEqual([{ item: ItemId.SugarCane, count: 1 }]);
    expect(juicer.ports.map((port) => port.liquid)).toEqual([LiquidId.CaneJuice]);

    const kettle = machineSpec(MachineKind.Kettle)!;
    expect(kettle.ports.map((port) => port.liquid)).toEqual([
      LiquidId.CaneJuice,
      LiquidId.SimpleSyrup,
    ]);

    const mixer = machineSpec(MachineKind.SyrupMixer)!;
    expect(mixer.inputs).toEqual([{ item: ItemId.KolaPowder, count: 1 }]);
    expect(mixer.ports.map((port) => port.liquid)).toEqual([
      LiquidId.SimpleSyrup,
      LiquidId.Water,
      LiquidId.SodaSyrup,
    ]);

    const bottler = machineSpec(MachineKind.Bottler)!;
    expect(bottler.inputs).toEqual([{ item: ItemId.Bottle, count: 1 }]);
    expect(bottler.outputItem).toBe(ItemId.Soda);
    // §5: "machines mostly 2×2 (Bottler 3×2 flagship)".
    expect([bottler.tilesWide, bottler.tilesHigh]).toEqual([3, 2]);

    expect(listPriceCents(ItemId.Soda)).toBe(1_600);
  });

  it('gives the Syrup Mixer two pipe inlets and one belt inlet', () => {
    // PLAN §5'S CENTREPIECE, and the one place solids and liquids meet in the open. Two liquid
    // inlets, one solid inlet, and one outlet — if this ever collapses to a single port the
    // machine has stopped being the thing the section describes.
    const spec = machineSpec(MachineKind.SyrupMixer)!;
    const intakes = spec.ports.filter((port) => port.flow === PortFlow.Intake);
    expect(intakes).toHaveLength(2);
    expect(spec.inputs).toHaveLength(1);
    expect(spec.ports.filter((port) => port.flow === PortFlow.Outlet)).toHaveLength(1);
  });

  it('refuses a mismatched liquid at the port, and accepts the two it takes', () => {
    // The refusal reuses the pipe grammar rather than inventing one: same function, same
    // `BuildRefusal` codes, refused while the player is still dragging.
    const state = createWorld(9001);
    spawnMachine(state, MachineKind.SyrupMixer, 6, 0);

    const at = (liquid: LiquidId): BuildRefusal =>
      pipePathRefusal(state, [{ x: 6, y: 2 }], liquid, PIPE_MAX_PATH_TILES);

    expect(at(LiquidId.SimpleSyrup)).toBe(BuildRefusal.None);
    expect(at(LiquidId.Water)).toBe(BuildRefusal.None);
    expect(at(LiquidId.SodaSyrup)).toBe(BuildRefusal.None);
    // Carbonated water goes to the Bottler, not the Mixer. Nothing about the mixer accepts it.
    expect(at(LiquidId.CarbonatedWater)).toBe(BuildRefusal.PortMismatch);
    expect(at(LiquidId.CaneJuice)).toBe(BuildRefusal.PortMismatch);

    // A machine with no ports at all is invisible to the rule — a water main may still run
    // past a Fryer, which is the whole reason the check asks about ports and not about tiles.
    spawnMachine(state, MachineKind.Fryer, 0, 6);
    expect(pipePathRefusal(state, [{ x: 2, y: 6 }], LiquidId.Water, PIPE_MAX_PATH_TILES)).toBe(
      BuildRefusal.None,
    );
  });

  it('refuses the same mistake made in the other order', () => {
    // Dropping a Carbonator onto a syrup main is the same error as dragging syrup into a
    // Carbonator, and the rule has to hold from both ends or it does not hold.
    const state = createWorld(9002);
    spawnPipe(state, 5, 0, LiquidId.SimpleSyrup);
    rebuildNetworks(state);

    expect(liquidPlacementRefusal(state, MachineKind.Carbonator, 6, 0)).toBe(
      BuildRefusal.PortMismatch,
    );
    // The Syrup Mixer takes simple syrup, so it may stand exactly where the Carbonator may not.
    expect(liquidPlacementRefusal(state, MachineKind.SyrupMixer, 6, 0)).toBe(BuildRefusal.None);
  });

  it('runs the Carbonator and the Bottler at 1:1:1 without either starving the other', () => {
    // THE SODA LINE'S RATIO LESSON, AND IT IS A VOLUME RATHER THAN A COUNT. One Mixer operation
    // makes exactly the soda syrup one Bottler operation drinks, one Carbonator operation makes
    // exactly the carbonated water it drinks, and all three take the same time — so the three
    // of them run in lockstep and a second Bottler turns the pipes amber instead of idling a
    // machine. `test/factory.test.ts` pins the chip line's 1:1:2:1:1 for the same reason: this
    // is a design ruling, not an implementation detail, and it must not be "optimised".
    expect(
      portSpec(MachineKind.SyrupMixer, LiquidId.SodaSyrup, PortFlow.Outlet).mlPerOperation,
    ).toBe(portSpec(MachineKind.Bottler, LiquidId.SodaSyrup, PortFlow.Intake).mlPerOperation);
    expect(
      portSpec(MachineKind.Carbonator, LiquidId.CarbonatedWater, PortFlow.Outlet).mlPerOperation,
    ).toBe(portSpec(MachineKind.Bottler, LiquidId.CarbonatedWater, PortFlow.Intake).mlPerOperation);

    const bottler = ticksPerOperation(MachineKind.Bottler);
    expect(ticksPerOperation(MachineKind.SyrupMixer)).toBe(bottler);
    expect(ticksPerOperation(MachineKind.Carbonator)).toBe(bottler);

    // And in the world: run one of each with the supply they need and count operations. Equal
    // counts are the ratio; a difference of more than one is one machine outrunning another.
    const state = sodaLine(4711);
    spawnReservoir(state, 12, 13, 3, 3);
    spawnMachine(state, MachineKind.Pump, 12, 12);
    for (let y = 4; y <= 12; y++) spawnPipe(state, 13, y, LiquidId.Water);
    rebuildNetworks(state);

    const mixer = machineOf(state, MachineKind.SyrupMixer);
    const carbonator = machineOf(state, MachineKind.Carbonator);
    const bottlerMachine = machineOf(state, MachineKind.Bottler);
    // Feed the mixer's syrup inlet by hand, so this measures the finishing three rather than
    // the press behind them — the upstream ratio is 1:1:2 and it is a different lesson.
    mixer.inputCounts[0] = 60;
    bottlerMachine.inputCounts[0] = 60;
    for (let i = 0; i < 40; i++) {
      mixer.ports[0]!.ml = 2_000;
      stepMany(state, 15);
    }

    expect(bottlerMachine.outputCount).toBeGreaterThan(10);
    expect(Math.abs(mixer.opCount - bottlerMachine.opCount)).toBeLessThanOrEqual(1);
    expect(Math.abs(carbonator.opCount - bottlerMachine.opCount)).toBeLessThanOrEqual(1);
    // Nobody went amber: supply matched demand exactly, which is what 1:1:1 means.
    expect(bottlerMachine.ports.some((port) => port.throttled)).toBe(false);
  });

  it('carries a cane all the way to a bottle', () => {
    const state = sodaLine(4712);
    spawnReservoir(state, 12, 13, 3, 3);
    spawnMachine(state, MachineKind.Pump, 12, 12);
    for (let y = 4; y <= 12; y++) spawnPipe(state, 13, y, LiquidId.Water);
    rebuildNetworks(state);

    machineOf(state, MachineKind.Juicer).inputCounts[0] = 20;
    machineOf(state, MachineKind.SyrupMixer).inputCounts[0] = 20;
    machineOf(state, MachineKind.Bottler).inputCounts[0] = 20;

    stepMany(state, 1_500);

    const bottler = machineOf(state, MachineKind.Bottler);
    expect(bottler.outputCount).toBeGreaterThan(0);
    expect(nextOutputItem(bottler, machineSpec(MachineKind.Bottler)!)).toBe(ItemId.Soda);
    // The cane really went through every machine rather than the Bottler running on nothing.
    for (const kind of [
      MachineKind.Juicer,
      MachineKind.Kettle,
      MachineKind.SyrupMixer,
      MachineKind.Carbonator,
    ]) {
      expect(machineOf(state, kind).opCount).toBeGreaterThan(0);
    }
  });

  it('stops a liquid producer dead when its outlet has nowhere to go', () => {
    // DEMAND-PULL IS ONE RULE, NOT TWO (plan §7 ruling 6). A Juicer with no pipe on it is in
    // exactly the position of a Fryer with a full basket: it fills its outlet, stops, and eats
    // nothing more. An unplumbed press that quietly destroyed cane would be a compost pile.
    const state = createWorld(4713);
    const juicer = spawnMachine(state, MachineKind.Juicer, 0, 0)!;
    juicer.inputCounts[0] = 20;

    stepMany(state, 2_000);

    const spec = machineSpec(MachineKind.Juicer)!;
    const outlet = spec.ports[0]!;
    expect(juicer.ports[0]!.ml).toBe(outlet.capacityMl);
    // Four litres of buffer at a litre an operation: four cane in, sixteen still in the hopper.
    expect(juicer.opCount).toBe(outlet.capacityMl / outlet.mlPerOperation);
    expect(juicer.inputCounts[0]).toBe(20 - juicer.opCount);
  });

  it('takes every ingredient at once or none of them', () => {
    // Atomic consumption: the Combo Packer is the only two-ingredient recipe in the game, and
    // there is no state in which it has swallowed the chips and is waiting for the soda.
    const state = createWorld(4714);
    const packer = spawnMachine(state, MachineKind.ComboPacker, 0, 0)!;
    packer.inputCounts[0] = 5;

    stepMany(state, 500);
    expect(packer.inputCounts[0]).toBe(5);
    expect(packer.outputCount).toBe(0);

    packer.inputCounts[1] = 5;
    stepMany(state, 500);
    expect(packer.outputCount).toBeGreaterThan(0);
    expect(packer.inputCounts[0]).toBe(packer.inputCounts[1]);
  });

  it('prices the bundles above their parts, and the Combo above the six-pack', () => {
    // Plan §4's "gentle bundle premiums", and the answer to §8's release gate: a Combo pays
    // 125% of a bag plus a bottle, so running both districts beats running either one twice.
    const parts = listPriceCents(ItemId.BaggedChips) + listPriceCents(ItemId.Soda);
    expect(listPriceCents(ItemId.SnackCombo)).toBe(divFloor(parts * 125, 100));
    expect(listPriceCents(ItemId.SixPack)).toBe(
      divFloor(listPriceCents(ItemId.Soda) * 6 * 110, 100),
    );

    // The six-pack bundles one product with itself, so its premium is the smaller of the two —
    // otherwise the Combo, which is the point, would be the worse buy. Both are "gentle": §4
    // says premium, not jackpot, so neither pays half again as much as its parts.
    const sixPackPercent = divFloor(
      listPriceCents(ItemId.SixPack) * 100,
      listPriceCents(ItemId.Soda) * 6,
    );
    const comboPercent = divFloor(listPriceCents(ItemId.SnackCombo) * 100, parts);
    expect(comboPercent).toBe(125);
    expect(sixPackPercent).toBe(110);
    expect(comboPercent).toBeGreaterThan(sixPackPercent);
    expect(comboPercent).toBeLessThanOrEqual(130);
  });

  it('keeps every liquid on its own network', () => {
    // Plan §5: one liquid per network, enforced. Five liquids, five networks, no sharing —
    // which is the constraint that makes routing the soda district a puzzle.
    const state = sodaLine(4715);
    const liquids = state.networks.map((network) => network.liquid).sort((a, b) => a - b);
    expect(liquids).toEqual([
      LiquidId.Water,
      LiquidId.CaneJuice,
      LiquidId.SimpleSyrup,
      LiquidId.CarbonatedWater,
      LiquidId.SodaSyrup,
    ]);

    // And each port found the network carrying its own liquid rather than the nearest one.
    const mixer = machineOf(state, MachineKind.SyrupMixer);
    const spec = machineSpec(MachineKind.SyrupMixer)!;
    for (let i = 0; i < spec.ports.length; i++) {
      const network = state.networks.find((n) => n.id === mixer.ports[i]!.network);
      expect(network?.liquid).toBe(spec.ports[i]!.liquid);
    }
  });

  it('agrees with itself about which liquid a machine advertises', () => {
    // `MachineSpec.liquid` is what the renderer reads to decide a machine has a typed port at
    // all, and for a converter it restates the first port. A restatement that drifted would
    // give the renderer a second opinion about the plumbing.
    for (const spec of MACHINE_SPECS) {
      if (spec.ports.length === 0) continue;
      expect(spec.liquid).toBe(spec.ports[0]!.liquid);
    }
  });
});

describe('the sell bin', () => {
  it('refuses seeds, and says so before the player clicks', () => {
    // A SELLABLE SEED IS A SOFTLOCK WITH A PRICE TAG: the stand sells seeds at the same price
    // it would pay, so dumping them is not even a trade — it is a way to end up unable to
    // plant. The reducer refuses, and the view carries the same fact so the HUD can grey it.
    const state = createWorld(4716);
    addItem(state, ItemId.PotatoSeed, 4);
    addItem(state, ItemId.RussetPotato, 4);
    standOn(state, FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + 8);

    const before = state.moneyCents;
    const seeds = itemCount(state, ItemId.PotatoSeed);
    run(state, [{ type: 'SellItem', item: ItemId.PotatoSeed, count: 4 }]);
    expect(state.moneyCents).toBe(before);
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seeds);
    // A refused command is not in the trace, because it did not happen.
    expect(state.trace).toHaveLength(0);

    run(state, [{ type: 'SellItem', item: ItemId.RussetPotato, count: 4 }]);
    expect(state.moneyCents).toBeGreaterThan(before);

    const projected = view(state, createWorldView());
    const seedRow = projected.inventory.find((slot) => slot.item === ItemId.PotatoSeed)!;
    expect(seedRow.sellable).toBe(0);
    expect(isSellable(ItemId.PotatoSeed)).toBe(false);
  });

  it('leaves every seed and every boxed machine unsellable, and everything else sellable', () => {
    // Pinned over the whole table rather than one item, and pinned as "seeds" rather than as
    // "the inverse of purchasable" — the two flags are different facts and a consumable that
    // is both buyable and sellable must stay possible.
    //
    // Boxed machines are the second thing the bin refuses, and for a different reason: a seed
    // is refused because selling it can end a world, while a box is refused because the bin
    // prices at list and a box has no list price. `SellBoxedMachine` scraps it at 40% of its
    // own invoice instead. Both facts live in the same one column, which is the point of
    // `ItemSpec.sellable` being data rather than a rule inferred from something else.
    for (const spec of ITEM_SPECS) {
      const refused = spec.slug.endsWith('-seed') || isBoxedMachineItem(spec.id);
      expect(spec.sellable).toBe(!refused);
    }
  });

  it('prices every boxed machine at zero, because a box is priced off its own invoice', () => {
    // A non-zero list price here would be counted by `computeNetWorthCents` ON TOP of the
    // per-box value it already adds, so every boxed machine would be worth itself plus a
    // constant. The zero is load-bearing, not a placeholder.
    for (const row of BOXED_MACHINE_ROWS) {
      expect(listPriceCents(row.item)).toBe(0);
    }
  });

  it('gives every buildable machine kind exactly one box, and the sell bin none', () => {
    // The map is a table rather than an offset (see `BOXED_MACHINE_ROWS`), so nothing but a
    // test stops it going out of step with `MACHINE_SPECS`. This is that test.
    const boxed = new Set(BOXED_MACHINE_ROWS.map((row) => row.kind));
    for (const spec of MACHINE_SPECS) {
      expect(boxed.has(spec.kind)).toBe(spec.kind !== MachineKind.SellBin);
    }
    expect(boxed.size).toBe(MACHINE_SPECS.length - 1);

    // And the slug says which machine it is, so a save opened in a text editor reads plainly.
    for (const row of BOXED_MACHINE_ROWS) {
      expect(itemSpec(row.item)?.slug).toBe(`boxed-${machineSpec(row.kind)?.slug ?? '?'}`);
      expect(machineKindForBoxedItem(row.item)).toBe(row.kind);
      expect(boxedItemForMachine(row.kind)).toBe(row.item);
    }
  });

  it('buys and sells a consumable at the same price, so there is no arbitrage', () => {
    // Every purchasable non-seed is sellable, which would be an infinite money machine if the
    // two prices ever diverged. One price per item is what makes that structurally impossible.
    for (const spec of ITEM_SPECS) {
      if (!spec.purchasable || !spec.sellable) continue;
      expect(listPriceCents(spec.id)).toBe(spec.listPriceCents);
    }
  });
});

describe('Rustic Style', () => {
  it('prices a burnt batch at exactly 70% of seasoned chips, floored', () => {
    // Plan §2's number, and the criterion is "exactly". The table entry is multiplied out
    // from the seasoned price rather than typed as a second literal, so this asserts the two
    // agree — the day seasoning is repriced, a drifting 980 would show up right here.
    expect(listPriceCents(ItemId.RusticStyleChips)).toBe(rusticStylePriceCents());
    expect(listPriceCents(ItemId.RusticStyleChips)).toBe(
      Math.floor((listPriceCents(ItemId.SeasonedChips) * 70) / 100),
    );
    // A discount, never a hole: burnt chips still sell, and for more than the unseasoned
    // chips they were a moment ago. Nothing in this game pays zero (plan §4).
    expect(listPriceCents(ItemId.RusticStyleChips)).toBeGreaterThan(0);
  });

  it('browns a chip only when the layout leaves the basket nowhere to go', () => {
    // THE CAUSE IS A LAYOUT CONDITION, NOT A DIE ROLL (plan §7 ruling 5). The Fryer here is
    // fed and unblocked; it must run for as long as you like without spoiling anything.
    const state = createWorld(77);
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    fryer.inputCounts[0] = 5;

    stepMany(state, OVERCOOK_BLOCKED_TICKS * 3);
    expect(fryer.overcookedCount).toBe(0);
    expect(fryer.blockedTicks).toBe(0);
  });

  it('turns one chip per interval while blocked, oldest first, and stops at the last', () => {
    const state = createWorld(78);
    const spec = machineSpec(MachineKind.Fryer)!;
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    fryer.inputCounts[0] = 10;
    fryer.outputCount = spec.outputCapacity;

    stepMany(state, OVERCOOK_BLOCKED_TICKS - 1);
    expect(fryer.overcookedCount).toBe(0);
    stepMany(state, 1);
    expect(fryer.overcookedCount).toBe(1);
    stepMany(state, OVERCOOK_BLOCKED_TICKS);
    expect(fryer.overcookedCount).toBe(2);

    // Demand-pull still holds: a blocked machine eats nothing while it browns.
    expect(fryer.inputCounts[0]!).toBe(10);
    expect(fryer.outputCount).toBe(spec.outputCapacity);

    // Left alone forever it browns the whole basket and then stops. There is no state past
    // "all of it is rustic" — a machine cannot burn the same chip twice.
    stepMany(state, OVERCOOK_BLOCKED_TICKS * (spec.outputCapacity + 5));
    expect(fryer.overcookedCount).toBe(spec.outputCapacity);
  });

  it('resets the clock the moment anything is taken out', () => {
    // A basket that moved is a basket out of the oil.
    const state = createWorld(79);
    const spec = machineSpec(MachineKind.Fryer)!;
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    fryer.outputCount = spec.outputCapacity;

    stepMany(state, OVERCOOK_BLOCKED_TICKS - 10);
    expect(takeOneOutput(fryer, spec)).toBe(ItemId.PlainChips);
    expect(fryer.blockedTicks).toBe(0);

    stepMany(state, 10);
    expect(fryer.overcookedCount).toBe(0);
  });

  it('hands the burnt chips over first, to a hand and to an arm alike', () => {
    const state = createWorld(80);
    const spec = machineSpec(MachineKind.Fryer)!;
    const fryer = spawnMachine(state, MachineKind.Fryer, 4, 4)!;
    fryer.outputCount = 4;
    fryer.overcookedCount = 2;

    expect(nextOutputItem(fryer, spec)).toBe(ItemId.RusticStyleChips);

    standOn(state, 4, 4);
    run(state, [{ type: 'UnloadMachine', machineId: fryer.id, count: 4 }]);

    // Two rustic and two good, not four of whichever was easier to count.
    expect(itemCount(state, ItemId.RusticStyleChips)).toBe(2);
    expect(itemCount(state, ItemId.PlainChips)).toBe(2);
    expect(fryer.outputCount).toBe(0);
    expect(fryer.overcookedCount).toBe(0);
  });

  it('spoils nothing anywhere else in the line', () => {
    // Only the Fryer names an overcooked grade. A blocked Washer is just a blocked Washer,
    // and it holds its washed potatoes indefinitely.
    for (const kind of [
      MachineKind.Washer,
      MachineKind.Slicer,
      MachineKind.Seasoner,
      MachineKind.Bagger,
      MachineKind.ChipKitchen,
    ]) {
      expect(machineSpec(kind)!.overcookOutputItem).toBeNull();
    }

    const state = createWorld(81);
    const spec = machineSpec(MachineKind.Washer)!;
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    washer.outputCount = spec.outputCapacity;
    stepMany(state, OVERCOOK_BLOCKED_TICKS * 4);
    expect(washer.overcookedCount).toBe(0);
    expect(washer.outputCount).toBe(spec.outputCapacity);
  });
});

// --- maintenance --------------------------------------------------------------------

describe('wear and repair', () => {
  it('loses no condition over 10,000 ticks when it completes no operations', () => {
    // PLAN §4, STATED AS ABSOLUTE: wear is per operation, never per second. This reads the
    // committed `idle-wear` golden fixture rather than a world built here, because the
    // criterion asks for a fixture — a pinned world nobody can quietly adjust — and because
    // the fixture's hash catches the same regression on every run.
    const fixture = loadFixture('idle-wear');
    const state = replay(fixture);

    const kitchen = state.machines.find((machine) => machine.kind === MachineKind.ChipKitchen);
    expect(kitchen).toBeDefined();
    expect(kitchen!.opCount).toBe(0);
    expect(kitchen!.condition).toBe(CONDITION_MAX);

    // And the last ten thousand ticks of it really are untouched: no command lands after the
    // kitchen goes down, so nothing but time passed.
    const last = fixture.commands[fixture.commands.length - 1]!;
    expect(fixture.ticks - last.tick).toBeGreaterThanOrEqual(10_000);
  });

  it('wastes an input on a cadence below the threshold, and never above it', () => {
    // Plan §4 says "waste chance"; plan §7 ruling 5 bans rolls. The reconciliation is a
    // period read off `opCount`, so the same world wastes the same potatoes every time.
    const spec = machineSpec(MachineKind.ChipKitchen)!;
    const healthy = { condition: CONDITION_MAX } as never;
    expect(effectiveWastePeriod(spec, healthy)).toBe(0);

    const state = createWorld(82);
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!;
    kitchen.condition = CONDITION_EFFECT_THRESHOLD;
    kitchen.inputCounts[0] = 20;
    stepMany(state, ticksPerOperation(MachineKind.ChipKitchen) * 3);
    expect(state.stats.inputsWastedByMachine).toBe(0);

    const worn = createWorld(83);
    const spoiler = spawnMachine(worn, MachineKind.ChipKitchen, 0, 0)!;
    spoiler.condition = CONDITION_EFFECT_THRESHOLD - 1;
    spoiler.inputCounts[0] = 40;
    const period = effectiveWastePeriod(spec, spoiler);
    expect(period).toBeGreaterThan(1);

    // Run just past the operation the cadence lands on, at half speed because it is worn.
    // Short enough that wear has not moved the period underneath us, which is why the closed
    // form below is legitimate rather than approximately true.
    stepMany(worn, ticksPerOperation(MachineKind.ChipKitchen) * 2 * period + period);
    expect(effectiveWastePeriod(spec, spoiler)).toBe(period);
    expect(spoiler.opCount).toBeGreaterThanOrEqual(period);
    expect(worn.stats.inputsWastedByMachine).toBeGreaterThan(0);
    expect(worn.stats.inputsWastedByMachine).toBe(Math.floor(spoiler.opCount / period));
    // The input is gone either way — that is what makes neglect cost margin, not progress.
    expect(spoiler.inputCounts[0]!).toBe(40 - spoiler.opCount);
    expect(spoiler.outputCount).toBe(spoiler.opCount - worn.stats.inputsWastedByMachine);
  });

  it('wastes the same inputs on the same ticks in two identical worlds', () => {
    // The criterion is "deterministic and reproducible from the same seed". There is no
    // stream to consult here at all, which is the strongest form of that: two worlds cannot
    // disagree about arithmetic.
    const build = (): WorldState => {
      const state = createWorld(87);
      const machine = spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!;
      machine.condition = 120;
      machine.inputCounts[0] = 30;
      stepMany(state, 4000);
      return state;
    };

    const a = build();
    const b = build();
    expect(a.stats.inputsWastedByMachine).toBeGreaterThan(1);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('shortens the waste cadence as the machine falls further apart', () => {
    const spec = machineSpec(MachineKind.ChipKitchen)!;
    const at = (condition: number): number =>
      effectiveWastePeriod(spec, { condition, efficiencyLevel: 0 } as never);

    expect(at(CONDITION_EFFECT_THRESHOLD - 1)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThanOrEqual(2);
    // Monotone all the way down, so "it got worse" is always true and never occasionally.
    for (let condition = CONDITION_EFFECT_THRESHOLD - 1; condition > 1; condition--) {
      expect(at(condition)).toBeGreaterThanOrEqual(at(condition - 1));
    }
  });

  it('lengthens the waste cadence with the Efficiency dial, and never to never', () => {
    // PLAN §3: Efficiency reduces "both input waste and wear". Wear has always been cut in
    // `effectiveWear`; this is the other half. It stretches the PERIOD rather than lowering a
    // chance, because plan §7 ruling 5 means there is no chance in it to lower.
    const spec = machineSpec(MachineKind.ChipKitchen)!;
    const at = (condition: number, efficiencyLevel: number): number =>
      effectiveWastePeriod(spec, { condition, efficiencyLevel } as never);

    // Just below the threshold: one input in seven becomes one in twelve at level 3.
    const worn = CONDITION_EFFECT_THRESHOLD - 1;
    expect(at(worn, 0)).toBe(7);
    expect(at(worn, 3)).toBe(12);
    for (let level = 1; level <= UPGRADE_MAX_LEVEL; level++) {
      expect(at(worn, level)).toBeGreaterThan(at(worn, level - 1));
    }

    // At death's door the dial still helps and still does not save you: a machine at 1
    // condition wastes one input in two, and one in three with the dial maxed. Never zero.
    expect(at(1, 0)).toBe(2);
    expect(at(1, UPGRADE_MAX_LEVEL)).toBe(3);
    for (let level = 0; level <= UPGRADE_MAX_LEVEL; level++) {
      expect(at(1, level)).toBeGreaterThanOrEqual(2);
      // A HEALTHY MACHINE WASTES NOTHING, DIAL OR NO DIAL. Waste is a consequence of neglect
      // and never a tax on running a factory, so the dial has nothing to improve up here.
      expect(at(CONDITION_EFFECT_THRESHOLD, level)).toBe(0);
    }
  });

  it("repairs every machine in the kit's radius in one use", () => {
    // Plan §4: "one trip services a cell." That is the whole reason a kit is worth $8 when
    // hands are free — it buys the walk, not the repair.
    const state = createWorld(84);
    const near = spawnMachine(state, MachineKind.Washer, 4, 4)!;
    const alsoNear = spawnMachine(state, MachineKind.Slicer, 6, 6)!;
    const far = spawnMachine(state, MachineKind.Fryer, 12, 12)!;
    for (const machine of [near, alsoNear, far]) machine.condition = 200;
    near.jammed = true;

    addItem(state, ItemId.RepairKit, 1);
    standOn(state, 5, 5);
    run(state, [{ type: 'UseRepairKit', tileX: 5, tileY: 5 }]);

    expect(near.condition).toBe(CONDITION_MAX);
    expect(near.jammed).toBe(false);
    expect(alsoNear.condition).toBe(CONDITION_MAX);
    // Out of the cell, out of luck: the radius is what makes where you stand a decision.
    expect(far.condition).toBe(200);

    expect(itemCount(state, ItemId.RepairKit)).toBe(0);
    expect(state.stats.repairKitsUsed).toBe(1);
  });

  it('walks to an out-of-reach cell with the kit armed, and services it on arrival', () => {
    // Wave 8's rough edge: every other verb walked when clicked out of reach; the armed kit
    // refused. `IntentAction.UseRepairKit` wires it exactly as `RefillCan` was — one click,
    // one trace entry, and the arrival runs the same reducer a standing click would.
    // The cell sits due east rather than at (20,20): since item 080 the pond is solid, and
    // the old diagonal crossed it — the walk would stop at the bank, which is its own test
    // (walk.test.ts), not this one.
    const state = createWorld(87);
    const machine = spawnMachine(state, MachineKind.Washer, 20, 4)!;
    machine.condition = 200;
    addItem(state, ItemId.RepairKit, 1);
    standOn(state, 4, 4); // Sixteen tiles away: far outside hand reach.

    const before = state.trace.length;
    run(state, [
      {
        type: 'WalkAndAct',
        action: IntentAction.UseRepairKit,
        tileX: 20,
        tileY: 4,
        item: 0,
        count: 0,
      },
    ]);
    expect(state.player.intent).not.toBeNull();

    let walked = 0;
    while (state.player.intent !== null && walked < 1000) {
      run(state, []);
      walked++;
    }

    // The walk has to be real, and the arrival has to be the same event as a direct click:
    // machine restored, kit spent, stats counted, and exactly ONE trace entry for all of it.
    expect(walked).toBeGreaterThan(1);
    expect(machine.condition).toBe(CONDITION_MAX);
    expect(itemCount(state, ItemId.RepairKit)).toBe(0);
    expect(state.stats.repairKitsUsed).toBe(1);
    expect(state.trace.length - before).toBe(1);
    expect(state.trace[state.trace.length - 1]!.command.type).toBe('WalkAndAct');
  });

  it('refuses a kit that would do nothing rather than eating it', () => {
    // Misplacement is never a fine (plan §4). A misclick that silently spent $8 would teach
    // the player to distrust the tool.
    const state = createWorld(85);
    const machine = spawnMachine(state, MachineKind.Washer, 4, 4)!;
    addItem(state, ItemId.RepairKit, 1);
    standOn(state, 5, 5);

    run(state, [{ type: 'UseRepairKit', tileX: 5, tileY: 5 }]);
    expect(itemCount(state, ItemId.RepairKit)).toBe(1);
    expect(state.trace).toHaveLength(0);
    expect(machine.condition).toBe(CONDITION_MAX);
  });

  it('leaves hand repair free, unlimited, and enough on its own', () => {
    // Plan §1: "Manual never rots." A player with $0 and no kits can bring a dead machine
    // all the way back, and it costs nothing but time.
    const state = createWorld(86);
    const machine = spawnMachine(state, MachineKind.ChipKitchen, 4, 4)!;
    machine.condition = 0;
    standOn(state, 4, 4);

    const moneyBefore = state.moneyCents;
    for (let i = 0; i < CONDITION_MAX / REPAIR_PER_TOUCH; i++) {
      run(state, [{ type: 'RepairMachine', machineId: machine.id }]);
    }

    expect(machine.condition).toBe(CONDITION_MAX);
    expect(state.moneyCents).toBe(moneyBefore);
    expect(itemCount(state, ItemId.RepairKit)).toBe(0);
  });
});

// --- fixture stories ----------------------------------------------------------------
//
// The golden hash pins that a fixture replays IDENTICALLY; it cannot pin that the fixture
// still tells the story its description claims. That gap is not hypothetical: the 8-pour-can
// amendment once left `maintenance.json` hash-stable with its one PlaceMachine deferred to
// the second-to-last tick — every feed, whack, and kit use replaying against a machine that
// did not exist yet. These tests replay the wear and junction fixtures WATCHING the world,
// so a fixture whose story dies goes red even while its hash stays green.

/** Replay a fixture like `goldens.replay`, but observing the world after every tick. */
function replayWatching(fixture: GoldenFixture, onTick: (state: WorldState) => void): WorldState {
  const state = createWorld(fixture.seed);
  const byTick = new Map<number, Command[]>();
  for (const entry of fixture.commands) {
    const bucket = byTick.get(entry.tick);
    if (bucket === undefined) byTick.set(entry.tick, [entry.command]);
    else bucket.push(entry.command);
  }
  const none: Command[] = [];
  for (let i = 0; i < fixture.ticks; i++) {
    step(state, { tick: state.tick, commands: byTick.get(state.tick) ?? none });
    onTick(state);
  }
  return state;
}

describe('fixture stories', () => {
  it('worn-to-zero: work drives a kitchen to zero, it halts, and hands alone restore it', () => {
    const fixture = loadFixture('worn-to-zero');
    // Kit-free by construction — the fixture guards plan §1's "manual never rots", and a kit
    // slipping into a later re-recording would quietly change what it proves.
    expect(fixture.commands.some((e) => e.command.type === 'UseRepairKit')).toBe(false);

    let minCondition = Infinity;
    let haltedTicks = 0;
    const state = replayWatching(fixture, (s) => {
      const kitchen = s.machines.find((m) => m.kind === MachineKind.ChipKitchen);
      if (kitchen === undefined) return;
      if (kitchen.condition < minCondition) minCondition = kitchen.condition;
      if (kitchen.condition <= 0) haltedTicks += 1;
    });

    const kitchen = state.machines.find((m) => m.kind === MachineKind.ChipKitchen)!;
    expect(minCondition).toBe(0);
    // It sat dead for a while — halted, costing nothing — rather than bouncing off zero.
    expect(haltedTicks).toBeGreaterThan(100);
    expect(kitchen.opCount).toBeGreaterThan(0);
    expect(kitchen.condition).toBe(CONDITION_MAX);
    expect(state.stats.repairKitsUsed).toBe(0);
    expect(state.stats.touches.handRepair).toBeGreaterThan(0);
  });

  it('maintenance: work reaches the worn regime and one kit restores the cell', () => {
    const fixture = loadFixture('maintenance');
    let minCondition = Infinity;
    const state = replayWatching(fixture, (s) => {
      const kitchen = s.machines.find((m) => m.kind === MachineKind.ChipKitchen);
      if (kitchen !== undefined && kitchen.condition < minCondition) {
        minCondition = kitchen.condition;
      }
    });

    // Below the effect threshold but never dead — a dead machine is worn-to-zero's story.
    expect(minCondition).toBeLessThan(CONDITION_EFFECT_THRESHOLD);
    expect(minCondition).toBeGreaterThan(0);
    // The worn regime actually cost something, deterministically.
    expect(state.stats.inputsWastedByMachine).toBeGreaterThanOrEqual(5);
    expect(state.stats.touches.jamWhack).toBeGreaterThanOrEqual(3);
    // One kit, bought at the till and consumed on the cell.
    expect(state.stats.repairKitsUsed).toBe(1);
    expect(state.stats.repairKitSpendCents).toBe(800);
    // Restored to full and back at work — the tail wears it a little, which is the point.
    const kitchen = state.machines.find((m) => m.kind === MachineKind.ChipKitchen)!;
    expect(kitchen.condition).toBeGreaterThan(CONDITION_EFFECT_THRESHOLD);
  });

  it('junction-loop: one junction alternates outputs, the other inputs, and goods reach every belt', () => {
    const fixture = loadFixture('junction-loop');
    const inCursors = new Map<number, Set<number>>();
    const outCursors = new Map<number, Set<number>>();
    const beltsThatCarried = new Set<number>();
    const state = replayWatching(fixture, (s) => {
      for (const machine of s.machines) {
        if (machine.kind !== MachineKind.BeltJunction) continue;
        let ins = inCursors.get(machine.id);
        if (ins === undefined) inCursors.set(machine.id, (ins = new Set()));
        ins.add(machine.junctionInCursor);
        let outs = outCursors.get(machine.id);
        if (outs === undefined) outCursors.set(machine.id, (outs = new Set()));
        outs.add(machine.junctionOutCursor);
      }
      for (const belt of s.belts) {
        if (belt.items.length > 0) beltsThatCarried.add(belt.id);
      }
    });

    const junctions = state.machines.filter((m) => m.kind === MachineKind.BeltJunction);
    expect(junctions).toHaveLength(2);
    // The splitter's out-cursor moved between faces; the merger's in-cursor did the same.
    // Item 024's criterion is the ALTERNATION, not merely the existence of the tiles.
    expect(junctions.some((j) => (outCursors.get(j.id)?.size ?? 0) >= 2)).toBe(true);
    expect(junctions.some((j) => (inCursors.get(j.id)?.size ?? 0) >= 2)).toBe(true);
    // Circulation reached every belt in the loop — both branches of the split included.
    expect(state.belts.length).toBeGreaterThanOrEqual(6);
    for (const belt of state.belts) {
      expect(beltsThatCarried.has(belt.id)).toBe(true);
    }
    // And the goods are still going round at the end, not parked in a buffer.
    const ridingNow = state.belts.reduce((sum, belt) => sum + belt.items.length, 0);
    expect(ridingNow).toBeGreaterThan(0);
  });
});

// --- belts and grabbers -------------------------------------------------------------

describe('belts', () => {
  it('carries items forward and never lets two overlap', () => {
    const state = createWorld(11);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 4)!;
    expect(beltInsert(belt, 0, ItemId.RussetPotato, 0)).toBe(true);
    expect(beltInsert(belt, 64, ItemId.RussetPotato, 0)).toBe(true);
    // Too close to the one already at 64 — a belt that accepted this would render as a
    // single smeared item and would silently double a line's throughput.
    expect(beltInsert(belt, 100, ItemId.RussetPotato, 0)).toBe(false);

    stepMany(state, 40);
    expect(belt.items[0]!.dist).toBeGreaterThan(0);
    for (let i = 1; i < belt.items.length; i++) {
      expect(belt.items[i]!.dist - belt.items[i - 1]!.dist).toBeGreaterThanOrEqual(64);
    }
    // Sorted ascending is a world invariant, not a presentation choice.
    expect([...belt.items].sort((a, b) => a.dist - b.dist)).toEqual(belt.items);
  });

  it('hands the head item off to the belt that starts where it ends', () => {
    const state = createWorld(12);
    const first = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 2)!;
    const second = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 2)!;
    beltInsert(first, 0, ItemId.PlainChips, 0);

    stepMany(state, 300);
    expect(first.items).toHaveLength(0);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.item).toBe(ItemId.PlainChips);
  });

  it('backs up rather than deleting items when there is nowhere to go', () => {
    // Plan §5: "belt gaps mean look upstream, jams mean look downstream." A belt that
    // dropped its head item would be a machine that eats money invisibly.
    const state = createWorld(13);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 3)!;
    beltInsert(belt, 0, ItemId.RussetPotato, 0);
    beltInsert(belt, 64, ItemId.RussetPotato, 0);
    beltInsert(belt, 128, ItemId.RussetPotato, 0);

    stepMany(state, 500);
    expect(belt.items).toHaveLength(3);
    expect(belt.items[2]!.dist).toBe(3 * SUBTILE - 1);
  });

  // Item 026 instruction 4: the flow LOD's scroll rate rides this field instead of the
  // renderer's occupancy estimate. The two properties lod.ts calls load-bearing are pinned
  // here at the source: an empty belt reads zero, and a full one reads its real speed.
  it('publishes throughput as speed scaled by occupancy — zero empty, tier speed full', () => {
    const state = createWorld(90);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;

    // AN EMPTY BELT READS ZERO. A stalled line must not scroll; spotting the stopped
    // segment is the far view's whole job.
    expect(view(state, createWorldView()).belts[0]!.throughputSubtilesPer100Ticks).toBe(0);

    // One item in four shoulder-to-shoulder slots: a quarter of the tier's 320.
    beltInsert(belt, 0, ItemId.RussetPotato, 0);
    expect(view(state, createWorldView()).belts[0]!.throughputSubtilesPer100Ticks).toBe(80);

    // Packed solid: exactly the tier speed, never more — a surface outrunning its goods
    // would be a lie told at the zoom where the player reads circulation.
    beltInsert(belt, 64, ItemId.RussetPotato, 0);
    beltInsert(belt, 128, ItemId.RussetPotato, 0);
    beltInsert(belt, 192, ItemId.RussetPotato, 0);
    expect(view(state, createWorldView()).belts[0]!.throughputSubtilesPer100Ticks).toBe(320);
  });

  it('reads throughput, not velocity: a trickle on an express loses to a packed basic', () => {
    const state = createWorld(91);
    const basic = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;
    const express = spawnBelt(state, BeltTier.Express, 0, 2, Direction.East, 4)!;
    for (let slot = 0; slot < 4; slot++) beltInsert(basic, slot * 64, ItemId.RussetPotato, 0);
    beltInsert(express, 0, ItemId.RussetPotato, 0); // One item on sixteen slots.

    const projected = view(state, createWorldView());
    const full = projected.belts[0]!.throughputSubtilesPer100Ticks;
    const trickle = projected.belts[1]!.throughputSubtilesPer100Ticks;
    expect(trickle).toBeGreaterThan(0);
    expect(trickle).toBeLessThan(full); // A fast belt carrying almost nothing is not busy.
  });
});

describe('grabbers', () => {
  it('moves an item from a machine output onto a belt and into the next machine', () => {
    const state = createWorld(14);
    // Washer at (0,0)-(1,1), arm at (2,0), belt (3,0)-(4,0), arm at (5,0), Slicer at (6,0).
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    const slicer = spawnMachine(state, MachineKind.Slicer, 6, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, 0);
    spawnBelt(state, BeltTier.Basic, 3, 0, Direction.East, 2);
    spawnGrabber(state, GrabberTier.Mk1, 5, 0, Direction.East, 0);

    washer.inputCounts[0] = 3;
    stepMany(state, 600);

    expect(washer.outputCount).toBe(0);
    expect(slicer.opCount + slicer.inputCounts[0]!).toBeGreaterThan(0);
  });

  it('leaves anything that does not match a filtered arm alone', () => {
    const state = createWorld(15);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;
    const sink = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 1)!;
    spawnGrabber(state, GrabberTier.Mk2, 1, 0, Direction.East, ItemId.PlainChips);
    beltInsert(belt, 0, ItemId.RussetPotato, 0);

    stepMany(state, 200);
    expect(belt.items).toHaveLength(1);
    expect(sink.items).toHaveLength(0);
  });
});

// --- an arm looks before it grabs (item 085) ----------------------------------------
//
// **THE RULING THESE TESTS PIN, AND THE ONE THEY OVERTURN.** Owner, 2026-08-15: "the grabbers
// should only be able to take what the machine is able to receive… if it grabs something that
// the machine can't take, it shouldn't grab it." Before this, every accept-door in the game
// documented the opposite as a feature: the arm grabbed, was refused, and stood there holding
// the goods as a visible "look downstream". The hostage is gone; the diagnostic moved to the
// lamp, and the last two tests in this block are the ones that keep it honest.
//
// The failure mode the whole design guards against is DRIFT — a peek that says yes where the
// accept says no. That is why `grabberWouldAccept` is exported and why the property test at the
// bottom exists: it drives the same arm at the same destination and asserts the prediction and
// the outcome agree, item by item, for every door in the tree.

describe('a grabber only takes what its destination will accept', () => {
  /** Belt of one tile, an arm over it, and whatever the caller stands in front of the arm. */
  function armRig(seed: number, filter: ItemId | 0 = 0) {
    const state = createWorld(seed);
    const source = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;
    const arm = spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, filter)!;
    return { state, source, arm };
  }

  function lampOf(state: WorldState, armId: number): number {
    return view(state, createWorldView()).grabbers.find((g) => g.id === armId)!.lamp;
  }

  it('never picks up an item no line of the recipe wants', () => {
    // A Bagger bags chips. Offered a raw potato it has no line for it, and before this item the
    // arm would have taken the potato off the belt and held it for the rest of the session.
    const { state, source, arm } = armRig(8501);
    const bagger = spawnMachine(state, MachineKind.Bagger, 2, 0)!;
    beltInsert(source, 0, ItemId.RussetPotato, 0);

    stepMany(state, 400);

    expect(arm.held).toBe(0);
    expect(arm.opCount).toBe(0);
    expect(source.items.map((e) => e.item)).toEqual([ItemId.RussetPotato]);
    expect(bagger.inputCounts.every((n) => n === 0)).toBe(true);
  });

  it('never picks up for a hopper that is already full, and resumes the moment it drains', () => {
    const { state, source, arm } = armRig(8502);
    const bagger = spawnMachine(state, MachineKind.Bagger, 2, 0)!;
    const spec = machineSpec(MachineKind.Bagger)!;
    const line = spec.inputs.findIndex((input) => input.item === ItemId.SeasonedChips);
    bagger.inputCounts[line] = effectiveInputCapacity(spec, bagger);
    // No condition left, so the machine cannot work its way out of a full hopper and the test
    // is genuinely about the door rather than about how fast a Bagger bags.
    bagger.condition = 0;
    beltInsert(source, 0, ItemId.SeasonedChips, 0);

    stepMany(state, 400);
    expect(arm.held).toBe(0);
    expect(source.items).toHaveLength(1);
    // Red, not amber: there IS something to take, and the thing in front will not have it.
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);

    // Room appears. Nothing else changes, and the arm goes back to work on its own.
    bagger.inputCounts[line] = 0;
    stepMany(state, 200);
    expect(source.items).toHaveLength(0);
    expect(bagger.inputCounts[line]).toBe(1);
  });

  it('never picks up for a belt with no room at the drop point', () => {
    const { state, source, arm } = armRig(8503);
    const sink = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 1)!;
    // A one-tile belt that leads nowhere, packed nose to tail against its own end: the goods
    // compact to the far end and the drop point in the middle of the tile has no legal spacing
    // left, permanently. This is what a backed-up line looks like from the arm's side.
    beltInsert(sink, SUBTILE - 1, ItemId.PlainChips, 0);
    beltInsert(sink, SUBTILE - 1 - BELT_ITEM_SPACING_SUBTILES, ItemId.PlainChips, 0);
    beltInsert(source, 0, ItemId.RussetPotato, 0);

    stepMany(state, 400);
    expect(arm.held).toBe(0);
    expect(source.items).toHaveLength(1);
    expect(sink.items).toHaveLength(2);
  });

  it('composes with the filter: the filter narrows, the look-ahead narrows again', () => {
    // The arm is filtered to chips, so the potato was never a candidate; the chips ARE a
    // candidate and are refused by the destination. Both goods stay on the belt, for two
    // different reasons, and the arm distinguishes them without holding either.
    const { state, source, arm } = armRig(8504, ItemId.PlainChips);
    const bagger = spawnMachine(state, MachineKind.Bagger, 2, 0)!;
    beltInsert(source, 0, ItemId.RussetPotato, 0);
    beltInsert(source, SUBTILE - 1, ItemId.PlainChips, 0);
    const before = source.items.length;

    stepMany(state, 400);
    expect(arm.held).toBe(0);
    expect(source.items).toHaveLength(before);
    expect(bagger.inputCounts.every((n) => n === 0)).toBe(true);
  });

  it('STILL STALLS MID-SWING when the world changes under an arm already holding something', () => {
    // The ruling prevents doomed grabs. It does not teleport goods backwards onto the belt they
    // already left — so an arm whose destination fills up between the grab and the drop keeps
    // the item in its hand and waits, exactly as it always did. This is the one stall left, and
    // it is bounded by the swing it was mid-way through.
    const { state, source, arm } = armRig(8505);
    const bagger = spawnMachine(state, MachineKind.Bagger, 2, 0)!;
    const spec = machineSpec(MachineKind.Bagger)!;
    const line = spec.inputs.findIndex((input) => input.item === ItemId.SeasonedChips);
    bagger.condition = 0;
    beltInsert(source, 0, ItemId.SeasonedChips, 0);

    // One tick is enough: the hopper has room, so the claw closes.
    stepMany(state, 1);
    expect(arm.held).toBe(ItemId.SeasonedChips);

    // The world changes mid-swing.
    bagger.inputCounts[line] = effectiveInputCapacity(spec, bagger);
    stepMany(state, 400);

    // Held, not eaten, and red — the honest stall, with the goods accounted for.
    expect(arm.held).toBe(ItemId.SeasonedChips);
    expect(bagger.inputCounts[line]).toBe(effectiveInputCapacity(spec, bagger));
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);

    // And it delivers the moment room appears, rather than having thrown the item away.
    bagger.inputCounts[line] = 0;
    stepMany(state, 30);
    expect(arm.held).toBe(0);
    expect(bagger.inputCounts[line]).toBe(1);
  });

  it('tells a starved arm from a blocked one: amber is nothing to take, red is nowhere to put it', () => {
    // **THE DIAGNOSTIC THE HOSTAGE USED TO CARRY.** Same arm, same destination, one difference:
    // whether there is anything on the belt behind it. If these two ever report the same colour,
    // item 085 has cost the player the ability to see a mis-aimed belt at all.
    const { state, source, arm } = armRig(8506);
    const bagger = spawnMachine(state, MachineKind.Bagger, 2, 0)!;
    bagger.condition = 0;

    stepMany(state, 5);
    expect(lampOf(state, arm.id)).toBe(LampState.Starved);

    beltInsert(source, 0, ItemId.RussetPotato, 0);
    stepMany(state, 5);
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);

    // And an arm whose destination WOULD take it is neither: it is working.
    const spec = machineSpec(MachineKind.Bagger)!;
    const line = spec.inputs.findIndex((input) => input.item === ItemId.SeasonedChips);
    source.items.length = 0;
    beltInsert(source, 0, ItemId.SeasonedChips, 0);
    stepMany(state, 2);
    expect(lampOf(state, arm.id)).toBe(LampState.Running);
    stepMany(state, 60);
    expect(bagger.inputCounts[line]).toBe(1);
  });

  it('PREDICTS EXACTLY WHAT IT DOES, at every door in the tree — no drifted second copy', () => {
    // **THE TEST THE ONE-PREDICATE-PER-DOOR RULE EXISTS FOR.** Every door in `grabberDeliver`
    // is a pure `canAccept` plus a mutating accept that calls it, and the grep in the item's
    // notes proves there is no parallel copy — but a grep cannot prove the two are *equivalent*.
    // This does: for each destination and each item, ask `grabberWouldAccept`, then hand the arm
    // that item for real and see whether it lands. A drifted predicate shows up as one row where
    // the prediction and the outcome disagree, and it names the door.
    const destinations: readonly { name: string; build: (s: WorldState) => void }[] = [
      { name: 'Bagger hopper', build: (s) => void spawnMachine(s, MachineKind.Bagger, 2, 0) },
      {
        name: 'Chip Kitchen hopper',
        build: (s) => void spawnMachine(s, MachineKind.ChipKitchen, 2, 0),
      },
      { name: 'sell bin', build: (s) => void spawnMachine(s, MachineKind.SellBin, 2, 0) },
      { name: 'truck depot', build: (s) => void spawnMachine(s, MachineKind.TruckDepot, 2, 0) },
      { name: 'planter dock', build: (s) => void spawnMachine(s, MachineKind.PlanterDock, 2, 0) },
      { name: 'drone bay', build: (s) => void spawnMachine(s, MachineKind.DroneBay, 2, 0) },
      // Item 105's door, and both machines that wear it — an empty box takes anything, so these
      // rows are the ones that would catch a predicate that said yes and an accept that did not.
      { name: 'root cellar', build: (s) => void spawnMachine(s, MachineKind.RootCellar, 2, 0) },
      { name: 'hand cart', build: (s) => void spawnMachine(s, MachineKind.HandCart, 2, 0) },
      {
        name: 'root cellar (already holding potatoes)',
        build: (s) => {
          const cellar = spawnMachine(s, MachineKind.RootCellar, 2, 0)!;
          cellar.cargoItem = ItemId.RussetPotato;
          cellar.cargoCount = 1;
        },
      },
      {
        name: 'root cellar (full)',
        build: (s) => {
          const cellar = spawnMachine(s, MachineKind.RootCellar, 2, 0)!;
          cellar.cargoItem = ItemId.PlainChips;
          cellar.cargoCount = machineSpec(MachineKind.RootCellar)!.inputCapacity;
        },
      },
      { name: 'belt', build: (s) => void spawnBelt(s, BeltTier.Basic, 2, 0, Direction.East, 1) },
      { name: 'bare ground', build: () => {} },
    ];
    const goods: readonly ItemId[] = [
      ItemId.RussetPotato,
      ItemId.PlainChips,
      ItemId.BaggedChips,
      ItemId.PotatoSeed,
      ItemId.DronePart,
    ];

    const disagreements: string[] = [];
    for (const destination of destinations) {
      for (const item of goods) {
        const { state, source, arm } = armRig(8507);
        destination.build(state);
        beltInsert(source, 0, item, 0);

        const predicted = grabberWouldAccept(state, arm, item);
        stepMany(state, 200);
        // It landed if it left the belt and is not still in the claw. Nothing in this rig can
        // consume the goods except the destination itself.
        const landed = source.items.length === 0 && arm.held === 0;
        if (predicted !== landed) {
          disagreements.push(
            `${destination.name} + item ${item}: said ${predicted}, did ${landed}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

// --- a box is a place on a belt line (item 105) --------------------------------------
//
// **THE MACHINE FOR KEEPING THINGS IN WAS THE ONE MACHINE NOTHING COULD PUT ANYTHING INTO.** A
// Root Cellar built, placed, moved, boxed and invoiced perfectly; it simply had no door. A belt
// could not fill it (`grabberDeliver` had no `MachineRole.Storage` branch and a box has no recipe
// for `hopperLineFor` to match), a belt could not drain it (`grabberSource` bailed on
// `spec.outputItem === null`, which is exactly what a box's spec says), and a click from out of
// reach walked the farmer over to do nothing, because the errand dropped the item on the way.
//
// These tests are written against the ROLE and run twice — once on the $250 shed, once on the $80
// barrow — because the bug was never about cellars. If the Hand Cart row ever disagrees with the
// Root Cellar row, somebody has special-cased a kind.
//
// The one place they are allowed to differ is the last test, and it is not a special case: a cart
// in tow is in the player's hands rather than standing on the ground.

describe('a container is a destination and a source (item 105)', () => {
  const BOXES: readonly { name: string; kind: MachineKind }[] = [
    { name: 'Root Cellar', kind: MachineKind.RootCellar },
    { name: 'Hand Cart', kind: MachineKind.HandCart },
  ];

  /** Belt → arm → box. The run that fills it. */
  function fillRig(seed: number, kind: MachineKind, filter: ItemId | 0 = 0) {
    const state = createWorld(seed);
    const source = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;
    const arm = spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, filter)!;
    const box = spawnMachine(state, kind, 2, 0)!;
    return { state, source, arm, box };
  }

  /**
   * Box → arm → belt. The run that empties it.
   *
   * The origin is derived from the footprint rather than written twice: a 2×2 cellar placed at
   * (0,0) and a 1×1 cart placed at (1,0) both cover the tile the arm reaches back into, which is
   * what makes the two rows of every test below the same rig rather than two rigs.
   */
  function drainRig(seed: number, kind: MachineKind, filter: ItemId | 0 = 0) {
    const state = createWorld(seed);
    const spec = machineSpec(kind)!;
    const box = spawnMachine(state, kind, 2 - spec.tilesWide, 0)!;
    const arm = spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, filter)!;
    const sink = spawnBelt(state, BeltTier.Basic, 3, 0, Direction.East, 3)!;
    return { state, box, arm, sink };
  }

  function lampOf(state: WorldState, armId: number): number {
    return view(state, createWorldView()).grabbers.find((g) => g.id === armId)!.lamp;
  }

  for (const { name, kind } of BOXES) {
    it(`a belt fills a ${name} — the run that had never once moved an item`, () => {
      const { state, source, arm, box } = fillRig(9101, kind);

      for (let i = 0; i < 5; i++) {
        beltInsert(source, 0, ItemId.RussetPotato, 0);
        stepMany(state, 60);
      }

      expect(box.cargoItem).toBe(ItemId.RussetPotato);
      expect(box.cargoCount).toBe(5);
      expect(source.items).toHaveLength(0);
      expect(arm.held).toBe(0);
    });

    it(`a belt drains a ${name} — the direction every earlier pass missed`, () => {
      const { state, box, arm, sink } = drainRig(9102, kind);
      box.cargoItem = ItemId.RussetPotato;
      box.cargoCount = 6;

      stepMany(state, 600);

      // Everything that left the box is on the belt or was handed off its end; nothing evaporated.
      expect(box.cargoCount).toBeLessThan(6);
      expect(sink.items.length + (arm.held === 0 ? 0 : 1)).toBeGreaterThan(0);
      expect(sink.items.every((entry) => entry.item === ItemId.RussetPotato)).toBe(true);
    });

    it(`a ${name} holding one product refuses a second rather than mixing`, () => {
      // "What is in this" has to stay one word. The arm reads that refusal before it grabs, so the
      // chips stay on the belt where the player can see the jam rather than in a frozen claw.
      const { state, source, arm, box } = fillRig(9103, kind);
      box.cargoItem = ItemId.RussetPotato;
      box.cargoCount = 1;
      beltInsert(source, 0, ItemId.PlainChips, 0);

      stepMany(state, 400);

      expect(arm.held).toBe(0);
      expect(box.cargoItem).toBe(ItemId.RussetPotato);
      expect(box.cargoCount).toBe(1);
      expect(source.items).toHaveLength(1);
      expect(lampOf(state, arm.id)).toBe(LampState.Blocked);
    });

    it(`a full ${name} stops the arm, and one unit of room starts it again`, () => {
      const { state, source, arm, box } = fillRig(9104, kind);
      const spec = machineSpec(kind)!;
      box.cargoItem = ItemId.RussetPotato;
      box.cargoCount = spec.inputCapacity;
      beltInsert(source, 0, ItemId.RussetPotato, 0);

      stepMany(state, 400);
      expect(arm.held).toBe(0);
      expect(source.items).toHaveLength(1);
      expect(box.cargoCount).toBe(spec.inputCapacity);
      expect(lampOf(state, arm.id)).toBe(LampState.Blocked);

      box.cargoCount -= 1;
      stepMany(state, 200);
      expect(source.items).toHaveLength(0);
      expect(box.cargoCount).toBe(spec.inputCapacity);
    });

    it(`a filter reads a ${name} exactly as it reads a shelf`, () => {
      const wrong = drainRig(9105, kind, ItemId.PlainChips);
      wrong.box.cargoItem = ItemId.RussetPotato;
      wrong.box.cargoCount = 4;
      stepMany(wrong.state, 400);
      expect(wrong.box.cargoCount, 'a filtered arm leaves what it did not ask for').toBe(4);
      expect(wrong.sink.items).toHaveLength(0);

      const right = drainRig(9106, kind, ItemId.RussetPotato);
      right.box.cargoItem = ItemId.RussetPotato;
      right.box.cargoCount = 4;
      stepMany(right.state, 400);
      expect(right.box.cargoCount).toBeLessThan(4);
    });

    it(`the hand and the arm agree about what a full ${name} is`, () => {
      // Both doors are one function since this item, so this is a tautology by construction —
      // which is precisely why it is worth pinning. The day somebody re-inlines the arithmetic
      // into `applyLoadMachine`, this is the test that notices.
      const { state, box } = fillRig(9107, kind);
      const spec = machineSpec(kind)!;
      standOn(state, box.tileX, box.tileY);
      addItem(state, ItemId.RussetPotato, spec.inputCapacity + 10);

      run(state, [
        {
          type: 'LoadMachine',
          machineId: box.id,
          count: spec.inputCapacity + 10,
          item: ItemId.RussetPotato,
        },
      ]);
      expect(box.cargoCount).toBe(spec.inputCapacity);
      expect(itemCount(state, ItemId.RussetPotato)).toBe(10);

      // And the same box refuses corn from the hand for the same reason it refuses it from a belt.
      addItem(state, ItemId.PlainChips, 5);
      run(state, [{ type: 'LoadMachine', machineId: box.id, count: 5, item: ItemId.PlainChips }]);
      expect(box.cargoItem).toBe(ItemId.RussetPotato);
      expect(itemCount(state, ItemId.PlainChips)).toBe(5);

      // Emptied by hand, in one armful, since item 068 struck the cap.
      run(state, [{ type: 'UnloadMachine', machineId: box.id, count: 999 }]);
      expect(box.cargoCount).toBe(0);
      expect(box.cargoItem).toBe(0);
      expect(itemCount(state, ItemId.RussetPotato)).toBe(spec.inputCapacity + 10);
    });

    it(`a load with no item named is refused at a ${name}, and nothing is lost`, () => {
      // The refusal that made the cellar look broken from the client: a box has no recipe, so
      // "load whatever fits" names nothing it could fit. It is the CALLER's job to say — see the
      // errand's `IntentAction.Load`, which used to forget.
      const { state, box } = fillRig(9108, kind);
      standOn(state, box.tileX, box.tileY);
      addItem(state, ItemId.RussetPotato, 20);

      run(state, [{ type: 'LoadMachine', machineId: box.id, count: 20 }]);

      expect(box.cargoCount).toBe(0);
      expect(itemCount(state, ItemId.RussetPotato)).toBe(20);
    });
  }

  it('A CART IN TOW IS NOT A SHELF — an arm may not pick the player’s pocket', () => {
    // The one place the two boxes differ, and it is the cart's own spec that says so: "hitch it
    // and it follows you at a cost in speed; PARK IT AND IT IS A BOX". Parked, it is furniture an
    // arm may empty. Towed, it is the load on the player's back, and it moves with them — an arm
    // that drained it would be stealing from a target that walks past once a minute.
    //
    // The player stands ON the cart's tile, so hitching changes the geometry not at all and the
    // tow is genuinely the only variable.
    const { state, box, arm, sink } = drainRig(9109, MachineKind.HandCart);
    box.cargoItem = ItemId.RussetPotato;
    box.cargoCount = 6;
    standOn(state, box.tileX, box.tileY);

    run(state, [{ type: 'HitchCart', cartId: box.id }]);
    expect(state.player.towedCartId).toBe(box.id);

    stepMany(state, 400);
    expect(box.cargoCount, 'the towed cart was raided').toBe(6);
    expect(sink.items).toHaveLength(0);
    expect(arm.held).toBe(0);

    // CONTROL: let go, and the same arm empties the same cart within the minute. Without this the
    // test above would pass on a rig that was never going to move.
    run(state, [{ type: 'UnhitchCart' }]);
    stepMany(state, 400);
    expect(box.cargoCount).toBeLessThan(6);
  });

  it('and an arm may not stuff a towed cart either — the gate is on both doors', () => {
    const { state, source, arm, box } = fillRig(9110, MachineKind.HandCart);
    standOn(state, box.tileX, box.tileY);
    run(state, [{ type: 'HitchCart', cartId: box.id }]);
    beltInsert(source, 0, ItemId.RussetPotato, 0);

    stepMany(state, 400);
    expect(box.cargoCount).toBe(0);
    expect(source.items).toHaveLength(1);
    expect(arm.held).toBe(0);
    // Red, not amber: there IS something to take, and the thing in front will not have it.
    expect(lampOf(state, arm.id)).toBe(LampState.Blocked);

    // CONTROL, again: park it and it is a box.
    run(state, [{ type: 'UnhitchCart' }]);
    stepMany(state, 200);
    expect(box.cargoCount).toBe(1);
  });

  it('the hand still loads and unloads a cart it is towing — the gate is the ARM’s', () => {
    // The reason the tow gate lives in `belts.ts` and not inside the door primitive both callers
    // share. Loading the cart you are pushing is the entire point of pushing one.
    const state = createWorld(9111);
    const cart = spawnMachine(state, MachineKind.HandCart, 5, 5)!;
    standOn(state, 5, 5);
    addItem(state, ItemId.RussetPotato, 10);
    run(state, [{ type: 'HitchCart', cartId: cart.id }]);

    run(state, [{ type: 'LoadMachine', machineId: cart.id, count: 10, item: ItemId.RussetPotato }]);
    expect(cart.cargoCount).toBe(10);

    run(state, [{ type: 'UnloadMachine', machineId: cart.id, count: 10 }]);
    expect(cart.cargoCount).toBe(0);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(10);
  });
});

describe('the belt junction', () => {
  // ONE DEVICE, TWO NAMES. Plan §5 asks for splitters and mergers; built honestly they are the
  // same tile, and which one it is doing is decided by the belts around it rather than by a menu.
  // These tests are that claim, from both sides.

  /** Feed belt west of the junction, and whichever output belts the caller asks for. */
  function junctionRig(
    seed: number,
    outputs: readonly { tileX: number; tileY: number; dir: Direction }[],
  ) {
    const state = createWorld(seed);
    const feed = spawnBelt(state, BeltTier.Basic, 0, 5, Direction.East, 3)!;
    spawnMachine(state, MachineKind.BeltJunction, 3, 5);
    const out = outputs.map((spec) =>
      spawnBelt(state, BeltTier.Basic, spec.tileX, spec.tileY, spec.dir, 4)!,
    );
    return { state, feed, out };
  }

  it('alternates between two outputs, deterministically and without a roll', () => {
    const { state, feed, out } = junctionRig(101, [
      { tileX: 4, tileY: 5, dir: Direction.East },
      { tileX: 3, tileY: 4, dir: Direction.North },
    ]);
    for (let i = 0; i < 6; i++) beltInsert(feed, i * 64, ItemId.PlainChips, 0);

    stepMany(state, 900);

    // Three each. A splitter that favoured one side would show up here as 6 and 0, and a
    // splitter that alternated on the tick counter would show up as an off-by-one that moves
    // depending on when the rig was built.
    expect(feed.items).toHaveLength(0);
    expect(out[0]!.items).toHaveLength(3);
    expect(out[1]!.items).toHaveLength(3);
  });

  it('produces the same hash from the same rig on two separate runs', () => {
    // ITEM 024'S CRITERION, LITERALLY: same seed, same command list, same hash. The round-robin
    // cursor is world state and lives in the digest, so this would fail the day somebody made
    // the alternation depend on iteration order, wall time, or the tick counter.
    const a = junctionRig(202, [
      { tileX: 4, tileY: 5, dir: Direction.East },
      { tileX: 3, tileY: 4, dir: Direction.North },
    ]);
    const b = junctionRig(202, [
      { tileX: 4, tileY: 5, dir: Direction.East },
      { tileX: 3, tileY: 4, dir: Direction.North },
    ]);
    for (let i = 0; i < 5; i++) {
      beltInsert(a.feed, i * 64, ItemId.PlainChips, 0);
      beltInsert(b.feed, i * 64, ItemId.PlainChips, 0);
    }

    stepMany(a.state, 700);
    stepMany(b.state, 700);
    expect(hashState(a.state)).toBe(hashState(b.state));
    // And the cursor actually moved, so the assertion above is not comparing two idle worlds.
    const junction = a.state.machines.find((m) => m.kind === MachineKind.BeltJunction)!;
    expect(junction.junctionOutCursor + junction.junctionInCursor).toBeGreaterThan(0);
  });

  it('merges two lines into one, taking from each in turn', () => {
    const state = createWorld(303);
    // Two belts pointing at the junction from opposite sides, one belt leading away.
    const west = spawnBelt(state, BeltTier.Basic, 0, 5, Direction.East, 3)!;
    const north = spawnBelt(state, BeltTier.Basic, 3, 2, Direction.South, 3)!;
    spawnMachine(state, MachineKind.BeltJunction, 3, 5);
    const out = spawnBelt(state, BeltTier.Basic, 4, 5, Direction.East, 8)!;

    for (let i = 0; i < 4; i++) {
      beltInsert(west, i * 64, ItemId.RussetPotato, 0);
      beltInsert(north, i * 64, ItemId.PlainChips, 0);
    }

    stepMany(state, 1200);

    // Both queues emptied. A merger that scanned its faces in a fixed order without a cursor
    // would drain the lower-numbered one first and starve the other until it was done, which is
    // the failure this alternation exists to prevent.
    expect(west.items).toHaveLength(0);
    expect(north.items).toHaveLength(0);
    expect(out.items).toHaveLength(8);

    // And they arrived interleaved rather than in two blocks.
    const kinds = out.items.map((entry) => entry.item);
    const alternations = kinds.filter((item, i) => i > 0 && item !== kinds[i - 1]).length;
    expect(alternations).toBeGreaterThan(4);
  });

  it('never hands an item back to the belt it arrived on', () => {
    // The one-rule version of "no ping-pong": a belt pointed at the junction is an input, so it
    // can never be chosen as an output. With nowhere else to go the item simply stays put, and
    // the belt behind it backs up — which is the jam plan §5 wants the player to be able to see.
    const { state, feed } = junctionRig(404, []);
    beltInsert(feed, 0, ItemId.PlainChips, 0);
    beltInsert(feed, 64, ItemId.PlainChips, 0);

    stepMany(state, 400);
    expect(feed.items).toHaveLength(2);
    expect(feed.items[1]!.dist).toBe(3 * SUBTILE - 1);
  });

  it('holds nothing of its own, so it can never swallow an item', () => {
    // A junction has no buffer at all: an item crosses inside one tick or it is still on a belt.
    // Count the world's goods before and after a run that jams — none may be inside the tile.
    const { state, feed, out } = junctionRig(505, [{ tileX: 4, tileY: 5, dir: Direction.East }]);
    for (let i = 0; i < 4; i++) beltInsert(feed, i * 64, ItemId.PlainChips, 0);

    stepMany(state, 2000);
    expect(feed.items.length + out[0]!.items.length).toBe(4);
  });

  it('takes no dial, wears nothing, and runs no work cycle', () => {
    // It is a belt fitting that happens to be built and boxed like a machine. A junction that
    // could wear out would put a maintenance chore in the middle of the run the belts exist to
    // remove, and a junction with a Speed dial would be a number in the belt layer.
    const spec = machineSpec(MachineKind.BeltJunction)!;
    expect(spec.workPerOperation).toBe(0);
    expect(spec.wearPerOperation).toBe(0);
    expect(acceptsUpgrades(spec)).toBe(false);
  });
});

// --- withering ----------------------------------------------------------------------

describe('withering', () => {
  it('walks a crop from mature through drooping to Day-Old, then to compost', () => {
    const state = createWorld(21);
    const tileX = FIELD_ORIGIN_X;
    const tileY = FIELD_ORIGIN_Y;
    standOn(state, tileX, tileY);

    run(state, [
      { type: 'PlantTile', tileX, tileY, crop: CropId.RussetPotato },
      { type: 'WaterTile', tileX, tileY },
      { type: 'PlantTile', tileX: tileX + 1, tileY, crop: CropId.RussetPotato },
      { type: 'WaterTile', tileX: tileX + 1, tileY },
    ]);

    // One watering carries a potato all the way to ready: 3,600 moisture outlasts the
    // ~2,000 ticks of growth it needs.
    stepMany(state, 2_500);
    const tile = tileAt(state, tileX, tileY)!;
    expect(tile.growth).toBeGreaterThanOrEqual(tile.growthTarget);
    expect(wiltStageForAge(tile.readyAge)).toBe(WiltStage.Fresh);

    // Thirty active minutes of grace, chosen so a maturing field cannot yank the player out
    // of a build project. Do not shorten it to "make it feel like a game".
    stepMany(state, WILT_GRACE_TICKS);
    expect(wiltStageForAge(tile.readyAge)).toBe(WiltStage.Wilting);

    stepMany(state, WILT_WINDOW_TICKS);
    expect(wiltStageForAge(tile.readyAge)).toBe(WiltStage.Wilted);

    // Harvested wilted: the Day-Old good, not the fresh one, and not nothing.
    const before = itemCount(state, ItemId.DayOldPotato);
    run(state, [{ type: 'HarvestTile', tileX, tileY }]);
    expect(itemCount(state, ItemId.DayOldPotato)).toBeGreaterThan(before);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);

    // The neighbour was never picked. It becomes compost on the tile, and the tile is
    // immediately replantable — there is no path here that pays zero.
    stepMany(state, COMPOST_AFTER_TICKS + 10);
    const neighbour = tileAt(state, tileX + 1, tileY)!;
    expect(neighbour.crop).toBe(CropId.None);
    expect(neighbour.compost).toBeGreaterThan(0);

    run(state, [{ type: 'HarvestTile', tileX: tileX + 1, tileY }]);
    expect(itemCount(state, ItemId.Compost)).toBeGreaterThan(0);
    expect(tileAt(state, tileX + 1, tileY)!.compost).toBe(0);
  });

  it('prices every Day-Old good at exactly half its fresh one, floored', () => {
    // Plan §4's 50%, with the rounding policy stated once in `dayOldPriceCents` and the
    // item table required to agree with it.
    for (const crop of CROP_SPECS) {
      expect(listPriceCents(crop.dayOldItem)).toBe(dayOldPriceCents(crop.yieldItem));
    }
  });

  it('advances the withering clock only while the world is ticking', () => {
    // Freshness counts active factory minutes and nothing else (plan §4, §6). There is no
    // wall clock in this package, so a world that is not stepped cannot age — which is the
    // whole "your factory is exactly where you left it" promise, held structurally.
    const state = createWorld(22);
    standOn(state, FIELD_ORIGIN_X, FIELD_ORIGIN_Y);
    run(state, [
      {
        type: 'PlantTile',
        tileX: FIELD_ORIGIN_X,
        tileY: FIELD_ORIGIN_Y,
        crop: CropId.RussetPotato,
      },
      { type: 'WaterTile', tileX: FIELD_ORIGIN_X, tileY: FIELD_ORIGIN_Y },
    ]);
    stepMany(state, 3_000);

    const parked = hashState(state);
    expect(hashState(state)).toBe(parked);
    expect(tileAt(state, FIELD_ORIGIN_X, FIELD_ORIGIN_Y)!.readyAge).toBeGreaterThan(0);
  });
});

// --- zones --------------------------------------------------------------------------

describe('zones', () => {
  it('records a whole drag as exactly one trace entry', () => {
    // The rect is the payload precisely so a sixty-tile paint is one entry, not sixty.
    const state = createWorld(31);
    const before = state.trace.length;
    run(state, [
      {
        type: 'CreateZone',
        rect: { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: 6, h: 6 },
        crop: CropId.RussetPotato,
      },
    ]);
    expect(state.trace.length).toBe(before + 1);
    expect(state.zones).toHaveLength(1);

    let painted = 0;
    for (const tile of state.field) if (tile.zone === state.zones[0]!.id) painted += 1;
    expect(painted).toBe(36);
  });

  it('reassigns overlapping tiles and deletes a zone that loses its last one', () => {
    const state = createWorld(32);
    run(state, [
      {
        type: 'CreateZone',
        rect: { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: 2, h: 2 },
        crop: CropId.None,
      },
    ]);
    const first = state.zones[0]!.id;
    run(state, [
      {
        type: 'CreateZone',
        rect: { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: 4, h: 4 },
        crop: CropId.None,
      },
    ]);

    // A tile belongs to at most one zone, so "47 / 60" is never ambiguous.
    expect(state.zones).toHaveLength(1);
    expect(state.zones[0]!.id).not.toBe(first);
  });

  it('refuses auto-replant until the seed hopper is researched', () => {
    // Locked in the simulation, not just in the UI — a disabled button is a suggestion.
    const state = createWorld(33);
    run(state, [
      {
        type: 'CreateZone',
        rect: { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: 2, h: 2 },
        crop: CropId.RussetPotato,
      },
    ]);
    const zoneId = state.zones[0]!.id;

    run(state, [{ type: 'SetZoneAutoReplant', zoneId, on: true }]);
    expect(state.zones[0]!.autoReplant).toBe(false);

    state.moneyCents = 10_000_000;
    for (const id of [TechId.Finishing, TechId.WorkshopCharter]) void id;
    state.unlocked = [TechId.AutoReplant];
    run(state, [{ type: 'SetZoneAutoReplant', zoneId, on: true }]);
    expect(state.zones[0]!.autoReplant).toBe(true);
  });

  it('plants an empty zone tile from the seed bag once the hopper is armed', () => {
    const state = createWorld(34);
    state.unlocked = [TechId.AutoReplant];
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);

    run(state, [
      {
        type: 'CreateZone',
        rect: { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: 2, h: 2 },
        crop: CropId.RussetPotato,
      },
    ]);
    const zoneId = state.zones[0]!.id;
    // The hopper serves the zone on the very tick it is armed — systems run after commands.
    run(state, [{ type: 'SetZoneAutoReplant', zoneId, on: true }]);
    stepMany(state, 200);

    let planted = 0;
    for (const tile of state.field) if (tile.crop !== CropId.None) planted += 1;
    expect(planted).toBe(4);
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seedsBefore - 4);
    // Automation the player bought must not score as if they had bent down themselves.
    expect(state.stats.touches.handPlant).toBe(0);
  });

  it('publishes a zone readout through the view as plain numbers', () => {
    const state = createWorld(35);
    run(state, [
      {
        type: 'CreateZone',
        rect: { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: 3, h: 2 },
        crop: CropId.RussetPotato,
      },
    ]);
    standOn(state, FIELD_ORIGIN_X, FIELD_ORIGIN_Y);
    run(state, [
      {
        type: 'PlantTile',
        tileX: FIELD_ORIGIN_X,
        tileY: FIELD_ORIGIN_Y,
        crop: CropId.RussetPotato,
      },
    ]);

    const projected = view(state, createWorldView());
    expect(projected.zones).toHaveLength(1);
    expect(projected.zones[0]!.tiles).toBe(6);
    expect(projected.zones[0]!.planted).toBe(1);
    expect(projected.zones[0]!.name).toBe(state.zones[0]!.name);
    // Plain enough to survive the trip a Worker would put it through.
    expect(() => JSON.stringify(projected)).not.toThrow();
  });
});

// --- the tree and the dials ---------------------------------------------------------

describe('tech and upgrades', () => {
  it('gives tech nodes nowhere to hide a stat bonus', () => {
    // THE ANTI-DOUBLE-DIP RULE, ENFORCED STRUCTURALLY (plan §3). Nodes unlock verbs; dials
    // scale numbers; neither does the other. A "+20% fryer speed" node cannot be added
    // without changing this key set, which is exactly the friction the rule wants.
    const allowed = ['id', 'branch', 'priceCents', 'requires', 'milestone', 'milestoneAmount'];
    for (const node of TECH_NODES) {
      expect(Object.keys(node).sort()).toEqual([...allowed].sort());
    }
  });

  it('keeps every node reachable through prerequisites that exist', () => {
    const ids = new Set(TECH_NODES.map((node) => node.id));
    for (const node of TECH_NODES) {
      for (const required of node.requires) expect(ids.has(required)).toBe(true);
    }
  });

  it('gates machines and crops on research rather than on money alone', () => {
    const state = createWorld(41);
    state.moneyCents = 1_000_000;
    run(state, [{ type: 'PlaceMachine', kind: MachineKind.Fryer, tileX: 0, tileY: 0 }]);
    expect(state.machines.some((machine) => machine.kind === MachineKind.Fryer)).toBe(false);

    state.unlocked = [TechId.WashAndSlice, TechId.Fryer];
    run(state, [{ type: 'PlaceMachine', kind: MachineKind.Fryer, tileX: 0, tileY: 0 }]);
    expect(state.machines.some((machine) => machine.kind === MachineKind.Fryer)).toBe(true);
  });

  it('holds a Charter behind money AND a visible milestone', () => {
    const state = createWorld(42);
    state.moneyCents = 1_000_000;
    state.unlocked = [TechId.WashAndSlice, TechId.Fryer, TechId.Finishing];

    run(state, [{ type: 'ResearchTech', techId: TechId.WorkshopCharter }]);
    expect(state.unlocked).not.toContain(TechId.WorkshopCharter);

    state.stats.itemsSold = 200;
    run(state, [{ type: 'ResearchTech', techId: TechId.WorkshopCharter }]);
    expect(state.unlocked).toContain(TechId.WorkshopCharter);
  });

  it('holds the Corporate Charter behind a line that has run itself for ten days', () => {
    // Plan §3's third Charter: money PLUS "one line untouched for 10 in-game days". The counter
    // is `longestUntouchedMachineTicks`, an in-game day is 9,600 ticks (plan §2: the day runs
    // eight real minutes), and ten of them is 96,000.
    const state = createWorld(44);
    state.moneyCents = 10_000_000;
    state.unlocked = [
      TechId.WashAndSlice,
      TechId.Fryer,
      TechId.Finishing,
      TechId.WorkshopCharter,
      TechId.Belts,
      TechId.AssemblyCharter,
    ];

    // One day short. The money is fine and the node is still refused, which is the half of the
    // gate that makes it a Charter rather than a purchase.
    state.stats.longestUntouchedMachineTicks = 9 * TICKS_PER_IN_GAME_DAY;
    run(state, [{ type: 'ResearchTech', techId: TechId.CorporateCharter }]);
    expect(state.unlocked).not.toContain(TechId.CorporateCharter);
    expect(state.moneyCents).toBe(10_000_000);

    state.stats.longestUntouchedMachineTicks = 10 * TICKS_PER_IN_GAME_DAY;
    run(state, [{ type: 'ResearchTech', techId: TechId.CorporateCharter }]);
    expect(state.unlocked).toContain(TechId.CorporateCharter);
  });

  it('runs the untouched clock only while a machine is actually working', () => {
    // The milestone is about a PRODUCTION line. A machine standing idle in a corner is untouched
    // in the sense that nobody visits it, and that is exactly the sense plan §3 does not mean —
    // ten days of a Fryer with nothing to fry would be a Charter earned by neglect.
    const state = createWorld(45);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;

    stepMany(state, 200);
    expect(washer.untouchedTicks).toBe(0);
    expect(state.stats.longestUntouchedMachineTicks).toBe(0);

    washer.inputCounts[0] = 4;
    stepMany(state, 50);
    expect(washer.untouchedTicks).toBeGreaterThan(0);
    expect(state.stats.longestUntouchedMachineTicks).toBe(washer.untouchedTicks);
  });

  it('puts the untouched clock back to zero the moment a hand lands on the machine', () => {
    const state = createWorld(46);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    standOn(state, 0, 0);
    washer.inputCounts[0] = 20;
    addItem(state, ItemId.RussetPotato, 1);

    stepMany(state, 100);
    const beforeTouch = washer.untouchedTicks;
    expect(beforeTouch).toBeGreaterThan(0);

    run(state, [{ type: 'LoadMachine', machineId: washer.id, count: 1 }]);
    // Back to zero on the tick the hand landed — and then one tick of work, because `step()`
    // applies the command and then advances the machine, in that order.
    expect(washer.untouchedTicks).toBeLessThanOrEqual(1);
    expect(washer.untouchedTicks).toBeLessThan(beforeTouch);

    // The high-water mark survives the touch, which is the whole reason it is a mark: a player
    // who demonstrated ten days and then refilled a hopper on the walk to the tech panel has
    // still demonstrated ten days.
    expect(state.stats.longestUntouchedMachineTicks).toBe(beforeTouch);
  });

  it('does not count a grabber feeding the hopper as a hand on the machine', () => {
    // The line running itself is the thing being demonstrated, so the machinery doing its job
    // must not reset the clock — only the player's hands do.
    const state = createWorld(47);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    const slicer = spawnMachine(state, MachineKind.Slicer, 3, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, 0);
    washer.inputCounts[0] = 30;

    stepMany(state, 400);
    expect(slicer.inputCounts[0]! + slicer.opCount).toBeGreaterThan(0);
    expect(washer.untouchedTicks).toBeGreaterThan(300);
  });

  it('makes the Speed dial faster and hungrier, and Efficiency the antidote', () => {
    const state = createWorld(43);
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    const spec = machineSpec(MachineKind.Fryer)!;

    const baseRate = effectiveWorkRate(spec, fryer);
    const baseWear = effectiveWear(spec, fryer);

    fryer.speedLevel = 3;
    expect(effectiveWorkRate(spec, fryer)).toBeGreaterThan(baseRate);
    expect(effectiveWear(spec, fryer)).toBeGreaterThan(baseWear);

    fryer.efficiencyLevel = 3;
    expect(effectiveWear(spec, fryer)).toBeLessThan(
      effectiveWear(spec, { ...fryer, efficiencyLevel: 0 }),
    );
    // Never free: the expensive track buys a discount, not a machine that never wears.
    expect(effectiveWear(spec, fryer)).toBeGreaterThan(0);

    fryer.capacityLevel = 2;
    expect(effectiveInputCapacity(spec, fryer)).toBe(spec.inputCapacity * 3);
  });

  it('escalates dial costs so maxing one machine competes with buying a second', () => {
    const spec = machineSpec(MachineKind.Fryer)!;
    let total = 0;
    for (let level = 0; level < UPGRADE_MAX_LEVEL; level++) {
      const cost = upgradeCostCents(spec, level, UpgradeDial.Speed);
      expect(cost).toBeGreaterThan(0);
      total += cost;
    }
    expect(upgradeCostCents(spec, UPGRADE_MAX_LEVEL, UpgradeDial.Speed)).toBe(-1);
    expect(total).toBeGreaterThan(spec.priceCents * 3);
  });

  it('charges more for Efficiency than for the other two dials', () => {
    // Plan §3 calls Efficiency "the expensive track", and until the dial's waste half landed
    // that was a comment rather than a price. It now cuts wear AND stretches the waste cadence,
    // which makes it the strongest dial on a hard-run machine — so it costs half again as much.
    const spec = machineSpec(MachineKind.Fryer)!;
    for (let level = 0; level < UPGRADE_MAX_LEVEL; level++) {
      const speed = upgradeCostCents(spec, level, UpgradeDial.Speed);
      const efficiency = upgradeCostCents(spec, level, UpgradeDial.Efficiency);
      const capacity = upgradeCostCents(spec, level, UpgradeDial.Capacity);
      expect(speed).toBe(capacity);
      expect(efficiency).toBeGreaterThan(speed);
    }
  });

  it('refuses a dial until the upgrade bench is bought, then charges for it', () => {
    const state = createWorld(44);
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!;
    standOn(state, 0, 0);
    state.moneyCents = 100_000;

    run(state, [{ type: 'UpgradeMachine', machineId: kitchen.id, dial: UpgradeDial.Speed }]);
    expect(kitchen.speedLevel).toBe(0);

    state.unlocked = [TechId.UpgradeBench];
    const before = state.moneyCents;
    run(state, [{ type: 'UpgradeMachine', machineId: kitchen.id, dial: UpgradeDial.Speed }]);
    expect(kitchen.speedLevel).toBe(1);
    expect(state.moneyCents).toBeLessThan(before);
    // Net worth invoices the machine at what it cost, upgrades included.
    expect(kitchen.investedCents).toBeGreaterThan(machineSpec(MachineKind.ChipKitchen)!.priceCents);
  });
});

// --- nothing vanishes ----------------------------------------------------------------

describe('the anti-softlock floor', () => {
  it('hands a torn-up belt and its cargo straight back to the player', () => {
    // Misplacement is never a fine (plan §4), and nothing on the belt is destroyed.
    const state = createWorld(51);
    state.moneyCents = 100_000;
    state.unlocked = [TechId.Belts];
    run(state, [
      {
        type: 'PlaceBelt',
        tier: BeltTier.Basic,
        tileX: 0,
        tileY: 0,
        dir: Direction.East,
        lengthTiles: 3,
      },
    ]);
    const belt = state.belts[0]!;
    beltInsert(belt, 0, ItemId.PlainChips, 0);
    beltInsert(belt, 128, ItemId.PlainChips, 0);

    const money = state.moneyCents;
    run(state, [{ type: 'RemoveBelt', beltId: belt.id }]);
    expect(state.belts).toHaveLength(0);
    expect(state.moneyCents).toBeGreaterThan(money);
    expect(itemCount(state, ItemId.PlainChips)).toBe(2);
  });

  it('does not let a refund count as earnings', () => {
    // First Ten is lifetime NET earnings. Buying and re-selling the same belt forever has
    // to land exactly where it started.
    const state = createWorld(52);
    state.moneyCents = 100_000;
    state.unlocked = [TechId.Belts];
    const netBefore = state.stats.lifetimeEarnedCents - state.stats.lifetimeSpentCents;

    run(state, [
      {
        type: 'PlaceBelt',
        tier: BeltTier.Basic,
        tileX: 0,
        tileY: 0,
        dir: Direction.East,
        lengthTiles: 4,
      },
    ]);
    run(state, [{ type: 'RemoveBelt', beltId: state.belts[0]!.id }]);

    expect(state.stats.lifetimeEarnedCents - state.stats.lifetimeSpentCents).toBe(netBefore);
  });
});

// --- rotation (item 052) --------------------------------------------------------------

describe('rotating a placed grabber', () => {
  function armAt(state: WorldState, dir: Direction): number {
    return spawnGrabber(state, GrabberTier.Mk1, 1, 1, dir, 0)!.id;
  }

  it('turns one step clockwise per press, all the way round', () => {
    // N → E → S → W → N. Four presses is a full turn and the fourth must land back where it
    // started, or "press R until it looks right" stops being a thing a player can do.
    const state = createWorld(61);
    standOn(state, 1, 1);
    const id = armAt(state, Direction.North);

    const seen: Direction[] = [];
    for (let i = 0; i < 4; i++) {
      run(state, [{ type: 'RotateGrabber', grabberId: id }]);
      seen.push(state.grabbers[0]!.dir);
    }
    expect(seen).toEqual([Direction.East, Direction.South, Direction.West, Direction.North]);
  });

  it('is one trace entry per press, and refuses an unknown arm', () => {
    const state = createWorld(62);
    standOn(state, 1, 1);
    const id = armAt(state, Direction.North);

    const before = state.trace.length;
    run(state, [{ type: 'RotateGrabber', grabberId: id }]);
    expect(state.trace.length).toBe(before + 1);

    run(state, [{ type: 'RotateGrabber', grabberId: id + 999 }]);
    expect(state.trace.length).toBe(before + 1);
  });

  it('refuses out of reach, and changes the arm the moment it is in reach', () => {
    // Item 052 asks for "one keypress standing next to it". Standing across the lot is not it.
    const state = createWorld(63);
    standOn(state, 12, 12);
    const id = armAt(state, Direction.North);

    run(state, [{ type: 'RotateGrabber', grabberId: id }]);
    expect(state.grabbers[0]!.dir).toBe(Direction.North);

    standOn(state, 1, 1);
    run(state, [{ type: 'RotateGrabber', grabberId: id }]);
    expect(state.grabbers[0]!.dir).toBe(Direction.East);
  });

  it('keeps what the arm is holding, because nothing ever vanishes', () => {
    const state = createWorld(64);
    standOn(state, 1, 1);
    const id = armAt(state, Direction.North);
    state.grabbers[0]!.held = ItemId.PlainChips;

    run(state, [{ type: 'RotateGrabber', grabberId: id }]);
    expect(state.grabbers[0]!.held).toBe(ItemId.PlainChips);
  });
});

// --- deconstruct to inventory (item 054) ----------------------------------------------

describe('boxing a machine', () => {
  /** How many Chip Kitchens are standing. The world always has a sell bin besides. */
  function kitchens(state: WorldState): number {
    return state.machines.filter((machine) => machine.kind === MachineKind.ChipKitchen).length;
  }

  /** A kitchen the player is standing next to, with the given dials already bought. */
  function kitchen(state: WorldState, speed: number, capacity: number): Machine {
    const machine = spawnMachine(state, MachineKind.ChipKitchen, 1, 1)!;
    machine.speedLevel = speed;
    machine.capacityLevel = capacity;
    machine.investedCents = machineSpec(MachineKind.ChipKitchen)!.priceCents + 18_000;
    standOn(state, 1, 1);
    return machine;
  }

  it('takes the machine off the lot and pays nothing for it', () => {
    // Boxing is the rearranging verb. A deconstruct that paid out would make demolishing a
    // factory a business model, which is exactly what item 054 rules out.
    const state = createWorld(70);
    const machine = kitchen(state, 2, 1);
    const money = state.moneyCents;

    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);

    expect(kitchens(state)).toBe(0);
    expect(state.moneyCents).toBe(money);
    expect(itemCount(state, ItemId.BoxedChipKitchen)).toBe(1);
  });

  it('puts it back down for free, as the machine it was', () => {
    const state = createWorld(71);
    const machine = kitchen(state, 2, 1);
    const invoice = machine.investedCents;
    machine.condition = 640;

    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    const money = state.moneyCents;
    run(state, [{ type: 'PlaceMachine', kind: MachineKind.ChipKitchen, tileX: 5, tileY: 1 }]);

    const back = state.machines.find((m) => m.kind === MachineKind.ChipKitchen)!;
    expect(state.moneyCents).toBe(money);
    expect(back.speedLevel).toBe(2);
    expect(back.capacityLevel).toBe(1);
    expect(back.condition).toBe(640);
    expect(back.investedCents).toBe(invoice);
    expect(itemCount(state, ItemId.BoxedChipKitchen)).toBe(0);
  });

  it('leaves net worth exactly where it was, round trip', () => {
    // The one number every leaderboard board is read off (plan §6). If boxing moved it, a
    // player could farm net worth by picking machines up and putting them down.
    const state = createWorld(72);
    const machine = kitchen(state, 3, 0);
    machine.condition = 517;
    const before = computeNetWorthCents(state);

    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    expect(computeNetWorthCents(state)).toBe(before);

    run(state, [{ type: 'PlaceMachine', kind: MachineKind.ChipKitchen, tileX: 5, tileY: 1 }]);
    expect(computeNetWorthCents(state)).toBe(before);
  });

  it('spills the hoppers and the output buffer — nothing vanishes', () => {
    const state = createWorld(73);
    const machine = kitchen(state, 0, 0);
    machine.inputCounts[0] = 7;
    machine.outputCount = machineSpec(MachineKind.ChipKitchen)!.outputCapacity;
    const bags = machine.outputCount;

    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);

    expect(itemCount(state, ItemId.RussetPotato)).toBe(7);
    expect(itemCount(state, ItemId.BaggedChips)).toBe(bags);
  });

  it('refuses a jammed machine, and a machine that is actually running', () => {
    const state = createWorld(74);
    const machine = kitchen(state, 0, 0);

    machine.jammed = true;
    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    expect(kitchens(state)).toBe(1);

    // Fed, with room to put the result: it is turning, so it is not a box.
    machine.jammed = false;
    machine.inputCounts[0] = 4;
    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    expect(kitchens(state)).toBe(1);

    // Starved: stopped, so it boxes.
    machine.inputCounts[0] = 0;
    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    expect(kitchens(state)).toBe(0);
  });

  it('boxes an upgraded machine even though it is holding leftover work-points', () => {
    // THE TRAP THIS RULE EXISTS TO AVOID. A Speed dial rarely divides the operation cost
    // evenly, so an upgraded machine rests with `progress > 0` forever. Refusing on that
    // would make the dial a permanent ban on boxing — and "an upgraded machine can be
    // deconstructed" is the feature's first acceptance criterion.
    const state = createWorld(75);
    const machine = kitchen(state, 3, 0);
    machine.progress = 117;

    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    expect(kitchens(state)).toBe(0);
  });

  it('refuses the sell bin, because a lot with no stand cannot trade', () => {
    const state = createWorld(76);
    const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
    standOn(state, bin.tileX, bin.tileY);

    run(state, [{ type: 'DeconstructMachine', machineId: bin.id }]);
    expect(state.machines.some((m) => m.kind === MachineKind.SellBin)).toBe(true);
  });

  it('refuses out of reach, like every other machine verb', () => {
    const state = createWorld(77);
    const machine = kitchen(state, 0, 0);
    standOn(state, 14, 14);

    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);
    expect(kitchens(state)).toBe(1);
  });

  it('drops a ported machine out of its network on the same tick it leaves', () => {
    // A stale membership list is a ledger dividing supply among a machine that is in the
    // player's bag. `MoveMachine` recomputes for the same reason; so must this.
    const state = createWorld(78);
    for (let y = 0; y < 3; y++) spawnPipe(state, 2, y, LiquidId.Water);
    const tank = spawnMachine(state, MachineKind.Tank, 3, 1)!;
    rebuildNetworks(state);
    standOn(state, 3, 1);
    expect(tank.network).not.toBe(0);

    run(state, [{ type: 'DeconstructMachine', machineId: tank.id }]);
    expect(state.machines.some((m) => m.kind === MachineKind.Tank)).toBe(false);
    // The pipes survive; nothing on them still claims a machine that is not there.
    expect(state.pipes).toHaveLength(3);
  });
});

describe('scrapping a boxed machine', () => {
  it('pays exactly 40% of the invoice, floored — item 037’s dangling criterion', () => {
    const state = createWorld(80);
    const machine = spawnMachine(state, MachineKind.ChipKitchen, 1, 1)!;
    machine.investedCents = 28_333;
    standOn(state, 1, 1);
    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);

    const money = state.moneyCents;
    run(state, [{ type: 'SellBoxedMachine', item: ItemId.BoxedChipKitchen }]);

    expect(state.moneyCents - money).toBe(divFloor(28_333 * 40, 100));
    expect(itemCount(state, ItemId.BoxedChipKitchen)).toBe(0);
  });

  it('is booked as money back rather than as income', () => {
    // Gross receipts and the items-sold counter both feed Charter milestones and leaderboard
    // boards. Scrap is a partial reversal of a spend, so it lands on the spend side.
    const state = createWorld(81);
    const machine = spawnMachine(state, MachineKind.ChipKitchen, 1, 1)!;
    standOn(state, 1, 1);
    run(state, [{ type: 'DeconstructMachine', machineId: machine.id }]);

    const earned = state.stats.lifetimeEarnedCents;
    const sold = state.stats.itemsSold;
    run(state, [{ type: 'SellBoxedMachine', item: ItemId.BoxedChipKitchen }]);

    expect(state.stats.lifetimeEarnedCents).toBe(earned);
    expect(state.stats.itemsSold).toBe(sold);
  });

  it('is refused by the sell bin, which only takes goods', () => {
    const state = createWorld(82);
    addItem(state, ItemId.BoxedFryer, 1);
    const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
    standOn(state, bin.tileX, bin.tileY);

    run(state, [{ type: 'SellItem', item: ItemId.BoxedFryer, count: 1 }]);
    expect(itemCount(state, ItemId.BoxedFryer)).toBe(1);
    expect(isSellable(ItemId.BoxedFryer)).toBe(false);
  });

  it('refuses an item that is not a boxed machine, and an empty bag', () => {
    const state = createWorld(83);
    const money = state.moneyCents;
    run(state, [{ type: 'SellBoxedMachine', item: ItemId.RussetPotato }]);
    run(state, [{ type: 'SellBoxedMachine', item: ItemId.BoxedFryer }]);
    expect(state.moneyCents).toBe(money);
  });
});

describe('a slot full of boxes', () => {
  function boxSlot(state: WorldState): (typeof state.inventory)[number] {
    return state.inventory.find((slot) => slot.item === ItemId.BoxedFryer)!;
  }

  function box(state: WorldState, invested: number, speed: number): void {
    addBoxedMachine(state, ItemId.BoxedFryer, {
      speedLevel: speed,
      efficiencyLevel: 0,
      capacityLevel: 0,
      condition: CONDITION_MAX,
      investedCents: invested,
    });
  }

  it('hashes the same whichever order the machines were boxed in', () => {
    // Two players who boxed the same bare Fryer and the same maxed one in opposite orders are
    // in the same world. The canonical order inside the slot is what makes the digest agree.
    const a = createWorld(90);
    box(a, 40_000, 3);
    box(a, 12_000, 0);

    const b = createWorld(90);
    box(b, 12_000, 0);
    box(b, 40_000, 3);

    expect(hashState(a)).toBe(hashState(b));
    expect(boxSlot(a).boxes[0]!.investedCents).toBe(12_000);
  });

  it('hands out the least-invested box first, to both verbs', () => {
    const state = createWorld(91);
    state.unlocked = [TechId.Fryer, TechId.WashAndSlice];
    box(state, 40_000, 3);
    box(state, 12_000, 0);
    standOn(state, 1, 1);

    run(state, [{ type: 'PlaceMachine', kind: MachineKind.Fryer, tileX: 1, tileY: 1 }]);
    expect(state.machines.find((m) => m.kind === MachineKind.Fryer)!.speedLevel).toBe(0);

    const money = state.moneyCents;
    run(state, [{ type: 'SellBoxedMachine', item: ItemId.BoxedFryer }]);
    expect(state.moneyCents - money).toBe(divFloor(40_000 * 40, 100));
    expect(itemCount(state, ItemId.BoxedFryer)).toBe(0);
  });

  it('keeps the box list exactly as long as the count', () => {
    const state = createWorld(92);
    box(state, 12_000, 0);
    box(state, 40_000, 3);
    expect(boxSlot(state).count).toBe(2);
    expect(boxSlot(state).boxes).toHaveLength(2);

    removeItem(state, ItemId.BoxedFryer, 1);
    expect(boxSlot(state).count).toBe(1);
    expect(boxSlot(state).boxes).toHaveLength(1);
    // The generic remover takes from the front, same as the two verbs do.
    expect(boxSlot(state).boxes[0]!.investedCents).toBe(40_000);
  });

  it('publishes every box to the HUD, with what each one would fetch', () => {
    const state = createWorld(93);
    box(state, 12_000, 0);
    box(state, 40_000, 3);

    const projected = view(state, createWorldView());
    const row = projected.inventory.find((slot) => slot.item === ItemId.BoxedFryer)!;
    expect(row.count).toBe(2);
    expect(row.sellable).toBe(0);
    expect(row.boxedMachineKind).toBe(MachineKind.Fryer);
    expect(row.boxes.map((entry) => entry.investedCents)).toEqual([12_000, 40_000]);
    expect(row.boxes.map((entry) => entry.scrapCents)).toEqual([4_800, 16_000]);
    expect(row.boxes[1]!.speedLevel).toBe(3);

    // An ordinary row carries neither, and the pooled buffer does not leak the last row's boxes.
    const seeds = projected.inventory.find((slot) => slot.item === ItemId.PotatoSeed)!;
    expect(seeds.boxedMachineKind).toBe(0);
    expect(seeds.boxes).toEqual([]);
  });
});

// --- the clock crossings this file owns (item 119) --------------------------------------------
//
// The scenarios live in `clock-crossings.ts` and the ones run here are the ones that named this
// file. That split is deliberate: item 119 measured every clock catch in the suite coming from a
// single file, so the guard was one `rm` away from silently disappearing. `clock-doors.test.ts`
// sweeps the test directory and fails if a file named by a crossing does not exist or does not
// call `runClockCrossings` with its own name.

describe('clock crossings: factory', () => {
  runClockCrossings('factory');
});
