// Does the sprinkler ceremony replay on reload? Answered against the REAL sim, not a mock.
//
// `ceremony.test.ts` pins the renderer's triggering logic with hand-built views, which
// proves the Ceremony class — but item 011's criterion is about the whole chain: the sim
// marks `CeremonyId.Sprinkler` at the first pour, the mark is world state, it survives
// `serialize`/`deserialize`, and a renderer handed the LOADED world primes rather than
// fires. Any link can break independently (the stand-in this replaced broke exactly one of
// them), so this test walks a real world through the real path: buy nothing on faith,
// place a barrel sprinkler by command, refill it by command, let `step()` pour it, then
// save, load, and watch what a fresh Ceremony does with the result.
//
// No browser, no GPU: `Texture.EMPTY` stands in for the atlas, exactly as ceremony.test.ts
// does, and the sim is the plain-TS package it always was.

import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';

import {
  CeremonyId,
  MachineKind,
  createWorld,
  deserialize,
  serialize,
  step,
  tileCentreSubtiles,
  view,
} from '@snack/sim';
import type { Command, WorldState } from '@snack/sim';

import { Ceremony } from './ceremony';

/** One tick, with the given commands — the same shape the game loop feeds `step`. */
function tick(state: WorldState, commands: Command[] = []): void {
  step(state, { tick: state.tick, commands });
}

function advance(ceremony: Ceremony, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) ceremony.update(16);
}

/**
 * A world whose barrel sprinkler has poured once, built by commands.
 *
 * The player starts at tile (8,12), one south of the field; the sprinkler goes beside them
 * at (9,12) so both the placement and the hand-refill are within reach without walking.
 * Money is topped up directly — this is a fixture, not an economy claim; the honest walk
 * to $150 is item 011's other half and has its own script.
 */
function worldWithPouredSprinkler(): WorldState {
  const state = createWorld(4242);
  state.moneyCents = 100_000;

  tick(state, [{ type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX: 9, tileY: 12 }]);
  const sprinkler = state.machines.find((m) => m.kind === MachineKind.Sprinkler);
  expect(sprinkler).toBeDefined();

  // Stand beside it and fill the barrel from the pond — the assisted tier's own verbs.
  state.player.xSub = tileCentreSubtiles(8);
  state.player.ySub = tileCentreSubtiles(12);
  tick(state, [{ type: 'RefillHopper', machineId: sprinkler!.id }]);
  expect(sprinkler!.tankMl).toBeGreaterThan(0);

  // Let it reach its first pour. A generous ceiling, and a hard stop if the machine never
  // waters — a sprinkler that cannot pour would make every assertion below vacuous.
  for (let i = 0; i < 2_000 && sprinkler!.wateredCount === 0; i++) tick(state);
  expect(sprinkler!.wateredCount).toBeGreaterThan(0);

  return state;
}

describe('sprinkler ceremony against the real sim', () => {
  it('is marked by the sim at the first pour, and fires exactly once in a live session', () => {
    const state = createWorld(4242);
    const ceremony = new Ceremony(Texture.EMPTY, () => undefined);

    // The world before any sprinkler exists: nothing owed, nothing playing.
    ceremony.observe(view(state));
    expect(view(state).ceremonies).toHaveLength(0);
    expect(ceremony.playing).toBe(false);

    const poured = worldWithPouredSprinkler();
    expect(view(poured).ceremonies).toContain(CeremonyId.Sprinkler);

    // The same live session watches the pour happen: the marquee moment plays.
    ceremony.observe(view(poured));
    expect(ceremony.playing).toBe(true);

    // ...and once it has run out, more pours from the same world never restart it.
    advance(ceremony, 11_000);
    for (let i = 0; i < 200; i++) tick(poured);
    ceremony.observe(view(poured));
    expect(ceremony.playing).toBe(false);
  });

  it('survives serialize/deserialize as world state, and a reload primes rather than replays', () => {
    const poured = worldWithPouredSprinkler();

    const loaded = deserialize(serialize(poured));
    const loadedView = view(loaded);

    // The fact travelled: the mark is in the save, not in a renderer variable.
    expect(loadedView.ceremonies).toContain(CeremonyId.Sprinkler);

    // A fresh Ceremony — a fresh page load — primes on its first frame and stays silent.
    const ceremony = new Ceremony(Texture.EMPTY, () => undefined);
    ceremony.observe(loadedView);
    expect(ceremony.playing).toBe(false);
    advance(ceremony, 1_000);
    expect(ceremony.playing).toBe(false);

    // The loaded world keeps living — the sprinkler keeps watering — and still nothing plays,
    // because the id was in the save from the first observed frame.
    for (let i = 0; i < 300; i++) tick(loaded);
    ceremony.observe(view(loaded));
    expect(ceremony.playing).toBe(false);
  });
});
