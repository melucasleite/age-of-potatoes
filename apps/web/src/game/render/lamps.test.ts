// What is pinned here is the SHAPE contract, because it is the half of a status lamp that a
// test can hold and the eye cannot.
//
// The colour half gets checked by looking at it, and looking at it is exactly why the gap this
// file guards existed for so long: `LAMP_TINT` shipped for weeks with Blocked and Jammed on
// the same hex and Off and Halted on the same hex, which looks completely fine on screen —
// four states, four lamps, all clearly doing something. The information was missing rather
// than wrong, and missing information does not look like anything.
//
// So: every state must resolve to its own frame, and the frame table must be exhaustive over
// `LampState` rather than over "the states that existed when this was written".

import { describe, expect, it } from 'vitest';

import { LampState } from '@snack/sim';

import { LAMP_FRAME, LAMP_TINT, lampAlpha, lampFrame, lampTint } from './lamps';
import { overPaper, PAPER } from './tint';

const STATES = Object.values(LampState);

describe('lamp shapes', () => {
  it('gives every LampState its own frame', () => {
    const frames = STATES.map((state) => lampFrame(state));
    expect(frames).toHaveLength(7);
    expect(new Set(frames).size).toBe(7);
  });

  it('names every frame in the table, with nothing left over', () => {
    expect(Object.keys(LAMP_FRAME)).toHaveLength(STATES.length);
    for (const state of STATES) expect(LAMP_FRAME[state]).toMatch(/^lamp_[a-z]+$/);
  });

  it('falls back to the off frame for a state the sim has not shipped yet', () => {
    expect(lampFrame(99)).toBe(LAMP_FRAME[LampState.Off]);
  });
});

describe('lamp colour', () => {
  it('still gives every state a tint, so shape ADDS to colour rather than replacing it', () => {
    for (const state of STATES) expect(lampTint(state)).toBeGreaterThan(0);
    expect(Object.keys(LAMP_TINT)).toHaveLength(STATES.length);
  });

  it('keeps blocked and jammed on one red, which is §5 grammar and not an oversight', () => {
    expect(LAMP_TINT[LampState.Jammed]).toBe(LAMP_TINT[LampState.Blocked]);
    expect(lampFrame(LampState.Jammed)).not.toBe(lampFrame(LampState.Blocked));
  });

  it('never blinks a lamp out entirely, so the shape is readable at any point in the pulse', () => {
    for (const state of STATES) {
      for (let ms = 0; ms < 2000; ms += 7) {
        expect(lampAlpha(state, ms)).toBeGreaterThan(0.4);
      }
    }
  });
});

describe('overPaper', () => {
  // The whole reason this arithmetic exists: a `paper` sprite multiplied by the returned tint
  // has to come out as the colour that was asked for, not a warm-shifted approximation of it.
  // Every channel below is darker than `paper`, so every one of them is exactly reachable.
  it('round-trips a palette swatch through a multiply by paper', () => {
    for (const target of [0x5fd44a, 0xd94f36, 0x6d5c4d, 0x9a8873]) {
      const tint = overPaper(target);
      for (let shift = 0; shift <= 16; shift += 8) {
        const paper = (PAPER >> shift) & 0xff;
        const got = Math.round((paper * ((tint >> shift) & 0xff)) / 255);
        expect(Math.abs(got - ((target >> shift) & 0xff))).toBeLessThanOrEqual(1);
      }
    }
  });

  // The two channels in the whole status palette that a multiply cannot reach, both under 5%
  // and both documented in `tint.ts`: `lamp_starved`'s red and `water_bright`'s blue. They must
  // clamp to full rather than wrap, because wrapping would turn a blue lamp dark red.
  it('clamps rather than wraps when a channel is brighter than paper', () => {
    expect(overPaper(0xffffff)).toBe(0xffffff);
    expect(overPaper(0x4fa3d1) & 0xff).toBe(0xff);
    expect((overPaper(0xf2a93b) >> 16) & 0xff).toBe(0xff);
  });
});
