'use client';

// The HUD tree: a docked sidebar on the left, and thin chrome over the canvas ([[069]]).
//
// THE LAYOUT RULE, AND ITS ONE SANCTIONED EXCEPTION. The sidebar is a fixed-width opaque
// column — money and the Ticker at the top, the four opener rows under them, the
// at-the-machine cards below those, and the papers (field card) at the bottom. The canvas
// owns everything to its right (`GameCanvas` offsets itself by the same `sidebarWidth()`),
// and item 069's rule was that nothing ever covers it. IT FOLDS SINCE [[096]] — two fixed
// widths and a handle rail, never an animated one, for the renderer reasons `layout.ts`'s
// header sets out — and folding does not bend 069's rule: collapsed, the dock is 24px wide
// and the lot is still entirely uncovered. Item 089 amended that rule knowingly,
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
// ...AND "UNCONDITIONALLY" HAD A HOLE IN IT FOR EXACTLY ONE DAY ([[106]]). The 093 ruling and
// the 096 fold landed together and never met: the cards render whatever else is happening, and
// the container they render INTO is unmounted by `[`. Folded, a click on an arm did nothing at
// all — no card, no walk, no tell — which is the worst answer a click can get, because the
// player cannot tell whether the game heard them. `MachineCards` below is the repair, and the
// shape of it is the point: THE THREE CARDS ARE WRITTEN DOWN ONCE, in one component, which the
// root then hands to one of two parents. A fourth card is a line inside that component and
// inherits the fold for free — which is the test the item set, and the test 093's own prose
// failed, having named a container rather than a rule.
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
// The modal's open flag, for the two key effects at the bottom of this file. `PauseMenu`
// itself subscribes; these want a plain boolean inside a keydown handler ([[126]]).
import { pauseMenuOpen } from '@/game/input/pause-panel';

import { BuildMenuPanel } from './BuildMenu';
import { toggleBuildPanel } from './build-row';
import { DebugPanel } from './DebugPanel';
import { DockCard } from './DockCard';
import { requestExit } from './exit';
import { FieldCard } from './FieldCard';
import { GrabberCard } from './GrabberCard';
import { BagToggle, InventoryWindow } from './Inventory';
import {
  SIDEBAR_HANDLE_PX,
  SIDEBAR_TOGGLE_CODE,
  SIDEBAR_TOGGLE_LABEL,
  sidebarBodyWidth,
  sidebarCollapsed,
  sidebarServerSnapshot,
  sidebarWidth,
  subscribeSidebar,
  toggleSidebar,
} from './layout';
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
import { PauseMenu } from './PauseMenu';
import { cx, s } from './styles';
import { Pouch } from './Pouch';
import { SaveNotices } from './SaveNotices';
import { ServiceCard } from './ServiceCard';
import { ShopPanel, ShopToggle } from './Shop';
import { StatusRibbon } from './StatusRibbon';
import { TechPanel, TechToggle } from './TechTree';
import { Ticker } from './Ticker';
import { Toolbelt } from './Toolbelt';
import { UpgradeBench } from './UpgradeBench';
import { WelcomeBack } from './WelcomeBack';
import { ZonePanel } from './ZonePanel';
import { useHudSlice } from './use-hud';

export default function HudRoot() {
  // Nothing has published yet — no world, or a save the client refused to overwrite. An
  // empty toolbelt is the tell, and it costs nothing to check because the slice is already
  // subscribed. Showing a confident "$0.00" over a boot failure would be a small lie.
  const tools = useHudSlice('tools');
  // The zones row's badge only — the panel itself subscribes for its own reasons ([[102]]).
  const lot = useHudSlice('lot');
  const panels = usePanels();
  const collapsed = useSidebar();

  // Still the tell for "no world" — but the save notices outlive it. A world that came back
  // from its backup copy, or one whose browser is out of room, has something to say before the
  // first tick publishes and would say it to an empty screen otherwise ([[041]]).
  if (tools.slots.length === 0) return <SaveNotices />;

  // ONE ELEMENT, TWO POSSIBLE PARENTS, AND THEY ARE MUTUALLY EXCLUSIVE ([[106]]). Built here
  // rather than written out in both branches below, because the failure this item exists to fix
  // is a card list that got copied nowhere and therefore existed in exactly one place that can
  // stop existing. React will unmount and remount the subtree when the parent changes, which is
  // correct and cheap: the cards are pure reads of their stores, and the only state that goes
  // with them is `usePending`'s optimistic "fitting…", worth losing on a deliberate fold.
  const machineCards = <MachineCards floating={collapsed} onOpenResearch={panels.toggleResearch} />;

  return (
    <>
      <SaveNotices />
      {/*
        NO NATIVE CONTEXT MENU OVER THE HUD EITHER ([[129]]).

        `pointer.ts` has suppressed `contextmenu` on the CANVAS since right-click had a verb at
        all — and only on the canvas, which was survivable while that verb was maintenance and
        nobody reached for it. Right-click is teardown now, so it is a gesture players make
        constantly and aim at things near the edges; overshoot onto the dock by four pixels and
        the browser's own menu opens over the lot. Measured before it was fixed: a `contextmenu`
        event on the canvas came back `defaultPrevented`, one on the sidebar did not.

        NOT ON `document`, and NOT OVER TEXT FIELDS. The one text input in the HUD is item 075's
        cheat console, and a right-click there should still offer Paste — swallowing it would
        trade one papercut for another in the single place a player types rather than clicks.
      */}
      <div
        className={s.root}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement | null;
          const tag = target?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA') return;
          event.preventDefault();
        }}
      >
        {/*
        THE DOCK. Width from `layout.ts`'s `sidebarWidth()` — inline so the number has exactly
        one home and `GameCanvas` computes its own edge from the same function, never from
        this DOM. TWO WIDTHS SINCE [[096]], and the switch between them is a discrete layout
        change with no transition on it: the renderer's ResizeObserver sees one settled rect
        per toggle rather than one per animation frame, which is the whole of the trap that
        item guarded against.
      */}
        <div className={s.sidebar} style={{ width: sidebarWidth(collapsed) }}>
          {/*
          THE BODY, UNMOUNTED WHEN FOLDED rather than hidden ([[096]]). A `display: none`
          column still owns focusable children, so a player tabbing through a collapsed HUD
          would travel the whole dock without seeing it; and every panel in here subscribes to
          the projection, so unmounting is also the only version that stops the work.
        */}
          {collapsed ? null : (
            <div className={s.sidebarBody}>
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
                <ZonesToggle
                  open={panels.open === 'zones'}
                  zones={lot.zones.length}
                  onToggle={panels.toggleZones}
                />
                <BuildToggle open={panels.open === 'build'} />
              </div>

              {/* The at-the-machine cards, in the half of the dock that folds — see
          `MachineCards`, which owns both this home and the one they fold out to. */}
              {machineCards}

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
          )}

          <SidebarHandle collapsed={collapsed} />
        </div>

        {/*
        THE STAGE — everything that is allowed over the canvas, exhaustively: the hotbar
        stack, the rare welcome-back card, the dev overlay, the floating panel window
        ([[089]], [[093]]) of which at most one exists at a time — and, ONLY WHILE THE DOCK IS
        FOLDED, the at-the-machine cards ([[106]]), which are here for the length of a
        collapse and back in the sidebar the moment it opens.
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
          THE FOLDED CARDS ([[106]]). The same element the sidebar had a moment ago, tucked into
          the top-left of the stage under the reports rail — see `MachineCards` for the route and
          `.machineFloat` for why it is a `.corner` rather than a second kind of window, and for
          the ⚠️ on sharing that left edge with the reports dock.

          RENDERED ONLY WHILE FOLDED, and the exclusion is what keeps 093 intact: expanded, the
          cards are in the dock and behave to the pixel as they did before this item existed.
          It is also why there is no need to ask whether any card HAS a subject — the wrapper
          takes no pointer events itself, so an empty one is not on the screen in any sense the
          lot can feel, and a fourth card never has to be added to a list somewhere else.
        */}
          {collapsed ? machineCards : null}

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
              ) : panels.open === 'zones' ? (
                <ZonePanel onClose={panels.close} />
              ) : (
                <BuildMenuPanel />
              )}
            </div>
          )}
        </div>

        {/*
        THE PAUSE MENU ([[126]]) — the sixth panel, and the one that breaks this file's rules
        on purpose, which is why it is HERE rather than in the stage above.

        Item 069's rule is that nothing covers the lot, amended by 089/093 for the five
        floating panels, which live in `.stage` and therefore never cover the DOCK either.
        This one covers both, and is a child of `.root` to do it. The argument is that the
        two halves of the screen stop being different while the world is stopped: the dock
        exists to be read and acted on WHILE PLAYING, and a scrim over the stage alone would
        have left every panel row live under a dimmed lot — clicking one would have opened a
        panel into `.floatWin`, beneath the scrim, invisible, waiting for the player on
        resume. See `.pauseScrim` for the rest of that argument.

        IT IS NOT PART OF THE `panel-state.ts` SINGLE-OPEN INVARIANT, and does not need to
        be: its truth lives in the input layer beside the build menu's, and the Escape
        cascade can only open it with every one of the five already shut (`escape.ts`).

        It renders null unless the world is stopped, so the common case is one boolean read.
      */}
        <PauseMenu />
      </div>
    </>
  );
}

/**
 * THE AT-THE-MACHINE CARDS, AND THE ONE PLACE THEY ARE WRITTEN DOWN ([[106]]).
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  WHY THE CARDS FLOAT RATHER THAN UNFOLDING THE DOCK OR REFUSING. The item offered three
 *  routes and asked for one, argued, not a blend.
 *
 *  NOT AUTO-EXPAND. Clicking a machine could have unfolded the sidebar, which is discoverable
 *  and would have needed no new markup at all. It loses on two counts and the second is the
 *  fatal one. First, it overrides a choice the player made on purpose, and folds are made by
 *  players who want the lot: taking the column back every time they touch a machine teaches
 *  them not to touch machines. Second, IT DOES NOT ACTUALLY COVER THE CASE — the bench and the
 *  dock card open because of where the farmer is STANDING, not because of a click, so a player
 *  who walks up to a Fryer on WASD has performed no click to hang the expansion off, and the
 *  card would go on being missing exactly as it is today. A fix that works for one of three
 *  cards is not a fix, it is the same bug with a smaller footprint.
 *
 *  NOT AN HONEST REFUSAL. "Expand the panel to see this machine" is a tell the player can act
 *  on, and it is genuinely better than silence — but it is a message about the HUD's own
 *  plumbing, sent to somebody who asked about a Fryer, and the answer to "can I show you this
 *  card" is never "press this other thing first".
 *
 *  SO: THE FLOAT. The player keeps the fold, the card is the same object it was in the dock
 *  (`sidebarBodyWidth()` — same width, same wraps, nothing to re-read), and it costs one
 *  positioned box on the stage. It is the direction the HUD was already going, per 089 and
 *  093: panels float, chrome docks.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * THE THREE, AND WHY A FOURTH IS FREE. The first two decide for themselves whether the player
 * is STANDING somewhere they have something to say about, and they can never both speak: the
 * bench takes machines with a work cycle, the dock card takes Agri-Bot docks, disjoint by
 * construction (`derive-dock.ts`). On the vast majority of frames all three return null and
 * this is an empty flex box that costs nothing. A fourth card is a line in this list; it
 * inherits the fold, the width and the corner without knowing any of them exist, which is the
 * property the item asked for by name and the one 093 thought it had.
 *
 * THE GRABBER CARD ([[099]]) IS THE ODD ONE AND KNOWINGLY SO: it is a consequence of a CLICK
 * rather than of position, because the owner asked for a click and because `SetGrabberFilter`
 * is the one grabber command the sim does not reach-gate. So it can be up beside the bench —
 * standing at a Fryer, having clicked an arm across the lot — and that is two true statements
 * stacked rather than a collision: this is where you are, and this is what you last pointed
 * at. It is also the card the fold broke most loudly, since the click had nowhere to land.
 */
function MachineCards({
  floating,
  onOpenResearch,
}: {
  /** Is the dock folded away under us. The only thing that differs between the two homes. */
  floating: boolean;
  onOpenResearch: () => void;
}) {
  return (
    <div
      className={floating ? cx(s.corner, s.machineFloat) : s.sideContext}
      // Inline for the same reason the sidebar's own width is: `layout.ts` owns the number,
      // and a 416 typed into the stylesheet is the second constant item 069 warned about.
      style={floating ? { width: sidebarBodyWidth() } : undefined}
    >
      {/*
        MAINTENANCE FIRST, AND "FIRST" IS THE REQUIREMENT ([[129]]). The owner's ruling puts a
        priced maintenance action at the TOP of the machine's card, so the card that carries it
        is the top line of this list rather than a row tucked inside one of the three below.

        IT IS ALSO THE ONLY PLACE IT COULD HAVE GONE. The bench takes machines with a work cycle
        and the dock card takes Agri-Bot docks; the two machines that WEAR OUT with neither card
        between them are the Sprinkler and — with some irony — the Maintenance Station. A
        maintenance row hosted inside either sibling would have missed exactly the machines whose
        repair the player now has no other route to, right after the route they had was taken
        away from them.

        This is the fourth card, and it cost the one line the comment above promised.
      */}
      <ServiceCard />
      <UpgradeBench onOpenResearch={onOpenResearch} />
      <DockCard />
      <GrabberCard />
    </div>
  );
}

/**
 * THE HANDLE ([[096]]) — the sidebar's one always-mounted control, and the only thing left of
 * the dock when it is folded.
 *
 * It is a rail rather than a tab, and it is inside the sidebar rather than floating over the
 * canvas, which is the detail that keeps item 069's rule intact through a collapse: nothing
 * ever covers the lot. Collapsed, the rail IS the sidebar — the canvas starts 24px in — so
 * the handle is not an exception to the rule, it is the smallest the dock can be.
 *
 * The chevron points where the panel is going, so the same glyph reads as both states of one
 * switch, and the accessible name says what it does rather than what it looks like. The key
 * is in the tooltip because that is where a player looks for one; `layout.ts` owns which key
 * it is, so this never has to be kept in step by hand.
 */
function SidebarHandle({ collapsed }: { collapsed: boolean }) {
  return (
    <button
      type="button"
      className={s.sidebarHandle}
      style={{ width: SIDEBAR_HANDLE_PX }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Show the panel' : 'Hide the panel'}
      title={`${collapsed ? 'Show' : 'Hide'} the panel  ·  ${SIDEBAR_TOGGLE_LABEL}`}
      onClick={toggleSidebar}
    >
      <span className={s.sidebarChevron} aria-hidden="true">
        {collapsed ? '›' : '‹'}
      </span>
      {collapsed ? <span className={s.sidebarHandleWord}>menu</span> : null}
    </button>
  );
}

/**
 * The fold, subscribed ([[096]]). A primitive snapshot, so the only re-render is the one that
 * actually changed the width — and `layout.ts` holds the flag, not this tree, because
 * `GameCanvas` has to read the same boolean from the other side of the seam without
 * importing the HUD's React.
 *
 * THE KEY IS BOUND HERE, beside the panel keys, from the same free space and by the same
 * rules: no auto-repeat (holding `[` must not strobe the panel), and nothing while a
 * modifier is down. No guard for form controls is needed, unlike `ReportsLayer`'s — the one
 * text field in the HUD is the cheat console, and it stops keydown propagation before any
 * window listener sees it. No `preventDefault()` either: the browser does nothing with a
 * bare `[`, and a HUD that swallows keys is one bug from swallowing one the game needed.
 */
function useSidebar(): boolean {
  const collapsed = useSyncExternalStore(subscribeSidebar, sidebarCollapsed, sidebarServerSnapshot);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Nothing but Escape while the world is stopped ([[126]]). The input layer has its own
      // pause guard, but these are the HUD'S OWN window listeners and it cannot speak for
      // them — without this line, `[` would fold the dock out from under a modal scrim.
      if (pauseMenuOpen()) return;
      if (event.code === SIDEBAR_TOGGLE_CODE) toggleSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return collapsed;
}

/**
 * THE ZONES ROW ([[102]]) — the fifth, and the one `PanelFrame.tsx` predicted.
 *
 * That file set the test for its own design in as many words: "a fifth row must be a `PanelRow`
 * and nothing else." This is four props and no markup, which is the test passing.
 *
 * IT NEVER LIGHTS FOR "SOMETHING IS WAITING", and that is a decision rather than an omission.
 * A `lit` row means the player has something to collect — research affordable, a box in the bag
 * — and a zone that needs attention already has a louder voice than a sidebar row: the field
 * card's alert, which plan §5 makes the one thing in the HUD allowed to interrupt. Lighting
 * this row for a wilting zone would be that alert said twice, one of them quietly.
 */
function ZonesToggle({
  open,
  zones,
  onToggle,
}: {
  open: boolean;
  zones: number;
  onToggle: () => void;
}) {
  return (
    <PanelRow
      name="The Zones"
      badge={zones === 0 ? 'none drawn' : `${zones} ${zones === 1 ? 'zone' : 'zones'}`}
      hotkey="Z"
      title="Grow Zones — crop, seed hopper, priority, name"
      open={open}
      onToggle={onToggle}
    />
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
 * F3, backtick, space and WASD are all spoken for, P belongs to the reports layer, and an
 * unhandled code falls through its switch untouched. `[` folds the sidebar ([[096]]) and is
 * bound in `useSidebar` below rather than here, because it is chrome rather than a panel.
 * T for the tree, G for goods, I for the bag — the one letter a player
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
  toggleZones: () => void;
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
  const toggleZones = useCallback(() => {
    togglePanel('zones');
  }, []);
  const close = useCallback(() => {
    closeLocalPanel();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat is not a state edge — holding the key must not strobe the panel.
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // The modal's half of the guard ([[126]]): T, G, I and Z are inert while the world is
      // stopped, or a player could open the bag BEHIND a scrim that dims it and take clicks
      // in front of it. The input layer's pause guard covers its own keys and not these.
      if (pauseMenuOpen()) return;
      if (event.code === 'KeyT') togglePanel('research');
      else if (event.code === 'KeyG') togglePanel('shop');
      else if (event.code === 'KeyI') togglePanel('bag');
      // Z for zones ([[102]]), taken from what the input layer leaves free: digits, B, R, C,
      // +, −, Escape, F3, backtick, Space and WASD are spoken for, P belongs to the reports
      // layer, T/G/I are the three above and `[` folds the dock. Z was unclaimed, and it is
      // the letter in the word. IT IS BOUND HERE, OUTSIDE THE COLLAPSED BRANCH, and that is
      // the whole reachability argument: `[` unmounts the sidebar body and every row in it,
      // but this listener and the `.floatWin` it opens live in the always-mounted half.
      else if (event.code === 'KeyZ') togglePanel('zones');
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

  return { open, toggleResearch, toggleShop, toggleBag, toggleZones, close };
}
