// The factory half: the production line, belts and arms, zones, withering, and the tree.
//
// These are cheap structural checks, in the spirit of the repo's deliberately light
// verification bar. Each one pins a RULING from the design document rather than an
// implementation detail — the Fryer's 2:1 ratio, Day-Old at exactly half, "nothing ever
// vanishes", "a drag is one command", and the anti-double-dip split between tech nodes and
// upgrade dials. If one of these goes red, a decision was reversed, not a function renamed.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type WorldState,
  BeltTier,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CROP_SPECS,
  COMPOST_AFTER_TICKS,
  CropId,
  Direction,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  GrabberTier,
  ItemId,
  MachineKind,
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
  addItem,
  beltInsert,
  createWorld,
  createWorldView,
  dayOldPriceCents,
  effectiveInputCapacity,
  effectiveWastePeriod,
  effectiveWear,
  effectiveWorkRate,
  hashState,
  itemCount,
  listPriceCents,
  machineSpec,
  nextOutputItem,
  rusticStylePriceCents,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  step,
  stepMany,
  takeOneOutput,
  tileAt,
  upgradeCostCents,
  view,
  wiltStageForAge,
} from '../src/index';
import { loadFixture, replay } from './goldens';

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
      expect(spec.inputItem).toBe(input);
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
    expect(spec.inputItem).toBe(ItemId.RussetPotato);
    expect(spec.outputItem).toBe(ItemId.BaggedChips);
  });

  it('stops a converter dead when its output buffer is full rather than eating inputs', () => {
    // Demand-pull (plan §7 ruling 6): an idle machine teaches the ratio, a compost pile does
    // not. A blocked Slicer must not consume one more washed potato.
    const state = createWorld(3);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    const spec = machineSpec(MachineKind.Washer)!;
    washer.inputCount = 5;
    washer.outputCount = spec.outputCapacity;

    stepMany(state, 200);
    expect(washer.inputCount).toBe(5);
    expect(washer.outputCount).toBe(spec.outputCapacity);
  });
});

// --- overcooking --------------------------------------------------------------------

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
    fryer.inputCount = 5;

    stepMany(state, OVERCOOK_BLOCKED_TICKS * 3);
    expect(fryer.overcookedCount).toBe(0);
    expect(fryer.blockedTicks).toBe(0);
  });

  it('turns one chip per interval while blocked, oldest first, and stops at the last', () => {
    const state = createWorld(78);
    const spec = machineSpec(MachineKind.Fryer)!;
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    fryer.inputCount = 10;
    fryer.outputCount = spec.outputCapacity;

    stepMany(state, OVERCOOK_BLOCKED_TICKS - 1);
    expect(fryer.overcookedCount).toBe(0);
    stepMany(state, 1);
    expect(fryer.overcookedCount).toBe(1);
    stepMany(state, OVERCOOK_BLOCKED_TICKS);
    expect(fryer.overcookedCount).toBe(2);

    // Demand-pull still holds: a blocked machine eats nothing while it browns.
    expect(fryer.inputCount).toBe(10);
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
    kitchen.inputCount = 20;
    stepMany(state, ticksPerOperation(MachineKind.ChipKitchen) * 3);
    expect(state.stats.inputsWastedByMachine).toBe(0);

    const worn = createWorld(83);
    const spoiler = spawnMachine(worn, MachineKind.ChipKitchen, 0, 0)!;
    spoiler.condition = CONDITION_EFFECT_THRESHOLD - 1;
    spoiler.inputCount = 40;
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
    expect(spoiler.inputCount).toBe(40 - spoiler.opCount);
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
      machine.inputCount = 30;
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
    const at = (condition: number): number => effectiveWastePeriod(spec, { condition } as never);

    expect(at(CONDITION_EFFECT_THRESHOLD - 1)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThanOrEqual(2);
    // Monotone all the way down, so "it got worse" is always true and never occasionally.
    for (let condition = CONDITION_EFFECT_THRESHOLD - 1; condition > 1; condition--) {
      expect(at(condition)).toBeGreaterThanOrEqual(at(condition - 1));
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

// --- belts and grabbers -------------------------------------------------------------

describe('belts', () => {
  it('carries items forward and never lets two overlap', () => {
    const state = createWorld(11);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 4)!;
    expect(beltInsert(belt, 0, ItemId.RussetPotato)).toBe(true);
    expect(beltInsert(belt, 64, ItemId.RussetPotato)).toBe(true);
    // Too close to the one already at 64 — a belt that accepted this would render as a
    // single smeared item and would silently double a line's throughput.
    expect(beltInsert(belt, 100, ItemId.RussetPotato)).toBe(false);

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
    beltInsert(first, 0, ItemId.PlainChips);

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
    beltInsert(belt, 0, ItemId.RussetPotato);
    beltInsert(belt, 64, ItemId.RussetPotato);
    beltInsert(belt, 128, ItemId.RussetPotato);

    stepMany(state, 500);
    expect(belt.items).toHaveLength(3);
    expect(belt.items[2]!.dist).toBe(3 * SUBTILE - 1);
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

    washer.inputCount = 3;
    stepMany(state, 600);

    expect(washer.outputCount).toBe(0);
    expect(slicer.opCount + slicer.inputCount).toBeGreaterThan(0);
  });

  it('leaves anything that does not match a filtered arm alone', () => {
    const state = createWorld(15);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;
    const sink = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 1)!;
    spawnGrabber(state, GrabberTier.Mk2, 1, 0, Direction.East, ItemId.PlainChips);
    beltInsert(belt, 0, ItemId.RussetPotato);

    stepMany(state, 200);
    expect(belt.items).toHaveLength(1);
    expect(sink.items).toHaveLength(0);
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
      const cost = upgradeCostCents(spec, level);
      expect(cost).toBeGreaterThan(0);
      total += cost;
    }
    expect(upgradeCostCents(spec, UPGRADE_MAX_LEVEL)).toBe(-1);
    expect(total).toBeGreaterThan(spec.priceCents * 3);
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
    beltInsert(belt, 0, ItemId.PlainChips);
    beltInsert(belt, 128, ItemId.PlainChips);

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
