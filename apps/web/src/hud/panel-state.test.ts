// The one-panel-anywhere invariant, pinned at the seam ([[089]]).
//
// What fails quietly here: two panels open at once. The owner's ruling is one sentence —
// "Don't let them overlap. If one is already open, close it and open the other one" — and
// every clause below is that sentence aimed at a specific pair of doors. The nasty cases
// are the cross-layer ones: the bag is HUD state, the build menu is INPUT state
// (`build-panel.ts`, [[071]]), and the invariant only holds if each side closes the other
// through the other's own door. A parallel boolean would compile, render, and let the bag
// sit open behind the build menu forever.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMenuSnapshot,
  publishBuildMenu,
  registerBuildMenuHooks,
} from '../game/input/build-panel';

import {
  closeLocalPanel,
  openPanel,
  panelServerSnapshot,
  panelSnapshot,
  subscribePanels,
  togglePanel,
} from './panel-state';

/** What the keyboard layer does when B lands: publish the menu's new truth. */
function publish(open: boolean): void {
  publishBuildMenu(open, 0, -1, []);
}

let unregister: () => void = () => undefined;

beforeEach(() => {
  // A close door that actually closes — `buildMenuClose()` reaches the input system
  // through these hooks in the real page, and the invariant is only exercised end to end
  // when closing has a real effect on the seam's snapshot.
  unregister = registerBuildMenuHooks({ armAt: () => undefined, close: () => publish(false) });
});

afterEach(() => {
  // Leave both module-scope stores closed for whichever test file runs next.
  closeLocalPanel();
  publish(false);
  unregister();
});

describe('the floating bag', () => {
  it('I opens it; I again closes it', () => {
    togglePanel('bag');
    expect(panelSnapshot()).toBe('bag');
    togglePanel('bag');
    expect(panelSnapshot()).toBeNull();
  });

  it('Esc (closeLocalPanel) closes it', () => {
    togglePanel('bag');
    closeLocalPanel();
    expect(panelSnapshot()).toBeNull();
  });
});

describe('one float at a time — bag versus build', () => {
  it('I then B: the menu opens and the bag is evicted for real, not hidden', () => {
    togglePanel('bag');
    publish(true); // B, as the keyboard layer reports it.
    expect(panelSnapshot()).toBe('build');
    // Closing the menu later must NOT resurrect the bag — the eviction was a state change.
    publish(false);
    expect(panelSnapshot()).toBeNull();
  });

  it('B then I: the bag opens and closes the menu through the seam’s own door', () => {
    publish(true);
    expect(panelSnapshot()).toBe('build');
    togglePanel('bag');
    expect(panelSnapshot()).toBe('bag');
    // The input layer AGREES the menu is gone — or B would need pressing twice.
    expect(buildMenuSnapshot().open).toBe(false);
  });
});

describe('float versus slot — one panel anywhere', () => {
  it('opening the bag closes a slot panel', () => {
    togglePanel('research');
    expect(panelSnapshot()).toBe('research');
    togglePanel('bag');
    expect(panelSnapshot()).toBe('bag');
  });

  it('opening a slot panel closes the bag', () => {
    togglePanel('bag');
    togglePanel('shop');
    expect(panelSnapshot()).toBe('shop');
  });

  it('the build float closes a slot panel too, and closing it restores nothing', () => {
    togglePanel('shop');
    publish(true);
    expect(panelSnapshot()).toBe('build');
    publish(false);
    expect(panelSnapshot()).toBeNull();
  });
});

describe('the doors themselves', () => {
  it('openPanel opens and never toggles — the sell-bin click, clicked twice', () => {
    openPanel('shop');
    openPanel('shop');
    expect(panelSnapshot()).toBe('shop');
  });

  it('openPanel closes the build menu like every other local door', () => {
    publish(true);
    openPanel('bag');
    expect(panelSnapshot()).toBe('bag');
    expect(buildMenuSnapshot().open).toBe(false);
  });

  it('the server snapshot is closed, so the HUD can render before anything attaches', () => {
    expect(panelServerSnapshot()).toBeNull();
  });

  it('subscribers hear both layers: local toggles and the build seam', () => {
    let heard = 0;
    const unsubscribe = subscribePanels(() => {
      heard += 1;
    });
    togglePanel('bag');
    const afterLocal = heard;
    publish(true); // notifies via the seam, and again via the eviction's own change
    unsubscribe();
    expect(afterLocal).toBeGreaterThan(0);
    expect(heard).toBeGreaterThan(afterLocal);
    // And after unsubscribing, silence — a leaked listener would re-render a dead tree.
    const before = heard;
    togglePanel('research');
    expect(heard).toBe(before);
  });
});
