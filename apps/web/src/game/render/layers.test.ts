// The z-order table, pinned.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS FILE EXISTS AT ALL. Item 120's entire renderer half is the ORDER of one array,
//  and an order is the easiest thing in a codebase to lose: it survives every refactor that
//  keeps the names, it has no call site to grep for, and it is re-established by whoever next
//  adds a slot and puts it "somewhere sensible". A screenshot catches a regression here only
//  if somebody happens to have a pipe over a belt in frame.
//
//  So the facts below are written as RELATIONS rather than as a copy of the array. Asserting
//  the literal list would fail on every future slot and teach the next person to update the
//  expectation without reading it — which is exactly how an ordering rule dies. Each `it` here
//  names one design decision and the reason it was made.
// ────────────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { LAYER_ORDER } from './layers';
import type { LayerName } from './layers';

/** Where a slot sits in draw order. Higher draws later, and therefore on top. */
function rank(name: LayerName): number {
  const at = LAYER_ORDER.indexOf(name);
  // A missing name is a renamed slot, and a renamed slot silently turns every comparison
  // below into `-1 < -1`, which passes. Fail loudly instead.
  if (at < 0) throw new Error(`layer ${name} is not in LAYER_ORDER`);
  return at;
}

/** `a` is painted over by `b`. */
function drawsUnder(a: LayerName, b: LayerName): boolean {
  return rank(a) < rank(b);
}

describe('the z-order table', () => {
  it('names each slot exactly once', () => {
    expect(new Set(LAYER_ORDER).size).toBe(LAYER_ORDER.length);
  });

  // ── item 120: plumbing is overhead ────────────────────────────────────────────────

  it('draws pipes over belts, their shapes, and the goods riding them', () => {
    // The feature in one assertion. Before item 120 the sim refused a pipe and a belt on one
    // tile, so this was a tie-break at a seam and `pipes` sat at the bottom; now a tile can
    // genuinely hold both, and the pipe is the nearer object.
    expect(drawsUnder('beltStructures', 'pipes')).toBe(true);
    expect(drawsUnder('beltShapes', 'pipes')).toBe(true);
    expect(drawsUnder('beltItems', 'pipes')).toBe(true);
  });

  it('draws pipes over crops and ground litter', () => {
    // A crop may now grow under a run (`applyPlantTile` never asks about plumbing), so this
    // is a real overlap and not a hypothetical. A pipe hidden BEHIND a potato plant would
    // read as buried, which is the opposite of the word "overhead".
    expect(drawsUnder('groundEntities', 'pipes')).toBe(true);
  });

  it('leaves machines and the player above the plumbing', () => {
    // A pipe may never share a machine footprint — item 120 kept that refusal — so this is
    // still only a seam tie, and a run should read as tucking into a collar rather than as
    // passing over the roof. The player is above for a blunter reason: losing the avatar
    // under a pipe is a worse bug than a slightly wrong depth cue.
    expect(drawsUnder('pipes', 'machines')).toBe(true);
    expect(drawsUnder('pipes', 'player')).toBe(true);
    expect(drawsUnder('pipes', 'worldUi')).toBe(true);
  });

  // ── item 120: the crossing has to READ as a crossing ──────────────────────────────

  it('lands the pipe shadow on the belt and under the plumbing', () => {
    // Both halves matter and they are different failures. Above `beltItems`, the shadow falls
    // ON the belt and the goods, which is what turns occlusion into height. Below `pipes`, it
    // stays a shadow — over the top it would be a dark stripe painted along the run.
    expect(drawsUnder('beltItems', 'pipeShade')).toBe(true);
    expect(drawsUnder('groundEntities', 'pipeShade')).toBe(true);
    expect(drawsUnder('pipeShade', 'pipes')).toBe(true);
  });

  it('keeps the shadow immediately beneath the pipe it belongs to', () => {
    // Adjacency, not merely order: anything that slipped between the two would be drawn into
    // the gap between a pipe and its own shadow — lit from underneath by its plumbing.
    expect(rank('pipes') - rank('pipeShade')).toBe(1);
  });

  // ── the ground bakes stay at the bottom ───────────────────────────────────────────

  it('keeps the baked ground under everything it is the ground for', () => {
    expect(drawsUnder('groundBake', 'zonePaint')).toBe(true);
    expect(drawsUnder('zonePaint', 'beltStructures')).toBe(true);
    expect(drawsUnder('zonePaint', 'pipeShade')).toBe(true);
  });
});
