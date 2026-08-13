'use client';

// The Welcome Back card's one piece of state, and the presence clock that feeds it ([[040]]).
//
// THE ORDERING RULE THIS FILE EXISTS TO ENFORCE: the last-played timestamp must be READ
// before the presence clock is allowed to OVERWRITE it. Get that backwards and the card
// reads back the current session, computes a gap of zero, and never appears — a bug that
// would be invisible in every test that does not involve waiting a day.
//
// STRICTMODE MAKES THAT ORDERING GENUINELY HARD, which is why the read is memoised at module
// scope rather than held in a ref. React 19 mounts, unmounts and remounts every component in
// development; a per-mount read would run twice, and the SECOND one would land after the
// first mount's clock had already written. The memo means both mounts await the same promise
// — one created before any write — so they agree, and they agree on the true answer.
//
// The clock is deliberately started only after that read resolves. It is a few hundred
// milliseconds of delay on a timestamp whose resolution is twenty seconds, in exchange for
// the ordering being structural instead of a race that usually goes the right way.

import { useCallback, useEffect, useState } from 'react';

import {
  type PlaySession,
  type PresenceHandle,
  deservesWelcome,
  formatTimeAway,
  readLastSession,
  startPresenceClock,
} from '@/storage';

import { hudStore } from './store';

/**
 * The pre-write read, done once per page load.
 *
 * Module scope rather than a ref for the StrictMode reason above. It is created lazily so it
 * never runs during SSR, where `isStorageAvailable()` is false anyway.
 */
let firstRead: Promise<PlaySession | null> | null = null;

function readOnce(): Promise<PlaySession | null> {
  firstRead ??= readLastSession();
  return firstRead;
}

/**
 * Dismissal outlives the component.
 *
 * A card the player has already closed must not return because StrictMode remounted the tree
 * or because `HudRoot` re-rendered through its no-world branch. Session-scoped, not
 * persisted: the next page load is a new arrival and gets to be greeted on its own merits.
 */
let dismissedThisSession = false;

export interface WelcomeState {
  /** True while the card should be on screen. */
  readonly show: boolean;
  /** "three days" — already phrased, already vague. Empty when there is nothing to show. */
  readonly awayLabel: string;
  readonly dismiss: () => void;
}

export function useWelcomeBack(): WelcomeState {
  const [awayLabel, setAwayLabel] = useState('');
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let clock: PresenceHandle | null = null;

    void readOnce().then((session) => {
      if (cancelled) return;

      if (!dismissedThisSession && deservesWelcome(session, Date.now())) {
        // `deservesWelcome` already established `session` is non-null and its gap positive.
        setAwayLabel(formatTimeAway(Date.now() - session!.at));
        setShow(true);
      }

      // Only now is it safe to start overwriting the record. See the header.
      if (cancelled) return;
      clock = startPresenceClock(() => {
        // The non-reactive channel (§13), which is exactly what it is for: a value read
        // inside an interval rather than rendered. `tick` is 0 before the first publish, and
        // a world that has not published has not advanced.
        const tick = hudStore.live.tick;
        return tick > 0 ? tick : null;
      });
    });

    return () => {
      cancelled = true;
      clock?.stop();
    };
  }, []);

  const dismiss = useCallback(() => {
    dismissedThisSession = true;
    setShow(false);
  }, []);

  return { show, awayLabel, dismiss };
}

/** Tests only. Drops the memoised read and the dismissal, so a case can set up its own. */
export function resetWelcomeMemo(): void {
  firstRead = null;
  dismissedThisSession = false;
}
