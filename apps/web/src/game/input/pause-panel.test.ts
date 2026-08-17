// The pause seam ([[126]]): the store React watches, and the one door back in.
//
// WHAT FAILS QUIETLY HERE:
//
//   · A PUBLISH THAT NOTIFIES ON A NON-EDGE. Every subscriber is a `useSyncExternalStore`,
//     and a store that notifies without changing re-renders the modal for nothing on a
//     path that runs while the game is stopped.
//   · A DOOR THAT THROWS BEFORE A HOST EXISTS. `pauseMenuClose()` is reachable from the
//     server render and from the seconds before the canvas mounts; a throw there is a blank
//     screen at boot, which is the most expensive failure this file could have.
//   · A STALE HOST UNREGISTERING OVER A LIVE ONE. StrictMode mounts twice, so the dying
//     host's unregister runs AFTER its replacement registered. If it cleared the live
//     hooks, Resume would silently stop working — no error, just a dead button.
//
// No DOM: this is a module-scope store and a `Set`, which is why the surface was split off
// from it in the first place.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  pauseMenuClose,
  pauseMenuOpen,
  pauseMenuServerSnapshot,
  pauseMenuSnapshot,
  publishPauseMenu,
  registerPauseMenuHooks,
  subscribePauseMenu,
} from './pause-panel';

beforeEach(() => {
  publishPauseMenu(false);
});

describe('the snapshot', () => {
  it('starts closed and says so cheaply', () => {
    expect(pauseMenuServerSnapshot().open).toBe(false);
    expect(pauseMenuOpen()).toBe(false);
  });

  it('is frozen, so nothing downstream can quietly pause the game by writing to it', () => {
    expect(Object.isFrozen(pauseMenuSnapshot())).toBe(true);
  });

  it('notifies on edges only', () => {
    let calls = 0;
    const off = subscribePauseMenu(() => {
      calls += 1;
    });

    publishPauseMenu(true);
    expect(calls).toBe(1);
    expect(pauseMenuOpen()).toBe(true);

    // The same value again is not an edge — `InputSystem` guards its own verbs too, and the
    // belt and braces are deliberate: this store is read on a paused frame loop.
    publishPauseMenu(true);
    expect(calls).toBe(1);

    publishPauseMenu(false);
    expect(calls).toBe(2);
    expect(pauseMenuOpen()).toBe(false);

    off();
    publishPauseMenu(true);
    expect(calls).toBe(2);
  });

  it('bumps the version on every real change, so a consumer can skip untouched frames', () => {
    const before = pauseMenuSnapshot().version;
    publishPauseMenu(true);
    expect(pauseMenuSnapshot().version).toBe(before + 1);
  });
});

describe('the door back in', () => {
  it('is a no-op before a host exists rather than a throw', () => {
    expect(() => {
      pauseMenuClose();
    }).not.toThrow();
  });

  it('routes Resume to whichever host is live', () => {
    let closed = 0;
    const off = registerPauseMenuHooks({
      close: () => {
        closed += 1;
      },
    });

    pauseMenuClose();
    expect(closed).toBe(1);

    off();
    pauseMenuClose();
    expect(closed).toBe(1);
  });

  it('survives a StrictMode double mount: the dead host cannot unhook the live one', () => {
    let live = 0;
    const offDying = registerPauseMenuHooks({ close: () => {} });
    const offLive = registerPauseMenuHooks({
      close: () => {
        live += 1;
      },
    });

    // The dying host's cleanup runs LAST, after its replacement already registered.
    offDying();

    pauseMenuClose();
    expect(live).toBe(1);
    offLive();
  });
});
