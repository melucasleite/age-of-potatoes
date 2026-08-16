'use client';

// The grabber card — what the arm you clicked is allowed to pick up ([[099]]).
//
// IT OPENS BECAUSE YOU CLICKED IT, and that is the one thing it does differently from its two
// siblings. `UpgradeBench` and `DockCard` open because you WALKED OVER; this opens on a click,
// because the owner asked for a click in as many words — *"is there a way for us to, when you
// click the grabber, allow you to select which item is gonna grab?"* — and because the sim
// agrees with him: `SetGrabberFilter` is the one grabber command that is not reach-gated
// (`tick.ts`: *"Retuning a filter is paperwork — a dropdown on a panel that names an arm"*).
// Making the player walk to an arm to give it orders would be the UI inventing a rule the sim
// declined to have. It closes on a second click on the same arm, on Esc, on the ×, and by
// itself the moment the arm stops existing.
//
// IT SHARES THE SIDEBAR'S CONTEXTUAL SPACE with the bench and the dock card, and unlike those
// two it CAN be on screen beside one of them — you can stand at a Fryer and click an arm
// across the lot. That is honest rather than untidy: one card describes where you are standing
// and the other describes what you last pointed at, and both are true at once. It borrows
// `.bench` wholesale for the same reason `DockCard` does — same corner, same control, same
// width, different question.
//
// WHAT THE CARD REFUSES TO DO:
//
//   IT DOES NOT OFFER THE Mk1 A PICKER. `GrabberSpec.filterable` is false for the Mk1 and the
//   reducer refuses a non-zero filter on one; a grid that dispatched a command the sim throws
//   away would be a control that lies about being a control. The card explains the tier
//   instead, which is also the only place in the game that says what the Mk2 is FOR.
//
//   IT DOES NOT OFFER THE WHOLE ITEM TABLE. The grid is built from the arm's SOURCE — see
//   `grabber-card.ts` — because fifty sprites, of which two can ever arrive at this arm, is a
//   wall rather than a choice.
//
//   IT DOES NOT DECIDE WHETHER THE FILTER WILL WORK. Pointing a potato-filtered arm at a sell
//   bin that refuses potatoes is a legal, sensible, wrong thing to do, and the arm's own red
//   lamp is where the game says so. A picker that greyed out "unwise" items would be a second
//   opinion about the delivery rules, in the one place a player is trying to state an intent.

import { useCallback, useSyncExternalStore } from 'react';

// Relative rather than the `@/` alias in the modules that have tests; a component does not,
// so this follows `BuildMenu.tsx` and reads the seam through the alias like its sibling does.
import {
  grabberPanelClose,
  grabberPanelServerSnapshot,
  grabberPanelSnapshot,
  subscribeGrabberPanel,
} from '@/game/input/grabber-panel';
import { ArmSource } from '@/game/input/grabber-card';

import { ItemIcon } from './ItemIcon';
import { itemName } from './item-copy';
import { hudStore } from './store';
import { cx, s } from './styles';
import { usePending } from './use-pending';
import { grabberLabel, machineLabel } from './tech-copy';

/** The compass, as the player sees it: the way goods FLOW, which is the way the claw drops. */
const ARROWS: Readonly<Record<number, string>> = { 1: '↑', 2: '→', 3: '↓', 4: '←' };

function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

export function GrabberCard() {
  const card = useSyncExternalStore(
    subscribeGrabberPanel,
    grabberPanelSnapshot,
    grabberPanelServerSnapshot,
  );
  const pending = usePending();

  const tune = useCallback(
    (grabberId: number, filter: number) => {
      pending.hold(`arm:${grabberId}`);
      // Straight down the HUD's one door to the world (`hudStore.dispatch`): an ordinary
      // command, applied at a tick boundary, validated in the sim, written to the trace and
      // replayable. Nothing here touches `WorldState`, and a refused command is a no-op.
      hudStore.dispatch({ type: 'SetGrabberFilter', grabberId, filter });
    },
    [pending],
  );

  // No arm selected. Like the bench, the card is not "closed" — it has no subject.
  if (!card.open) return null;

  const waiting = pending.isPending(`arm:${card.grabberId}`);

  return (
    <div className={cx(s.card, s.bench)}>
      <div className={s.benchHead}>
        <span className={s.benchName}>{grabberLabel(card.tier)}</span>
        <button
          type="button"
          className={s.armClose}
          aria-label="Close"
          onMouseDown={keepFocus}
          onClick={grabberPanelClose}
        >
          ×
        </button>
      </div>

      {/*
        WHAT IT IS DOING, IN ONE LINE, and it names the item rather than saying "filtered".
        This is the sentence that answers the complaint the item was filed about — "it's
        picking the wrong thing" — so it has to be readable without opening anything else.
      */}
      <div className={cx(s.armOrders, card.filter === 0 && s.armOrdersAny)}>
        {card.filter === 0
          ? 'Takes anything it can reach.'
          : `Takes ${itemName(card.filter)} and nothing else.`}
      </div>
      <div className={s.armFacing}>
        {ARROWS[card.dir] ?? '·'} {sourceLine(card.source, card.sourceKind)}
      </div>

      <div className={s.benchDivider} />

      {card.filterable ? (
        <>
          {/*
            The lot fallback, said out loud. A grid the player cannot account for is worse
            than a short one: if these items are the lot's rather than the belt's, the card
            says so, and the player knows why a potato they have never sent down this line is
            on offer.
          */}
          <div className={s.armGridNote}>
            {card.fromLot
              ? 'Nothing behind it when you looked — so this is everything your lot has.'
              : 'What its source has offered.'}
          </div>
          <div className={s.armGrid}>
            <AnyCell
              active={card.filter === 0}
              disabled={waiting}
              onPick={() => tune(card.grabberId, 0)}
            />
            {card.candidates.map((item) => (
              <ItemCell
                key={item}
                item={item}
                active={item === card.filter}
                disabled={waiting}
                onPick={() => tune(card.grabberId, item)}
              />
            ))}
          </div>
        </>
      ) : (
        // THE Mk1's ANSWER, and it is the only place in the game that says what the upgrade
        // buys. Phrased as a fact about this arm, never as a refusal of the click: the player
        // did nothing wrong, they are just holding the cheap one.
        <div className={s.benchLocked}>
          This arm takes whatever comes — it has no filter to set. The Mk2 and the Long Grabber do;
          swap this one out for either and this panel grows a picker.
        </div>
      )}
    </div>
  );
}

/**
 * Where the candidates came from, in words.
 *
 * The seam publishes numbers (`ArmSource`, `MachineKind`) and this side spells them, which is
 * the rule `item-copy.ts` and `tech-copy.ts` both state: presentation does not live in the
 * layer that owns the state. An arm reaching into bare ground is worth saying plainly — it is
 * a real mistake, it looks identical to a working arm from three tiles away, and the lamp
 * calls it "starved" without saying why.
 */
function sourceLine(source: number, sourceKind: number): string {
  if (source === ArmSource.Belt) return 'takes from the belt behind it';
  if (source === ArmSource.Machine) return `takes from the ${machineLabel(sourceKind)} behind it`;
  return 'nothing behind it to take from';
}

/**
 * The clear button, drawn as a cell rather than as a link.
 *
 * "Anything" is the state an arm ships in and the state a player returns it to, so it is the
 * first cell in the grid and it is always exactly one click away — the item asks for that in
 * as many words, and a "clear" tucked under the grid would make undoing a filter feel like a
 * different kind of action from setting one. It is the same shape as the items so the two
 * read as one row of choices.
 */
function AnyCell({
  active,
  disabled,
  onPick,
}: {
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(s.armCell, s.armCellAny, active && s.armCellOn)}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onPick}
      title="Take anything"
    >
      <span className={s.armCellAnyMark}>∗</span>
      <span className={s.armCellName}>anything</span>
    </button>
  );
}

/** One candidate, drawn as itself — the same `ItemIcon` the bag and the build menu use. */
function ItemCell({
  item,
  active,
  disabled,
  onPick,
}: {
  item: number;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const name = itemName(item);
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(s.armCell, active && s.armCellOn)}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onPick}
      title={name}
    >
      <ItemIcon item={item} size={28} />
      <span className={s.armCellName}>{name}</span>
    </button>
  );
}
