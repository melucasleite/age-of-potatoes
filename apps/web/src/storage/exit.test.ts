// The exit ordering ([[078]]), pinned where it can fail quietly.
//
// What this file is FOR: "save → verify → unmount" is a sentence in a vault note until a
// test makes it structural. The failure modes are all silent — a teardown that runs before
// the flush resolves loses under a minute of play with no error anywhere; an exit that
// proceeds past a failed save loses it politely. Both are pinned here against fakes,
// because the real flush is IndexedDB and the real teardown is a Pixi renderer, and the
// ORDER is the part worth testing, not either end.

import { describe, expect, it } from 'vitest';

import { type ExitDeps, performExit, saveBeforeExit } from './exit';

/** A deps double whose flush "lands" a save at the given tick, after a real await. */
function landingDeps(tick: number, log: string[]): ExitDeps {
  let saved: number | null = null;
  return {
    tickNow: () => tick,
    async flush() {
      log.push('flush-start');
      await Promise.resolve(); // A genuine microtask, so ordering bugs cannot hide.
      saved = tick + 3; // The sim ticked a little while the write was in flight.
      log.push('flush-done');
      return true;
    },
    lastSavedTick: () => saved,
  };
}

/** A deps double whose flush fails the way the real one does: resolves false, saves nothing. */
function failingDeps(tick: number, lastLanded: number | null): ExitDeps {
  return {
    tickNow: () => tick,
    flush: () => Promise.resolve(false),
    lastSavedTick: () => lastLanded,
  };
}

describe('saveBeforeExit', () => {
  it('is safe once a save at or past the request tick has landed', async () => {
    expect(await saveBeforeExit(landingDeps(500, []))).toBe(true);
  });

  it('is NOT safe when the flush failed and the disk is behind the request', async () => {
    // Last landed save is a minute of ticks behind: leaving would abandon that minute.
    expect(await saveBeforeExit(failingDeps(2_400, 1_200))).toBe(false);
  });

  it('is NOT safe when nothing has ever saved and the world has moved', async () => {
    expect(await saveBeforeExit(failingDeps(100, null))).toBe(false);
  });

  it('lets a world that never advanced leave without a save on disk', async () => {
    // Booted, never ticked, nothing to lose. Refusing here would trap the player.
    expect(await saveBeforeExit(failingDeps(0, null))).toBe(true);
  });

  it('accepts the already-saved case without demanding a fresh write', async () => {
    // flush() returns false because the tick has not moved since the last landed save —
    // the world as of the request is already on disk, which is exactly what safe means.
    expect(await saveBeforeExit(failingDeps(1_200, 1_200))).toBe(true);
  });
});

describe('performExit', () => {
  it('tears down strictly after the flush resolves, never concurrently', async () => {
    const log: string[] = [];
    const left = await performExit(landingDeps(500, log), () => log.push('leave'));
    expect(left).toBe(true);
    expect(log).toEqual(['flush-start', 'flush-done', 'leave']);
  });

  it('refuses to leave when the save did not land', async () => {
    let torndown = false;
    const left = await performExit(failingDeps(2_400, 1_200), () => {
      torndown = true;
    });
    expect(left).toBe(false);
    expect(torndown).toBe(false);
  });
});
