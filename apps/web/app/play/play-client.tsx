'use client';

// The client boundary that keeps Pixi out of the server render, and the switch between the
// front door and the lot ([[055]]).
//
// `ssr: false` is only legal inside a Client Component, so the route's `page.tsx` stays a
// Server Component (and keeps its metadata) and defers to this. Pixi must never execute
// during SSR: `Application` reaches for `window` and `devicePixelRatio` on construction.
//
// THE SWITCH IS A GATE, NOT A TOGGLE. With no `?world` the door renders and the game is never
// imported at all — no canvas, no `GameHost`, no HUD store, no reports store. With one, the
// world is made active FIRST and only then is the game mounted, because `bootWorld()` reads the
// registry's active id and there is exactly one right answer at the moment it does. Getting
// that order wrong would boot the world the player left rather than the one they clicked, and
// would then autosave the wrong lot over the right one — silently, and within a minute.

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import { HudRoot } from '@/hud';
import FrontDoor from '@/hud/FrontDoor';
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
}

/** `opening` while the registry is consulted, `open` once the lot is live, `missing` if it is not. */
type Gate = 'opening' | 'open' | 'missing';

export default function PlayClient({ worldId }: PlayClientProps) {
  const [gate, setGate] = useState<Gate>(worldId === null ? 'missing' : 'opening');

  useEffect(() => {
    if (worldId === null) {
      setGate('missing');
      return;
    }
    let cancelled = false;
    void activateWorld(worldId).then((world) => {
      if (cancelled) return;
      // A link to a lot that has been deleted, or that never existed on this machine. Falling
      // back to the door is the honest answer — the alternative, booting whatever happened to
      // be active, would open somebody's factory because they mistyped a URL.
      setGate(world === null ? 'missing' : 'open');
    });
    return () => {
      cancelled = true;
    };
  }, [worldId]);

  if (gate === 'missing') return <FrontDoor />;
  if (gate === 'opening') return <div style={LOADING_STYLE}>finding the lot…</div>;

  // Siblings, not parent and child. The HUD is DOM chrome sitting over the canvas — it is
  // not inside the Pixi scene, and it must not be inside the `ssr: false` boundary either:
  // it renders a frozen zero snapshot on the server (see `getServerSnapshot`) and hydrates
  // without a mismatch, which is the cheap proof that the store's server path works.
  // Three siblings, not a tree. The reports are their own layer over the HUD rather than a
  // panel inside it: the HUD's corners are glanceable chrome and a ledger is a thing you
  // open on purpose ([[033]]). Like the HUD it renders on the server from a frozen zero
  // snapshot and hydrates without a mismatch, which is the cheap proof its store's server
  // path works too.
  //
  // Keyed on the world id so that a change of lot — which today only arrives with a document
  // navigation — could never reuse a `GameHost` built for a different world.
  return (
    <>
      <GameCanvas key={worldId ?? 'none'} />
      <HudRoot />
      <ReportsLayer />
    </>
  );
}
