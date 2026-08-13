'use client';

// The one place the save layer gets to talk to the player.
//
// WHY THIS EXISTS AT ALL: work item 041's constraint is that a save must never fail silently,
// and until now every failure the storage layer could produce went to `console.error` — which
// is to say, to nobody. `GameCanvas` already renders the one refusal that stops the game dead
// (a save from a newer build); this is its counterpart for everything that does NOT stop the
// game: the backup was loaded, the disk is full, the browser has not promised to keep the
// world. Those all happen while the player is mid-build, so they get a card rather than a
// takeover.
//
// STYLES ARE INLINE, on purpose and against the local grain. Every other panel here draws from
// `hud.module.css` through the typed `s` map, and that is right for the panels that are always
// on screen. This one is different in two ways: it renders approximately never, and it must
// keep working when the thing that is wrong is the storage layer itself. Adding eight class
// names to a stylesheet and a union type that four other in-flight panels are also editing
// buys nothing here and costs a merge. The colours below are still the palette ones from
// `master.json` that the stylesheet's header pins — ink, umber, stone, bone, paper, and the
// red ramp for the tone that means something is actually wrong.
//
// IT IS NOT INSIDE `.root`. That container is `pointer-events: none` and these cards need a
// dismiss button that works, so this sits alongside it with its own stacking context.

import { useCallback, useSyncExternalStore } from 'react';

import {
  type SaveNotice,
  dismissNotice,
  noticeSnapshot,
  serverNoticeSnapshot,
  subscribeNotices,
} from '@/storage';

export function SaveNotices() {
  const notices = useSyncExternalStore(subscribeNotices, noticeSnapshot, serverNoticeSnapshot);

  if (notices.length === 0) return null;

  return (
    <div style={WRAP}>
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}

function NoticeCard({ notice }: { notice: SaveNotice }) {
  const onDismiss = useCallback(() => {
    dismissNotice(notice.id);
  }, [notice.id]);

  const warn = notice.tone === 'warning';

  return (
    <div
      style={warn ? CARD_WARN : CARD}
      // A warning interrupts a screen reader; the calm ones wait their turn. The difference
      // matters: "your world has stopped saving" is worth cutting in on, "this browser has not
      // promised to keep your world" is not.
      role={warn ? 'alert' : 'status'}
      aria-live={warn ? 'assertive' : 'polite'}
    >
      <div style={warn ? TITLE_WARN : TITLE}>{notice.title}</div>
      <div style={BODY}>{notice.body}</div>
      <button type="button" onClick={onDismiss} style={BUTTON}>
        Got it
      </button>
    </div>
  );
}

export default SaveNotices;

const WRAP: React.CSSProperties = {
  position: 'absolute',
  top: '14px',
  left: '50%',
  transform: 'translateX(-50%)',
  // Top centre is the one corner the HUD leaves free: the ticker and the research toggle hold
  // the top left, the dev overlay the top right, and the whole bottom edge is the toolbelt
  // stack. Nothing here overlaps anything the player aims at.
  width: 'min(34rem, calc(100vw - 28px))',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  zIndex: 20,
  pointerEvents: 'none',
  fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace",
};

// The stylesheet's bevel, restated: two inset rings and a light top edge. Notched corners
// rather than rounded ones, for the reason `hud.module.css` gives at the top — a border-radius
// on a 16px-tile pixel game reads as a component library bolted onto a different game.
const NOTCH =
  'polygon(5px 0, calc(100% - 5px) 0, 100% 5px, 100% calc(100% - 5px), ' +
  'calc(100% - 5px) 100%, 5px 100%, 0 calc(100% - 5px), 0 5px)';

const CARD: React.CSSProperties = {
  pointerEvents: 'auto',
  background: 'linear-gradient(180deg, #2b2119 0%, #211a13 100%)',
  boxShadow: 'inset 0 0 0 2px #14100e, inset 0 0 0 3px #46392f, inset 0 4px 0 -3px #6d5c4d',
  clipPath: NOTCH,
  padding: '12px 14px',
  color: '#efe2c6',
  fontSize: '13px',
  lineHeight: 1.5,
};

const CARD_WARN: React.CSSProperties = {
  ...CARD,
  boxShadow: 'inset 0 0 0 2px #14100e, inset 0 0 0 3px #9e2f27, inset 0 4px 0 -3px #d94f36',
};

const TITLE: React.CSSProperties = {
  color: '#d9b475',
  fontSize: '13px',
  fontWeight: 700,
  letterSpacing: '0.02em',
  marginBottom: '6px',
};

const TITLE_WARN: React.CSSProperties = { ...TITLE, color: '#ef8f68' };

const BODY: React.CSSProperties = {
  color: '#cbb99b',
  fontSize: '12px',
  // The one place in this HUD that runs to three sentences, so it gets normal selectable text:
  // a player who wants to paste this into a bug report should be able to.
  userSelect: 'text',
};

const BUTTON: React.CSSProperties = {
  marginTop: '10px',
  padding: '4px 12px',
  background: '#46392f',
  color: '#efe2c6',
  border: 'none',
  clipPath: NOTCH,
  font: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
};
