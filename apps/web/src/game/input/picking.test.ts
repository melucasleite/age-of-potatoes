// The field lookup, now that farmland is a collection rather than a rectangle ([[066]]).
//
// What fails QUIETLY here (AGENTS.md's bar): `tileAtView` used to derive `isField` from the
// bounding box, which is exactly right until the first till — then a hole un-tilled inside
// the box still reads as field (the plant verb offers itself over grass) and a tile tilled
// outside it reads as grass (the ghost refuses farmland that exists). Neither throws; both
// read as "the game ignored my click". So the membership question is pinned against views
// with holes and with off-box tiles, plus the empty-field zeros case.

import { describe, expect, it } from 'vitest';
import { createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { fieldIndexAtView, tileAtView } from './picking';

/**
 * A view whose farmland is exactly `tiles`, written in the sim's own order — row-major by
 * world key ascending — because the lookup binary-searches and an unsorted fixture would
 * test a world the sim never publishes.
 */
function withField(view: WorldView, tiles: readonly (readonly [number, number])[]): WorldView {
  const sorted = [...tiles].sort(
    (a, b) => a[1] * view.worldTilesWide + a[0] - (b[1] * view.worldTilesWide + b[0]),
  );
  view.field.count = sorted.length;
  sorted.forEach(([x, y], i) => {
    view.field.tileX[i] = x;
    view.field.tileY[i] = y;
  });
  return view;
}

describe('fieldIndexAtView', () => {
  it('finds every member of a non-rectangular field and nothing else', () => {
    // An L: the legacy corner plus one tile tilled far outside the old rect.
    const view = withField(createWorldView(), [
      [4, 4],
      [5, 4],
      [4, 5],
      [20, 17],
    ]);

    expect(fieldIndexAtView(view, 4, 4)).toBeGreaterThanOrEqual(0);
    expect(fieldIndexAtView(view, 20, 17)).toBeGreaterThanOrEqual(0);
    // Inside the BOUNDING BOX of those tiles but not in the collection — the exact tile the
    // old rect arithmetic got wrong.
    expect(fieldIndexAtView(view, 5, 5)).toBe(-1);
    expect(fieldIndexAtView(view, 0, 0)).toBe(-1);
  });

  it('indexes into the parallel arrays, not into rect arithmetic', () => {
    const view = withField(createWorldView(), [
      [4, 4],
      [20, 17],
    ]);
    view.field.crop[0] = 1; // (4,4) — first in row-major world order.
    view.field.crop[1] = 3; // (20,17)

    expect(tileAtView(view, 4, 4).crop).toBe(1);
    expect(tileAtView(view, 20, 17).crop).toBe(3);
    expect(tileAtView(view, 20, 17).isField).toBe(true);
  });

  it('answers "not field" everywhere on an empty field, zeros and all', () => {
    const view = createWorldView(); // count 0; the box holds the legacy numbers.
    expect(fieldIndexAtView(view, 4, 4)).toBe(-1);
    expect(tileAtView(view, 4, 4).isField).toBe(false);
  });

  it('carries compost through the query — the field-placement refusal reads it ([[067]])', () => {
    const view = withField(createWorldView(), [[4, 4]]);
    view.field.compost[0] = 2;
    expect(tileAtView(view, 4, 4).compost).toBe(2);
    expect(tileAtView(view, 5, 4).compost).toBe(0);
  });
});
