// What the read-back check costs, and therefore whether it can run on every save.
//
// THE QUESTION THIS ANSWERS. Work item 041 asks for write-then-verify on every autosave, and
// then asks the obvious follow-up: that check loads the entire world, so if it is expensive the
// answer is to sample it — verify every Nth autosave plus every manual save — rather than pay it
// sixty times an hour on the main thread. That is a real trade and it should be decided from a
// number, not from nerves. So this measures it on a world far larger than a player will plausibly
// have, and the measured answer is that there is no trade to make: see the agent log for the
// figures, but the verify lands around three quarters of a millisecond against a cadence of sixty
// SECONDS. Sampling would save nothing worth having and would leave gaps in exactly the guarantee
// the check exists to provide, so N is 1 — every save, always.
//
// IT ASSERTS A CEILING RATHER THAN A TIME. A test that pinned 0.7 ms would fail on a loaded CI
// box for no reason and get deleted within the month. The budget below is roughly thirty times
// the measured cost: loose enough that machine-to-machine variance cannot reach it, tight enough
// that the failure it is really watching for — someone making the restore path quadratic, or
// hashing inside a loop — cannot hide under it.
//
// The world is built full but run BRIEFLY on purpose. Verify cost tracks the size of the world,
// not its age: the payload is machines, belts and tiles, so ticks buy seconds of test runtime and
// almost no extra bytes. The predecessor's version of this ran an hour of sim and timed out.

import { describe, expect, it } from 'vitest';
import {
  PARCEL_COUNT,
  TECH_NODES,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  createWorld,
  hashState,
  restoreWorld,
  serialize,
  step,
  stepMany,
} from '@snack/sim';
import type { Command, WorldState } from '@snack/sim';

import { verifySave } from './verify';

/** Milliseconds a single verify may take on a maxed-out lot before this is a real regression. */
const VERIFY_BUDGET_MS = 25;

/** Fill every buildable tile on the lot, plant the whole field, and run it briefly. */
function fullLot(ticks: number): WorldState {
  const state = createWorld(20260812);
  state.moneyCents = 1_000_000_000;
  state.unlocked = TECH_NODES.map((n) => n.id).sort();

  // MachineKind is a numeric as-const map: Washer 4, Slicer 5, Fryer 6, Seasoner 7, Bagger 8.
  const kinds = [4, 5, 6, 7, 8] as const;
  const commands: Command[] = [];
  // Land deeds (item 053): only parcel 0 starts owned, and everything east of tile 16 would
  // be refused as unowned — turning this "maxed-out lot" into a quiet 44-machine one. Buy
  // the whole map first; the $10M above covers the ladder with room to spare.
  for (let parcel = 1; parcel < PARCEL_COUNT; parcel++) {
    commands.push({ type: 'BuyDeed', parcel } as unknown as Command);
  }
  let n = 0;
  for (let y = 0; y < WORLD_TILES_HIGH; y++) {
    for (let x = 0; x < WORLD_TILES_WIDE; x++) {
      // Alternate machines and belts so both collections fill up.
      if ((x + y) % 2 === 0) {
        commands.push({ type: 'PlaceMachine', kind: kinds[n % kinds.length]!, tileX: x, tileY: y });
      } else {
        commands.push({
          type: 'PlaceBelt',
          tier: 1,
          tileX: x,
          tileY: y,
          dir: 1,
          lengthTiles: 1,
        } as unknown as Command);
      }
      n++;
    }
  }
  for (let y = 4; y < 12; y++) {
    for (let x = 4; x < 12; x++) {
      commands.push({ type: 'TillTile', tileX: x, tileY: y } as unknown as Command);
      commands.push({ type: 'PlantTile', tileX: x, tileY: y, crop: 1 } as unknown as Command);
    }
  }
  step(state, { tick: state.tick, commands });
  stepMany(state, ticks);
  return state;
}

describe('the cost of verifying every save', () => {
  it('is a rounding error against the autosave cadence, even on a maxed-out lot', () => {
    const state = fullLot(1_200);
    const envelope = serialize(state);

    // Warm once — the first call pays for JIT and for lazily-built lookup tables, and reporting
    // that as the steady-state cost would overstate it by an order of magnitude.
    expect(verifySave(envelope, state).ok).toBe(true);

    const reps = 20;
    const started = performance.now();
    for (let i = 0; i < reps; i++) verifySave(envelope, state);
    const perVerify = (performance.now() - started) / reps;

    const bytes = JSON.stringify(envelope).length;
    console.log(
      `verify: ${perVerify.toFixed(3)} ms on ${(bytes / 1024).toFixed(1)} KB — ` +
        `${String(state.machines.length)} machines, ${String(state.belts.length)} belts, ` +
        `tick ${String(state.tick)}`,
    );

    expect(perVerify).toBeLessThan(VERIFY_BUDGET_MS);
    // The world really is the big one. If this ever shrinks, the timing above stopped meaning
    // anything and the budget is being measured against a toy.
    expect(state.machines.length).toBeGreaterThan(400);
    expect(bytes).toBeGreaterThan(100_000);
  });

  it('round-trips that world byte-for-byte, which is what makes the timing worth paying', () => {
    // The cost is only justified if the check is real. A fast verify that agreed with everything
    // would be cheaper still and worth nothing.
    const state = fullLot(1_200);
    const restored = restoreWorld(JSON.parse(JSON.stringify(serialize(state))));
    expect(hashState(restored.state)).toBe(hashState(state));
  });
});
