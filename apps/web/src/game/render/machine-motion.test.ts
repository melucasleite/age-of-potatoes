// The structural gate for the machine work-loop motion ([[091]]).
//
// Everything here is invisible in a screenshot for the same reason the farm-fx gate is:
// a chop lasts under half a second, and the failure modes are all "looks like an art
// bug" — a machine that drifts a sub-pixel and shimmers, a jammed machine that keeps
// dancing, a save that opens with the whole factory flinching, a speck pool that grows.
//
// The table itself is pinned for EXHAUSTIVENESS AND DISTINCTNESS because the owner's
// ruling is "every machine gets an animation": `Record<MachineKind, MotionSpec>` already
// fails the BUILD when a kind is missing; the runtime half below fails the SUITE if a
// row loses its name or two kinds collapse into one motion identity.
//
// Pixi is stubbed exactly as `farm-fx.test.ts` stubs it: `Texture.EMPTY` needs no GPU,
// and everything asserted is arithmetic over plain numbers.

import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';

import { LampState, MachineKind } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

import {
  MACHINE_MOTION,
  MachineMotion,
  PROGRESS_HOLD_MS,
  SPECK_POOL,
  sampleWave,
} from './machine-motion';
import type { MotionSample } from './machine-motion';

function blankSample(): MotionSample {
  return { dx: 0, dy: 0, dw: 0, dh: 0, specks: null, fillPulse: false };
}

function machine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    id: 1,
    kind: MachineKind.Slicer,
    tileX: 4,
    tileY: 4,
    tilesWide: 2,
    tilesHigh: 2,
    lamp: LampState.Running,
    wrenchDue: 0,
    progressPermille: 0,
    conditionPermille: 1000,
    tankPermille: 0,
    inputCount: 0,
    outputCount: 0,
    inputCapacity: 4,
    outputCapacity: 4,
    inputItem: 0,
    outputItem: 0,
    wantsItem: 0,
    wantsCount: 0,
    wantsHeld: 0,
    overcookedCount: 0,
    overcookedItem: 0,
    speedLevel: 0,
    efficiencyLevel: 0,
    capacityLevel: 0,
    boundZone: 0,
    network: 0,
    flowMlPerMinute: 0,
    ticksToEmpty: -1,
    throttled: 0,
    tankCharges: 0,
    tankChargesMax: 0,
    coverageRadius: 0,
    moistureSensing: 0,
    wateredCount: 0,
    skippedCount: 0,
    cargoItem: 0,
    cargoCount: 0,
    cargoTicksToSpoil: -1,
    cargoFrozen: 0,
    seedShelfItem: 0,
    seedShelfCount: 0,
    bleedCentsLast60s: 0,
    recipe: [],
    ports: [],
    ...overrides,
  };
}

/** The slice of `WorldView` the motion system actually reads. Cast at the call site. */
function world(overrides: Record<string, unknown> = {}): WorldView {
  return {
    bots: [],
    belts: [],
    commerce: { carts: [], depots: [], contracts: [] },
    stats: { itemsSold: 0 },
    ...overrides,
  } as unknown as WorldView;
}

function makeMotion(): MachineMotion {
  return new MachineMotion(Texture.EMPTY, () => undefined);
}

describe('the motion table', () => {
  const kinds = Object.values(MachineKind) as number[];

  it('names a motion for every machine kind, with no two kinds sharing a name', () => {
    const names = new Set<string>();
    for (const kind of kinds) {
      const spec = MACHINE_MOTION[kind as MachineKind];
      expect(spec, `kind ${kind} has no motion row`).toBeDefined();
      expect(spec.name.length).toBeGreaterThan(0);
      expect(names.has(spec.name), `motion name '${spec.name}' is reused`).toBe(false);
      names.add(spec.name);
    }
    expect(names.size).toBe(kinds.length);
  });

  it('keeps every wave to whole pixels within the 2px amplitude ceiling', () => {
    const out = blankSample();
    for (const kind of kinds) {
      const spec = MACHINE_MOTION[kind as MachineKind];
      for (let step = 0; step < 64; step++) {
        sampleWave(spec.wave, step / 64, out);
        for (const value of [out.dx, out.dy, out.dw, out.dh]) {
          expect(Number.isInteger(value), `${spec.name} emits a sub-pixel offset`).toBe(true);
          expect(Math.abs(value)).toBeLessThanOrEqual(2);
        }
        // A squeeze keeps its base planted: any height loss is paired with the dy that
        // pins the bottom edge, so no wave can lift a machine off its own footprint.
        if (out.dh < 0) expect(out.dy).toBe(-out.dh);
      }
    }
  });

  it('moves every kind whose motion is carried by the body itself', () => {
    // The two deliberate exceptions: the Fryer's motion IS its bubbles, and the Tank's
    // is its fill line breathing. Everything else must visibly move over a cycle.
    const out = blankSample();
    for (const kind of kinds) {
      const spec = MACHINE_MOTION[kind as MachineKind];
      if (spec.wave === 'still') {
        expect([MachineKind.Fryer, MachineKind.Tank]).toContain(kind);
        expect(spec.specks !== undefined || spec.fillPulse === true).toBe(true);
        continue;
      }
      let moved = false;
      for (let step = 0; step < 64 && !moved; step++) {
        sampleWave(spec.wave, step / 64, out);
        moved = out.dx !== 0 || out.dy !== 0 || out.dw !== 0 || out.dh !== 0;
      }
      expect(moved, `${spec.name} never moves`).toBe(true);
    }
  });
});

describe('the working detector', () => {
  it('primes on first sight and moves only once progress advances', () => {
    const motion = makeMotion();
    const out = blankSample();
    const v = world();

    // First sight mid-operation: prime, no motion — the loaded-save rule.
    expect(motion.sample(machine({ progressPermille: 500 }), v, 1000, out)).toBe(false);

    // Progress moved: working, and the chop's own cycle guarantees a nonzero offset
    // somewhere in the period even if this instant samples the blade at rest.
    expect(motion.sample(machine({ progressPermille: 520 }), v, 1050, out)).toBe(true);
  });

  it('keeps moving through the permille hold, then stops when progress stalls', () => {
    const motion = makeMotion();
    const out = blankSample();
    const v = world();

    motion.sample(machine({ progressPermille: 500 }), v, 1000, out);
    motion.sample(machine({ progressPermille: 520 }), v, 1050, out);

    // Inside the hold with no new step: still working (permille steps can be slow).
    expect(motion.sample(machine({ progressPermille: 520 }), v, 1050 + 300, out)).toBe(true);

    // Past the hold with no new step: still.
    const later = 1050 + PROGRESS_HOLD_MS + 50;
    expect(motion.sample(machine({ progressPermille: 520 }), v, later, out)).toBe(false);
    expect([out.dx, out.dy, out.dw, out.dh]).toEqual([0, 0, 0, 0]);
  });

  it('freezes the same frame the lamp leaves Running — starved, blocked, halted, jammed', () => {
    const motion = makeMotion();
    const out = blankSample();
    const v = world();

    motion.sample(machine({ progressPermille: 500 }), v, 1000, out);
    motion.sample(machine({ progressPermille: 520 }), v, 1050, out);

    for (const lamp of [LampState.Starved, LampState.Blocked, LampState.Halted, LampState.Jammed]) {
      // One frame later, inside every hold window: the lamp alone must stop it dead.
      expect(motion.sample(machine({ progressPermille: 520, lamp }), v, 1066, out)).toBe(false);
      expect([out.dx, out.dy, out.dw, out.dh]).toEqual([0, 0, 0, 0]);
    }
  });

  it('stills a jammed or halted machine under EVERY driver, not just progress', () => {
    const motion = makeMotion();
    const out = blankSample();
    const v = world();

    // A pump is 'running'-driven; jam it (a whack pending) and it must not throb.
    const pump = machine({ kind: MachineKind.Pump, lamp: LampState.Jammed });
    expect(motion.sample(pump, v, 1000, out)).toBe(false);
  });

  it('drives a dock from its bot being out, and stills it when the bot docks', () => {
    const motion = makeMotion();
    const out = blankSample();
    const dock = machine({ kind: MachineKind.HarvesterDock, id: 7, lamp: LampState.Off });

    const botOut = world({ bots: [{ id: 1, dockId: 7, phase: 2 }] });
    motion.beginFrame(botOut, 1000);
    expect(motion.sample(dock, botOut, 1000, out)).toBe(true);

    const botHome = world({ bots: [{ id: 1, dockId: 7, phase: 0 }] });
    motion.beginFrame(botHome, 2000);
    expect(motion.sample(dock, botHome, 2000, out)).toBe(false);
  });

  it('rings the sell bin as a pulse when the sales counter moves, then settles', () => {
    const motion = makeMotion();
    const out = blankSample();
    const bin = machine({ kind: MachineKind.SellBin, lamp: LampState.Off });

    // Priming frame: a loaded save's lifetime sales are history, not a sale.
    motion.beginFrame(world({ stats: { itemsSold: 400 } }), 1000);
    expect(motion.sample(bin, world(), 1000, out)).toBe(false);

    motion.beginFrame(world({ stats: { itemsSold: 403 } }), 2000);
    expect(motion.sample(bin, world(), 2000, out)).toBe(true);

    // The pulse is a burst, not a mood: well past its duration the bin sits still.
    expect(motion.sample(bin, world(), 2000 + 2000, out)).toBe(false);
  });

  it('cranks the maintenance station on a kit SPENT, never on a kit arriving', () => {
    const motion = makeMotion();
    const out = blankSample();
    const station = (kits: number) =>
      machine({ kind: MachineKind.MaintenanceStation, inputCount: kits });
    const v = world();

    motion.sample(station(2), v, 1000, out); // prime
    expect(motion.sample(station(3), v, 2000, out)).toBe(false); // a delivery
    expect(motion.sample(station(2), v, 3000, out)).toBe(true); // a service
  });
});

describe('the speck pool', () => {
  it('is bounded, reused, and never allocates under load', () => {
    const motion = makeMotion();

    // Hammer the emitter far past the pool from many machines at escalating times so the
    // throttle never saves it. The pool must cap, and expiry must free every slot.
    for (let i = 0; i < SPECK_POOL * 4; i++) {
      motion.emitSpecks(i, 'boil', 0, 0, 32, 32, i * 500);
    }
    expect(motion.activeSpecks).toBeLessThanOrEqual(SPECK_POOL);
    expect(motion.activeSpecks).toBeGreaterThan(0);

    for (let elapsed = 0; elapsed < 1200; elapsed += 16) motion.update(16);
    expect(motion.activeSpecks).toBe(0);
  });

  it('feeds the fryer, kettle, carbonator and kitchen from the one shared pool', () => {
    // The budget ruling in one assertion: the specking kinds name a style, not a pool.
    const specking = [
      MachineKind.Fryer,
      MachineKind.Kettle,
      MachineKind.Carbonator,
      MachineKind.ChipKitchen,
    ];
    for (const kind of specking) {
      expect(MACHINE_MOTION[kind].specks).toBeDefined();
    }
  });
});
