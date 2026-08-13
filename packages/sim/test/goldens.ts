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
  'withering',
  'water-works',
  'walk-errands',
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
  WaterTile: true,
  PlantTile: true,
  HarvestTile: true,
  PlaceMachine: true,
  LoadMachine: true,
  UnloadMachine: true,
  RefillHopper: true,
  RepairMachine: true,
  WhackJam: true,
  SellItem: true,
  BuyItem: true,
  MoveMachine: true,
  UpgradeMachine: true,
  ResearchTech: true,
  PlaceBelt: true,
  RemoveBelt: true,
  PlaceGrabber: true,
  SetGrabberFilter: true,
  RemoveGrabber: true,
  CreateZone: true,
  PaintZone: true,
  SetZoneCrop: true,
  SetZonePriority: true,
  RenameZone: true,
  SetZoneAutoReplant: true,
  PlacePipe: true,
  RemovePipe: true,
};

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
