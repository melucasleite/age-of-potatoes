// Item 070: the no-op walk errand. Clicking empty ground walks the farmer there, and
// arrival IS completion — no verb, no touch, no sound, no second trace entry.
//
// The design constraint this file watches: `IntentAction.Walk` rides the SAME errand
// machinery as every working verb — one command in the trace, replacement on a second click,
// the same timeout, the same save shape — so the tests here are mostly the ordinary errand
// facts asserted against a verb that does nothing at the end.

import { describe, expect, it } from 'vitest';

import {
  type WorldState,
  Direction,
  IntentAction,
  createWorld,
  fromPayload,
  hashState,
  step,
  toPayload,
} from '../src/index';
import { POND_ORIGIN_X, POND_ORIGIN_Y } from '../src/data';
import { SUBTILE, tileCentreSubtiles } from '../src/units';

const HAND_REACH_SUBTILES = 384;

function walkCommand(tileX: number, tileY: number) {
  return {
    type: 'WalkAndAct',
    action: IntentAction.Walk,
    tileX,
    tileY,
    item: 0,
    count: 0,
  } as const;
}

function stepEmpty(state: WorldState, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(state, { tick: state.tick, commands: [] });
}

function finishIntent(state: WorldState): number {
  let ticks = 0;
  while (state.player.intent !== null) {
    step(state, { tick: state.tick, commands: [] });
    ticks += 1;
    if (ticks > 10_000) throw new Error('the walk never ended');
  }
  return ticks;
}

function withinReach(state: WorldState, tileX: number, tileY: number): boolean {
  const dx = state.player.xSub - tileCentreSubtiles(tileX);
  const dy = state.player.ySub - tileCentreSubtiles(tileY);
  return dx * dx + dy * dy <= HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;
}

describe('the no-op walk errand', () => {
  it('walks to empty owned ground and does exactly nothing on arrival', () => {
    const state = createWorld(70);
    const touchesBefore = JSON.stringify(state.stats.touches);
    const target = { x: 2, y: 2 };

    const trace = state.trace.length;
    step(state, { tick: state.tick, commands: [walkCommand(target.x, target.y)] });
    expect(state.trace.length, 'the walk click was refused').toBe(trace + 1);
    expect(state.player.intent).not.toBeNull();

    const walked = finishIntent(state);
    expect(walked, 'the farmer teleported').toBeGreaterThan(0);
    expect(withinReach(state, target.x, target.y), 'never arrived').toBe(true);
    // ARRIVAL IS SILENT: no touch counted, nothing appended. (The clock ran; walking is time.)
    expect(state.trace.length).toBe(trace + 1);
    expect(JSON.stringify(state.stats.touches)).toBe(touchesBefore);
  });

  it('retargets on a second click mid-walk — the ordinary errand replacement', () => {
    const state = createWorld(71);
    step(state, { tick: state.tick, commands: [walkCommand(2, 2)] });
    stepEmpty(state, 10);
    expect(state.player.intent).not.toBeNull();

    step(state, { tick: state.tick, commands: [walkCommand(14, 2)] });
    expect(state.player.intent?.tileX).toBe(14);
    expect(state.player.intent?.tileY).toBe(2);

    finishIntent(state);
    expect(withinReach(state, 14, 2)).toBe(true);
    expect(withinReach(state, 2, 2)).toBe(false);
  });

  it('refuses unowned land and open water, exactly as a working click would', () => {
    const state = createWorld(72);
    const trace = state.trace.length;

    // The far corner of the map: a real place with a price on it, not walkable yet.
    step(state, { tick: state.tick, commands: [walkCommand(62, 62)] });
    expect(state.trace.length, 'walked onto unowned land').toBe(trace);
    expect(state.player.intent).toBeNull();

    // The pond. Nothing in this world is solid, but water is not standable.
    step(state, { tick: state.tick, commands: [walkCommand(POND_ORIGIN_X, POND_ORIGIN_Y)] });
    expect(state.trace.length, 'walked into the pond').toBe(trace);
    expect(state.player.intent).toBeNull();
  });

  it('yields to a held movement key, like every errand', () => {
    const state = createWorld(73);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.East }],
    });
    const trace = state.trace.length;
    step(state, { tick: state.tick, commands: [walkCommand(2, 2)] });
    expect(state.trace.length, 'the click overruled the held key').toBe(trace);
  });

  it('survives a mid-walk save and completes after the reload', () => {
    const state = createWorld(74);
    step(state, { tick: state.tick, commands: [walkCommand(2, 12)] });
    stepEmpty(state, 15);
    expect(state.player.intent?.action).toBe(IntentAction.Walk);

    // The save round-trip, mid-stride: same hash coming back, and the same walk still loaded.
    const restored = fromPayload(toPayload(state), state.trace);
    expect(hashState(restored)).toBe(hashState(state));
    expect(restored.player.intent?.action).toBe(IntentAction.Walk);

    // Both worlds finish the walk on their own and agree on every subtile of it.
    finishIntent(state);
    finishIntent(restored);
    expect(hashState(restored)).toBe(hashState(state));
    expect(withinReach(restored, 2, 12)).toBe(true);
  });

  it('walks across its own farmland and machines — nothing is solid', () => {
    const state = createWorld(75);
    // Straight across the starting field: the walk is a straight line THROUGH the crops'
    // tiles, locked by item 050 ("NO PATHING LIVES HERE"), and farmland is standable ground.
    step(state, { tick: state.tick, commands: [walkCommand(7, 7)] });
    expect(state.player.intent).not.toBeNull();
    finishIntent(state);
    expect(withinReach(state, 7, 7)).toBe(true);
  });
});

// Keep the constant honest: if reach retunes, this file should fail loudly, not drift.
it('pins the reach the tests above measure with', async () => {
  const data = await import('../src/data');
  expect(data.HAND_REACH_SUBTILES).toBe(HAND_REACH_SUBTILES);
});

// `SUBTILE` is imported for the reach maths above; assert the base so the maths reads true.
it('pins the subtile base', () => {
  expect(SUBTILE).toBe(256);
});
