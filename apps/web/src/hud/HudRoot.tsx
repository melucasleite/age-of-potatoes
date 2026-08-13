'use client';

// The HUD tree. DOM chrome over the canvas, not part of the Pixi scene.
//
// NOTE WHAT IS NOT HERE: there is no provider, no context, no `useState` holding world
// data, and nothing passing sim numbers down as props from a common ancestor. Each panel
// subscribes to its own slice and re-renders alone. A Context value changing 8×/sec would
// re-render every consumer subtree, and `memo` on the children does not save you because
// Context propagation bypasses the memo check — which is why §13 states the rule as
// structural rather than as a performance preference.
//
// The root is `pointer-events: none`; only the toolbelt buttons opt back in. A HUD that
// swallows a click meant for a tile is a HUD that makes the game feel broken in a way the
// player cannot name.

import { useCallback, useEffect, useState } from 'react';

import { Clipboard } from './Clipboard';
import { s } from './styles';
import { PerfOverlay } from './PerfOverlay';
import { Pouch } from './Pouch';
import { SaveNotices } from './SaveNotices';
import { StatusRibbon } from './StatusRibbon';
import { TechPanel, TechToggle } from './TechTree';
import { Ticker } from './Ticker';
import { Toolbelt } from './Toolbelt';
import { UpgradeBench } from './UpgradeBench';
import { useHudSlice } from './use-hud';

/**
 * Inlined by the bundler to a literal, so the branch below is dead code in a production
 * build and the overlay goes with it. Verified by grepping `.next` for a string that only
 * exists inside the overlay.
 */
const DEV = process.env.NODE_ENV !== 'production';

export default function HudRoot() {
  // Nothing has published yet — no world, or a save the client refused to overwrite. An
  // empty toolbelt is the tell, and it costs nothing to check because the slice is already
  // subscribed. Showing a confident "$0.00" over a boot failure would be a small lie.
  const tools = useHudSlice('tools');
  const research = useResearchPanel();

  // Still the tell for "no world" — but the save notices outlive it. A world that came back
  // from its backup copy, or one whose browser is out of room, has something to say before the
  // first tick publishes and would say it to an empty screen otherwise ([[041]]).
  if (tools.slots.length === 0) return <SaveNotices />;

  return (
    <>
      <SaveNotices />
      <div className={s.root}>
        <div className={`${s.corner} ${s.topLeft}`}>
          <Ticker />
          <TechToggle onOpen={research.open} />
        </div>

        {/*
        The upgrade bench, anchored to the last free edge. It has no open/closed flag of its
        own: it draws when the player is standing at a machine that takes dials and vanishes
        when they walk away, because "bought at the machine" (plan §3) is a fact about where
        the avatar is rather than a menu the player manages.
      */}
        <div className={`${s.corner} ${s.midRight}`}>
          <UpgradeBench onOpenResearch={research.open} />
        </div>

        {/*
        Ribbon, pouch, toolbelt — one centred stack at the bottom edge, in that order.
        The stack is centred rather than tucked left for two reasons: the toolbelt is the
        one thing here the player actually aims at, and the lower-left corner belongs to
        the audio layer's click-to-start gate ([[014]]), which must not end up underneath it.
      */}
        <div className={`${s.corner} ${s.bottomCentre}`}>
          <StatusRibbon />
          <Pouch />
          <Toolbelt />
        </div>

        <div className={`${s.corner} ${s.bottomRight}`}>
          <Clipboard />
        </div>

        {DEV ? (
          <div className={`${s.corner} ${s.topRight}`}>
            <PerfOverlay />
          </div>
        ) : null}

        {research.isOpen ? <TechPanel onClose={research.close} /> : null}
      </div>
    </>
  );
}

/**
 * Whether the research panel is showing. UI STATE, and it stays that way.
 *
 * Camera pan, hover, tool mode, and menu state are explicitly not commands and never enter the
 * world (§12) — a replay must not depend on which panels were open. So this is a `useState` in
 * the HUD and nothing else knows about it.
 *
 * `T` is bound here rather than in `input/keyboard.ts` because the key toggles a DOM panel that
 * the input system has no business knowing exists. It is chosen from what that layer leaves
 * free: digits 1–6, B, R, C, +, −, Escape, F3, backtick, space and WASD are all spoken for, and
 * an unhandled code falls through its switch untouched.
 */
function useResearchPanel(): { isOpen: boolean; open: () => void; close: () => void } {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat is not a state edge — holding T must not strobe the panel.
      if (event.repeat || event.code !== 'KeyT') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      setIsOpen((was) => !was);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return { isOpen, open, close };
}
