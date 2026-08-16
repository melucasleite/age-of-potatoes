'use client';

// The HUD tree: a docked sidebar on the left, and thin chrome over the canvas ([[069]]).
//
// THE LAYOUT RULE, AND ITS ONE SANCTIONED EXCEPTION. The sidebar is a fixed-width opaque
// column — money and the Ticker at the top, the four opener rows under them, the
// at-the-machine cards below those, and the papers (field card) at the bottom. The canvas
// owns everything to its right (`GameCanvas` offsets itself by the same `SIDEBAR_WIDTH_PX`),
// and item 069's rule was that nothing ever covers it. Item 089 amended that rule knowingly,
// by owner ruling, for the bag and the build menu; ITEM 093 FINISHES THE JOB for all four —
// "The stand and research should also be buttons that open a menu, just like the build and
// the bag. Consolidate those. They should have the same feeling to them." So RESEARCH, THE
// STAND, THE BAG and BUILD are now one family: four identical `PanelRow`s over four
// identical `PanelWindow`s (`PanelFrame.tsx`), each centred over the canvas region, exactly
// one open at a time by the `panel-state.ts` invariant. Everything else over the canvas
// stays thin: the hotbar stack, transient hints, and the dev overlay.
//
// THE CONTEXTUAL SLOT DID NOT RETIRE — IT STOPPED BEING A SLOT ([[093]]). It used to be a
// space three unrelated things queued for, and the queue is gone now that no menu wants it.
// What is left is exactly what belongs in a sidebar: the at-the-machine cards (`UpgradeBench`,
// `DockCard`), which are contextual to WHAT THE PLAYER IS STANDING AT rather than menus the
// player opens. They have no row, no hotkey, and nothing to toggle — floating them would have
// meant inventing an opener for a card whose entire job is appearing unasked. And because
// they no longer share the space with anything, they render UNCONDITIONALLY: standing at a
// Fryer with the tech tree open used to hide the bench, which was never a decision anybody
// made, just what a slot with one occupant does.
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

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { onPanelRequest } from '@/game/input/panels';

import { BuildMenuPanel } from './BuildMenu';
import { toggleBuildPanel } from './build-row';
import { DebugPanel } from './DebugPanel';
import { DockCard } from './DockCard';
import { requestExit } from './exit';
import { FieldCard } from './FieldCard';
import { BagToggle, InventoryWindow } from './Inventory';
import { SIDEBAR_WIDTH_PX } from './layout';
import { PanelRow } from './PanelFrame';
import {
  closeLocalPanel,
  openPanel,
  panelServerSnapshot,
  panelSnapshot,
  subscribePanels,
  togglePanel,
} from './panel-state';
import type { PanelName } from './panel-state';
import { cx, s } from './styles';
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
          EXIT GAME first, top-left, modest ([[078]]). It ASKS (`requestExit`) — the ordered
          save-then-teardown runs where the world and its autosave live (`GameCanvas`), and
          there is no "are you sure": the save IS the confirmation, because nothing is lost.
        */}
          <button type="button" className={s.exitButton} onClick={requestExit}>
            exit game
          </button>

          {/*
          THE FOUR ROWS ([[093]]) — Research, the Stand, the Bag, Build, hanging off the
          number that says how much money there is ([[051]]). They are one component now
          (`PanelRow`), so a fifth is four props and no markup, and the ordering rules that
          got them here still hold: THE BAG became a row when item 069's always-open dock
          section retired ([[089]]), and BUILD stays at the bottom ([[076]], owner: "add at
          the bottom for the build menu"). Every row is wired to the same door its hotkey
          uses — build through the item-071 input seam, the other three through
          `panel-state.ts`. One invariant, many doors.
        */}
          <div className={s.sideSection}>
            <Ticker />
            <TechToggle open={panels.open === 'research'} onOpen={panels.toggleResearch} />
            <ShopToggle open={panels.open === 'shop'} onOpen={panels.toggleShop} />
            <BagToggle open={panels.open === 'bag'} onToggle={panels.toggleBag} />
            <BuildToggle open={panels.open === 'build'} />
          </div>

          {/*
          THE AT-THE-MACHINE CARDS, and nothing else queues for this space any more
          ([[093]]). Each decides for itself whether the player is standing somewhere it has
          something to say about, and they can never both speak: the bench takes machines
          with a work cycle, the dock card takes Agri-Bot docks, disjoint by construction
          (`derive-dock.ts`). On the vast majority of frames both return null and this is an
          empty flex box that costs nothing.
        */}
          <div className={s.sideContext}>
            <UpgradeBench onOpenResearch={panels.toggleResearch} />
            <DockCard />
          </div>

          {/*
          The field card, alone at the bottom now. THE CLIPBOARD IS GONE BY RULING ([[076]],
          owner: "Get rid of the clipboard as well. It's taking space and it's not adding
          much value") — the observation surface item 040 built. Its derive logic survives
          (`deriveClipboard`, the promotion whisper, the slice) because the Welcome Back
          card still reads the same notes; only the always-on paper unmounted. Noted in item
          040's log, which the ruling supersedes.
        */}
          <div className={cx(s.sideSection, s.sidePapers)}>
            <FieldCard />
          </div>
        </div>

        {/*
        THE STAGE — everything that is allowed over the canvas, exhaustively: the hotbar
        stack, the rare welcome-back card, the dev overlay, and the two floating windows
        ([[089]]), of which at most one exists at a time.
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

          {/*
          The debug panel ([[075]]): perf rows + the cheat console, in every build — the
          owner wants his cheat in production, so the old DEV gate is gone and the panel
          pays its rent by rendering null until the backtick asks for it.
        */}
          <div className={cx(s.corner, s.topRight)}>
            <DebugPanel />
          </div>

          {/*
          THE FLOATING WINDOW — singular, and that is the point ([[093]]). All four panels
          come through here now, centred over the canvas region and never over the sidebar,
          which is why this lives inside the stage rather than the root. ONE `.floatWin`
          wrapper rather than one per panel: the geometry is a property of the window, not of
          whichever panel is currently inside it, and four copies of it is exactly how the
          two species drifted apart in the first place. At most one panel exists by the
          `panel-state.ts` invariant, and the wrapper is rendered only while one is open — an
          empty `pointer-events: auto` box parked over the middle of the lot would swallow
          clicks meant for tiles.
        */}
          {panels.open === null ? null : (
            <div className={s.floatWin}>
              {panels.open === 'research' ? (
                <TechPanel onClose={panels.close} />
              ) : panels.open === 'shop' ? (
                <ShopPanel onClose={panels.close} />
              ) : panels.open === 'bag' ? (
                <InventoryWindow onClose={panels.close} />
              ) : (
                <BuildMenuPanel />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The BUILD row ([[076]]) — the fourth of four, and the one that proves the shape: it lives
 * in a different file from its panel, its truth lives in a different LAYER (the input seam,
 * [[071]]), and it is still just a `PanelRow` with four props ([[093]]). It is the only row
 * with no second reason to light up: research has "affordable", the stand has "at the
 * counter", the bag has "boxed machine inside", and build has nothing waiting in it — a
 * catalogue is never ready, it is just there.
 */
function BuildToggle({ open }: { open: boolean }) {
  return (
    <PanelRow
      name="Build"
      badge="place · buy"
      hotkey="B"
      title="The build menu — everything placeable, priced"
      open={open}
      // WRAPPED, NOT PASSED. `toggleBuildPanel(dispatchKey = dispatchKeydown)` takes an
      // optional first argument as a test seam, so handing it straight to `onClick` makes
      // React call it with the MouseEvent — `dispatchKey('KeyB')` then throws "dispatchKey is
      // not a function" inside a click handler, which unmounts the tree and dumps the player
      // back at the front door. Cost an afternoon once ([[093]]); the arrow is load-bearing.
      onToggle={() => {
        toggleBuildPanel();
      }}
    />
  );
}

/**
 * Which panel is open — anywhere: the slot (research, shop), the floats (bag, build). UI
 * STATE, and it stays that way: camera pan, hover, tool mode, and menu state are explicitly
 * not commands and never enter the world (§12) — a replay must not depend on which panels
 * were open.
 *
 * THE MACHINE ITSELF LIVES IN `panel-state.ts` NOW ([[089]]) — one name, never a flag per
 * panel, with the build menu's truth still owned by the input layer and folded in at read
 * time. It moved out of this hook so the exclusion rules (I then B, B then I, float versus
 * slot) could be pinned by tests that run without a DOM; this hook is the subscription plus
 * the keys.
 *
 * The keys are bound here rather than in `input/keyboard.ts` because they toggle DOM
 * panels that the input system has no business knowing exist. They are chosen from what
 * that layer leaves free: digits 1–9 and 0 (the hotbar, [[061]]), B, R, C, +, −, Escape,
 * F3, backtick, space and WASD are all spoken for, and an unhandled code falls through its
 * switch untouched. T for the tree, G for goods, I for the bag — the one letter a player
 * will try without being told. I TOGGLES THE FLOATING BAG now, per the 089 ruling — the
 * same key that collapsed the old dock section, aimed at the window that replaced it. Esc
 * is NOT bound here: each panel closes itself on Esc (their own listeners, the bag's
 * included), and the input layer's Esc — put the tool down — keeps working exactly because
 * nobody swallows it. Esc for the build menu is the input layer's own cascade, as ever.
 */
function usePanels(): {
  open: PanelName | null;
  toggleResearch: () => void;
  toggleShop: () => void;
  toggleBag: () => void;
  close: () => void;
} {
  // A primitive snapshot (a name or null), so every build-seam publish that is not an
  // open/close — cursor moves, price refreshes — bails on `Object.is`.
  const open = useSyncExternalStore(subscribePanels, panelSnapshot, panelServerSnapshot);

  const toggleResearch = useCallback(() => {
    togglePanel('research');
  }, []);
  const toggleShop = useCallback(() => {
    togglePanel('shop');
  }, []);
  const toggleBag = useCallback(() => {
    togglePanel('bag');
  }, []);
  const close = useCallback(() => {
    closeLocalPanel();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat is not a state edge — holding the key must not strobe the panel.
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'KeyT') togglePanel('research');
      else if (event.code === 'KeyG') togglePanel('shop');
      else if (event.code === 'KeyI') togglePanel('bag');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // The input layer's one line to the HUD ([[054]], `input/panels.ts`): a Hand click on the
  // sell bin with nothing to sell asks for the stand rather than doing nothing at all. It
  // ASKS — this side still decides, which is why it goes through the same module as the
  // keys. Open, never toggle: a click on the bin means "open it", and toggling would shut
  // the board in the face of a player who clicked the bin twice. A request for the bag
  // opens the floating window, which is what "open the inventory" means since [[089]].
  useEffect(
    () =>
      onPanelRequest((panel) => {
        openPanel(panel === 'inventory' ? 'bag' : panel);
      }),
    [],
  );

  return { open, toggleResearch, toggleShop, toggleBag, close };
}
