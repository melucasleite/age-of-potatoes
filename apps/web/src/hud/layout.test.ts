// The width contract, pinned at the seam ([[096]]).
//
// What fails quietly here is drift: `GameCanvas`'s `inset`, the sidebar's own `width` and the
// reports dock's `left` are three readers of one number, and the failure mode of a second
// constant is not a crash — it is a canvas that starts 416 pixels away from where the dock
// ends, on one state of one toggle, which nobody notices until they collapse the panel.
//
// The other thing pinned below is the toggle key. It is checked against the whole grammar by
// hand in `layout.ts`'s comment, and by list here, because the failure mode of a collision is
// silent too: `[` quietly walking the player north forever would be a bug with no error in it.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  SIDEBAR_HANDLE_PX,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_TOGGLE_CODE,
  SIDEBAR_WIDTH_PX,
  resetSidebarForTest,
  setSidebarCollapsed,
  sidebarCollapsed,
  sidebarServerSnapshot,
  sidebarWidth,
  subscribeSidebar,
  toggleSidebar,
} from './layout';

/** A `Storage` that lives in a Map. vitest runs with no DOM here, so there is no other one. */
function fakeStorage(seed: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as Storage & { map: Map<string, string> };
}

beforeEach(() => {
  resetSidebarForTest(() => null);
});

describe('the width contract', () => {
  it('gives the canvas the expanded width when the sidebar is open', () => {
    expect(sidebarWidth(false)).toBe(SIDEBAR_WIDTH_PX);
  });

  it('leaves only the handle behind when it is folded', () => {
    expect(sidebarWidth(true)).toBe(SIDEBAR_HANDLE_PX);
  });

  // Not a tautology: it is the whole reason the collapsed width is not zero. A fold that gave
  // the canvas every pixel would have nothing left on screen for the player to press.
  it('never folds to nothing', () => {
    expect(SIDEBAR_HANDLE_PX).toBeGreaterThan(0);
    expect(SIDEBAR_HANDLE_PX).toBeLessThan(SIDEBAR_WIDTH_PX);
  });
});

describe('the fold', () => {
  it('starts open when nothing was ever stored', () => {
    expect(sidebarCollapsed()).toBe(false);
  });

  it('toggles', () => {
    toggleSidebar();
    expect(sidebarCollapsed()).toBe(true);
    toggleSidebar();
    expect(sidebarCollapsed()).toBe(false);
  });

  it('tells its subscribers, once per real change', () => {
    let calls = 0;
    const stop = subscribeSidebar(() => {
      calls += 1;
    });

    toggleSidebar();
    expect(calls).toBe(1);

    // The no-op write. `useSyncExternalStore` would bail on `Object.is` anyway, but a store
    // that notifies on every set makes every subscriber's render budget the caller's problem.
    setSidebarCollapsed(true);
    expect(calls).toBe(1);

    stop();
    toggleSidebar();
    expect(calls).toBe(1);
  });

  it('renders open on the server, whatever the client last chose', () => {
    toggleSidebar();
    expect(sidebarCollapsed()).toBe(true);
    expect(sidebarServerSnapshot()).toBe(false);
  });
});

describe('the choice surviving a reload', () => {
  it('writes the fold to storage', () => {
    const store = fakeStorage();
    resetSidebarForTest(() => store);

    toggleSidebar();
    expect(store.map.get(SIDEBAR_STORAGE_KEY)).toBe('1');

    toggleSidebar();
    expect(store.map.get(SIDEBAR_STORAGE_KEY)).toBe('0');
  });

  it('reads it back — the reload', () => {
    resetSidebarForTest(() => fakeStorage({ [SIDEBAR_STORAGE_KEY]: '1' }));
    expect(sidebarCollapsed()).toBe(true);

    resetSidebarForTest(() => fakeStorage({ [SIDEBAR_STORAGE_KEY]: '0' }));
    expect(sidebarCollapsed()).toBe(false);
  });

  // Private browsing, quota, storage switched off entirely. The session must still play.
  it('survives storage that throws', () => {
    resetSidebarForTest(() => {
      throw new Error('SecurityError');
    });
    expect(sidebarCollapsed()).toBe(false);
    expect(() => {
      toggleSidebar();
    }).not.toThrow();
    expect(sidebarCollapsed()).toBe(true);
  });
});

describe('the toggle key', () => {
  // Every code bound anywhere in `apps/web`, swept for item 096. If one of these ever moves
  // onto the sidebar's key, this test is where it says so.
  const SPOKEN_FOR = [
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Space',
    'KeyB',
    'KeyR',
    'KeyC',
    'KeyT',
    'KeyG',
    'KeyI',
    'KeyP',
    'Escape',
    'Backquote',
    'F3',
    'Enter',
    'NumpadEnter',
    'Equal',
    'Minus',
    'NumpadAdd',
    'NumpadSubtract',
    'Digit0',
    'Digit1',
    'Digit2',
    'Digit3',
    'Digit4',
    'Digit5',
    'Digit6',
    'Digit7',
    'Digit8',
    'Digit9',
  ];

  it('collides with nothing in the existing grammar', () => {
    expect(SPOKEN_FOR).not.toContain(SIDEBAR_TOGGLE_CODE);
  });
});
