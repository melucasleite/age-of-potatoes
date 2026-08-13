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

import { onPanelRequest } from '@/game/input/panels';

import { Clipboard } from './Clipboard';
import { FieldCard } from './FieldCard';
import { InventoryPanel, InventoryToggle } from './Inventory';
import { s } from './styles';
import { PerfOverlay } from './PerfOverlay';
import { Pouch } from './Pouch';
import { SaveNotices } from './SaveNotices';
import { ShopPanel, ShopToggle } from './Shop';
import { StatusRibbon } from './StatusRibbon';
import { TechPanel, TechToggle } from './TechTree';
import { Ticker } from './Ticker';
import { Toolbelt } from './Toolbelt';
import { UpgradeBench } from './UpgradeBench';
import { WelcomeBack } from './WelcomeBack';
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
  const panels = usePanels();

  // Still the tell for "no world" — but the save notices outlive it. A world that came back
  // from its backup copy, or one whose browser is out of room, has something to say before the
  // first tick publishes and would say it to an empty screen otherwise ([[041]]).
  if (tools.slots.length === 0) return <SaveNotices />;

  return (
    <>
      <SaveNotices />
      <div className={s.root}>
        {/*
        Ticker, Research, the Stand, the Bag — one column, in that order. The first two buttons
        are the only places money leaves the player's hands without them walking somewhere, so
        they read as a pair hanging off the counter that says how much money there is ([[051]]).
        The Bag joins them because it is where money comes BACK — scrapping a boxed machine is
        the other side of the same counter ([[054]]) — and because it is the panel a player
        opens while wondering what they are carrying, which is a question about the same column.
      */}
        <div className={`${s.corner} ${s.topLeft}`}>
          <Ticker />
          <TechToggle onOpen={panels.openResearch} />
          <ShopToggle onOpen={panels.openShop} />
          <InventoryToggle onOpen={panels.openInventory} />
        </div>

        {/*
        The upgrade bench, anchored to the last free edge. It has no open/closed flag of its
        own: it draws when the player is standing at a machine that takes dials and vanishes
        when they walk away, because "bought at the machine" (plan §3) is a fact about where
        the avatar is rather than a menu the player manages.
      */}
        <div className={`${s.corner} ${s.midRight}`}>
          <UpgradeBench onOpenResearch={panels.openResearch} />
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

        {/*
        Field card above the clipboard, deliberately. Both are read at a glance from the same
        corner, but the clipboard is paper you catch up on and the field card is the only
        thing in the HUD with a clock running on it ([[021]]) — so it sits where the eye
        arrives first rather than underneath three lines of observation.
      */}
        <div className={`${s.corner} ${s.bottomRight}`}>
          <FieldCard />
          <Clipboard />
        </div>

        {/*
        The Welcome Back card ([[040]]). Rendered unconditionally — it decides for itself
        whether it has anything to say, and on all but a handful of boots the answer is no
        and it returns null. Top centre because it is the rarest thing in the HUD.
      */}
        <div className={`${s.corner} ${s.topCentre}`}>
          <WelcomeBack />
        </div>

        {DEV ? (
          <div className={`${s.corner} ${s.topRight}`}>
            <PerfOverlay />
          </div>
        ) : null}

        {panels.open === 'research' ? <TechPanel onClose={panels.close} /> : null}
        {panels.open === 'shop' ? <ShopPanel onClose={panels.close} /> : null}
        {panels.open === 'inventory' ? <InventoryPanel onClose={panels.close} /> : null}
      </div>
    </>
  );
}

type PanelName = 'research' | 'shop' | 'inventory';

/**
 * Which full-screen panel is showing, if any. UI STATE, and it stays that way.
 *
 * Camera pan, hover, tool mode, and menu state are explicitly not commands and never enter the
 * world (§12) — a replay must not depend on which panels were open. So this is a `useState` in
 * the HUD and nothing else knows about it.
 *
 * ONE AT A TIME, held as a name rather than as a flag per panel. Both panels draw a scrim over
 * the whole game; two booleans would let the pair be true at once and stack one modal on top of
 * another, which is a state nothing in the UI is designed to look right in. A single slot makes
 * that unrepresentable instead of merely unlikely.
 *
 * The keys are bound here rather than in `input/keyboard.ts` because they toggle DOM panels
 * that the input system has no business knowing exist. They are chosen from what that layer
 * leaves free: digits 1–6, B, R, C, +, −, Escape, F3, backtick, space and WASD are all spoken
 * for, and an unhandled code falls through its switch untouched. T for the tree, G for goods,
 * I for the bag — the one letter a player will try without being told.
 */
function usePanels(): {
  open: PanelName | null;
  openResearch: () => void;
  openShop: () => void;
  openInventory: () => void;
  close: () => void;
} {
  const [open, setOpen] = useState<PanelName | null>(null);

  const openResearch = useCallback(() => setOpen('research'), []);
  const openShop = useCallback(() => setOpen('shop'), []);
  const openInventory = useCallback(() => setOpen('inventory'), []);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat is not a state edge — holding the key must not strobe the panel.
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const name: PanelName | null =
        event.code === 'KeyT'
          ? 'research'
          : event.code === 'KeyG'
            ? 'shop'
            : event.code === 'KeyI'
              ? 'inventory'
              : null;
      if (name === null) return;
      setOpen((was) => (was === name ? null : name));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // The input layer's one line to the HUD ([[054]], `input/panels.ts`): a Hand click on the sell
  // bin with nothing to sell asks for the stand rather than doing nothing at all. It ASKS — this
  // side still decides, which is why it goes through the same `setOpen` as the key and inherits
  // the one-at-a-time rule for free. Not a toggle: a click on the bin means "open it", and
  // toggling would shut the board in the face of a player who clicked the bin twice.
  useEffect(() => onPanelRequest((panel) => setOpen(panel)), []);

  return { open, openResearch, openShop, openInventory, close };
}
