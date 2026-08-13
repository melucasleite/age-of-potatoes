'use client';

// The bag — everything the player is carrying, and the two things you can do to a boxed machine.
//
// WHY IT EXISTS AT ALL. `WorldState.inventory` has been real since the first commit, and the
// only window onto it was the pouch: a strip of chips along the bottom edge that shows a count
// and a value and has room for nothing else. That was survivable while the bag held seeds and
// russets. It stopped being survivable the moment a machine could go INTO the bag ([[054]]) —
// a boxed Fryer has three dial levels, a condition, an invoice and a scrap price, and none of
// that fits on a chip. So this is the pouch's long form, not a second inventory.
//
// IT IS A GRID OF PICTURES NOW, NOT A LIST OF SENTENCES ([[058]]). Lucas's words: "the inventory
// should be a visual grid not a bunch of text." The change is not decoration. A list of rows
// makes you READ your own bag — every stack costs a word before it costs a glance — and the
// thing a player does with an inventory forty times an hour is look for one item in it. Sprites
// are found by shape and colour in one saccade; names are found by scanning. So the grid answers
// "what have I got", one cell per kind, and everything that needs a sentence moved into a pane
// beside it that describes the ONE thing you pointed at. Two questions, two surfaces, and
// neither one is now paying for the other's clutter.
//
// FOUR THINGS IT REFUSES TO DO, each of which would have been shorter to write:
//
//   IT DOES NOT RUN A CLOCK. Freshness ([[035]]) arrives as `ticksToSpoil`, already subtracted
//   from the world's absolute `spoilAtTick` by the projection, and is copied across untouched.
//   What this lane owns is only WHEN A CELL GOES AMBER — two display thresholds, named as such,
//   in `freshness.ts`. Nothing here decides when food spoils and nothing here counts down.
//
//   IT DOES NOT PRICE ANYTHING. Every figure on a box comes off the view — `investedCents` and
//   `scrapCents` are the sim's own arithmetic, and `SellBoxedMachine` pays exactly the number
//   printed on the button. The forty-percent ratio is not in this file, not in `types.ts`, and
//   not in `derive-inventory.ts`. See the tombstone at the end of `derive-tech.ts` for what the
//   alternative cost last time.
//
//   IT DOES NOT PICK WHICH BOX. `PlaceMachine` puts down the plainest box you own and
//   `SellBoxedMachine` scraps the plainest box you own — one rule, decided in the sim, and
//   neither command takes an index. A panel with a button per box would be offering the player
//   a choice the world does not implement, so the pane has ONE pair of buttons and the list
//   above them says which box they act on. The consequence is worth stating out loud, because it
//   is a kindness: THE MACHINE YOU SPENT MONEY ON IS THE LAST ONE YOU CAN LOSE BY ACCIDENT.
//
//   IT DOES NOT SELL GOODS. The bin takes goods, standing at the bin, at list ([[051]]); boxes
//   are paperwork and sell from here. Two verbs, two places, and collapsing them into one list
//   of sell buttons would teach the player that the walk to the stand is optional.
//
//   IT DOES NOT PLACE ANYTHING ITSELF. "Place" arms the build cursor and closes the panel; the
//   machine goes down where the player clicks. Placement is a gesture on the world, and a panel
//   that put a Fryer down for you would have to invent a tile to put it on.

import { useCallback, useEffect, useRef, useState } from 'react';

import { CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, UPGRADE_MAX_LEVEL, permille } from '@snack/sim';
import type { ItemId } from '@snack/sim';

import type { ToolMode } from '@/game/input/tools';

import { ItemIcon } from './ItemIcon';
import { formatCents } from './format';
import { freshnessBand, freshnessNote, isWarning } from './freshness';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { InventoryBox, InventoryRow } from './types';

/** Where a condition bar turns red. The bench's constant, derived the same way and for the same
 * reason: condition and permille happen to share a scale today, and a panel that assumed it
 * would start lying silently the day somebody rescaled one of them. */
const ROUGH_PERMILLE = permille(CONDITION_EFFECT_THRESHOLD, CONDITION_MAX);

/**
 * How wide the grid is, in slots — and it is a CONSTANT rather than an `auto-fill`.
 *
 * A responsive grid would be one line of CSS and would make the arrow keys lie: Down means "the
 * slot underneath this one", the handler works that out by adding this number, and a grid that
 * reflowed to five columns at some window width would send the cursor somewhere the player is
 * not looking. The DOM and the keyboard have to agree about the shape of the thing, so exactly
 * one of them gets to decide it.
 */
const COLUMNS = 6;

/** Sprite box sizes. Bigger in the pane, because that is the one you are actually looking at. */
const SLOT_ICON = 48;
const DETAIL_ICON = 64;

/** Keeps focus on the canvas — see the long note in `Toolbelt.tsx` for why it is `mousedown`. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

// --- the corner button -----------------------------------------------------------------

/**
 * Third in the top-left column, under Research and the Stand.
 *
 * It lights up when there is a boxed machine in the bag, which is the only teaching the feature
 * gets: a player who boxes their first Fryer sees a corner of the screen change while they are
 * still standing where the Fryer was.
 */
export function InventoryToggle({ onOpen }: { onOpen: () => void }) {
  const inventory = useHudSlice('inventory');
  const boxed = inventory.boxCount;

  return (
    <button
      type="button"
      className={cx(s.techToggle, boxed > 0 && s.techToggleReady)}
      title="The bag — goods, seeds, and machines you have boxed up"
      onMouseDown={keepFocus}
      onClick={onOpen}
    >
      <span className={s.techToggleName}>The Bag</span>
      <span className={s.techToggleBadge}>
        {boxed > 0
          ? `${boxed} boxed`
          : inventory.rows.length === 0
            ? 'empty'
            : `${inventory.rows.length} ${inventory.rows.length === 1 ? 'kind' : 'kinds'}`}
      </span>
      <span className={s.techToggleKey}>I</span>
    </button>
  );
}

// --- the panel -------------------------------------------------------------------------

export function InventoryPanel({ onClose }: { onClose: () => void }) {
  const inventory = useHudSlice('inventory');
  const economy = useHudSlice('economy');
  const pending = usePending();

  // WHICH SLOT, HELD AS AN ITEM ID RATHER THAN AN INDEX. The rows are rebuilt from the world
  // eight times a second and a stack that runs out disappears from the middle of them; an index
  // would quietly re-point at whatever slid into that position, so the pane would change what it
  // is describing while the player reads it. An id that is no longer carried simply falls back
  // to the first slot, which is the honest answer to "you have none of those left".
  const [selected, setSelected] = useState(-1);

  const rows = inventory.rows;
  const index = Math.max(
    0,
    rows.findIndex((row) => row.id === selected),
  );
  const active = rows[index] ?? null;

  const scrap = useCallback(
    (item: number) => {
      pending.hold(`scrap:${item}`);
      // The view carries plain numbers by rule — no enums across the boundary (§12) — so the id
      // widens on the way out and narrows here, exactly as the stand does with a purchase.
      hudStore.dispatch({ type: 'SellBoxedMachine', item: item as ItemId });
    },
    [pending],
  );

  // Arming a cursor is UI state and never a command (§12), so this goes out through
  // `selectTool` rather than `dispatch`. Closing afterwards is not a flourish: the panel is a
  // full-screen scrim, and a build cursor you cannot see the lot through is not armed, it is
  // stuck.
  const place = useCallback(
    (tool: number) => {
      hudStore.selectTool(tool as ToolMode);
      onClose();
    },
    [onClose],
  );

  // The key handler is bound once and reads the current grid through a ref. This panel
  // re-renders on every publish; putting `rows` in the dependency array would tear the listener
  // down and build it again eight times a second for a keyboard that has not changed.
  const live = useRef<{ rows: readonly InventoryRow[]; index: number }>({ rows, index });
  useEffect(() => {
    live.current = { rows, index };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') {
        // Deliberately NOT swallowed, unlike the keys below: Escape has meant "put the tool
        // down" to the input layer since before this panel existed, and closing the bag has
        // always done both. Changing that here would be a second feature in a stealth commit.
        onClose();
        return;
      }

      const step = STEPS[event.code];
      const acting = event.code === 'Enter' || event.code === 'NumpadEnter';
      if (step === undefined && !acting) return;

      // CAPTURED AND SWALLOWED. Arrows are also the walk keys (`input/keyboard.ts`), and this
      // listener is registered in the capture phase specifically so it can stop them reaching
      // the window listener that walks the farmer. Without it, browsing the bag marches the
      // player across a lot they cannot see behind a full-screen scrim. The build menu already
      // makes exactly this courtesy — see its note about walking away from a menu you are
      // reading. Only the keys this panel consumes are taken; everything else passes through.
      event.preventDefault();
      event.stopPropagation();

      const grid = live.current;
      const row = grid.rows[grid.index];
      if (row === undefined) return;

      if (step !== undefined) {
        // One clamp for all four directions: Left at the start stays, Right at the end stays,
        // Down off the bottom lands on the last slot. Wrapping would move the cursor somewhere
        // the eye has to go hunting for.
        const next = Math.min(Math.max(grid.index + step, 0), grid.rows.length - 1);
        setSelected(grid.rows[next]?.id ?? -1);
        return;
      }

      // ENTER PLACES; ENTER NEVER SCRAPS. Place is free and reversible — the machine goes back
      // in the bag with one whack of the wrench — and scrapping is money you cannot get back at
      // a price you did not read. A blind Enter on a keyboard-driven grid must not be able to
      // sell a maxed Fryer, so the destructive verb stays a deliberate click.
      if (row.boxedKind !== 0 && row.placeTool >= 0) place(row.placeTool);
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, place]);

  return (
    <div
      className={s.scrim}
      onMouseDown={(event) => {
        // Only a click on the scrim ITSELF closes, as in the other two panels: a drag that
        // starts on a row and ends on the backdrop must not dismiss the bag mid-scrap.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={cx(s.shopPanel, s.invPanel)} onMouseDown={(event) => event.stopPropagation()}>
        <div className={s.techHead}>
          <span className={s.techTitle}>The Bag</span>
          <span className={s.shopTag}>everything you are carrying</span>
          <span className={s.techMoney}>{formatCents(economy.moneyCents)}</span>
          <button type="button" className={s.techClose} onMouseDown={keepFocus} onClick={onClose}>
            ESC
          </button>
        </div>

        <div
          className={cx(s.shopStatus, inventory.boxCount > 0 ? s.shopStatusOpen : s.shopStatusShut)}
        >
          {inventory.boxCount > 0
            ? `${inventory.boxCount} boxed ${inventory.boxCount === 1 ? 'machine' : 'machines'} — ${formatCents(inventory.scrapCents)} if you scrapped every one of them.`
            : 'Nothing boxed. A machine you take apart comes here whole, with its dials, and goes back down for free.'}
        </div>

        {active === null ? (
          <div className={s.invEmpty}>Your pockets are empty.</div>
        ) : (
          <div className={s.invBody}>
            <div className={s.invGrid}>
              {rows.map((row) => (
                <Slot
                  key={row.id}
                  row={row}
                  selected={row.id === active.id}
                  onSelect={setSelected}
                />
              ))}
            </div>

            <Detail
              row={active}
              pending={pending.isPending(`scrap:${active.id}`)}
              onScrap={scrap}
              onPlace={place}
            />
          </div>
        )}

        <div className={s.techHint}>
          A box keeps its dials and its wear · arrows pick, Enter places · I or ESC closes
        </div>
      </div>
    </div>
  );
}

/** Which way each key moves the cursor, in slots. `COLUMNS` is what makes Up and Down mean anything. */
const STEPS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -COLUMNS,
  ArrowDown: COLUMNS,
};

// --- one slot in the grid ----------------------------------------------------------------

/**
 * A kind of thing you are carrying: its picture, how many, and nothing else.
 *
 * THE CELL IS CLEAN ON PURPOSE and it is the whole design ([[058]]). Every fact that wanted to
 * be here — the name, the price, the invoice, the two verbs — is one click away in the pane, and
 * the reason is that a grid earns its keep by being SCANNABLE. Six sprites and six numbers are
 * read at a glance; six sprites, six numbers and eighteen words are a list with pictures on it.
 *
 * A boxed machine gets two marks and no words: a warmer cell with a crate corner, so the eye
 * finds a Fryer in a bag full of potatoes, and a strip of pips saying which of its dials have
 * been turned up. Both are the same reasoning the row-based version used — machines "sit a shade
 * warmer than goods" — carried over to a shape where colour is all there is room for.
 *
 * A STACK WITH A CLOCK ON IT gets the same treatment and the same restraint ([[035]]): a wedge in
 * the one free corner and a shift in the cell's colour, drawn only once the countdown has crossed
 * a display threshold, and never a number — the count badge is the only figure a 60px cell has
 * room to be read at.
 */
function Slot({
  row,
  selected,
  onSelect,
}: {
  row: InventoryRow;
  selected: boolean;
  onSelect: (item: number) => void;
}) {
  const boxed = row.boxedKind !== 0;
  const next = row.boxes[0];

  // FRESHNESS IS DRAWN ONLY WHEN IT IS NEWS, which is this file's own rule twice over: the dial
  // strip is absent on a machine with three dials at zero, and "next out" is absent on a single
  // box, both because a mark that is always there is a mark nobody reads on the day it means
  // something. A perishable stack with twelve minutes left looks exactly like a bag of chips —
  // correctly, because neither one is asking for anything. The pane, one click away, always
  // answers the question in full.
  const band = freshnessBand(row.ticksToSpoil);
  const warning = isWarning(band);

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        s.invSlot,
        boxed && s.invSlotBoxed,
        band === 'turning' && s.invSlotTurning,
        band === 'going' && s.invSlotGoing,
        selected && s.invSlotOn,
      )}
      // The name is not printed in the cell, so it has to be reachable some other way for a
      // player who cannot place a sprite — the pointer gets a tooltip, the screen reader gets
      // the label, and the pane gets the long form. A wedge is a colour and colours have no
      // accessible name, so the clock joins both strings rather than only the tooltip.
      title={
        warning
          ? `${row.name} — ${row.count} — ${freshnessNote(row.ticksToSpoil, row.spoilingCount, row.count)}`
          : `${row.name} — ${row.count}`
      }
      aria-label={
        warning
          ? `${row.name}, ${row.count}, ${freshnessNote(row.ticksToSpoil, row.spoilingCount, row.count)}`
          : `${row.name}, ${row.count}`
      }
      onMouseDown={keepFocus}
      onClick={() => onSelect(row.id)}
    >
      <ItemIcon item={row.id} size={SLOT_ICON} />
      {boxed ? <span className={s.invSlotCrate} /> : null}
      {/*
        Two cues for one fact, exactly as the crate corner and the warm tint are: a wedge in the
        free corner and a shift in the cell's own colour. One of the two survives a player who
        cannot tell amber from red, and the wedge is the one that does — it is present or it is
        not, which is a shape question rather than a hue question.
      */}
      {warning ? (
        <span className={cx(s.invSlotFresh, band === 'going' && s.invSlotFreshGoing)} />
      ) : null}
      <span className={s.invSlotCount}>{row.count}</span>
      {boxed && next !== undefined ? <DialStrip box={next} /> : null}
    </button>
  );
}

/**
 * Which dials the next box out has been turned up on. Not how far — that is the pane's line.
 *
 * Nothing is drawn for a machine with three dials at zero, which is the same rule the renderer's
 * upgrade decals follow: level 0 has no frame by design. A strip that is always there is a strip
 * nobody reads on the day it means something.
 */
function DialStrip({ box }: { box: InventoryBox }) {
  const levels = [box.speedLevel, box.efficiencyLevel, box.capacityLevel];
  if (levels[0] === 0 && levels[1] === 0 && levels[2] === 0) return null;

  return (
    <span className={s.invSlotPips}>
      {levels.map((level, i) => (
        <span key={i} className={cx(s.invSlotPip, level > 0 && s.invSlotPipOn)} />
      ))}
    </span>
  );
}

// --- the pane beside it ------------------------------------------------------------------

/**
 * Everything about the one slot the player pointed at.
 *
 * This is where the old row's prose went, unchanged in substance: the same figures, off the same
 * fields, with the same two buttons wired to the same two verbs. What moved is only WHEN it is
 * on screen — once, for the thing you asked about, instead of once per stack forever.
 */
function Detail({
  row,
  pending,
  onScrap,
  onPlace,
}: {
  row: InventoryRow;
  pending: boolean;
  onScrap: (item: number) => void;
  onPlace: (tool: number) => void;
}) {
  const boxed = row.boxedKind !== 0;

  return (
    <div className={s.invDetail}>
      <div className={s.invDetailHead}>
        <ItemIcon item={row.id} size={DETAIL_ICON} />
        <span className={s.invDetailNames}>
          <span className={s.invDetailName}>{row.name}</span>
          <span className={s.invDetailCount}>
            {boxed ? `${row.count} boxed` : `${row.count} in the bag`}
          </span>
        </span>
      </div>

      {boxed ? (
        <BoxedDetail row={row} pending={pending} onScrap={onScrap} onPlace={onPlace} />
      ) : (
        <GoodsDetail row={row} />
      )}
    </div>
  );
}

/**
 * A stack of goods: how long it keeps, and what it is worth if the bin will take it.
 *
 * The value is dropped rather than zeroed when the bin refuses the stack, the same call
 * `Pouch.tsx` makes and for the same reason: "8 seeds · $4" is a price for a transaction that
 * cannot happen, and a price beside something unsellable reads as a promise. The clock is not
 * dropped for the same rows, because a seed keeping forever is still true and still worth
 * knowing — the two facts are independent and only one of them is a claim about money.
 */
function GoodsDetail({ row }: { row: InventoryRow }) {
  return (
    <>
      <Freshness row={row} />
      {row.sellable !== 1 ? (
        <div className={s.invNotForSale}>the bin does not take these</div>
      ) : (
        <div className={s.invValue}>
          <span className={s.shopPrice}>{formatCents(row.stackValueCents)} at the bin</span>
          <span className={s.invUnit}>{formatCents(row.unitPriceCents)} each</span>
        </div>
      )}
    </>
  );
}

/**
 * The honest half: the clock in words, on every good, whether or not it has one.
 *
 * ABOVE THE PRICE, DELIBERATELY. What a stack is worth is a fact about the bin; how long it has
 * left is a fact about the stack, and it is the one that decides whether the walk to the bin is
 * still the right move. A player reading top to bottom should meet the deadline before the money.
 *
 * "Keeps indefinitely" is printed rather than omitted, and only looks like filler until you read
 * it on a bag of chips: §4's *processing is preservation* is the reward for building the line,
 * and this is the only place in the game that ever says so in a sentence.
 */
function Freshness({ row }: { row: InventoryRow }) {
  const band = freshnessBand(row.ticksToSpoil);

  return (
    <div
      className={cx(
        s.invFresh,
        band === 'turning' && s.invFreshTurning,
        band === 'going' && s.invFreshGoing,
      )}
    >
      {freshnessNote(row.ticksToSpoil, row.spoilingCount, row.count)}
    </div>
  );
}

function BoxedDetail({
  row,
  pending,
  onScrap,
  onPlace,
}: {
  row: InventoryRow;
  pending: boolean;
  onScrap: (item: number) => void;
  onPlace: (tool: number) => void;
}) {
  const next = row.boxes[0];
  const placeable = row.placeTool >= 0;

  return (
    <>
      <div className={s.invBoxes}>
        {row.boxes.map((box) => (
          <Box key={box.index} box={box} showNextOut={row.boxes.length > 1} />
        ))}
      </div>

      {placeable ? null : (
        // Honest rather than hopeful: twenty machine kinds can be boxed and only some of them
        // have a build cursor in the UI yet, so the pane says which situation this is instead
        // of arming a tool that would put down the wrong machine.
        <div className={s.shopLocked}>
          Nothing in the build menu places one of these yet — it is safe in the bag, and it still
          scraps.
        </div>
      )}

      <div className={s.shopBuys}>
        <button
          type="button"
          className={cx(s.shopBuy, placeable && s.shopBuyReady)}
          disabled={!placeable}
          onMouseDown={keepFocus}
          onClick={() => onPlace(row.placeTool)}
        >
          <span className={s.shopBuyCount}>Place</span>
          <span className={s.shopBuyCost}>free</span>
        </button>
        <button
          type="button"
          className={s.shopBuy}
          disabled={pending || next === undefined}
          onMouseDown={keepFocus}
          onClick={() => onScrap(row.id)}
        >
          <span className={s.shopBuyCount}>Scrap</span>
          <span className={s.shopBuyCost}>
            {pending ? 'wait…' : formatCents(next?.scrapCents ?? 0)}
          </span>
        </button>
      </div>
    </>
  );
}

/**
 * One box, with what is inside it.
 *
 * `showNextOut` only when there is more than one, because "next out" is an answer to a question
 * a single box does not raise — and a badge that is always there is a badge nobody reads on the
 * day it matters.
 */
function Box({ box, showNextOut }: { box: InventoryBox; showNextOut: boolean }) {
  const conditionPercent = Math.round(box.conditionPermille / 10);
  const rough = box.conditionPermille < ROUGH_PERMILLE;

  return (
    <div className={s.invBox}>
      {showNextOut && box.index === 0 ? <span className={s.invNextOut}>next out</span> : null}
      <Dial letter="S" level={box.speedLevel} />
      <Dial letter="E" level={box.efficiencyLevel} />
      <Dial letter="C" level={box.capacityLevel} />
      <span className={cx(s.invCondition, rough && s.invConditionLow)}>{conditionPercent}%</span>
      <span className={s.invInvested}>{formatCents(box.investedCents)} in</span>
      <span className={s.invScrap}>{formatCents(box.scrapCents)} scrap</span>
    </div>
  );
}

/** Speed, Efficiency, Capacity — as pips, the same ones the bench draws. */
function Dial({ letter, level }: { letter: string; level: number }) {
  const pips: number[] = [];
  for (let i = 0; i < UPGRADE_MAX_LEVEL; i++) pips.push(i);

  return (
    <span className={s.invDial} title={`${letter} — level ${level} of ${UPGRADE_MAX_LEVEL}`}>
      <span className={s.invDialKey}>{letter}</span>
      <span className={s.pips}>
        {pips.map((i) => (
          <span key={i} className={cx(s.pip, i < level && s.pipOn)} />
        ))}
      </span>
    </span>
  );
}
