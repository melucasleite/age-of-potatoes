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

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// Leaf modules, not the `@/hud` barrel — no React tree ([[069]]). The HUD draws its sidebar
// at this width; the canvas starts where the sidebar stops, so the two can never overlap and
// the renderer's container is `calc(100vw - sidebar)` by geometry rather than by
// coordination. `exit.ts` is the same kind of leaf: the EXIT GAME button's one-shot signal.
// Since [[096]] `layout.ts` also owns WHETHER the sidebar is showing, as a module-scope store
// with a subscription — so this side reads the fold without importing any of the HUD's React.
import { onExitRequest } from '@/hud/exit';
import {
  sidebarCollapsed,
  sidebarServerSnapshot,
  sidebarWidth,
  subscribeSidebar,
} from '@/hud/layout';
import { type AutosaveHandle, bootWorld, performExit, startAutosave } from '@/storage';

import { GameHost } from './GameHost';
// The renderer's avatar seam ([[079]]): the boot path publishes which farmer this world
// dresses, and 0 — the legacy farmer — when no world is up. Pure module, no Pixi.
import { publishAvatar } from './render/avatar';

export interface GameCanvasProps {
  seed?: number;
  /**
   * Called when an EXIT GAME request has finished its save-and-verify and the world may be
   * unmounted ([[078]]). The parent switches back to the front door, which unmounts this
   * component and runs the ordinary cleanup below — teardown is REACHED through React
   * rather than duplicated beside it. Absent on routes with nowhere to go back to.
   */
  onExited?: () => void;
}

export default function GameCanvas({ seed, onExited }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The fold ([[096]]). A boolean, so a toggle re-renders this component and NOTHING re-runs
  // the boot effect below — its deps are `[seed, onExited]` and stay that way, because a
  // player collapsing a panel must not tear down and re-boot their world. All this render
  // changes is one number in the `inset` string; the renderer finds out the way it has always
  // found out about a resize, from the ResizeObserver on this element.
  const collapsed = useSyncExternalStore(subscribeSidebar, sidebarCollapsed, sidebarServerSnapshot);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Cancelled by the StrictMode unmount before boot resolves. Everything after an
    // await re-checks it, for the same reason `GameHost` re-checks `destroyed`.
    let cancelled = false;
    let host: GameHost | null = null;
    let autosave: AutosaveHandle | null = null;
    let offExit: (() => void) | null = null;
    /** One exit at a time — a double-click must not race two flushes at one teardown. */
    let exiting = false;

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

      // Which farmer walks this world — envelope metadata, never world state ([[079]]).
      // Absent (every save that predates the picker) is the legacy farmer, id 0.
      publishAvatar(boot.world?.avatar ?? 0);

      host = new GameHost(container, { initialState: boot.state });
      host.start();

      const handle = startAutosave(() => host!.getState(), { sinceTick: boot.state.tick });
      autosave = handle;

      // EXIT GAME ([[078]]). The order is the whole feature: flush through the
      // write-then-verify machinery, CHECK the save landed, and only then let the parent
      // unmount us — at which point the cleanup below runs the teardown that already knows
      // how to die cleanly (StrictMode built it). A failed save cancels the exit and the
      // storage layer's notice card says why.
      offExit = onExitRequest(() => {
        if (exiting || cancelled) return;
        exiting = true;
        void performExit(
          {
            tickNow: () => host!.getState().tick,
            flush: () => handle.flush('manual'),
            lastSavedTick: () => handle.lastSavedTick,
          },
          () => {
            if (!cancelled) onExited?.();
          },
        ).then((left) => {
          if (!left) exiting = false;
        });
      });
    })();

    return () => {
      cancelled = true;
      offExit?.();
      // Flush before stopping so the last few seconds of play survive a navigation. On the
      // exit path this is the second, best-effort write — the guaranteed one already
      // resolved before `onExited` was allowed to fire.
      void autosave?.flush();
      autosave?.stop();
      // No world on stage: the next scene build dresses the legacy farmer unless a boot
      // publishes otherwise. Harmless under StrictMode — the remount re-publishes.
      publishAvatar(0);
      // `dispose()` is async and safe to fire and forget: it sets `destroyed` FIRST, so
      // everything still in flight inside `start()` bails at its next await. React does
      // not wait for cleanup, and it does not need to.
      void host?.dispose();
    };
  }, [seed, onExited]);

  const inset = `0 0 0 ${sidebarWidth(collapsed)}px`;

  if (refusal !== null) {
    return (
      <div style={{ ...REFUSAL_STYLE, inset }}>
        <strong style={{ display: 'block', marginBottom: '0.75rem' }}>
          Your saved lot was left untouched.
        </strong>
        {refusal}
      </div>
    );
  }

  // The sidebar's column is left out of the container entirely, so the Pixi renderer sizes
  // itself to the visible region and NOTHING else: `GameHost.resize()` reads this element's
  // rect through its ResizeObserver, and because the offset is a constant BETWEEN toggles the
  // observer fires once per real layout change, never per frame. Picking survives untouched —
  // it subtracts the canvas's own `getBoundingClientRect()` before inverting the camera
  // (`picking.ts`), so a canvas that starts somewhere new needs no picking change at all.
  //
  // HOW THE RENDERER LEARNS ABOUT THE FOLD, in full, because the answer is "it already did"
  // ([[096]]): the store publishes → React re-renders this div with a new `inset` → the
  // browser lays out once → the ResizeObserver fires once → `GameHost.resize()` reads the
  // SETTLED rect and calls `renderer.resize` and `camera.setViewport`. There is no new
  // plumbing and no imperative "the sidebar moved" call, and there must not be: a second path
  // into `resize()` would be a second source of truth for the stage's size, and the one the
  // camera's snap arithmetic trusts is the rect the browser actually laid out.
  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset,
        overflow: 'hidden',
        cursor: 'crosshair',
      }}
    />
  );
}

/** `inset` is spread in at render time — it is the one property that moves with the fold. */
const REFUSAL_STYLE: React.CSSProperties = {
  position: 'absolute',
  display: 'grid',
  placeItems: 'center',
  padding: '2rem',
  textAlign: 'center',
  color: '#c8b9a4',
  font: '14px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace',
};
