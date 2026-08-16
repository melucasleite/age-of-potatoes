// The can chip's face ([[073]]): the shared threshold, resolved against the REAL atlas.
//
// The threshold arithmetic itself is pinned in `game/render/can-state.test.ts` — one
// helper, one boundary suite. What THIS file pins is the HUD's half of the bargain: the
// frame each state names actually exists in the shipped manifest, so the chip draws a can
// and not the silent null-fallback. An atlas repack that drops `tool_water_half` should be
// a red test, not a chip that quietly loses its face.

import { describe, expect, it } from 'vitest';

import { CAN_STATE_FRAME, canFrame } from '../game/render/can-state';

import { resolveFrameIcon } from './item-art';

describe('the can chip’s sprite', () => {
  it('every state’s frame is really in the atlas, at icon size', () => {
    for (const frame of Object.values(CAN_STATE_FRAME)) {
      const source = resolveFrameIcon(frame);
      expect(source, frame).not.toBeNull();
      expect(source!.width).toBe(16);
      expect(source!.height).toBe(16);
    }
  });

  it('the chip flips frames exactly where the shared threshold says (max 20)', () => {
    expect(canFrame(20, 20)).toBe('tool_water');
    expect(canFrame(11, 20)).toBe('tool_water');
    expect(canFrame(10, 20)).toBe('tool_water_half');
    expect(canFrame(1, 20)).toBe('tool_water_half');
    expect(canFrame(0, 20)).toBe('tool_water_empty');
  });
});
