// The slicing arithmetic, pinned — because every failure here is silent.
//
// A strip sliced into the wrong cell count does not throw: it draws every stage slightly
// wrong, which reads as "the art came back bad" rather than as a bug. And the wilt-cell
// question has a failure mode subtler still: asking a four-cell strip for frame five
// CLAMPS, returning the mature plant as a perfectly real texture — so a wilted crop would
// stand fresh and green in the field, telegraphing the exact opposite of item 021's
// pressure. These are the numbers the atlas actually ships, tested at the widths it ships
// them at: 64×16 today, 80×16 the moment the five-frame strips land.

import { describe, expect, it } from 'vitest';

import { STAND_CELL, stridePhase, stripCells, stripHasWiltCell, walkStep } from './strips';

describe('stripCells', () => {
  it('reads four cells off a 64×16 strip — every committed crop strip today', () => {
    expect(stripCells(64, 16)).toBe(4);
  });

  it('reads five cells off an 80×16 strip — the regenerated wilt-bearing shape', () => {
    expect(stripCells(80, 16)).toBe(5);
  });

  it('rounds rather than floors, so a packer shaving a pixel cannot drop the last frame', () => {
    expect(stripCells(79, 16)).toBe(5);
    expect(stripCells(63, 16)).toBe(4);
  });

  it('never answers zero for a real picture', () => {
    expect(stripCells(8, 16)).toBe(1);
  });

  it('answers zero only for degenerate dimensions', () => {
    expect(stripCells(0, 16)).toBe(0);
    expect(stripCells(64, 0)).toBe(0);
    expect(stripCells(-64, 16)).toBe(0);
  });
});

describe('stripHasWiltCell', () => {
  // Every crop in data.ts has stageCount 5: four growth frames plus the sim's "ready"
  // stage drawn with the last of them. So the wilted frame is cell five.
  const STAGE_COUNT = 5;

  it('says no for the four-cell strips in the committed atlas', () => {
    expect(stripHasWiltCell(stripCells(64, 16), STAGE_COUNT)).toBe(false);
  });

  it('says yes the moment an 80×16 strip lands', () => {
    expect(stripHasWiltCell(stripCells(80, 16), STAGE_COUNT)).toBe(true);
  });

  it('tolerates a strip longer than it needs to be', () => {
    expect(stripHasWiltCell(6, STAGE_COUNT)).toBe(true);
  });

  it('refuses degenerate stage counts', () => {
    expect(stripHasWiltCell(5, 0)).toBe(false);
    expect(stripHasWiltCell(5, -1)).toBe(false);
  });
});

// The walk cadence ([[065]]): distance-driven, so it stops when the walker does. The
// numbers below are the real ones — SUBTILE is 256 and the stride is 64, four footfalls
// per tile, the values `bots.ts` shipped with and the player now shares.
const STRIDE = 64;

describe('stridePhase', () => {
  it('swaps feet every stride of distance walked', () => {
    expect(stridePhase(0, 0, STRIDE)).toBe(0);
    expect(stridePhase(63, 0, STRIDE)).toBe(0);
    expect(stridePhase(64, 0, STRIDE)).toBe(1);
    expect(stridePhase(127, 0, STRIDE)).toBe(1);
    expect(stridePhase(128, 0, STRIDE)).toBe(0);
  });

  it('accumulates distance across both axes, so a diagonal walk still steps', () => {
    expect(stridePhase(32, 32, STRIDE)).toBe(1);
    expect(stridePhase(64, 64, STRIDE)).toBe(0);
  });

  it('is a pure function of position — the same spot is always the same foot', () => {
    // No clock and no state: a save loaded mid-stride resumes on the same foot for free,
    // and a replay walks frame-identically.
    expect(stridePhase(500, 300, STRIDE)).toBe(stridePhase(500, 300, STRIDE));
  });

  it('answers the stand phase for a degenerate stride', () => {
    expect(stridePhase(100, 100, 0)).toBe(0);
  });
});

describe('walkStep', () => {
  it('cycles cells 1 and 2 while moving', () => {
    expect(walkStep(true, 0, 0, STRIDE)).toBe(1);
    expect(walkStep(true, 64, 0, STRIDE)).toBe(2);
  });

  it('never selects the stand cell while moving, at any distance', () => {
    // The walk must not flicker through the neutral pose. Every stride phase either side of
    // a boundary, and a long diagonal, all have to land inside the two contact cells.
    for (let d = 0; d < 512; d++) {
      const step = walkStep(true, d, d * 3, STRIDE);
      expect(step === 1 || step === 2).toBe(true);
      expect(step).not.toBe(STAND_CELL);
    }
  });

  it('takes the NEUTRAL cell when still, whatever foot the walk stopped on ([[134]])', () => {
    // The bug, stated as a test: standing used to answer cell 1, and cell 1 is a CONTACT
    // pose — one foot four source pixels off the ground. Both positions below have a stride
    // phase that would have produced a stride cell; neither may.
    expect(walkStep(false, 64, 0, STRIDE)).toBe(STAND_CELL);
    expect(walkStep(false, 96, 32, STRIDE)).toBe(STAND_CELL);
    expect(walkStep(false, 0, 0, STRIDE)).toBe(STAND_CELL);
  });

  it('pins the stand cell to the strip the atlas actually ships', () => {
    // `STAND_CELL` and the manifest have to agree or the farmer stands in a contact pose
    // again, silently. The committed human strips are 144×48 — three 48px cells, harvested
    // as contact, contact, PASSING — so the neutral cell is the LAST one.
    expect(STAND_CELL).toBe(stripCells(144, 48));
  });

  it('degrades rather than breaks on a two-cell strip', () => {
    // A stale atlas (or a bot strip, which is deliberately still two cells) clamps in
    // `fromStrip`. The stand cell must stay inside the clamp's reach rather than resolving
    // to a magenta square — wrong picture, real texture.
    expect(STAND_CELL).toBeGreaterThan(stripCells(96, 48));
  });
});
