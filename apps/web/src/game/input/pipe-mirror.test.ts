// Two of the legality MIRRORS this app keeps, pinned against the sim predicates they mirror —
// and the picking rule that item 120 made necessary by letting a tile hold two things.
//
// THE THIRD IS NEXT DOOR, in `till-mirror.test.ts` ([[127]]): the till's anchor and per-tile
// ghost. It is a separate file rather than a third block here because it cannot do what the
// two below do — `applyTillTile` exports no predicate to import, keeping its verdict as an
// inline `continue` — so it asks the real reducer a 1×1 command per tile and reads the answer
// out of the trace. Same standard, different instrument.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  A MIRROR THAT DRIFTS IS A GHOST THAT LIES, AND BOTH OF THESE HAD JUST DRIFTED.
//
//  `pipeTilesClear` and `farmRefusal` are input-layer copies of sim rules. They gate nothing
//  (§12 — the sim re-checks everything and is the authority); what they decide is whether the
//  band under the cursor is green or red, and what sentence it carries. That makes drift
//  invisible in exactly the way this repo keeps getting caught by: the game still WORKS, and
//  only the promise on screen is wrong. Items 120 and 121 both relaxed a sim rule and left
//  these two claiming refusals the reducer no longer makes — a red band over a legal click.
//
//  So neither is checked by reading the two functions side by side. Each is checked against
//  THE ACTUAL EXPORTED PREDICATE, over a real world built by the real reducer, EXHAUSTIVELY —
//  every tile of the lot, not a handful somebody thought of. An exhaustive sweep is what makes
//  this a pin rather than an example: the next relaxation cannot move one rule and leave the
//  other behind without a tile somewhere disagreeing.
//
//  WHAT THE PIPE MIRROR DELIBERATELY DOES NOT COVER, stated so the assertion can be exact:
//  `pipePathRefusal` has two halves. The per-tile loop (inside the world, owned, no pipe, no
//  machine) is what `pipeTilesClear` mirrors. The tail is about ADJACENCY — two liquids meeting,
//  a typed port, two pumps on one network — and belongs to `liquidRefusal` and the run's own
//  liquid inference, which have their own tests. So the sweep compares against the per-tile
//  refusals by name rather than against `!== None`, which would fail for a reason that is not
//  this function's job.
// ────────────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BuildRefusal,
  CropId,
  Direction,
  BeltTier,
  GrabberTier,
  ItemId,
  LiquidId,
  MachineKind,
  PIPE_MAX_PATH_TILES,
  SUBTILE,
  TechId,
  TillMode,
  addItem,
  beltAt,
  createWorld,
  createWorldView,
  isFieldTile,
  isOwnedTile,
  machineAt,
  machineFootprintFree,
  machineSpec,
  pipeAt,
  pipePathRefusal,
  step,
  tileAt,
  view,
} from '@snack/sim';
import type { Command, WorldState, WorldView } from '@snack/sim';

import { ghostBand, pipeTilesClear } from './pointer';
import { TeardownOutcome, outcomePhrase, teardownPlan, teardownTargetAt } from './teardown';
import { ToolMode } from './tools';

/** Everything researched and money to burn, so every refusal is about the tile. */
function world(): WorldState {
  const state = createWorld(9137);
  state.moneyCents = 100_000_000;
  state.unlocked = [TechId.Belts, TechId.Pumps, TechId.PipedSprinklers, TechId.IrrigationHub];
  return state;
}

function run(state: WorldState, ...commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

function project(state: WorldState): WorldView {
  return view(state, createWorldView());
}

/** Stand the farmer on a tile. `applyPlantTile` is reach-gated, so the hand verbs need this. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

/**
 * A world with one of everything standing on it, so the sweeps below have something to
 * disagree about.
 *
 * SEARCHED FOR RATHER THAN HARD-CODED, the rule `belt-run.test.ts` sets: the starting lot's
 * machines and field move between releases, and a test that hard-codes (3,3) starts failing
 * for a reason that has nothing to do with mirrors. Every placement is asserted to have LANDED,
 * because a sweep over a world where the belt was silently refused would pass while proving
 * nothing at all — the failure mode a mirror test is most likely to die of.
 */
function furnished(): { state: WorldState; belt: { x: number; y: number } } {
  const state = world();

  const strip = clearStrip(state, 4);
  run(state, {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: strip.x,
    tileY: strip.y,
    dir: Direction.East,
    lengthTiles: 4,
  });
  expect(beltAt(state, strip.x, strip.y)).not.toBeNull();

  // An arm beside the belt, on its own ground tile.
  run(state, {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: strip.x,
    tileY: strip.y + 1,
    dir: Direction.North,
    filter: 0,
  });

  // A run of pipe crossing the belt at right angles — the crossing every rule here is about.
  run(state, {
    type: 'PlacePipe',
    liquid: LiquidId.Water,
    path: [
      { x: strip.x + 1, y: strip.y - 1 },
      { x: strip.x + 1, y: strip.y },
      { x: strip.x + 1, y: strip.y + 1 },
    ],
  });
  expect(pipeAt(state, strip.x + 1, strip.y)).not.toBeNull();
  expect(beltAt(state, strip.x + 1, strip.y)).not.toBeNull();

  return { state, belt: strip };
}

/** The left end of a horizontal strip of clear, owned, non-field ground with room above/below. */
function clearStrip(state: WorldState, span: number): { x: number; y: number } {
  for (let y = 1; y < 20; y++) {
    for (let x = 0; x + span < 20; x++) {
      let ok = true;
      for (let i = 0; i < span; i++) {
        for (let dy = -1; dy <= 1; dy++) {
          const tx = x + i;
          const ty = y + dy;
          if (!isOwnedTile(state, tx, ty)) ok = false;
          if (isFieldTile(state, tx, ty)) ok = false;
          if (machineAt(state, tx, ty) !== null) ok = false;
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('no clear strip on the starting lot');
}

/** The per-tile half of `pipePathRefusal` — the only half `pipeTilesClear` claims to mirror. */
const PER_TILE_REFUSALS: readonly BuildRefusal[] = [
  BuildRefusal.OutsideWorld,
  BuildRefusal.Unowned,
  BuildRefusal.Occupied,
];

describe('the pipe mirror agrees with the sim, tile for tile', () => {
  it('says exactly what `pipePathRefusal` says on EVERY tile of a furnished lot', () => {
    const { state } = furnished();
    const v = project(state);

    let disagreements = 0;
    let refusedByTile = 0;
    let clear = 0;

    for (let y = -1; y <= v.worldTilesHigh; y++) {
      for (let x = -1; x <= v.worldTilesWide; x++) {
        const refusal = pipePathRefusal(state, [{ x, y }], LiquidId.Water, PIPE_MAX_PATH_TILES);
        const simSaysClear = !PER_TILE_REFUSALS.includes(refusal);
        const mirrorSaysClear = pipeTilesClear(v, [{ tileX: x, tileY: y }]);
        if (simSaysClear !== mirrorSaysClear) disagreements += 1;
        if (!simSaysClear) refusedByTile += 1;
        if (simSaysClear) clear += 1;
      }
    }

    expect(disagreements).toBe(0);
    // A sweep that found nothing on either side would agree vacuously. Both answers have to
    // actually occur for the zero above to mean the two rules were compared.
    expect(refusedByTile).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
  });

  it('is green over the belt, the arm and the farmland a pipe may now cross', () => {
    const { state, belt } = furnished();
    const v = project(state);

    // The belt's own tiles: a pipe crosses them, and the sim agrees.
    expect(pipeTilesClear(v, [{ tileX: belt.x, tileY: belt.y }])).toBe(true);
    expect(pipePathRefusal(state, [{ x: belt.x, y: belt.y }], LiquidId.Water, 8)).toBe(
      BuildRefusal.None,
    );

    // The arm's tile.
    expect(pipeTilesClear(v, [{ tileX: belt.x, tileY: belt.y + 1 }])).toBe(true);

    // Farmland, which used to be `query.isField` and a red band.
    const field = firstFieldTile(v);
    expect(pipeTilesClear(v, [{ tileX: field.x, tileY: field.y }])).toBe(true);
  });

  it('still refuses another pipe and a machine footprint, which is what is left of the rule', () => {
    const { state, belt } = furnished();
    const v = project(state);

    expect(pipeTilesClear(v, [{ tileX: belt.x + 1, tileY: belt.y }])).toBe(false);

    const machine = v.machines[0]!;
    expect(pipeTilesClear(v, [{ tileX: machine.tileX, tileY: machine.tileY }])).toBe(false);
  });
});

describe('the farm mirror agrees with `machineFootprintFree`', () => {
  it('matches the sim on every farm tile, planted and bare, flagged and not', () => {
    const state = world();
    const v0 = project(state);
    const field = firstFieldTile(v0);

    // Plant one, leave another bare — the two states of the same rule.
    addItem(state, ItemId.PotatoSeed, 10);
    standOn(state, field.x, field.y);
    run(state, { type: 'PlantTile', tileX: field.x, tileY: field.y, crop: CropId.RussetPotato });
    expect(tileAt(state, field.x, field.y)!.crop).toBe(CropId.RussetPotato);

    const v = project(state);
    const sprinkler = machineSpec(MachineKind.Sprinkler)!;
    const kitchen = machineSpec(MachineKind.ChipKitchen)!;

    let checked = 0;
    for (let i = 0; i < v.field.count; i++) {
      const x = v.field.tileX[i]!;
      const y = v.field.tileY[i]!;

      // The flagged machine: the sim allows it on farmland whatever is growing, and so must
      // the ghost. `tone === 'zone'` is the band's word for legal.
      const simFlagged = machineFootprintFree(state, x, y, 1, 1, 0, sprinkler.fieldPlaceable);
      const ghostFlagged = ghostBand(v, { tileX: x, tileY: y }, ToolMode.PlaceSprinkler, 0);
      expect(ghostFlagged === null ? null : ghostFlagged.tone === 'zone').toBe(simFlagged);

      // The unflagged one: refused, and refused for the reason the tag gives.
      const simPlain = machineFootprintFree(state, x, y, 1, 1, 0, kitchen.fieldPlaceable);
      expect(simPlain).toBe(false);
      const ghostPlain = ghostBand(v, { tileX: x, tileY: y }, ToolMode.PlaceChipKitchen, 0);
      expect(ghostPlain!.tone).toBe('blocked');
      expect(ghostPlain!.label).toContain('not on farmland');
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  //  THE TILE NEITHER ITEM OWNS, AND THE REASON THIS SWEEP NEEDED A THIRD FIXTURE.
  //
  //  The sweep above is exhaustive over TILES and it still missed this, because it is
  //  exhaustive over ONE WORLD — and in that world no pipe is ever on farmland. Item 120 made
  //  a pipe over farmland legal for the first time; item 121 made a sprinkler over a crop legal
  //  for the first time. Neither is wrong. Their INTERSECTION was: the sim's
  //  `machineFootprintFree` asks `tileOccupied`, which counts the pipe, while the ghost's
  //  `footprintClear` did not — so the band went green and item 121's tell offered back a seed
  //  the reducer would never hand over.
  //
  //  One piped farm tile against 64 clear ones is exactly one disagreement, which is why the
  //  fixture has to exist rather than the assertion being tightened. Without the pipe below,
  //  this whole describe block passes with the bug in place.
  // ────────────────────────────────────────────────────────────────────────────────────
  it('still agrees on a farm tile with a pipe running over it', () => {
    const state = world();
    const field = firstFieldTile(project(state));

    addItem(state, ItemId.PotatoSeed, 10);
    standOn(state, field.x, field.y);
    run(state, { type: 'PlantTile', tileX: field.x, tileY: field.y, crop: CropId.RussetPotato });
    run(state, {
      type: 'PlacePipe',
      liquid: LiquidId.Water,
      path: [
        { x: field.x, y: field.y },
        { x: field.x, y: field.y + 1 },
      ],
    });
    // The premise. If item 120 is ever reverted this goes red first, and says why.
    expect(pipeAt(state, field.x, field.y), 'item 120 lets a pipe cross farmland').not.toBeNull();

    const v = project(state);
    const sprinkler = machineSpec(MachineKind.Sprinkler)!;
    const sim = machineFootprintFree(state, field.x, field.y, 1, 1, 0, sprinkler.fieldPlaceable);
    expect(sim, 'the sim counts the pipe as occupying the footprint').toBe(false);

    const band = ghostBand(v, { tileX: field.x, tileY: field.y }, ToolMode.PlaceSprinkler, 0);
    expect(band === null ? null : band.tone === 'zone', 'the ghost must agree').toBe(sim);
    // The sharp end: a refusal may not still be advertising the goods it was going to return.
    if (band !== null) expect(band.label).not.toContain('returns');
  });

  it('names what comes back instead of refusing — the tell item 121 asks for', () => {
    const state = world();
    const field = firstFieldTile(project(state));
    addItem(state, ItemId.PotatoSeed, 10);
    standOn(state, field.x, field.y);
    run(state, { type: 'PlantTile', tileX: field.x, tileY: field.y, crop: CropId.RussetPotato });
    expect(tileAt(state, field.x, field.y)!.crop).toBe(CropId.RussetPotato);

    const band = ghostBand(
      project(state),
      { tileX: field.x, tileY: field.y },
      ToolMode.PlaceSprinkler,
      0,
    )!;
    expect(band.tone).toBe('zone');
    expect(band.label).toContain('returns 1 potato seed');
    // The refusal this item exists to remove must not be anywhere in the sentence.
    expect(band.label).not.toContain('crop is in the way');
  });

  it('names the PRODUCE as well once the crop is ripe — the surprise item 121 is about', () => {
    const state = world();
    const field = firstFieldTile(project(state));
    addItem(state, ItemId.PotatoSeed, 10);
    standOn(state, field.x, field.y);
    run(state, { type: 'PlantTile', tileX: field.x, tileY: field.y, crop: CropId.RussetPotato });

    // Ripen it the way the world does, then confirm the world agrees it is ripe.
    const tile = tileAt(state, field.x, field.y)!;
    tile.growth = tile.growthTarget;
    step(state, { tick: state.tick, commands: [] });
    expect(project(state).field.ready[0]).toBe(1);

    const band = ghostBand(
      project(state),
      { tileX: field.x, tileY: field.y },
      ToolMode.PlaceSprinkler,
      0,
    )!;
    expect(band.tone).toBe('zone');
    // Both halves of the sim's one sentence: every crop gives back its seed, and a ripe one
    // gives back its produce too. A count is quoted for the seed, which is exact, and NOT for
    // the produce, which is `HARVEST_BASE_COUNT + an RNG roll` the tell must not draw.
    expect(band.label).toContain('russet potato');
    expect(band.label).toContain('1 potato seed');
  });

  it('says nothing about a hand-back on a bare farm tile', () => {
    const state = world();
    const field = firstFieldTile(project(state));
    const band = ghostBand(
      project(state),
      { tileX: field.x, tileY: field.y },
      ToolMode.PlaceSprinkler,
      0,
    )!;
    expect(band.tone).toBe('zone');
    expect(band.label).not.toContain('returns');
  });
});

describe('the picking rule: a tile with two layers on it', () => {
  it('a click takes the PIPE and leaves the belt standing', () => {
    const { state, belt } = furnished();
    const v = project(state);
    const cross = { x: belt.x + 1, y: belt.y };

    const plan = teardownPlan(v, { x: cross.x, y: cross.y, w: 1, h: 1 });
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]!.type).toBe('RemovePipe');
  });

  it('the ribbon names BOTH — what goes and what stays — and the click keeps that promise', () => {
    const { state, belt } = furnished();
    const cross = { x: belt.x + 1, y: belt.y };

    const target = teardownTargetAt(project(state), cross.x, cross.y)!;
    expect(target.name).toBe('the pipe');
    expect(target.beneath).toBe('the belt tile');
    expect(outcomePhrase(target)).toContain('leaves the belt tile');

    // The promise, kept: apply the click's own commands and the belt is still there.
    const plan = teardownPlan(project(state), { x: cross.x, y: cross.y, w: 1, h: 1 });
    run(state, ...plan.commands);
    expect(pipeAt(state, cross.x, cross.y)).toBeNull();
    expect(beltAt(state, cross.x, cross.y)).not.toBeNull();
  });

  it('a SECOND click then takes the belt, so two clicks clear the crossing', () => {
    const { state, belt } = furnished();
    const cross = { x: belt.x + 1, y: belt.y };

    run(state, ...teardownPlan(project(state), { x: cross.x, y: cross.y, w: 1, h: 1 }).commands);
    const second = teardownTargetAt(project(state), cross.x, cross.y)!;
    expect(second.name).toBe('the belt tile');
    expect(second.beneath).toBeNull();

    run(state, ...teardownPlan(project(state), { x: cross.x, y: cross.y, w: 1, h: 1 }).commands);
    expect(beltAt(state, cross.x, cross.y)).toBeNull();
  });

  it('a DRAG still takes both layers, and promises both in its ghost', () => {
    const { state, belt } = furnished();
    const rect = { x: belt.x, y: belt.y - 1, w: 4, h: 3 };

    const plan = teardownPlan(project(state), rect);
    const types = plan.commands.map((c) => c.type);
    expect(types).toContain('RemovePipe');
    expect(types.some((t) => t === 'RemoveBelt' || t === 'RemoveBeltTile')).toBe(true);
    // Nothing in a drag claims to leave anything standing — that clause is the click's alone.
    expect(plan.label).not.toContain('leaves');

    run(state, ...plan.commands);
    expect(pipeAt(state, belt.x + 1, belt.y)).toBeNull();
    expect(beltAt(state, belt.x + 1, belt.y)).toBeNull();
  });

  it('the click and the ribbon are the SAME call, so they cannot disagree', () => {
    const { state, belt } = furnished();
    const v = project(state);

    // Every tile of the furnished strip, hovered and clicked, must name the same object.
    for (let x = belt.x - 1; x <= belt.x + 4; x++) {
      for (let y = belt.y - 1; y <= belt.y + 1; y++) {
        const target = teardownTargetAt(v, x, y);
        const plan = teardownPlan(v, { x, y, w: 1, h: 1 });
        if (target === null) {
          expect(plan.commands).toHaveLength(0);
          expect(plan.label).toBe('nothing to take up');
          continue;
        }
        expect(plan.label).toBe(`${target.name} · ${outcomePhrase(target)}`);
        const expected = target.outcome === TeardownOutcome.Kept ? 0 : 1;
        expect(plan.commands).toHaveLength(expected);
      }
    }
  });

  it('a pipe over BARE GROUND promises nothing left behind', () => {
    const { state, belt } = furnished();
    // The pipe run's top tile sits on bare ground, not on the belt.
    const target = teardownTargetAt(project(state), belt.x + 1, belt.y - 1)!;
    expect(target.name).toBe('the pipe');
    expect(target.beneath).toBeNull();
    expect(outcomePhrase(target)).not.toContain('leaves');
  });
});

describe('the till still sees both layers, because the sim still does', () => {
  it('refuses to till under a pipe — the asymmetry item 120 left standing on purpose', () => {
    const { state, belt } = furnished();
    const bare = { x: belt.x + 1, y: belt.y - 1 };
    expect(isFieldTile(state, bare.x, bare.y)).toBe(false);
    standOn(state, bare.x, bare.y);
    run(state, {
      type: 'TillTile',
      rect: { x: bare.x, y: bare.y, w: 1, h: 1 },
      mode: TillMode.Till,
    });
    // Still not farmland: `applyTillTile` asks `tileOccupied`, which counts the pipe overhead.
    expect(isFieldTile(state, bare.x, bare.y)).toBe(false);
  });
});

/** The first farmland tile on the lot, as a plain pair. */
function firstFieldTile(v: WorldView): { x: number; y: number } {
  expect(v.field.count).toBeGreaterThan(0);
  return { x: v.field.tileX[0]!, y: v.field.tileY[0]! };
}
