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

import { useEffect, useRef, useState } from 'react';

import { bootWorld, startAutosave } from '@/storage';

import { GameHost } from './GameHost';

export interface GameCanvasProps {
  seed?: number;
}

export default function GameCanvas({ seed }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Cancelled by the StrictMode unmount before boot resolves. Everything after an
    // await re-checks it, for the same reason `GameHost` re-checks `destroyed`.
    let cancelled = false;
    let host: GameHost | null = null;
    let autosave: { flush: () => void; stop: () => void } | null = null;

    void (async () => {
      const boot = await bootWorld(seed === undefined ? {} : { seed });
      if (cancelled) return;

      // A readable save exists that this build must not touch — from a newer deploy, or
      // unparseable. Starting a fresh world here would hand the next autosave a licence
      // to overwrite it, so we show the reason and refuse to play instead.
      if (boot.state === null) {
        setRefusal(
          boot.outcome.status === 'refused'
            ? boot.outcome.message
            : 'This save was made by a newer version.',
        );
        return;
      }

      host = new GameHost(container, { initialState: boot.state });
      host.start();

      autosave = startAutosave(() => host!.getState(), { sinceTick: boot.state.tick });
    })();

    return () => {
      cancelled = true;
      // Flush before stopping so the last few seconds of play survive a navigation.
      autosave?.flush();
      autosave?.stop();
      // `dispose()` is async and safe to fire and forget: it sets `destroyed` FIRST, so
      // everything still in flight inside `start()` bails at its next await. React does
      // not wait for cleanup, and it does not need to.
      void host?.dispose();
    };
  }, [seed]);

  if (refusal !== null) {
    return (
      <div style={REFUSAL_STYLE}>
        <strong style={{ display: 'block', marginBottom: '0.75rem' }}>
          Your saved lot was left untouched.
        </strong>
        {refusal}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', cursor: 'crosshair' }}
    />
  );
}

const REFUSAL_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  padding: '2rem',
  textAlign: 'center',
  color: '#c8b9a4',
  font: '14px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace',
};
