'use client';

// The client boundary that keeps Pixi out of the server render.
//
// `ssr: false` is only legal inside a Client Component, so the route's `page.tsx` stays a
// Server Component (and keeps its metadata) and defers to this. Pixi must never execute
// during SSR: `Application` reaches for `window` and `devicePixelRatio` on construction.

import dynamic from 'next/dynamic';

import { HudRoot } from '@/hud';
import { ReportsLayer } from '@/reports';

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

export default function PlayClient() {
  // Siblings, not parent and child. The HUD is DOM chrome sitting over the canvas — it is
  // not inside the Pixi scene, and it must not be inside the `ssr: false` boundary either:
  // it renders a frozen zero snapshot on the server (see `getServerSnapshot`) and hydrates
  // without a mismatch, which is the cheap proof that the store's server path works.
  // Three siblings, not a tree. The reports are their own layer over the HUD rather than a
  // panel inside it: the HUD's corners are glanceable chrome and a ledger is a thing you
  // open on purpose ([[033]]). Like the HUD it renders on the server from a frozen zero
  // snapshot and hydrates without a mismatch, which is the cheap proof its store's server
  // path works too.
  return (
    <>
      <GameCanvas />
      <HudRoot />
      <ReportsLayer />
    </>
  );
}
