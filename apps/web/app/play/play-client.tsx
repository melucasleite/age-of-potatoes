'use client';

// The client boundary that keeps Pixi out of the server render, and the switch between the
// front door and the lot ([[055]], grown a road back by [[078]]).
//
// `ssr: false` is only legal inside a Client Component, so the route's `page.tsx` stays a
// Server Component (and keeps its metadata) and defers to this. Pixi must never execute
// during SSR: `Application` reaches for `window` and `devicePixelRatio` on construction.
//
// THE SWITCH IS A GATE, NOT A TOGGLE — and since item 078, it swings both ways without a
// document navigation. Opening a lot still makes the world active FIRST and only then mounts
// the game, because `bootWorld()` reads the registry's active id and there is exactly one
// right answer at that moment. Leaving runs the other order: EXIT GAME saves through the
// write-then-verify machinery, `GameCanvas` confirms the save landed, and ONLY THEN does
// this component swap the tree back to the door — which unmounts the canvas, the HUD and the
// reports layer, running the teardown paths StrictMode already proved out ([[006]]). The
// stores' ownership tokens make a half-replaced world unrepresentable: `GameHost.dispose`
// releases them, the next host claims them, and a stale host's writes are ignored.
//
// WHY THE URL IS KEPT IN STEP BY HAND (`history.replaceState`) RATHER THAN BY NAVIGATING.
// `FrontDoor`'s own header argues a real navigation "is the only version of this that cannot
// leak" — and it was, until the exit path needed the opposite guarantee: item 078's flow must
// not reload anywhere, because a reload between the save and the door is a page teardown
// racing an IndexedDB write. So the door stays mounted in the same tree, the world swap goes
// through a full unmount/remount (`key={worldId}` besides), and the URL is updated silently
// so a refresh or a shared link still lands where the player actually is. `replaceState`
// rather than `pushState`: Back should leave the game, not walk a history of every lot
// visited this session.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';

import { HudRoot } from '@/hud';
import FrontDoor from '@/hud/FrontDoor';
import { resetWelcomeMemo } from '@/hud/use-welcome';
import { ReportsLayer } from '@/reports';
import { activateWorld } from '@/storage';

const GameCanvas = dynamic(() => import('@/game/GameCanvas'), {
  ssr: false,
  loading: () => <div style={LOADING_STYLE}>waking up the lot…</div>,
});

const LOADING_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  color: '#8d8378',
  font: '14px ui-monospace, SFMono-Regular, Menlo, monospace',
};

export interface PlayClientProps {
  /** The lot to open, from `?world=`. Null means show the front door. */
  worldId: string | null;
  /**
   * Skip the door and boot without activating a world (`?artsheet` and friends). The boot
   * path resolves the active world itself, and the screens behind this flag do not read the
   * world at all — so asking "which world?" first would be a question with no consumer.
   */
  bypassDoor?: boolean;
}

/** `opening` while the registry is consulted, `open` once the lot is live, `door` otherwise. */
type Gate =
  | { mode: 'door' }
  | { mode: 'opening'; worldId: string }
  | { mode: 'open'; worldId: string | null };

/** Keep the address bar telling the truth without navigating. No-op on the server. */
function syncUrl(worldId: string | null): void {
  if (typeof window === 'undefined') return;
  const url = worldId === null ? '/play' : `/play?world=${encodeURIComponent(worldId)}`;
  window.history.replaceState(null, '', url);
}

export default function PlayClient({ worldId, bypassDoor = false }: PlayClientProps) {
  const [gate, setGate] = useState<Gate>(
    worldId === null
      ? bypassDoor
        ? { mode: 'open', worldId: null }
        : { mode: 'door' }
      : { mode: 'opening', worldId },
  );

  // The initial `?world=` prop still gates through activation, exactly as before: a link to
  // a lot that has been deleted, or that never existed on this machine, falls back to the
  // door — the honest answer. Booting whatever happened to be active would open somebody's
  // factory because they mistyped a URL.
  useEffect(() => {
    if (worldId === null) {
      setGate(bypassDoor ? { mode: 'open', worldId: null } : { mode: 'door' });
      return;
    }
    let cancelled = false;
    void activateWorld(worldId).then((world) => {
      if (cancelled) return;
      setGate(world === null ? { mode: 'door' } : { mode: 'open', worldId });
    });
    return () => {
      cancelled = true;
    };
  }, [worldId, bypassDoor]);

  // The door's way in, without a navigation ([[078]]). The world is ALREADY ACTIVE — the
  // door awaited `activateWorld` before calling this — so mounting the canvas is safe for
  // the same reason it always was: `bootWorld()` will read the id the door just wrote.
  const enterWorld = useCallback((id: string) => {
    // A fresh world must not inherit the last one's memoised last-played read, or its
    // Welcome Back dismissal — both are per-visit facts, and this is a new visit.
    resetWelcomeMemo();
    syncUrl(id);
    setGate({ mode: 'open', worldId: id });
  }, []);

  // The way back ([[078]]). Called by `GameCanvas` strictly AFTER the exit save has been
  // written and verified — swapping to the door is what unmounts the world, so the ordering
  // "save → verify → teardown" is enforced by who gets to call this, not by hoping.
  const exitToDoor = useCallback(() => {
    resetWelcomeMemo();
    syncUrl(null);
    setGate({ mode: 'door' });
  }, []);

  if (gate.mode === 'door') return <FrontDoor onEnter={enterWorld} />;
  if (gate.mode === 'opening') return <div style={LOADING_STYLE}>finding the lot…</div>;

  // Siblings, not parent and child. The HUD is DOM chrome sitting over the canvas — it is
  // not inside the Pixi scene, and it must not be inside the `ssr: false` boundary either:
  // it renders a frozen zero snapshot on the server (see `getServerSnapshot`) and hydrates
  // without a mismatch, which is the cheap proof that the store's server path works.
  // Three siblings, not a tree. The reports are their own layer over the HUD rather than a
  // panel inside it: the HUD's corners are glanceable chrome and a ledger is a thing you
  // open on purpose ([[033]]).
  //
  // Keyed on the world id so a change of lot — via the URL or via the in-page door — can
  // never reuse a `GameHost` built for a different world: the old canvas unmounts (running
  // the full teardown) and a new one mounts, claiming the stores through fresh tokens.
  return (
    <>
      <GameCanvas key={gate.worldId ?? 'none'} onExited={exitToDoor} />
      <HudRoot />
      <ReportsLayer />
    </>
  );
}
