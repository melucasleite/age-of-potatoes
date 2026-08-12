'use client';

// Text that changes faster than a person reads it, written straight into a DOM node.
//
// This is §13's bypass rule with a hook around it: "high-frequency transient readouts draw
// in Pixi or write to a DOM node by ref, bypassing React entirely". React owns panels and
// menus — things that change when the PLAYER does something. A clock and a hover readout
// change when the WORLD does, several times a second, forever, and routing them through a
// render would cost a reconciliation per tick to move six characters.

import { useEffect, useRef } from 'react';

/**
 * Poll `read` and write the result into the returned ref's node when it changed.
 *
 * `read` is stashed in a ref, so an inline arrow at the call site does not restart the
 * timer on every render. The interval is deliberately coarse — 250 ms is four updates a
 * second, which is faster than anyone reads a clock and cheaper than one React render.
 */
export function useLiveText<T extends HTMLElement>(
  read: () => string,
  intervalMs = 250,
): React.RefObject<T | null> {
  const nodeRef = useRef<T | null>(null);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    let previous: string | null = null;
    const write = (): void => {
      const node = nodeRef.current;
      if (node === null) return;
      const next = readRef.current();
      if (next === previous) return;
      previous = next;
      node.textContent = next;
    };
    write();
    const timer = window.setInterval(write, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return nodeRef;
}
