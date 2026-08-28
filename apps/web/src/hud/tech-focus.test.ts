// The research panel's landing request, pinned at the seam ([[148]]).
//
// What fails quietly here: a locked build cell that opens the manual on the FRONTIER. The
// panel opens, something is selected, nothing throws — and the player who clicked "needs
// Belts" is looking at whatever they could afford instead of at Belts. The whole feature is
// the id surviving the trip, so the trip is what these tests walk: focus, consume-once,
// notify, and the open-never-toggle door into `panel-state.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publishBuildMenu, registerBuildMenuHooks } from '../game/input/build-panel';

import { closeLocalPanel, panelSnapshot } from './panel-state';
import { consumeFocusedTech, focusTech, openResearchPanel, subscribeTechFocus } from './tech-focus';

let unregister: () => void = () => undefined;

beforeEach(() => {
  // A close door that actually closes, exactly as `panel-state.test.ts` builds it — the
  // one-open invariant is only exercised end to end when closing moves the seam's snapshot.
  unregister = registerBuildMenuHooks({
    armAt: () => undefined,
    close: () => publishBuildMenu(false, 0, -1, []),
  });
});

afterEach(() => {
  // Leave the module-scope stores empty for whichever test file runs next.
  consumeFocusedTech();
  closeLocalPanel();
  publishBuildMenu(false, 0, -1, []);
  unregister();
});

describe('the pending focus', () => {
  it('is consumed once — the next plain T seeds from the frontier again', () => {
    focusTech('logistics-belts');
    expect(consumeFocusedTech()).toBe('logistics-belts');
    expect(consumeFocusedTech()).toBe('');
  });

  it('keeps the latest request when two locks are clicked before the panel reads', () => {
    focusTech('logistics-belts');
    focusTech('fabrication-fryer');
    expect(consumeFocusedTech()).toBe('fabrication-fryer');
  });

  it('notifies subscribers, so an already-open panel adopts the request', () => {
    let heard = 0;
    const unsubscribe = subscribeTechFocus(() => {
      heard += 1;
    });
    focusTech('logistics-belts');
    expect(heard).toBe(1);
    // The same id again is not news — nothing consumed it yet.
    focusTech('logistics-belts');
    expect(heard).toBe(1);
    unsubscribe();
    focusTech('fabrication-fryer');
    expect(heard).toBe(1);
  });
});

describe('openResearchPanel', () => {
  it('opens the research window with the node waiting for the panel to consume', () => {
    openResearchPanel('logistics-belts');
    expect(panelSnapshot()).toBe('research');
    expect(consumeFocusedTech()).toBe('logistics-belts');
  });

  it('OPENS, never toggles — two locked clicks in a row keep the manual up', () => {
    openResearchPanel('logistics-belts');
    openResearchPanel('logistics-belts');
    expect(panelSnapshot()).toBe('research');
  });

  it('closes the build menu through the seam’s own door, like every local opener', () => {
    publishBuildMenu(true, 0, -1, []); // B, as the keyboard layer reports it
    expect(panelSnapshot()).toBe('build');
    openResearchPanel('logistics-belts');
    expect(panelSnapshot()).toBe('research');
  });
});
