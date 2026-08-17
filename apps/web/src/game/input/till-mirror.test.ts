// The TILL mirror, pinned tile-for-tile against the reducer that owns the rule ([[127]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  A MIRROR THAT DRIFTS IS A GHOST THAT LIES — and this one is worse than the two next door.
//
//  `pipe-mirror.test.ts` guards two copies of sim rules that only COLOUR a preview: the sim
//  re-checks everything and is the authority (§12), so drift there paints a red band over a
//  legal click and nothing else. The till has the same kind of copy in `tillConverts`, and one
//  that is not that kind at all:
//
//  **`tillModeFor` PICKS THE `mode` FIELD THE COMMAND ACTUALLY CARRIES.** It is the anchor
//  rule, and the anchor rule is not a hint — `dragCommands` puts its answer straight into the
//  `TillTile` the sim will obey. A drift there does not mis-draw a preview; it sends the wrong
//  verb, and the sim faithfully performs the wrong verb, and the tile the player pressed on is
//  skipped for a reason that appears nowhere on screen. There is no §12 backstop for a wrong
//  mode, because the sim cannot know what the player meant.
//
//  So neither half is checked by reading `applyTillTile` alongside them. Both are checked
//  against THE REAL REDUCER, over a real world built by real commands, EXHAUSTIVELY over every
//  tile of the world plus a ring outside it — the standard the pipe mirror set after items 120
//  and 121 each moved a sim rule and left a ghost behind promising the old one.
//
//  HOW THE REDUCER IS ASKED, since it exports no predicate to import. `applyTillTile` keeps
//  its verdict to itself: the laden test is an inline `continue`, not an exported function, so
//  there is nothing to call the way the pipe mirror calls `pipePathRefusal`. But the reducer
//  publishes that verdict anyway, in the one place that cannot lie about it — THE TRACE.
//  `appendTrace` runs only for a command that returned true ("only commands that actually took
//  effect are recorded"), and `applyTillTile` returns true only when `changed > 0`. So a 1×1
//  `TillTile` on a tile is the reducer being asked "would you take this one?", and the trace is
//  its answer in its own words.
//
//  ALL OF THEM IN ONE TICK, which is what makes the sweep both exhaustive and honest. Every
//  tile gets its own 1×1 command and all ~4,400 go into a single `step`, so `applyCommands`
//  runs them before the world advances by even one tick — the same world the view was projected
//  from, with no growth, no wilt, no moisture drain and no RNG drift between the projection the
//  mirror read and the state the reducer judged. Per mode this needs no cloning at all, because
//  no tile's legality under a mode depends on what the same mode did to another tile.
// ────────────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BeltTier,
  CropId,
  Direction,
  GrabberTier,
  ItemId,
  LiquidId,
  MachineKind,
  SUBTILE,
  TechId,
  TillMode,
  addItem,
  createWorld,
  createWorldView,
  isFieldTile,
  isOwnedTile,
  machineAt,
  pipeAt,
  step,
  tileAt,
  view,
} from '@snack/sim';
import type { Command, WorldState, WorldView } from '@snack/sim';

import { tillConverts, tillModeFor } from './pointer';

const MODES: readonly TillMode[] = [TillMode.Till, TillMode.Unplant, TillMode.Untill];

/** Everything researched and money to burn, so every refusal is about the tile. */
function world(): WorldState {
  const state = createWorld(4271);
  state.moneyCents = 100_000_000;
  state.unlocked = [TechId.Belts, TechId.Pumps, TechId.PipedSprinklers, TechId.Composting];
  return state;
}

function run(state: WorldState, ...commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

function project(state: WorldState): WorldView {
  return view(state, createWorldView());
}

/** `applyPlantTile` is reach-gated, so the hand verbs need the farmer stood on the tile. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

/** The starting field's tiles, in world order. Searched, never hard-coded (`belt-run.test.ts`). */
function fieldTiles(state: WorldState): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      if (isFieldTile(state, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** A clear, owned, non-field tile with nothing on it — somewhere to put a belt or an arm. */
function clearGround(state: WorldState, taken: Set<string>): { x: number; y: number } {
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      if (taken.has(key(x, y))) continue;
      if (!isOwnedTile(state, x, y) || isFieldTile(state, x, y)) continue;
      if (machineAt(state, x, y) !== null || pipeAt(state, x, y) !== null) continue;
      taken.add(key(x, y));
      return { x, y };
    }
  }
  throw new Error('no clear ground on the starting lot');
}

/**
 * ONE WORLD WITH EVERY TILE STATE THE THREE RUNGS CAN DISAGREE ABOUT.
 *
 * A sweep is only as exhaustive as the world under it — `pipe-mirror.test.ts` learned that the
 * expensive way, passing over every tile of a lot that happened to contain no pipe on farmland
 * and therefore missing the one disagreement that existed. So this builds, on purpose:
 *
 *   · grass (most of the lot) and UNOWNED grass beyond the starting parcel;
 *   · bare farmland — the `Untill` rung;
 *   · planted farmland, growing — the `Unplant` rung and the owner's actual ask;
 *   · **bare farmland carrying compost** — the rung's other half, and the tile that was a dead
 *     end for this tool until item 127 (`Till` passed it over, `Untill` refused it);
 *   · **farmland carrying BOTH a crop and compost**, since the laden test is an `||`;
 *   · a fieldPlaceable machine standing on farmland ([[067]]);
 *   · **a pipe lying over PLANTED farmland** ([[120]]) — the intersection tile, laden to the
 *     view and occupied to the sim, which is exactly the shape of the bug the farm mirror
 *     needed a third fixture to catch;
 *   · a belt and an arm on grass, and the pond.
 *
 * Every placement is asserted to have LANDED. A sweep over a world where the pipe was silently
 * refused would pass while proving nothing — the failure a mirror test is most likely to die of.
 */
function furnished(): { state: WorldState; piped: { x: number; y: number } } {
  const state = world();
  const field = fieldTiles(state);
  expect(field.length, 'the starting lot has farmland').toBeGreaterThan(8);

  addItem(state, ItemId.PotatoSeed, 40);

  // Plant the first third of the field, leave the rest bare.
  const planted = field.slice(0, 6);
  for (const tile of planted) {
    standOn(state, tile.x, tile.y);
    run(state, {
      type: 'PlantTile',
      tileX: tile.x,
      tileY: tile.y,
      crop: CropId.RussetPotato,
    });
    expect(tileAt(state, tile.x, tile.y)!.crop, `plant landed at ${key(tile.x, tile.y)}`).toBe(
      CropId.RussetPotato,
    );
  }

  // COMPOST IS SET ON THE TILE RATHER THAN COMMANDED ONTO IT, and that is not laziness.
  // There is no player verb that puts compost on the ground: the sim's only path is a ripe crop
  // left standing for `COMPOST_AT_AGE` ticks, which is tens of thousands of ticks of maintained
  // moisture away. The field this test needs is a plain integer on a `CropTile`, and the
  // reducer reads it back through its own `tileAt`; building the world by command and then
  // setting one number the world has no verb for is the honest version of this fixture.
  const composted = field[10]!;
  tileAt(state, composted.x, composted.y)!.compost = 2;
  const both = planted[0]!;
  tileAt(state, both.x, both.y)!.compost = 1;
  expect(tileAt(state, both.x, both.y)!.crop, 'the both-tile still has its crop').not.toBe(
    CropId.None,
  );

  // A sprinkler on farmland ([[067]]). The reducer clears the tile on the way in, so this ends
  // up BARE and OCCUPIED — the pair that keeps `Untill` honest about a machine's floor.
  const underMachine = field[12]!;
  run(state, {
    type: 'PlaceMachine',
    kind: MachineKind.Sprinkler,
    tileX: underMachine.x,
    tileY: underMachine.y,
  });
  expect(machineAt(state, underMachine.x, underMachine.y), 'the sprinkler landed').not.toBeNull();

  // THE INTERSECTION TILE: a pipe over a tile that still has a crop in it.
  const piped = planted[3]!;
  run(state, {
    type: 'PlacePipe',
    liquid: LiquidId.Water,
    path: [
      { x: piped.x, y: piped.y },
      { x: piped.x, y: piped.y + 1 },
    ],
  });
  expect(pipeAt(state, piped.x, piped.y), 'item 120 lets a pipe cross farmland').not.toBeNull();
  expect(tileAt(state, piped.x, piped.y)!.crop, 'and the crop is still under it').toBe(
    CropId.RussetPotato,
  );

  // A belt and an arm on grass, so the occupancy skip has non-farm work to do too.
  const taken = new Set<string>();
  const beltAt0 = clearGround(state, taken);
  run(state, {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: beltAt0.x,
    tileY: beltAt0.y,
    dir: Direction.East,
    lengthTiles: 3,
  });
  const armAt = clearGround(state, taken);
  run(state, {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: armAt.x,
    tileY: armAt.y,
    dir: Direction.North,
    filter: 0,
  });

  return { state, piped };
}

/**
 * THE REDUCER'S OWN ANSWER FOR EVERY TILE, read out of the trace it writes for itself.
 *
 * One 1×1 `TillTile` per tile, every one of them in a SINGLE tick, so nothing about the world
 * moves between the projection the mirror read and the judgement the reducer made.
 */
function reducerTook(state: WorldState, v: WorldView, mode: TillMode): Set<string> {
  const commands: Command[] = [];
  for (let y = -1; y <= v.worldTilesHigh; y++) {
    for (let x = -1; x <= v.worldTilesWide; x++) {
      commands.push({ type: 'TillTile', rect: { x, y, w: 1, h: 1 }, mode });
    }
  }

  const from = state.trace.length;
  step(state, { tick: state.tick, commands });

  const took = new Set<string>();
  for (let i = from; i < state.trace.length; i++) {
    const command = state.trace[i]!.command;
    if (command.type !== 'TillTile') continue;
    took.add(key(command.rect.x, command.rect.y));
  }
  return took;
}

describe('the till mirror agrees with `applyTillTile`, tile for tile', () => {
  for (const mode of MODES) {
    it(`says exactly what the reducer does in ${mode} mode, on EVERY tile of a furnished lot`, () => {
      // A FRESH WORLD PER MODE, because asking the reducer mutates it — the whole point is that
      // the question is put to a real reducer, and a real reducer answers by doing the thing.
      const { state } = furnished();
      const v = project(state);
      const took = reducerTook(state, v, mode);

      let disagreements = 0;
      let converts = 0;
      let skips = 0;
      const examples: string[] = [];

      for (let y = -1; y <= v.worldTilesHigh; y++) {
        for (let x = -1; x <= v.worldTilesWide; x++) {
          const ghost = tillConverts(v, x, y, mode);
          const sim = took.has(key(x, y));
          if (ghost !== sim) {
            disagreements += 1;
            if (examples.length < 8) examples.push(`(${x},${y}) ghost=${ghost} sim=${sim}`);
          }
          if (sim) converts += 1;
          else skips += 1;
        }
      }

      expect(disagreements, `first disagreements: ${examples.join(' · ')}`).toBe(0);
      // A sweep that found nothing on either side would agree vacuously. Both answers have to
      // actually occur for the zero above to mean the two rules were compared at all.
      expect(converts, `${mode} converted nothing, so the sweep proved nothing`).toBeGreaterThan(0);
      expect(skips).toBeGreaterThan(0);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  //  THE ANCHOR, WHICH IS THE HALF WITH NO §12 BACKSTOP.
  //
  //  The three sweeps above pin `tillConverts`, and `tillConverts` only paints. This pins
  //  `tillModeFor`, which chooses the verb — and it pins it against the reducer rather than
  //  against a table of what the modes are supposed to mean, by asking the one question the
  //  player is actually asking when they press the button:
  //
  //      "I pressed on THIS tile. Will anything happen to it?"
  //
  //  A click is a 1×1 drag, so the promise the tool makes is that pressing on a tile the till
  //  has an answer for does that thing to that tile. That makes the property checkable: for
  //  every tile, collect the modes the REDUCER would take it under, and require that the mode
  //  the anchor picks is one of them whenever the set is non-empty. An anchor that returned
  //  `Untill` over a planted tile would fail here without anybody having to write down what
  //  `Untill` means.
  //
  //  And the same collection proves the PARTITION the sim's ruling 2 rests on: no tile is
  //  taken by two modes. If `Unplant` and `Untill` ever stopped being exact complements, the
  //  anchor would have a genuine choice to make and this test would say so first.
  // ────────────────────────────────────────────────────────────────────────────────────
  it('picks a mode that actually converts the tile the player pressed on', () => {
    const reference = project(furnished().state);

    const takenBy = new Map<string, TillMode[]>();
    for (const mode of MODES) {
      const { state } = furnished();
      for (const at of reducerTook(state, project(state), mode)) {
        const list = takenBy.get(at);
        if (list === undefined) takenBy.set(at, [mode]);
        else list.push(mode);
      }
    }

    let answered = 0;
    let dead = 0;
    let wrongVerb = 0;
    let shared = 0;
    const examples: string[] = [];

    for (let y = -1; y <= reference.worldTilesHigh; y++) {
      for (let x = -1; x <= reference.worldTilesWide; x++) {
        const modes = takenBy.get(key(x, y)) ?? [];
        if (modes.length > 1) {
          shared += 1;
          if (examples.length < 8) examples.push(`(${x},${y}) taken by ${modes.join(' and ')}`);
          continue;
        }
        if (modes.length === 0) {
          dead += 1;
          continue;
        }
        answered += 1;
        const picked = tillModeFor(reference, { tileX: x, tileY: y });
        if (picked !== modes[0]) {
          wrongVerb += 1;
          if (examples.length < 8) {
            examples.push(
              `(${x},${y}) anchor picked ${picked}, reducer takes it under ${modes[0]}`,
            );
          }
        }
      }
    }

    expect(shared, `no tile may be taken by two modes · ${examples.join(' · ')}`).toBe(0);
    expect(wrongVerb, `the anchor sent a verb the tile refuses · ${examples.join(' · ')}`).toBe(0);
    // Grass, farmland laden and farmland bare all exist on this lot, so all three rungs have
    // tiles. Without this the two zeroes above are satisfied by a lot nothing can be done to.
    expect(answered, 'the lot has tiles the till has an answer for').toBeGreaterThan(0);
    expect(dead).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  //  THE TILE THE SWEEPS COVER AND NOBODY WOULD HAVE THOUGHT OF, SPELLED OUT.
  //
  //  A pipe over a planted tile is laden to the VIEW and occupied to the SIM. The anchor reads
  //  ladenness and picks `Unplant`, which is right — a drag from here over a planted row should
  //  lift the row. `tillConverts` reads occupancy and refuses this one tile, which is also
  //  right, because `applyTillTile` skips it. The two disagreeing about the SAME TILE is not a
  //  bug; it is the anchor being about the gesture and the cell being about the tile.
  //
  //  This is spelled out rather than left to the sweep for the reason `pipe-mirror.test.ts`
  //  spells out its own: one such tile against four thousand ordinary ones is exactly one
  //  disagreement, and a fixture that quietly stopped producing it would take the coverage with
  //  it while every assertion above stayed green.
  // ────────────────────────────────────────────────────────────────────────────────────
  it('is silent over a planted tile with a pipe on it, and still anchors an un-plant there', () => {
    const { state, piped } = furnished();
    const v = project(state);

    expect(tillModeFor(v, { tileX: piped.x, tileY: piped.y })).toBe(TillMode.Unplant);
    expect(tillConverts(v, piped.x, piped.y, TillMode.Unplant)).toBe(false);

    // And the reducer agrees it takes nothing here, in any mode.
    for (const mode of MODES) {
      const fresh = furnished();
      const took = reducerTook(fresh.state, project(fresh.state), mode);
      expect(took.has(key(piped.x, piped.y)), `${mode} skips the piped tile`).toBe(false);
    }
  });
});
