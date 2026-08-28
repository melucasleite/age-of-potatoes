'use client';

// THE ZONES PANEL — where a rectangle stops being a decision made once, blind, and becomes a
// thing with settings ([[102]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHAT WAS BROKEN, BECAUSE IT IS NOT WHAT IT LOOKS LIKE. The zone commands — `SetZoneCrop`,
//  `SetZonePriority`, `RenameZone`, and at the time `SetZoneAutoReplant` — have correct,
//  tested reducers in `tick.ts` and had ZERO callers anywhere in the app. Not a broken
//  caller: none. The zone card existed (`FieldCard`) and rendered `<span>`s. The sim was
//  never at fault, and neither was the projection: `ZoneView` published the fields the whole
//  time and `derive-lot.ts` copied the counts and dropped them on the floor. So the card
//  could not have drawn a crop even if it had wanted to, and the state working reducers
//  wrote was invisible to the entire HUD.
//
//  (The most expensive casualty of that bug was the seed hopper — a $1,200 node whose toggle
//  was perfect and unreachable. Item 102 wired it; item 146 then retired the node outright in
//  favour of the planter bot, so the hopper section this panel briefly had is gone with
//  `SetZoneAutoReplant` itself. History in item 102's log.)
// ────────────────────────────────────────────────────────────────────────────────────
//
// WHY THIS IS A FLOATING PANEL AND NOT AN AT-THE-MACHINE CARD, which is the item's open
// question and has three answers, in order of how much they matter:
//
//   1. THE SIDEBAR FOLDS AND UNMOUNTS ITS BODY ([[096]]). `.sideContext` and `.sidePapers` are
//      both inside that branch, the fold is global and remembered in `localStorage`, and
//      [[099]]'s verifier found that clicking a grabber with the dock folded does nothing at
//      all — the state opens and there is no DOM to draw it in. A zone card in the sidebar
//      would have inherited that exactly, and the four verbs would have been unreachable again
//      for anybody who had ever pressed `[`. The float renders in `.stage`, and `Z` is bound
//      beside the other panel keys OUTSIDE the collapsed branch. Folded or not, it opens.
//
//   2. A ZONE IS NOT A MACHINE AND YOU CANNOT STAND AT IT. The bench and the dock card pick
//      their subject by nearest-within-reach, which is a well-defined question about a thing
//      with a tile. A zone is a rectangle the player is frequently standing in the MIDDLE of,
//      possibly two of them, and "the zone you are at" has no honest answer.
//
//   3. A CLICK RUNG WOULD FIGHT THE FARM. [[099]] put grabbers on `pointer.ts`'s click ladder
//      and that was safe because an arm is one tile the player has no other use for. Zones
//      cover the field — the ground the player is clicking to plant, water and harvest — so a
//      rung that opened a panel on a zone tile would fire on a large share of ordinary farming
//      clicks. The item's own note flags this as riskier than it was for grabbers, and it is.
//
// The field card keeps its readout and gains one job: its zone rows are OPENERS now
// (`openZonePanel`), so the sidebar route still exists for the player who has the dock open.
// It is a second door to one panel, never a second copy of the controls.
//
// WHAT THE PANEL REFUSES TO DO:
//
//   IT DOES NOT OFFER A CROP THE SIM WOULD REFUSE. `applySetZoneCrop` rejects any crop whose
//   `requiresTech` is unresearched, so `deriveCropOptions` asks `techSatisfied` the same
//   question and the row is simply not drawn. A button that dispatches a discarded command is
//   indistinguishable, to the player, from the bug this item is about.
//
//   IT DOES NOT INVENT A SECOND CONSUMER FOR PRIORITY. Priority drives the planter bots' seed
//   queue and nothing else (`zones.ts`), which is correct and stays correct. The dial is wired
//   and the copy says plainly what it decides.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { CropId, ZONE_NAME_MAX_LENGTH, ZONE_PRIORITY_MAX, ZONE_PRIORITY_MIN } from '@snack/sim';

import { zoneSwatch } from './derive-dock';
import { ItemIcon } from './ItemIcon';
import { keepFocus, PanelWindow } from './PanelFrame';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import {
  focusZone,
  subscribeZoneFocus,
  zoneFocusServerSnapshot,
  zoneFocusSnapshot,
} from './zone-focus';
import { zoneNameShown, zoneNameToCommit } from './zone-name';
import type { ZoneCropOption, ZoneRow } from './types';

export function ZonePanel({ onClose }: { onClose: () => void }) {
  const lot = useHudSlice('lot');
  const pending = usePending();
  const focused = useSyncExternalStore(
    subscribeZoneFocus,
    zoneFocusSnapshot,
    zoneFocusServerSnapshot,
  );

  const zones = lot.zones;
  // The id, not the index — see `zone-focus.ts`. A zone that has been absorbed or pruned falls
  // back to the first row rather than pointing the pane at a stranger.
  const active = zones.find((zone) => zone.id === focused) ?? zones[0] ?? null;

  return (
    <PanelWindow
      title="The Zones"
      tag="what grows where"
      count={zones.length === 0 ? 'none drawn' : `${zones.length} ${plural(zones.length)}`}
      hint="Z or ESC closes"
      onClose={onClose}
    >
      {active === null ? (
        // The honest dead end, and the one every new player is in: `createWorld` starts with
        // no zones at all. Naming the tool is not a quest, it is the answer to "settings for
        // what?" — the same call `DockCard` makes about an unpainted lot.
        <div className={s.invEmpty}>
          No Grow Zones yet. Paint a rectangle over the rows you want to plan, and it gets a crop
          and a name in here.
        </div>
      ) : (
        <div className={s.winScroll}>
          <div className={s.invBody}>
            <div className={s.zoneList}>
              {zones.map((zone) => (
                <ZoneButton
                  key={zone.id}
                  zone={zone}
                  active={zone.id === active.id}
                  onPick={() => focusZone(zone.id)}
                />
              ))}
            </div>

            <ZoneDetail zone={active} options={lot.cropOptions} pending={pending} />
          </div>
        </div>
      )}
    </PanelWindow>
  );
}

function plural(count: number): string {
  return count === 1 ? 'zone' : 'zones';
}

/**
 * One zone in the list: which rectangle, and what is in it.
 *
 * THE SWATCH IS THE ONLY THING HERE THAT ANSWERS "WHICH RECTANGLE?" — the same eight tints the
 * overlay paints on the ground, for the reason `derive-dock.ts` gives at length. A zone is
 * called "Zone 3" until somebody renames it, and until this panel existed nobody could.
 */
function ZoneButton({
  zone,
  active,
  onPick,
}: {
  zone: ZoneRow;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(s.zoneItem, active && s.zoneItemOn)}
      onMouseDown={keepFocus}
      onClick={onPick}
    >
      <span className={s.zoneItemHead}>
        <span className={s.dockZoneSwatch} style={{ background: zoneSwatch(zone.id) }} />
        <span className={s.dockZoneName}>{zone.name}</span>
        <span className={s.dockZoneCrop}>{zone.cropName === '' ? 'fallow' : zone.cropName}</span>
      </span>
      <span className={s.dockZoneCounts}>
        {zone.planted}/{zone.tiles} planted
        {zone.mature > 0 ? ` · ${zone.mature} ready` : ''}
      </span>
    </button>
  );
}

/** The three controls, in the order a player meets them: name, crop, priority. */
function ZoneDetail({
  zone,
  options,
  pending,
}: {
  zone: ZoneRow;
  options: readonly ZoneCropOption[];
  pending: ReturnType<typeof usePending>;
}) {
  const waiting = pending.isPending(`zone:${zone.id}`);

  const send = useCallback(
    (command: Parameters<typeof hudStore.dispatch>[0]) => {
      pending.hold(`zone:${zone.id}`);
      // Straight down the HUD's one door to the world. An ordinary command: applied at a tick
      // boundary, validated inside the sim, written to the trace, replayable. Nothing here
      // touches `WorldState` and a refused command is a silent no-op — which is exactly why
      // every control above refuses to offer what the sim would refuse.
      hudStore.dispatch(command);
    },
    [pending, zone.id],
  );

  /**
   * The rename's own door, and **THE MISSING `pending.hold` IS THE POINT** ([[108]]).
   *
   * The hold greys every control in this pane for up to 700 ms so a button cannot be pressed
   * twice before the world answers. A rename does not need that — a commit sets its draft to
   * `null` and a null draft sends nothing, so double-sending is not reachable — and taking the
   * hold here would be actively wrong in two ways at once. It disabled the focused field, which
   * is the entire bug. And it would fire in the middle of somebody else's click: the pointer
   * goes down on a priority pip, this commits, the hold greys the pip, and React's own
   * disabled-element check swallows the click the player was making. The name would be saved by
   * eating the gesture that saved it.
   */
  const rename = useCallback((zoneId: number, name: string) => {
    hudStore.dispatch({ type: 'RenameZone', zoneId, name });
  }, []);

  return (
    <div className={s.zoneDetail}>
      {/* Keyed on the zone so that switching rectangles unmounts the field — which is how the
          old zone's draft gets committed instead of following the player to the new one. */}
      <NameField key={zone.id} zone={zone} onRename={rename} />

      <div className={s.zoneSection}>
        <div className={s.zoneSectionHead}>Crop</div>
        <div className={s.armGrid}>
          {options.map((option) => (
            <CropCell
              key={option.id}
              option={option}
              active={option.id === zone.crop}
              disabled={waiting}
              onPick={() =>
                send({ type: 'SetZoneCrop', zoneId: zone.id, crop: option.id as CropId })
              }
            />
          ))}
        </div>
        {/*
          §5's pacing, stated where the choice is made rather than after the money is spent —
          `DockCard` says the same sentence about the same fact on its own buttons. A one-shot
          zone is not a mistake; it is a zone that needs the hopper or a planter to stay full.
        */}
        {zone.crop !== CropId.None && zone.regrows === 0 ? (
          <div className={s.zoneNote}>
            A one-shot crop — harvest it and the tile stays bare until something sows it again.
          </div>
        ) : null}
      </div>

      <Priority zone={zone} disabled={waiting} onSend={send} />
    </div>
  );
}

/**
 * RENAME — the cosmetic one, and the one with the sharpest trap in it.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  ⚠️ **WHY THE OBVIOUS VERSION OF THIS FIELD LOSES WHAT YOU TYPE** ([[108]]), because it is
 *  not a mistake anybody makes twice and it is invisible from every direction.
 *
 *  The shipped field was `disabled={waiting}` and every control in this panel calls
 *  `pending.hold(...)` on click. So typing a name and clicking the hopper toggle DISABLED THE
 *  FIELD WHILE IT STILL HAD FOCUS. Chrome's response to that is to drop focus to `<body>` and
 *  fire the non-bubbling `blur` — while React's `onBlur` is a delegated listener on `focusout`,
 *  which never runs. Item 102's verifier caught it with an instrumented log:
 *
 *      focus +2ms     disabled=false
 *      blur  +2780ms  disabled=true      <- commit never fires
 *      MUT            disabled=false +4118ms   (usePending's 700ms release valve)
 *
 *  And the second half is worse than the first: `keepFocus` calls `preventDefault()` on every
 *  other control's mousedown, precisely so focus does NOT move — so on a build where the field
 *  is never disabled, clicking another control fires no blur AT ALL. Neither does clicking the
 *  world: `pointer.ts` preventDefaults its `pointerdown`. Enter was the only gesture that
 *  committed anything, and closing the panel — the likeliest exit of all — was guaranteed to
 *  lose the name and then go on displaying it.
 *
 *  THE FIX IS THREE THINGS, and none of them is a timer:
 *
 *    1. THE FIELD IS NEVER DISABLED. `waiting` is a guard against double-dispatching a click;
 *       a text field cannot be double-clicked into two commands, because a commit returns the
 *       draft to `null` and a null draft sends nothing. So the field does not take the hold and
 *       does not answer to it — see `onRename` in `ZoneDetail` for the other half of that.
 *    2. EVERY EXIT ROUTES TO ONE `commit`. Enter, a real blur, the pointer going down anywhere
 *       else, and unmount — which is what closing the panel with Z or ESC, or picking a
 *       different zone, actually is.
 *    3. THE POINTER LISTENER IS `pointerdown` IN THE CAPTURE PHASE, ON `window`. That is the
 *       one thing in this document that fires no matter what: capture runs before the target
 *       sees the event, so neither `keepFocus`'s `preventDefault` nor the canvas's can hide it,
 *       and unlike `mousedown` it is not a compatibility event that a prevented pointerdown
 *       suppresses. It is armed only while there is a draft to lose.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **THE KEYDOWN GUARD IS LOAD-BEARING, NOT TIDINESS.** This is the SECOND text field in the
 * HUD. `HudRoot`'s panel hook says so in as many words — "the one text field in the HUD is the
 * cheat console, and it stops keydown propagation before any window listener sees it" — and
 * that comment is now out of date by exactly this input. The game layer is already safe
 * (`keyboard.ts`'s `editableTarget` focus guard), but the HUD's OWN key effects are bare
 * `window` listeners with no such guard: without `stopPropagation` here, typing "North Field"
 * would open the research tree on the T, the bag on the I, and fold the sidebar on nothing at
 * all. The cheat input's handler is copied deliberately, character for character in shape.
 *
 * COMMITTED ON EXIT, never per keystroke: one command per rename, so the trace carries "the
 * player named it North Field" rather than thirteen prefixes of it. ESCAPE ABANDONS by dropping
 * the draft — and `stopPropagation` means that Escape never reaches the input layer's cascade,
 * so putting a tool down is not a side effect of giving up on a name.
 *
 * CONTROLLED NOW, AND THAT IS THE READOUT FIX. `defaultValue` is a copy of the name taken once
 * at mount, which is a second source by construction: it cannot notice the world renaming a
 * zone, and it kept a discarded draft on screen forever. The value is `zoneNameShown`, which is
 * `zone.name` itself whenever nobody is typing — the same string the list row prints. The caret
 * fight that made the original author reach for `defaultValue` does not apply, because a draft
 * is local state and a publish never overwrites one.
 */
function NameField({
  zone,
  onRename,
}: {
  zone: ZoneRow;
  onRename: (zoneId: number, name: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);

  // Everything `commit` reads, refreshed every render. The commit is called from places that
  // outlive the render that created them — a `window` listener and an unmount cleanup — so
  // capturing `zone.name` in a closure would mean committing against a stale world, and giving
  // `commit` a dependency array would mean re-registering the listener on every keystroke.
  const latest = useRef({ draft, name: zone.name, id: zone.id, onRename });
  latest.current = { draft, name: zone.name, id: zone.id, onRename };

  /**
   * Drop the draft, in the ref AND in React state, in that order.
   *
   * ⚠️ **THE REF WRITE IS NOT REDUNDANT WITH THE `setDraft`, AND THE BROWSER PASS PROVED IT.**
   * `setDraft(null)` is a scheduled render, not an assignment — nothing has changed by the time
   * the current event finishes. Every exit here is followed synchronously by another one:
   * Enter commits and then calls `blur()`, which fires `onBlur` → `commit` again; Escape drops
   * the draft and then calls `blur()`, likewise. With only the state update, the second call
   * still saw the typed string and acted on it — so ESCAPE SAVED THE NAME IT WAS ABANDONING,
   * and Enter sent the rename twice (the second refused by `applyRenameZone`, but in the queue).
   * The ref is what `commit` reads, so the ref is what has to be cleared to mean "handled".
   */
  const drop = useCallback(() => {
    latest.current = { ...latest.current, draft: null };
    setDraft(null);
  }, []);

  const commit = useCallback(() => {
    const held = latest.current;
    // Nothing typed since the last commit. Every exit calls this and several of them fire in
    // sequence for one gesture — pointer down on the ESC button, then unmount — so being a
    // no-op on a null draft is what makes them idempotent rather than a double send.
    if (held.draft === null) return;
    drop();
    const name = zoneNameToCommit(held.draft, held.name);
    if (name !== null) onRename(held.id, name);
  }, [drop]);

  // EXIT: the pointer goes down anywhere that is not this box. See the note above for why this
  // is the listener and why it is in the capture phase. Armed only while a draft exists, so the
  // ordinary cost of having this panel open is one closure and no listener.
  useEffect(() => {
    if (draft === null) return undefined;
    const onDown = (event: PointerEvent): void => {
      if (event.target === ref.current) return;
      commit();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [draft, commit]);

  // EXIT: the field goes away. Closing the panel with Z or ESC unmounts it with no blur and no
  // pointer event anywhere near it, and so does selecting another zone — `ZoneDetail` keys this
  // component on the zone id precisely so that switching rectangles commits the old one rather
  // than carrying a draft across to a stranger.
  useEffect(() => commit, [commit]);

  return (
    <div className={s.zoneNameRow}>
      <input
        ref={ref}
        className={s.zoneNameInput}
        type="text"
        value={zoneNameShown(draft, zone.name)}
        maxLength={ZONE_NAME_MAX_LENGTH}
        spellCheck={false}
        autoComplete="off"
        aria-label="Zone name"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            // ABANDON. `drop` rather than `setDraft(null)` because the `blur()` below runs
            // before any re-render and would otherwise commit the name Escape just gave up on.
            drop();
            event.currentTarget.blur();
          }
        }}
        onKeyUp={(event) => {
          event.stopPropagation();
        }}
        // The blur that DOES fire — Tab, or a click on something that does not keep focus. It is
        // no longer the only hope, but it is still the cheapest and the most correct one.
        onBlur={commit}
      />
      <span className={s.zoneTiles}>
        {zone.tiles} {zone.tiles === 1 ? 'tile' : 'tiles'}
      </span>
    </div>
  );
}

// THE SEED HOPPER'S SECTION STOOD HERE — the $1,200 node item 102 found dead, wired, and item
// 146 then retired outright: `SetZoneAutoReplant`, `ZoneView.autoReplant` and the node itself
// are gone from the sim, and planter bots are the only automatic planting. The toggle, its
// three-case seed-bag note and the locked signpost went with them; the history is in item
// 102's log.

/**
 * PRIORITY — wired, honest, and currently consumed by NOTHING in the sim.
 *
 * Item 102's constraint was "do not 'fix' `SetZonePriority` by inventing a second consumer";
 * its one consumer was the seed hopper's queue, and item 146 retired the hopper. The command
 * still lands, persists and hashes, so the control stays — but the copy below says out loud
 * that no bot reads it yet, because a caption claiming a queue that does not run is exactly
 * the lie this panel was built to stop telling. Flagged for a design ruling (cut the command,
 * or point the planter bots at it) in the wave report.
 *
 * Drawn as ten pips rather than a number field, which is the bench's dial vocabulary: the range
 * is the sim's own `ZONE_PRIORITY_MIN`/`MAX` read rather than a 0–9 written here, so a rebalance
 * moves the control with it.
 */
function Priority({
  zone,
  disabled,
  onSend,
}: {
  zone: ZoneRow;
  disabled: boolean;
  onSend: (command: Parameters<typeof hudStore.dispatch>[0]) => void;
}) {
  const steps: number[] = [];
  for (let value = ZONE_PRIORITY_MIN; value <= ZONE_PRIORITY_MAX; value++) steps.push(value);

  return (
    <div className={s.zoneSection}>
      <div className={s.zoneSectionHead}>
        Priority <span className={s.zonePriorityValue}>{zone.priority}</span>
      </div>
      <div className={s.zonePips}>
        {steps.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`Priority ${value}`}
            aria-pressed={value === zone.priority}
            className={cx(s.zonePip, value <= zone.priority && s.zonePipOn)}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => onSend({ type: 'SetZonePriority', zoneId: zone.id, priority: value })}
          />
        ))}
      </div>
      <div className={s.zoneNote}>
        A rank saved with the zone. Nothing on the lot reads it yet — a planter bot works whatever
        zone its dock is pointed at, seed or no seed.
      </div>
    </div>
  );
}

/**
 * One crop the zone can be set to, drawn as itself.
 *
 * The seed count is on the cell because the question a player is actually asking here is not
 * "which crop is best" but "which crop can I sow right now" — and the answer is in their bag.
 * Fallow has no icon and no count: it is the absence of a crop rather than a crop.
 */
function CropCell({
  option,
  active,
  disabled,
  onPick,
}: {
  option: ZoneCropOption;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const fallow = option.id === CropId.None;

  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(s.armCell, fallow && s.armCellAny, active && s.armCellOn)}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onPick}
      title={
        fallow
          ? 'Sow nothing here'
          : `${option.name}${option.regrows === 1 ? ' — regrows after harvest' : ''}`
      }
    >
      {fallow ? (
        <span className={s.armCellAnyMark}>∅</span>
      ) : (
        <ItemIcon item={option.item} size={28} />
      )}
      <span className={s.armCellName}>{option.name}</span>
      {fallow ? null : <span className={s.zoneCellSeeds}>{option.seeds} seed</span>}
    </button>
  );
}
