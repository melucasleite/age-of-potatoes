// The BUILD row's toggle, pinned at the seam ([[076]]).
//
// What fails quietly here: the row and the B key disagreeing about what "toggle" means.
// The row must close through the seam's own door when the menu is up (so the input layer
// AGREES it is gone — one slot, one occupant, [[071]]) and must never try to open the menu
// itself — opening is the keyboard layer's job, reached through the same keydown B produces.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMenuServerSnapshot,
  publishBuildMenu,
  registerBuildMenuHooks,
} from '../game/input/build-panel';

import { toggleBuildPanel } from './build-row';

function publish(open: boolean): void {
  publishBuildMenu(open, 0, -1, []);
}

afterEach(() => {
  // Leave the module-scope snapshot closed for whichever test file runs next.
  publish(false);
});

describe('the BUILD row toggle', () => {
  it('asks the keyboard layer to open when the menu is shut', () => {
    publish(false);
    const keys: string[] = [];
    toggleBuildPanel((code) => keys.push(code));
    expect(keys).toEqual(['KeyB']);
  });

  it('closes through the seam when the menu is up, and presses nothing', () => {
    publish(true);
    const close = vi.fn();
    const unregister = registerBuildMenuHooks({ armAt: () => undefined, close });
    const keys: string[] = [];
    toggleBuildPanel((code) => keys.push(code));
    unregister();

    expect(close).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([]);
  });

  it('the server snapshot is closed, so the row can render before the input attaches', () => {
    expect(buildMenuServerSnapshot().open).toBe(false);
  });
});
