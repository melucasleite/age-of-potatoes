'use client';

// The HUD tree: a docked sidebar on the left, and thin chrome over the canvas ([[069]]).
//
// THE LAYOUT RULE, WHICH IS THE FEATURE: no panel ever overlaps the canvas. The sidebar is
// a fixed-width opaque column — money and the Ticker at the top, the bag always open under
// them, ONE contextual slot that the shop, the research tree and the at-the-machine cards
// swap through, and the papers (field card, clipboard) at the bottom. The canvas owns
// everything to its right (`GameCanvas` offsets itself by the same `SIDEBAR_WIDTH_PX`), and
// the only things allowed over it are the hotbar stack, transient hints, and the dev
// overlay. Opening a panel changes what the sidebar shows, never what the player can see
// of their lot.
//
// NOTE WHAT IS NOT HERE: there is no provider, no context, no `useState` holding world
// data, and nothing passing sim numbers down as props from a common ancestor. Each panel
// subscribes to its own slice and re-renders alone. A Context value changing 8×/sec would
// re-render every consumer subtree, and `memo` on the children does not save you because
// Context propagation bypasses the memo check — which is why §13 states the rule as
// structural rather than as a performance preference.
//
// POINTER EVENTS, IN ONE SENTENCE EACH SIDE OF THE SPLIT: the sidebar takes them wholesale,
// because it is opaque and nothing playable is under it; the stage stays `none` and only
// its controls opt back in, because a HUD that swallows a click meant for a tile makes the
// game feel broken in a way the player cannot name.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { buildMenuClose, buildMenuSnapshot, subscribeBuildMenu } from '@/game/input/build-panel';
import { onPanelRequest } from '@/game/input/panels';

import { BuildMenuPanel } from './BuildMenu';
import { Clipboard } from './Clipboard';
import { DockCard } from './DockCard';
import { FieldCard } from './FieldCard';
import { InventorySection } from './Inventory';
import { SIDEBAR_WIDTH_PX } from './layout';
import { cx, s } from './styles';
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
        THE DOCK. Fixed width from `layout.ts` — inline so the number has exactly one home
        and `GameCanvas` computes its own edge from the same constant, never from this DOM.
      */}
        <div className={s.sidebar} style={{ width: SIDEBAR_WIDTH_PX }}>
          {/*
          Ticker, Research, the Stand — the counter. The two buttons are the only places
          money leaves the player's hands without them walking somewhere, so they hang off
          the number that says how much money there is ([[051]]). The Bag no longer needs a
          button in this column: it is permanently open one section down.
        */}
          <div className={s.sideSection}>
            <Ticker />
            <TechToggle onOpen={panels.toggleResearch} />
            <ShopToggle onOpen={panels.toggleShop} />
          </div>

          {/*
          The bag, always visible — a collapsible section header rather than a removable
          panel ([[069]]: "perhaps the inventory is always open there as well" — default
          yes). I collapses and expands it; nothing closes it.
        */}
          <InventorySection open={panels.bagOpen} onToggle={panels.toggleBag} />

          {/*
          THE ONE CONTEXTUAL SLOT. Shop and research swap through it on their toggles and
          keys; Esc empties it (each panel's own Esc listener → `panels.close`). When no
          panel claims it, the at-the-machine cards get it — each decides for itself
          whether the player is standing somewhere it has something to say about, and they
          can never both speak: the bench takes machines with a work cycle, the dock card
          takes Agri-Bot docks, disjoint by construction (`derive-dock.ts`).
        */}
          <div className={s.sideSlot}>
            {panels.open === 'build' ? (
              <BuildMenuPanel />
            ) : panels.open === 'research' ? (
              <TechPanel onClose={panels.close} />
            ) : panels.open === 'shop' ? (
              <ShopPanel onClose={panels.close} />
            ) : (
              <>
                <UpgradeBench onOpenResearch={panels.toggleResearch} />
                <DockCard />
              </>
            )}
          </div>

          {/*
          Field card above the clipboard, deliberately. Both are read at a glance from the
          same stretch of dock, but the clipboard is paper you catch up on and the field
          card is the only thing in the HUD with a clock running on it ([[021]]) — so it
          sits where the eye arrives first rather than underneath three lines of observation.
        */}
          <div className={cx(s.sideSection, s.sidePapers)}>
            <FieldCard />
            <Clipboard />
          </div>
        </div>

        {/*
        THE STAGE — everything that is allowed over the canvas, exhaustively: the hotbar
        stack, the rare welcome-back card, and the dev overlay.
      */}
        <div className={s.stage}>
          {/*
          Ribbon, pouch, toolbelt — one centred stack at the bottom edge, in that order.
          Centred rather than tucked left for two reasons: the toolbelt is the one thing
          here the player actually aims at, and the lower-left corner belongs to the audio
          layer's click-to-start gate ([[014]]), which must not end up underneath it.
        */}
          <div className={cx(s.corner, s.bottomCentre)}>
            <StatusRibbon />
            <Pouch />
            <Toolbelt />
          </div>

          {/*
          The Welcome Back card ([[040]]). Rendered unconditionally — it decides for itself
          whether it has anything to say, and on all but a handful of boots the answer is no
          and it returns null. Top centre because it is the rarest thing in the HUD.
        */}
          <div className={cx(s.corner, s.topCentre)}>
            <WelcomeBack />
          </div>

          {DEV ? (
            <div className={cx(s.corner, s.topRight)}>
              <PerfOverlay />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

type PanelName = 'research' | 'shop' | 'build';

/**
 * Which panel holds the contextual slot, if any — plus whether the persistent bag section
 * is expanded. UI STATE, and it stays that way.
 *
 * Camera pan, hover, tool mode, and menu state are explicitly not commands and never enter the
 * world (§12) — a replay must not depend on which panels were open. So this is a `useState` in
 * the HUD and nothing else knows about it.
 *
 * ONE AT A TIME, held as a name rather than as a flag per panel. The contextual slot is a
 * single region of the sidebar; two booleans would let both panels be true at once and fight
 * over it. A single slot makes that unrepresentable instead of merely unlikely. The bag is a
 * separate boolean precisely because it is NOT in the slot — it is a persistent section that
 * collapses, and expanding it must not evict a panel the player is reading.
 *
 * The keys are bound here rather than in `input/keyboard.ts` because they toggle DOM sections
 * that the input system has no business knowing exist. They are chosen from what that layer
 * leaves free: digits 1–9 and 0 (the hotbar, [[061]]), B, R, C, +, −, Escape, F3, backtick,
 * space and WASD are all spoken for, and an unhandled code falls through its switch untouched.
 * T for the tree, G for goods, I for the bag — the one letter a player will try without being
 * told. Esc is NOT bound here: each panel closes itself on Esc (their own listeners), and the
 * input layer's Esc — put the tool down — keeps working exactly because nobody swallows it.
 *
 * THE BUILD MENU IS THE THIRD OCCUPANT AND THE ODD ONE OUT ([[071]]): its source of truth is
 * the INPUT layer (`build-panel.ts`), because B, the arrows and the walk-stop are modal there
 * and the two sides must agree about `menuOpen`. This hook subscribes to that truth and folds
 * it into `open` — build simply wins while it is up — and keeps the one-occupant invariant by
 * closing the loser on every door: opening build evicts the local panel (the effect below),
 * and every local opener calls `buildMenuClose()` first. Esc for the menu is not bound here
 * either: the input layer's Esc cascade already closes it before anything else fires.
 */
function usePanels(): {
  open: PanelName | null;
  bagOpen: boolean;
  toggleResearch: () => void;
  toggleShop: () => void;
  toggleBag: () => void;
  close: () => void;
} {
  const [localOpen, setLocalOpen] = useState<PanelName | null>(null);
  // Open by default and expected to stay that way — collapsing is the player's exception.
  const [bagOpen, setBagOpen] = useState(true);
  // A primitive snapshot, so every publish that is not an open/close bails on `Object.is`.
  const buildOpen = useSyncExternalStore(
    subscribeBuildMenu,
    () => buildMenuSnapshot().open,
    () => false,
  );

  const toggleResearch = useCallback(() => {
    buildMenuClose();
    setLocalOpen((was) => (was === 'research' ? null : 'research'));
  }, []);
  const toggleShop = useCallback(() => {
    buildMenuClose();
    setLocalOpen((was) => (was === 'shop' ? null : 'shop'));
  }, []);
  const toggleBag = useCallback(() => setBagOpen((was) => !was), []);
  const close = useCallback(() => setLocalOpen(null), []);

  // B pressed while the shop or the tree holds the slot: the menu opens in the input layer
  // and the local panel must yield. Effect rather than render-time logic so the eviction is
  // a real state change — reopening T later must not resurrect a panel evicted weeks ago.
  useEffect(() => {
    if (buildOpen) setLocalOpen(null);
  }, [buildOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat is not a state edge — holding the key must not strobe the panel.
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'KeyT') {
        buildMenuClose();
        setLocalOpen((was) => (was === 'research' ? null : 'research'));
      } else if (event.code === 'KeyG') {
        buildMenuClose();
        setLocalOpen((was) => (was === 'shop' ? null : 'shop'));
      } else if (event.code === 'KeyI') setBagOpen((was) => !was);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // The input layer's one line to the HUD ([[054]], `input/panels.ts`): a Hand click on the sell
  // bin with nothing to sell asks for the stand rather than doing nothing at all. It ASKS — this
  // side still decides, which is why it goes through the same setters as the keys. Not a toggle:
  // a click on the bin means "open it", and toggling would shut the board in the face of a
  // player who clicked the bin twice. A request for the bag expands the persistent section,
  // which is all "open the inventory" can mean now that it has no closed state to open from.
  useEffect(
    () =>
      onPanelRequest((panel) => {
        if (panel === 'inventory') {
          setBagOpen(true);
          return;
        }
        buildMenuClose();
        setLocalOpen(panel);
      }),
    [],
  );

  return {
    open: buildOpen ? 'build' : localOpen,
    bagOpen,
    toggleResearch,
    toggleShop,
    toggleBag,
    close,
  };
}
