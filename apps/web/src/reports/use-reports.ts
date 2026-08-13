'use client';

// The read side. One hook, and deliberately not a framework.
//
// `hud/use-hud.ts` makes the argument in full and it applies unchanged here: the
// version-counter machinery is correct design that only starts earning its keep around panel
// six, so this is a store and one subscription hook. It is not a selector library, it has no
// equality-function parameter, and it memo-diffs nothing — the store already did that work,
// which is the entire reason `getSnapshot` can be a field read.

import { useSyncExternalStore } from 'react';

import { reportsStore } from './store';
import type { ReportsSliceName, ReportsSnapshot } from './types';

/**
 * Subscribe to one slice. The component re-renders only when THAT slice was rebuilt — every
 * other publish bails out inside React on an `Object.is` hit, because
 * `reportsStore.getters[name]` returns the same reference until the slice actually moved.
 */
export function useReportsSlice<K extends ReportsSliceName>(name: K): ReportsSnapshot[K] {
  return useSyncExternalStore(
    reportsStore.subscribe,
    reportsStore.getters[name],
    reportsStore.serverGetters[name],
  );
}
