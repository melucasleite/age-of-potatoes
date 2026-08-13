'use client';

// One shared hook, for the gap between clicking a HUD button and the world admitting it.
//
// A HUD control that changes the world enqueues a `Command` (see `hudStore.dispatch`). The
// command applies at the NEXT tick boundary and the result reaches React at the next publish,
// so there is a window of up to about 150 ms in which the button still looks clickable and the
// slice still says the old thing. Click twice in that window and you have bought two levels of
// Speed when you meant one.
//
// The fix is NOT to optimistically update the slice. Sim state has exactly one source and the
// HUD is a reader (§12, §13); a panel that draws a level the world has not granted is a panel
// that will occasionally be wrong, and it will be wrong precisely when a command was refused.
// So: the button goes inert for a moment and the world answers in its own time.
//
// The timeout is a release valve rather than the mechanism. Normally the next publish changes
// the slice and the panel re-renders with real numbers well before it fires; it exists so that
// a REFUSED command — which changes nothing, publishes nothing, and is therefore invisible —
// cannot leave a button disabled forever.

import { useCallback, useEffect, useRef, useState } from 'react';

const RELEASE_MS = 700;

export interface Pending {
  /** True while this key is waiting on the world. */
  readonly isPending: (key: string) => boolean;
  /** Mark a key as sent. Cleared by the next slice change or by the release valve. */
  readonly hold: (key: string) => void;
  /** Drop the hold. Call when the published slice proves the command landed. */
  readonly clear: () => void;
}

export function usePending(): Pending {
  const [key, setKey] = useState<string | null>(null);
  const timer = useRef(0);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    setKey(null);
  }, []);

  const hold = useCallback((next: string) => {
    setKey(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      setKey(null);
    }, RELEASE_MS);
  }, []);

  useEffect(() => {
    const held = timer;
    return () => {
      window.clearTimeout(held.current);
    };
  }, []);

  const isPending = useCallback((candidate: string) => candidate === key, [key]);

  return { isPending, hold, clear };
}
