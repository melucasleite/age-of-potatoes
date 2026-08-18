// Loading and replaying the golden fixtures.
//
// One module, three consumers, on purpose: `golden.test.ts` asserts against it,
// `scripts/regen-goldens.ts` rewrites hashes with it, and `scripts/hash-goldens.ts` runs it
// in a separate bare-Node process. If replay meant three slightly different things, the
// cross-process check would compare two runs of two different programs and prove nothing.
//
// This file is deliberately dependency-free apart from Node builtins and the sim itself.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Command,
  type CommandType,
  type WorldState,
  createWorld,
  hashState,
  step,
} from '../src/index';

/** One recorded command and the tick it was applied on. Matches `TraceEntry`. */
export interface FixtureCommand {
  tick: number;
  command: Command;
}

export interface GoldenFixture {
  name: string;
  /** Why this fixture exists — what regression it is here to catch. */
  description: string;
  seed: number;
  /** Total ticks stepped from a fresh world. */
  ticks: number;
  /** The hash `replayHash()` must produce. Rewritten only by `yarn goldens:regen`. */
  expectedHash: string;
  /**
   * The tick after which this fixture applies no further commands, for the one fixture whose
   * point is what happens when nobody touches anything.
   *
   * Present only on `depot-run`. It is not derivable from `commands` — the last command's tick
   * is where the player stopped *issuing*, not where the world went quiet, and `depot-run`
   * deliberately waits for a cart to come home after its final command so that the hands-off
   * window contains only automated money. `factory.test.ts` replays to here and then steps the
   * rest with an empty command list, which is what makes "zero manual touches across a depot
   * run" a thing a test can assert rather than a thing a comment can claim.
   */
  handsOffFromTick?: number;
  /** Ascending by tick. Ties keep array order, which is application order. */
  commands: FixtureCommand[];
}

/**
 * The fixture set, in a fixed order.
 *
 * Deliberately a written list rather than a directory scan: which worlds are pinned is a
 * decision, and a scan would silently drop a fixture that failed to be committed.
 */
export const FIXTURE_NAMES = [
  'empty-world',
  'canary-1000',
  'rng-streams',
  'all-verbs',
  'factory-line',
  'the-long-wait',
  'water-works',
  'walk-errands',
  'idle-wear',
  'maintenance',
  'soda-line',
  'rotate-and-box',
  'land-deeds',
  'depot-run',
  'the-farm',
  'worn-to-zero',
  'junction-loop',
  'the-till',
  'mid-field',
  'flavour-line',
  'bottle-return',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

/**
 * Every `Command` variant the fixture set is required to exercise.
 *
 * Typed as `Record<CommandType, true>` so that adding a twelfth variant to the union fails
 * `yarn typecheck` right here, with the fix — extend a fixture to cover it — in the same
 * file as the complaint. A golden set that quietly stops covering a verb is the failure
 * mode this guards against.
 */
export const REQUIRED_COMMAND_COVERAGE: Record<CommandType, true> = {
  SetMoveDirection: true,
  WalkAndAct: true,
  Cheat: true,
  TillTile: true,
  WaterTile: true,
  RefillCan: true,
  PlantTile: true,
  HarvestTile: true,
  PlaceMachine: true,
  LoadMachine: true,
  UnloadMachine: true,
  RefillHopper: true,
  RepairMachine: true,
  WhackJam: true,
  UseRepairKit: true,
  SellItem: true,
  BuyItem: true,
  MoveMachine: true,
  DeconstructMachine: true,
  SellBoxedMachine: true,
  UpgradeMachine: true,
  ResearchTech: true,
  BuyDeed: true,
  LoadCart: true,
  DispatchCart: true,
  CreateContract: true,
  CancelContract: true,
  PlaceBelt: true,
  RemoveBelt: true,
  RemoveBeltTile: true,
  RotateBelt: true,
  PlaceGrabber: true,
  SetGrabberFilter: true,
  RotateGrabber: true,
  RemoveGrabber: true,
  CreateZone: true,
  PaintZone: true,
  SetZoneCrop: true,
  SetZonePriority: true,
  RenameZone: true,
  SetZoneAutoReplant: true,
  PlacePipe: true,
  RemovePipe: true,
  SwingScythe: true,
  HitchCart: true,
  UnhitchCart: true,
  SetDockZone: true,
};

/**
 * Verbs the fixture set is allowed not to reach, and **each one needs an argument rather than a
 * shrug** — this list is the escape hatch the test above warns against, so it is deliberately
 * hard to add to and every entry says what pins the verb instead.
 *
 * `SetDockZone` — the Agri-Bot dock is gated on `TechId.AgriBots`, which requires the **Corporate
 * Charter**, whose milestone is *one line untouched for ten in-game days*: 96,000 consecutive
 * ticks of one machine advancing work with something feeding it and something emptying it. A
 * golden fixture that reached this verb honestly would be a six-figure-tick recording of a belt
 * loop built for no reason but to satisfy a checklist, and it would take longer to replay than
 * the rest of the set combined. The alternative — putting the command in a fixture where it is
 * refused — would leave the coverage test passing while guarding nothing, which is worse than
 * this list.
 *
 * **What pins it instead:** `test/bots.test.ts` builds a docked world directly through the
 * exported spawn helpers, binds a zone, runs ten thousand ticks, and asserts the same thing a
 * fixture would — that two independently-built worlds with the same seed and the same steps hash
 * identically, that a bot clears its zone with no player input, and that an idle bot wears
 * nothing. The determinism claim is tested; only the *file format* it is tested through differs.
 *
 * If the tech gate ever moves, delete this entry and extend a fixture.
 */
export const GOLDEN_COVERAGE_EXEMPT: ReadonlySet<CommandType> = new Set<CommandType>([
  'SetDockZone',

  /**
   * `Cheat` — a golden fixture is a canonical honest session, and baking `klapaucius` into
   * one would make every future fixture-derived comparison a comparison against a cheated
   * world; the coverage test would pass while pinning a session nobody should be recording.
   *
   * **What pins it instead:** the item-075 tests in `sim.test.ts` and `save.test.ts` assert
   * the exact determinism claim a fixture would — the command round-trips through a save's
   * trace, and two worlds with the same seed that apply the same cheat on the same tick hash
   * identically — plus the refusal claim no fixture can hold (an unknown code leaves no trace
   * entry at all).
   */
  'Cheat',

  /**
   * `RotateBelt` and `RemoveBeltTile` (item 084) — every fixture in the set predates belts
   * being individually ownable, and none of their recorded sessions had a reason to cut a
   * segment open. Re-timing an old session to smuggle one in would change that fixture's
   * story and its hash for no guarding gain, and recording a fresh fixture just to tick a
   * checklist is the SetDockZone argument at a smaller scale.
   *
   * **What pins them instead:** `test/belt-tiles.test.ts` asserts the exact claims a fixture
   * would — two worlds with the same seed applying the same surgery on the same tick hash
   * identically, goods survive every cut by count and by position, and a chain of 1-tile
   * segments delivers at the same steady-state rate as the long segment it was cut from.
   *
   * When a future fixture's session honestly reaches for R over a belt, delete this entry.
   */
  'RemoveBeltTile',
  'RotateBelt',
]);

/**
 * Marks the payload line `scripts/hash-goldens.ts` prints, so a stray Node warning on
 * stdout can never be parsed as the answer.
 */
export const HASH_LINE_PREFIX = 'GOLDEN_HASHES ';

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
}

export function loadFixture(name: string): GoldenFixture {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as GoldenFixture;
}

export function loadAllFixtures(): GoldenFixture[] {
  return FIXTURE_NAMES.map((name) => loadFixture(name));
}

/**
 * Replay a fixture from a fresh world and return the final state.
 *
 * Commands are bucketed by tick and applied in array order within a tick — the same order
 * `step()` received them when the fixture was recorded.
 */
export function replay(fixture: GoldenFixture): WorldState {
  const state = createWorld(fixture.seed);

  const byTick = new Map<number, Command[]>();
  for (let i = 0; i < fixture.commands.length; i++) {
    const entry = fixture.commands[i]!;
    const bucket = byTick.get(entry.tick);
    if (bucket === undefined) byTick.set(entry.tick, [entry.command]);
    else bucket.push(entry.command);
  }

  const none: Command[] = [];
  for (let i = 0; i < fixture.ticks; i++) {
    step(state, { tick: state.tick, commands: byTick.get(state.tick) ?? none });
  }

  return state;
}

export function replayHash(fixture: GoldenFixture): string {
  return hashState(replay(fixture));
}

/** Every fixture replayed, as `name -> hash`. The unit the cross-process check compares. */
export function replayAllHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  const fixtures = loadAllFixtures();
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    hashes[fixture.name] = replayHash(fixture);
  }
  return hashes;
}
