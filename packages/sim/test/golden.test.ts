// The golden determinism gate.
//
// Committed fixtures of `{seed, commands, ticks, expectedHash}` replay headless — no
// renderer, no DOM, no network — and fail loudly the day the simulation stops producing
// what it produced yesterday. Plan §12 puts this in v0.1 on purpose: today a red hash has
// exactly one possible cause, and in 2029, with belts and fluids and bots all stepping, it
// has nine.
//
// A failure here means one of two things and never a third:
//   1. You changed the simulation deliberately — regenerate, and SAY SO in the commit.
//   2. You changed it by accident — you have just found the bug this file exists to find.
// `test/fixtures/README.md` has the long version. Nothing in this file rewrites a fixture.

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findNonIntegerFields, hashState } from '../src/index';
import {
  type GoldenFixture,
  FIXTURE_NAMES,
  GOLDEN_COVERAGE_EXEMPT,
  HASH_LINE_PREFIX,
  REQUIRED_COMMAND_COVERAGE,
  loadAllFixtures,
  loadFixture,
  replay,
  replayHash,
} from './goldens';

const fixtures = loadAllFixtures();

/**
 * A mismatch report worth reading. A bare `expected 'a' to be 'b'` costs the first ten
 * minutes of every future investigation working out which world it was even talking about.
 */
function mismatchReport(fixture: GoldenFixture, actual: string): string {
  return [
    `golden fixture "${fixture.name}" did not replay to its pinned hash.`,
    '',
    `  seed      ${fixture.seed}`,
    `  ticks     ${fixture.ticks}`,
    `  commands  ${fixture.commands.length}`,
    `  expected  ${fixture.expectedHash}`,
    `  actual    ${actual}`,
    '',
    `  ${fixture.description}`,
    '',
    'Either the simulation changed on purpose — run `yarn goldens:regen` and say so in the',
    'commit message — or it changed by accident, in which case this is the bug. Decide which',
    'before touching the fixture.',
  ].join('\n');
}

describe('golden fixtures', () => {
  it('pins every fixture in the set', () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual([...FIXTURE_NAMES]);
  });

  for (const fixture of fixtures) {
    it(`replays "${fixture.name}" to ${fixture.expectedHash}`, () => {
      const state = replay(fixture);
      const actual = hashState(state);

      expect(actual, mismatchReport(fixture, actual)).toBe(fixture.expectedHash);

      // A float that reached the digest would already have changed the hash; this names the
      // field, so the next question is "why is moisture fractional" rather than "where".
      expect(findNonIntegerFields(state)).toEqual([]);
    });
  }
});

describe('replay stability', () => {
  it('gives the same hash twice in the same process', () => {
    // Catches state leaking across runs — a module-level cache, a shared buffer, a lazily
    // memoised table — which a single replay compared against a constant cannot see.
    for (const fixture of fixtures) {
      const first = replayHash(fixture);
      const second = replayHash(fixture);
      expect(second, `"${fixture.name}" replayed differently the second time in one process`).toBe(
        first,
      );
    }
    // AN EXPLICIT BUDGET, like the launches test below, and for the same reason: this replays
    // every fixture in the set TWICE, so its cost is the size of the set and it was riding on
    // Vitest's 5-second default with no margin left. Item 111's `flavour-line` tipped it over
    // — the test failed on a stopwatch rather than on a hash, which is the least informative
    // way a determinism gate can go red. Thirty seconds is a hang-catcher, not a performance
    // bar; if this ever starts timing out again, something is genuinely stuck.
  }, 30_000);

  it('gives the same hashes in two separate process launches', () => {
    // Two fresh bare-Node processes, no Vitest and no bundler in either. Same-process
    // repetition cannot see anything that varies per process; this can. It also keeps the
    // "headless, no renderer, no build step" claim honest.
    const first = hashesFromChildProcess();
    const second = hashesFromChildProcess();

    expect(second, 'two separate process launches disagreed about the golden hashes').toEqual(
      first,
    );

    const pinned: Record<string, string> = {};
    for (const fixture of fixtures) pinned[fixture.name] = fixture.expectedHash;
    expect(first, 'a separate process disagreed with the pinned hashes').toEqual(pinned);
  }, 120_000);
});

describe('fixture set health', () => {
  it('exercises every Command variant', () => {
    const seen = new Set<string>();
    for (const fixture of fixtures) {
      for (const entry of fixture.commands) seen.add(entry.command.type);
    }

    const required = Object.keys(REQUIRED_COMMAND_COVERAGE)
      .sort()
      .filter((type) => !GOLDEN_COVERAGE_EXEMPT.has(type as never));
    const missing = required.filter((type) => !seen.has(type));

    expect(
      missing,
      `no golden fixture applies ${missing.join(', ')}. A verb no fixture exercises is a verb ` +
        'the determinism gate does not guard — extend a fixture rather than deleting this test.',
    ).toEqual([]);
  });

  it('keeps every command inside its fixture, in tick order', () => {
    for (const fixture of fixtures) {
      let previous = -1;
      for (const entry of fixture.commands) {
        expect(
          entry.tick,
          `"${fixture.name}" has a command out of tick order`,
        ).toBeGreaterThanOrEqual(previous);
        expect(entry.tick, `"${fixture.name}" has a command past its last tick`).toBeLessThan(
          fixture.ticks,
        );
        previous = entry.tick;
      }
    }
  });

  it('covers more than one seed and more than one run length', () => {
    expect(new Set(fixtures.map((fixture) => fixture.seed)).size).toBeGreaterThan(1);
    expect(Math.max(...fixtures.map((fixture) => fixture.ticks))).toBeGreaterThan(10_000);
  });

  it('loads a fixture by name', () => {
    expect(loadFixture('canary-1000').seed).toBe(1234);
  });
});

// --- the second process ---------------------------------------------------------------

function hashesFromChildProcess(): Record<string, string> {
  const hook = fileURLToPath(new URL('../scripts/node-resolve-hook.mjs', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/hash-goldens.ts', import.meta.url));

  const result = spawnSync(process.execPath, ['--import', hook, script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      `the bare-Node golden replay exited with status ${String(result.status)}.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const line = result.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith(HASH_LINE_PREFIX));

  if (line === undefined) {
    throw new Error(
      `the bare-Node golden replay printed no "${HASH_LINE_PREFIX}" line.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return JSON.parse(line.slice(HASH_LINE_PREFIX.length)) as Record<string, string>;
}
