'use client';

// THE ZONES PANEL — where a rectangle stops being a decision made once, blind, and becomes a
// thing with settings ([[102]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHAT WAS BROKEN, BECAUSE IT IS NOT WHAT IT LOOKS LIKE. Four zone commands —
//  `SetZoneCrop`, `SetZoneAutoReplant`, `SetZonePriority`, `RenameZone` — have correct,
//  tested reducers in `tick.ts` and had ZERO callers anywhere in the app. Not a broken
//  caller: none. The zone card existed (`FieldCard`) and rendered `<span>`s. The sim was
//  never at fault, and neither was the projection: `ZoneView` published `crop`, `priority`
//  and `autoReplant` the whole time and `derive-lot.ts` copied the counts and dropped the
//  three fields on the floor. So the card could not have drawn a crop even if it had
//  wanted to, and the state four working reducers wrote was invisible to the entire HUD.
//
//  THE EXPENSIVE ONE IS THE HOPPER. `agronomy-seed-hopper` costs $1,200, its panel copy
//  promises that an armed zone "sows a tile the moment it is cleared", every zone is minted
//  `autoReplant: false`, and the only writer of that flag was a reducer nothing called. A
//  verifier ran 5,000 ticks in a fully-researched world: 0 tiles replanted. Fed the reducer
//  directly: 8 tiles in the same window. The mechanism was perfect and unreachable — and
//  not skippable either, since the $3,000 Planter Bot lists it as a prerequisite. It was a
//  mandatory toll gate on the road to a node that works, which is exactly why nobody
//  noticed: the thing behind the dead node did its job by a different mechanism.
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
//   IT DOES NOT PRETEND THE HOPPER IS ARMABLE UNRESEARCHED. `applySetZoneAutoReplant`'s first
//   line is a tech check — the lock is in the simulation, not in the UI — so with the node
//   unowned the toggle is inert and says what buys it. That is also the first place in the
//   game where $1,200 gets to describe what it is for.
//
//   IT DOES NOT INVENT A SECOND CONSUMER FOR PRIORITY. Priority drives the seed queue and
//   nothing else (`zones.ts`), which is correct and stays correct. The dial is wired and the
//   copy says plainly what it decides; auto-replant is what gives it meaning.

import { useCallback, useRef, useSyncExternalStore } from 'react';

import {
  CropId,
  ZONE_NAME_MAX_LENGTH,
  ZONE_PRIORITY_MAX,
  ZONE_PRIORITY_MIN,
  clipZoneName,
} from '@snack/sim';

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
          No Grow Zones yet. Paint a rectangle over the rows you want to plan, and it gets a crop, a
          hopper and a name in here.
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

            <ZoneDetail
              zone={active}
              options={lot.cropOptions}
              hopperOwned={lot.autoReplantOwned === 1}
              pending={pending}
            />
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
 * One zone in the list: which rectangle, what is in it, and whether its hopper is on.
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
        {/* The armed hopper, said on the row rather than only in the pane, because "which of my
            six zones is replanting itself" is a question about the LIST. */}
        {zone.autoReplant === 1 ? <span className={s.zoneItemArmed}>hopper</span> : null}
        <span className={s.dockZoneCrop}>{zone.cropName === '' ? 'fallow' : zone.cropName}</span>
      </span>
      <span className={s.dockZoneCounts}>
        {zone.planted}/{zone.tiles} planted
        {zone.mature > 0 ? ` · ${zone.mature} ready` : ''}
      </span>
    </button>
  );
}

/** The four controls, in the order a player meets them: name, crop, hopper, priority. */
function ZoneDetail({
  zone,
  options,
  hopperOwned,
  pending,
}: {
  zone: ZoneRow;
  options: readonly ZoneCropOption[];
  hopperOwned: boolean;
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

  return (
    <div className={s.zoneDetail}>
      <NameField zone={zone} disabled={waiting} onSend={send} />

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

      <Hopper zone={zone} owned={hopperOwned} disabled={waiting} onSend={send} />

      <Priority zone={zone} disabled={waiting} onSend={send} />
    </div>
  );
}

/**
 * RENAME — the cosmetic one, and the one with the sharpest trap in it.
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
 * COMMITTED ON ENTER AND ON BLUR, never per keystroke: one command per rename, so the trace
 * carries "the player named it North Field" rather than thirteen prefixes of it. ESCAPE
 * ABANDONS by restoring the world's name — and `stopPropagation` means that Escape never
 * reaches the input layer's cascade, so putting a tool down is not a side effect of giving up
 * on a name.
 *
 * UNCONTROLLED, with `defaultValue` and a key. A controlled input fed from a slice that
 * republishes several times a second fights the caret; keying it on the zone id is what makes
 * the field reset when the player selects a different rectangle.
 */
function NameField({
  zone,
  disabled,
  onSend,
}: {
  zone: ZoneRow;
  disabled: boolean;
  onSend: (command: Parameters<typeof hudStore.dispatch>[0]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  const commit = useCallback(() => {
    const input = ref.current;
    if (input === null) return;
    // `clipZoneName` is the sim's own clipper, imported rather than reimplemented, so the field
    // and the reducer agree about the 24th character. An empty or unchanged name is refused by
    // `applyRenameZone` anyway; not sending it keeps a no-op out of the trace.
    const name = clipZoneName(input.value.trim());
    if (name === '' || name === zone.name) {
      input.value = zone.name;
      return;
    }
    onSend({ type: 'RenameZone', zoneId: zone.id, name });
  }, [onSend, zone.id, zone.name]);

  return (
    <div className={s.zoneNameRow}>
      <input
        key={zone.id}
        ref={ref}
        className={s.zoneNameInput}
        type="text"
        defaultValue={zone.name}
        maxLength={ZONE_NAME_MAX_LENGTH}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        aria-label="Zone name"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.currentTarget.value = zone.name;
            event.currentTarget.blur();
          }
        }}
        onKeyUp={(event) => {
          event.stopPropagation();
        }}
        onBlur={commit}
      />
      <span className={s.zoneTiles}>
        {zone.tiles} {zone.tiles === 1 ? 'tile' : 'tiles'}
      </span>
    </div>
  );
}

/**
 * THE SEED HOPPER — the $1,200 node that did nothing, given the one thing it was missing.
 *
 * THE TOGGLE MUST BE VISIBLY EFFECTIVE THE MOMENT IT IS SWITCHED, and that is a chain of four
 * links rather than a CSS class: the button dispatches, the reducer flips `zone.autoReplant`,
 * `deriveLot` copies it (it did not, before this item), and `setLot` compares it (it did not
 * either). Break any link and the player presses a button and watches nothing happen, which is
 * the precise bug being fixed. The armed state also shows on the zone's row in the list, so the
 * feedback is not confined to the control that caused it.
 *
 * IT REPORTS THE SEED BAG, because that is the difference between "armed and working" and
 * "armed and mute". `replantOneTile` plants from the player's own stock and simply returns
 * false when there is none — no lamp, no message, nothing — so an armed zone with no seed looks
 * exactly like the bug this item is about. Naming it is what stops the next bug report.
 */
function Hopper({
  zone,
  owned,
  disabled,
  onSend,
}: {
  zone: ZoneRow;
  owned: boolean;
  disabled: boolean;
  onSend: (command: Parameters<typeof hudStore.dispatch>[0]) => void;
}) {
  const on = zone.autoReplant === 1;
  const fallow = zone.crop === CropId.None;

  return (
    <div className={s.zoneSection}>
      <div className={s.zoneSectionHead}>Seed hopper</div>

      {owned ? (
        <>
          <button
            type="button"
            aria-pressed={on}
            className={cx(s.zoneToggle, on && s.zoneToggleOn)}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => onSend({ type: 'SetZoneAutoReplant', zoneId: zone.id, on: !on })}
          >
            <span className={cx(s.zoneToggleLamp, on && s.zoneToggleLampOn)} />
            <span className={s.zoneToggleWord}>{on ? 'Armed' : 'Disarmed'}</span>
          </button>

          {/*
            WHAT IT WILL ACTUALLY DO NEXT, in three cases, because "armed" alone is a claim the
            player cannot check. Fallow and out-of-seed are both states where an armed hopper
            does nothing at all, and both are invisible in the field.
          */}
          <div className={cx(s.zoneNote, on && (fallow || zone.seeds === 0) && s.zoneNoteWarn)}>
            {!on
              ? 'Cleared tiles stay bare until you sow them yourself.'
              : fallow
                ? 'Nothing to sow — give this zone a crop and the hopper starts filling it.'
                : zone.seeds === 0
                  ? `Armed, but there is no ${zone.cropName} seed in your bag. It sows from your own stock, so it will sit idle until you buy some.`
                  : `Sows a cleared tile from your own stock — ${zone.seeds} ${zone.cropName} ${zone.seeds === 1 ? 'seed' : 'seeds'} in the bag.`}
          </div>
        </>
      ) : (
        // The locked case, and the first time in the game that $1,200 gets to say what it buys.
        // A fact about what is not owned yet, never a refusal of the click — the bench's rule.
        <div className={s.benchLocked}>
          Locked. The Seed Hopper (research, Agronomy) arms a zone to replant itself: it sows a tile
          from your own seed stock the moment one is cleared.
        </div>
      )}
    </div>
  );
}

/**
 * PRIORITY — wired, honest about being second-order, and deliberately not given a second job.
 *
 * The item's own constraint: "Do not 'fix' `SetZonePriority` by inventing a second consumer.
 * Its only consumer is the replant queue and that is correct; wire the control and let
 * auto-replant give it meaning." So the copy states the one thing it decides and does not
 * imply a bot pays attention to it, because none does.
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
        Which zone the seed hopper serves first when seed runs short. It changes nothing else — the
        bots work whatever zone their dock is pointed at.
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
