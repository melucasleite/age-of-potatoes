// The cheap structural gate for the Music Box.
//
// Two things in this subsystem fail SILENTLY, which is why they are the two things pinned
// here. A grid that drifts by a few milliseconds still makes noise, so nothing throws and
// nothing looks wrong in a screenshot — it just stops sounding like a groove and starts
// sounding like a clatter, and by then the cause is three refactors back. And a synthesis
// bug that puts a NaN in a buffer produces exact silence from a subsystem whose normal
// state on a fresh page load is also exact silence.
//
// Everything here runs headless with stub nodes. There is no `AudioContext` in Node, and
// building one would be testing the browser rather than this code.

import { describe, expect, it } from 'vitest';

import { Scheduler, TICKS_PER_SIXTEENTH } from './scheduler';
import type { AudioEngine } from './AudioEngine';
import { ALL_SOUND_IDS, SoundId, soundSpec } from './sounds';
import { SoundBank } from './synth';

const TICK_S = 0.05;
const BEAT_TICKS = 12;
const ANCHOR = 100;

interface Played {
  readonly id: string;
  readonly when: number;
}

/** A scheduler wired to a fake clock and a fake pool, so `now` can be driven by hand. */
function makeRig(): {
  played: Played[];
  engine: { now: number; anchorTick: number; anchorTime: number };
  scheduler: Scheduler;
  pump: () => void;
} {
  const played: Played[] = [];
  const engine = {
    started: true,
    now: ANCHOR,
    anchorTick: 0,
    anchorTime: ANCHOR,
    voices: {
      play(spec: { id: string }, when: number): boolean {
        played.push({ id: spec.id, when });
        return true;
      },
    },
    timeOf(tick: number): number {
      return this.anchorTime + (tick - this.anchorTick) * TICK_S;
    },
  };

  const scheduler = new Scheduler(engine as unknown as AudioEngine);
  const pump = (): void => {
    (scheduler as unknown as { pump: () => void }).pump();
  };
  return { played, engine, scheduler, pump };
}

/** Distance from the nearest beat boundary, in ticks. */
function offGrid(when: number, anchorTick: number): number {
  const tick = (when - ANCHOR) / TICK_S + anchorTick;
  return Math.abs(tick - Math.round(tick / BEAT_TICKS) * BEAT_TICKS);
}

describe('the beat grid', () => {
  it('derives a sixteenth from the sim rather than redeclaring it', () => {
    // The sim owns the grid. If `TICKS_PER_BEAT` ever moves, this moves with it.
    expect(TICKS_PER_SIXTEENTH).toBe(3);
  });

  it('lands a machine sound on a beat boundary from every possible starting tick', () => {
    for (let tick = 0; tick < BEAT_TICKS * 5; tick++) {
      const rig = makeRig();
      rig.engine.anchorTick = tick;
      rig.scheduler.setTick(tick, performance.now());
      // The jam alarm is the beat-quantized machine sound since [[145]] took the kitchen's.
      rig.scheduler.push({ soundId: SoundId.MachineJam, tick, pan: 0, gain: 1, rate: 1 });

      for (let pass = 0; pass < 40 && rig.played.length === 0; pass++) {
        rig.engine.now = ANCHOR + pass * 0.025;
        rig.pump();
      }

      expect(rig.played.length, `tick ${tick} never sounded`).toBe(1);
      const when = rig.played[0]!.when;
      expect(offGrid(when, tick), `tick ${tick} landed off the grid`).toBeLessThan(1e-6);
      // Never into the past, and never inside the ~30 ms the audio thread needs.
      expect(when).toBeGreaterThanOrEqual(rig.engine.now + 0.03 - 1e-9);
    }
  });

  it('fires a player verb immediately instead of waiting for a beat', () => {
    // Plan §2's tactile spec. Quantizing this would add up to 600 ms to hand-farming.
    const rig = makeRig();
    rig.scheduler.setTick(0, performance.now());
    rig.scheduler.push({ soundId: SoundId.HarvestPop, tick: 0, pan: 0, gain: 1, rate: 1 });
    rig.pump();

    expect(rig.played.length).toBe(1);
    expect(rig.played[0]!.when).toBeCloseTo(ANCHOR, 6);
  });

  it('places the running ensemble once per beat and only on boundaries', () => {
    const rig = makeRig();
    rig.scheduler.setEnsemble([{ soundId: SoundId.MachineJam, pan: 0, gain: 1, rate: 1 }]);

    for (let pass = 0; pass < 200; pass++) {
      const elapsed = pass * 0.025;
      rig.engine.now = ANCHOR + elapsed;
      rig.scheduler.setTick(Math.floor(elapsed / TICK_S), performance.now());
      rig.pump();
    }

    expect(rig.played.length).toBeGreaterThan(5);
    for (const sound of rig.played) expect(offGrid(sound.when, 0)).toBeLessThan(1e-6);
    // No beat is placed twice — that is what a double-drum sounds like.
    expect(new Set(rig.played.map((s) => s.when.toFixed(6))).size).toBe(rig.played.length);
  });

  it('stops drumming when the world stops reporting frames', () => {
    // A paused game or a hidden tab. Projected tick times are fiction from there on.
    const rig = makeRig();
    rig.scheduler.setEnsemble([{ soundId: SoundId.MachineJam, pan: 0, gain: 1, rate: 1 }]);
    rig.scheduler.setTick(0, performance.now() - 5000);

    for (let pass = 0; pass < 100; pass++) {
      rig.engine.now = ANCHOR + pass * 0.025;
      rig.pump();
    }
    expect(rig.played.length).toBe(0);
  });
});

describe('the synthesized bank', () => {
  it('renders every catalogued sound finite, audible, unclipped, and ending in silence', () => {
    const ctx = {
      sampleRate: 48000,
      createBuffer(_channels: number, frames: number, sampleRate: number) {
        const data = new Float32Array(frames);
        return { length: frames, sampleRate, getChannelData: () => data };
      },
    };
    const bank = new SoundBank(ctx as unknown as BaseAudioContext);

    for (const id of ALL_SOUND_IDS) {
      const buffer = bank.get(id);
      expect(buffer, `${id} was never rendered`).not.toBeNull();

      const data = buffer!.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const sample = data[i]!;
        expect(Number.isFinite(sample), `${id} has a non-finite sample at ${i}`).toBe(true);
        if (Math.abs(sample) > peak) peak = Math.abs(sample);
      }

      expect(peak, `${id} is silent`).toBeGreaterThan(0.01);
      expect(peak, `${id} clips`).toBeLessThanOrEqual(1.0001);
      // A buffer that ends on a non-zero sample clicks on EVERY playback, which reads as
      // a bug in the voice pool and is not one.
      expect(Math.abs(data[data.length - 1]!), `${id} ends on a click`).toBeLessThan(1e-6);
      expect(soundSpec(id).id).toBe(id);
    }
  });

  it('quantizes machines and never quantizes the player', () => {
    for (const id of [SoundId.MachineJam]) {
      expect(soundSpec(id).quantize, `${id} must ride the grid`).toBe('beat');
    }
    for (const id of [SoundId.WaterPour, SoundId.HarvestPop, SoundId.PlantSeed, SoundId.UiClick]) {
      expect(soundSpec(id).quantize, `${id} must not wait for a beat`).toBe('immediate');
    }
  });
});
