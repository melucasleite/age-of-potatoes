// The cheap structural gate for the fluid layer.
//
// Two things here fail in a way nobody notices in a screenshot, which is why they are the
// two things pinned.
//
// A wrong entry in the auto-tiling table draws a pipe that LOOKS joined and is not, or looks
// broken and is fine. Both are lies told to a player who is mid-way through debugging a dead
// syrup line — and both render perfectly, so there is nothing to see in review.
//
// And a liquid whose tint collapses toward the empty-pipe grey silently disarms §5's one
// diagnostic instrument: "pipes auto-tint by liquid and render gray when empty" only helps if
// the coloured ones are visibly not grey.
//
// Everything below is Pixi-free by construction — `pipe-shape.ts` and `liquids.ts` are pure
// arithmetic and tables, and they are separate modules from the layer for exactly this reason.

import { describe, expect, it } from 'vitest';

import { EMPTY_PIPE_TINT, LIQUID_LOOKS, liquidName, liquidTint } from './liquids';
import { PIPE_FRAMES, PipeSide, pipeShape, pipeSides } from './pipe-shape';
import type { PipeFrame } from './pipe-shape';

/** Rotate a mask `quarterTurns` clockwise. The inverse of what the renderer does to a sprite. */
function rotate(mask: number, quarterTurns: number): number {
  let out = mask;
  for (let i = 0; i < quarterTurns; i++) out = ((out << 1) | (out >> 3)) & 0b1111;
  return out;
}

/** The mask each frame is DRAWN for, before any rotation. `textures.ts` paints these exactly. */
const CANONICAL: Record<PipeFrame, number> = {
  stub: 0,
  cap: PipeSide.East,
  straight: PipeSide.East | PipeSide.West,
  corner: PipeSide.East | PipeSide.South,
  tee: PipeSide.East | PipeSide.South | PipeSide.West,
  cross: 0b1111,
};

describe('pipe auto-tiling', () => {
  it('covers all sixteen neighbour masks', () => {
    for (let mask = 0; mask < 16; mask++) {
      const shape = pipeShape(mask);
      expect(PIPE_FRAMES).toContain(shape.frame);
      expect(shape.quarterTurns).toBeGreaterThanOrEqual(0);
      expect(shape.quarterTurns).toBeLessThan(4);
    }
  });

  it('turns each frame to exactly the mask it was asked for', () => {
    // The one assertion that actually matters: rotating the chosen frame's canonical mask by
    // the chosen number of turns must reproduce the neighbour mask. A pipe that draws a
    // corner where the run needs a tee fails here and nowhere else.
    for (let mask = 0; mask < 16; mask++) {
      const shape = pipeShape(mask);
      expect(rotate(CANONICAL[shape.frame], shape.quarterTurns)).toBe(mask);
    }
  });

  it('picks the frame whose arm count matches the junction', () => {
    const arms: Record<PipeFrame, number> = {
      stub: 0,
      cap: 1,
      straight: 2,
      corner: 2,
      tee: 3,
      cross: 4,
    };
    for (let mask = 0; mask < 16; mask++) {
      expect(arms[pipeShape(mask).frame]).toBe(pipeSides(mask));
    }
  });

  it('reads a straight run as straight and an elbow as a corner', () => {
    expect(pipeShape(PipeSide.East | PipeSide.West).frame).toBe('straight');
    expect(pipeShape(PipeSide.North | PipeSide.South).frame).toBe('straight');
    expect(pipeShape(PipeSide.North | PipeSide.West).frame).toBe('corner');
    expect(pipeShape(PipeSide.North).frame).toBe('cap');
    expect(pipeShape(0).frame).toBe('stub');
  });

  it('ignores bits above the four compass sides', () => {
    expect(pipeShape(0b1111 | 0b110000)).toEqual(pipeShape(0b1111));
  });
});

describe('liquid colours', () => {
  it('renders an unknown liquid and an empty pipe as the same grey', () => {
    // Deliberate: an unrecognised liquid must look like a state the player already knows how
    // to debug, never like a rendering fault they cannot.
    expect(liquidTint(0)).toBe(EMPTY_PIPE_TINT);
    expect(liquidTint(9999)).toBe(EMPTY_PIPE_TINT);
    expect(liquidName(0)).toBeNull();
  });

  it('keeps every liquid clearly off the empty grey', () => {
    for (const [slug, look] of Object.entries(LIQUID_LOOKS)) {
      expect(distance(look.tint, EMPTY_PIPE_TINT), slug).toBeGreaterThan(60);
    }
  });

  it('keeps the soda chain distinguishable step by step', () => {
    // Juice → syrup → carbonated water → soda syrup are the four a player sees within one
    // glance of each other at the Bottler. If any adjacent pair converges, the "which inlet
    // is starved" read that the whole soda mid-game rests on is gone.
    const chain = ['cane-juice', 'simple-syrup', 'carbonated-water', 'soda-syrup'];
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        const a = LIQUID_LOOKS[chain[i]!]!.tint;
        const b = LIQUID_LOOKS[chain[j]!]!.tint;
        expect(distance(a, b), `${chain[i]} vs ${chain[j]}`).toBeGreaterThan(90);
      }
    }
  });

  it('names water, because the sim ships that one and the ribbon says it out loud', () => {
    expect(liquidName(1)).toBe('water');
  });
});

/** Straight RGB distance. Crude, and enough to catch two colours that have converged. */
function distance(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
