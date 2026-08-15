// The diagnostics ranking's structural gates (work item 039).
//
// Same philosophy as `reports.test.ts`: pin only what fails QUIETLY. Every failure below
// leaves a panel that renders perfectly — it simply ranks wrong, names wrong, or shows a
// list to a player who has not bought the read. Nothing throws, and a screenshot looks fine.
//
//   · THE ORDER IS THE PRODUCT. A ranked list that is mis-sorted is worse than no list —
//     the player aims their maintenance factory at the wrong machine and the panel took the
//     blame for it. Descending by cents, ties by id, deterministically.
//   · THE GATE IS A DESIGN RULING. §3 makes diagnostics a real node with real UI; a list
//     that leaks before research is a tech tree with a hole in it.
//   · THE NAMES MUST AGREE WITH THE DAWN FLAG'S. "Fryer B" must be the same fryer in both
//     surfaces, or the two halves of §5's cash voice contradict each other.
//
// Everything under test is pure — no DOM, no React, no store.

import { describe, expect, it } from 'vitest';
import { TechId, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { DIAGNOSTICS_ROW_LIMIT, diagnosticsUnlocked, rankBleeds } from './diagnostics';
import { reportsStore } from './store';

/** A machine view with the three fields the ranking actually reads. */
function machine(id: number, kind: number, bleedCentsLast60s: number): unknown {
  return { id, kind, bleedCentsLast60s };
}

function viewWithMachines(
  machines: readonly unknown[],
  unlocked: readonly string[] = [TechId.Diagnostics],
): WorldView {
  const view = createWorldView();
  view.unlocked = unlocked.slice();
  view.machines = machines as typeof view.machines;
  return view;
}

describe('the diagnostics ranking', () => {
  it('ranks by cents bled, worst first, ties broken by id', () => {
    const view = viewWithMachines([
      machine(1, 6, 400),
      machine(2, 6, 1400),
      // The tie: two machines that wasted the same money must always list in the same
      // order, or the panel shuffles on every publish and reads as alive in the one way a
      // receipt must not.
      machine(3, 4, 400),
      machine(4, 5, 900),
    ]);
    expect(rankBleeds(view).map((row) => row.id)).toEqual([2, 4, 1, 3]);
  });

  it('lists only machines that actually bled', () => {
    // A healthy machine on the list with "$0.00 wasted" would turn the ranked list into
    // the machine census, and the empty state — the nicest sentence the panel prints —
    // would never appear.
    const view = viewWithMachines([machine(1, 6, 0), machine(2, 4, 250), machine(3, 5, 0)]);
    const rows = rankBleeds(view);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(2);
  });

  it('caps the list rather than itemising a whole broken lot', () => {
    const many: unknown[] = [];
    for (let i = 1; i <= DIAGNOSTICS_ROW_LIMIT + 5; i++) many.push(machine(i, 6, i * 10));
    const rows = rankBleeds(viewWithMachines(many));
    expect(rows).toHaveLength(DIAGNOSTICS_ROW_LIMIT);
    // Capped from the BOTTOM: the worst bleeds survive the cut.
    expect(rows[0]?.bleedCents).toBe((DIAGNOSTICS_ROW_LIMIT + 5) * 10);
  });

  it('names machines the way the dawn flag does — kind plus letter, by id order', () => {
    // Two fryers: the lower id is "Fryer A" wherever it appears, so the diagnostics list
    // and the dawn card can never call the same machine two different names.
    const view = viewWithMachines([machine(7, 6, 100), machine(9, 6, 900)]);
    const rows = rankBleeds(view);
    expect(rows[0]?.label).toBe('Fryer B');
    expect(rows[1]?.label).toBe('Fryer A');
  });

  it('is locked until the node is researched', () => {
    expect(diagnosticsUnlocked(viewWithMachines([], []))).toBe(false);
    expect(diagnosticsUnlocked(viewWithMachines([], [TechId.Diagnostics]))).toBe(true);
  });
});

describe('the diagnostics slice in the store', () => {
  it('publishes no rows before the unlock, and the ranking after it', () => {
    const token = {};
    reportsStore.claim(token, 3939);

    // Bleeding machines, node not researched: the slice must not leak the list.
    reportsStore.publishWorld(token, viewWithMachines([machine(1, 6, 500)], []));
    let slice = reportsStore.getSnapshot().diagnostics;
    expect(slice.unlocked).toBe(0);
    expect(slice.rows).toHaveLength(0);

    // The node lands: same lot, and the list lights up phrased-in-cash rows.
    reportsStore.publishWorld(token, viewWithMachines([machine(1, 6, 500)]));
    slice = reportsStore.getSnapshot().diagnostics;
    expect(slice.unlocked).toBe(1);
    expect(slice.rows).toHaveLength(1);
    expect(slice.rows[0]?.bleedCents).toBe(500);
    expect(slice.rows[0]?.label).toBe('Fryer A');

    reportsStore.release(token);
  });

  it('holds the slice still while nothing moves', () => {
    const token = {};
    reportsStore.claim(token, 4040);

    reportsStore.publishWorld(token, viewWithMachines([machine(1, 6, 500)]));
    const first = reportsStore.getSnapshot().diagnostics;
    reportsStore.publishWorld(token, viewWithMachines([machine(1, 6, 500)]));
    // Same bleed, same object — the version dance's whole promise, so React does nothing.
    expect(reportsStore.getSnapshot().diagnostics).toBe(first);

    reportsStore.release(token);
  });
});
