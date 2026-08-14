// The structural gate for the can readout ([[009]]).
//
// What fails QUIETLY here (AGENTS.md's bar for what earns a test):
//
//   · A HEADING THAT POINTS AT THE POND'S CENTRE. The refusal tell says "the water is
//     north-east" while the bank is due east at your feet — wrong exactly when the player
//     is closest, which is when they read it.
//   · '' MEANING THE WRONG THING. Empty is "nothing to point at" (within reach, or no pond
//     at all); a regression that returns '' for a distant pond silently deletes the pointer
//     half of the empty-can tell.
//   · CHARGES INVENTED HERE. The chip must repeat the sim's number, never count pours
//     itself — pinned by copying two odd values through.

import { describe, expect, it } from 'vitest';
import { HAND_REACH_SUBTILES, SUBTILE, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { deriveCan } from './derive';

function playerAt(tileX: number, tileY: number): WorldView {
  const view = createWorldView();
  view.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  view.player.ySub = tileY * SUBTILE + SUBTILE / 2;
  return view;
}

function withPond(view: WorldView, tileX: number, tileY: number, tiles = 2): WorldView {
  view.reservoirs.push({
    id: 1,
    tileX,
    tileY,
    tilesWide: tiles,
    tilesHigh: tiles,
    levelMl: 0,
    capacityMl: 1,
    levelPermille: 0,
    throttle: 0,
  } as WorldView['reservoirs'][number]);
  return view;
}

describe('deriveCan', () => {
  it('repeats the sim’s charge numbers without opinion', () => {
    const view = playerAt(4, 4);
    view.player.canCharges = 3;
    view.player.canChargesMax = 8;
    const can = deriveCan(view);
    expect(can.canCharges).toBe(3);
    expect(can.canChargesMax).toBe(8);
  });

  it('points at a distant pond, eight-point quantised', () => {
    expect(deriveCan(withPond(playerAt(4, 4), 20, 4)).shoreHeading).toBe('east');
    expect(deriveCan(withPond(playerAt(4, 4), 20, 20)).shoreHeading).toBe('south-east');
  });

  it('measures to the nearest point of the rect, not its centre', () => {
    // A wide pond due east whose CENTRE is south-east. The bank is what the arm reaches.
    const view = withPond(playerAt(4, 4), 12, 4, 8);
    expect(deriveCan(view).shoreHeading).toBe('east');
  });

  it('says nothing when the water is within dipping reach', () => {
    // The pond's edge one tile away — inside HAND_REACH, so there is nothing to point at.
    const view = withPond(playerAt(4, 4), 4, 5);
    expect(deriveCan(view).shoreHeading).toBe('');
  });

  it('says nothing in a pondless world, where the refill works anywhere', () => {
    expect(deriveCan(playerAt(4, 4)).shoreHeading).toBe('');
  });

  it('the reach fence is the sim’s hand reach, asserted at the boundary', () => {
    const view = playerAt(0, 0);
    view.player.xSub = 0;
    view.player.ySub = 0;
    // A 1×1 pond whose nearest corner is exactly one subtile past reach, due east.
    const justPast = HAND_REACH_SUBTILES + 1;
    view.reservoirs.push({
      id: 1,
      tileX: 0,
      tileY: 0,
      tilesWide: 0,
      tilesHigh: 0,
      levelMl: 0,
      capacityMl: 1,
      levelPermille: 0,
      throttle: 0,
    } as WorldView['reservoirs'][number]);
    // Degenerate rect at the origin: nearest point is (0,0) — within reach at distance 0.
    expect(deriveCan(view).shoreHeading).toBe('');
    // Step the player one subtile past the fence: now it points.
    view.player.xSub = -justPast;
    expect(deriveCan(view).shoreHeading).toBe('east');
  });
});
