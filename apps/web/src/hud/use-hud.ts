'use client';

// The read side. Two hooks, and deliberately not a third.
//
// Work item 013 is explicit that the version-counter machinery is correct design but only
// starts *earning* its place around panel six — so this is a store, one subscription hook,
// and one escape hatch to the non-reactive channel. It is not a selector framework, it has
// no equality-function parameter, and it does not memo-diff anything. When panel six
// arrives, generalise it then, with six real call sites to generalise from.

import { useSyncExternalStore } from 'react';

import { hudStore } from './store';
import type { HudLive, HudSnapshot, SliceName } from './types';

/**
 * Subscribe to one slice. The component re-renders only when THAT slice's object was
 * rebuilt — every other publish bails out inside React on an `Object.is` hit, because
 * `hudStore.getters[name]` returns the same reference until the slice actually moved.
 */
export function useHudSlice<K extends SliceName>(name: K): HudSnapshot[K] {
  return useSyncExternalStore(
    hudStore.subscribe,
    hudStore.getters[name],
    hudStore.serverGetters[name],
  );
}

/**
 * The non-reactive channel, for readouts that change faster than a person reads (§13).
 *
 * The returned object is STABLE AND MUTABLE and is not a render input. Read it inside a
 * rAF or an interval and write the result into a DOM node by ref. Putting one of its
 * fields into `useState` re-introduces exactly the per-frame React work this exists to
 * avoid, and the object identity never changes so it would not even update.
 */
export function useHudLive(): HudLive {
  return hudStore.live;
}
