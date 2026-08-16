// The can's three-state threshold ([[073]]), pinned at its boundaries.
//
// What fails QUIETLY without this: an off-by-one at max/2 shows the wrong can for one
// charge out of twenty — invisible in play, guaranteed to drift the day someone rewrites
// the comparison — and a `<` where `<=` belongs makes the chip and the hand disagree,
// which is the exact two-surfaces bug the shared helper exists to make impossible.

import { describe, expect, it } from 'vitest';
import { CAN_CHARGES_MAX } from '@snack/sim';

import { CAN_STATE_FRAME, canFillState, canFrame } from './can-state';

describe('canFillState', () => {
  it('pins the boundaries at the shipped cap of twenty', () => {
    // The owner's number, asserted here so a balance change re-opens this conversation.
    expect(CAN_CHARGES_MAX).toBe(20);
    expect(canFillState(0, CAN_CHARGES_MAX)).toBe('empty');
    expect(canFillState(1, CAN_CHARGES_MAX)).toBe('half');
    expect(canFillState(CAN_CHARGES_MAX / 2, CAN_CHARGES_MAX)).toBe('half');
    expect(canFillState(CAN_CHARGES_MAX / 2 + 1, CAN_CHARGES_MAX)).toBe('full');
    expect(canFillState(CAN_CHARGES_MAX, CAN_CHARGES_MAX)).toBe('full');
  });

  it('rounds an odd cap toward half, so the flip never claims fullness early', () => {
    // max 7: half covers 1..3 (3 <= 3.5), full starts at 4.
    expect(canFillState(3, 7)).toBe('half');
    expect(canFillState(4, 7)).toBe('full');
  });

  it('never throws on a view from a stranger sim', () => {
    expect(canFillState(-2, 20)).toBe('empty');
    expect(canFillState(3, 0)).toBe('full');
    expect(canFillState(0, 0)).toBe('empty');
  });
});

describe('canFrame', () => {
  it('maps each state to its authored frame, full being input’s own tool_water', () => {
    expect(canFrame(20, 20)).toBe('tool_water');
    expect(canFrame(10, 20)).toBe('tool_water_half');
    expect(canFrame(0, 20)).toBe('tool_water_empty');
    // The table itself, pinned by name: these are the art pipeline's shipped ids.
    expect(CAN_STATE_FRAME).toEqual({
      full: 'tool_water',
      half: 'tool_water_half',
      empty: 'tool_water_empty',
    });
  });
});
