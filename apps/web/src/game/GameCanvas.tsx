'use client';

// The React side of the boundary, and deliberately almost nothing.
//
// React owns mounting and unmounting a DOM node. `GameHost` owns everything inside it.
// That split is plan §11's choice of PixiJS as a library with no game framework, and it
// is why there is no `@pixi/react` here: reconciling thousands of display objects twenty
// times a second through a virtual DOM, to produce mutations you could make directly, is
// work with no payoff.
//
// Three rules this component follows, each of which has a failure mode:
//   - ONE HOST PER MOUNT. No module-level singleton — a singleton survives the StrictMode
//     unmount and the second mount then drives a destroyed renderer.
//   - THE HOST IS NOT IN REACT STATE. It is not rendered from, so storing it would only
//     add a re-render and a stale closure.
//   - NO SIM STATE IN REACT CONTEXT, ever (§13). The HUD reads through the projection
//     seam ([[013]]), not through the component tree.

import { useEffect, useRef } from 'react';

import { GameHost } from './GameHost';

export interface GameCanvasProps {
  seed?: number;
}

export default function GameCanvas({ seed }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const host = new GameHost(container, seed === undefined ? {} : { seed });
    host.start();

    return () => {
      // `dispose()` is async and safe to fire and forget: it sets `destroyed` FIRST, so
      // everything still in flight inside `start()` bails at its next await. React does
      // not wait for cleanup, and it does not need to.
      void host.dispose();
    };
  }, [seed]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', cursor: 'crosshair' }}
    />
  );
}
