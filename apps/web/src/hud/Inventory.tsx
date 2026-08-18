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
// under it that describes the ONE thing you pointed at. Two questions, two surfaces, and
// neither one is now paying for the other's clutter.
//
// FOUR THINGS IT REFUSES TO DO, each of which would have been shorter to write:
//
//   IT DOES NOT RUN A CLOCK, and since [[124]] there is no clock to run: nothing in the bag
//   ages, so a cell's only states are what it is, how many, and whether it is boxed.
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
//   IT DOES NOT PLACE ANYTHING ITSELF. "Place" arms the build cursor; the machine goes down
//   where the player clicks, on a lot that stays visible around the floating bag ([[089]] —
//   the window is centred and the canvas owns everything behind and beside it). Placement is
//   a gesture on the world, and a panel that put a Fryer down for you would have to invent a
//   tile to put it on.

import { useCallback, useEffect, useState } from 'react';

import { CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, UPGRADE_MAX_LEVEL, permille } from '@snack/sim';
import type { ItemId } from '@snack/sim';

import type { ToolMode } from '@/game/input/tools';

import { ItemIcon } from './ItemIcon';
import { formatCents } from './format';
import { beginHotbarDrag } from './hotbar-drag';
import { hudStore } from './store';
import { keepFocus, PanelRow, PanelWindow } from './PanelFrame';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { InventoryBox, InventoryRow } from './types';

/** Where a condition bar turns red. The bench's constant, derived the same way and for the same
 * reason: condition and permille happen to share a scale today, and a panel that assumed it
 * would start lying silently the day somebody rescaled one of them. */
const ROUGH_PERMILLE = permille(CONDITION_EFFECT_THRESHOLD, CONDITION_MAX);

// THE GRID IS SIX FIXED COLUMNS, declared in `.invGrid`. It sized the whole sidebar while
// the bag lived there (`layout.ts` keeps the history); the floating window ([[089]]) sizes
// itself around the same 390px grid via `.floatWin`. The arrow-key cursor that used to
// share the constant went with the modal ([[069]]): arrows walk the farmer, so nothing in
// this file does column arithmetic any more.

/** Sprite box sizes. Bigger in the pane, because that is the one you are actually looking at. */
// 64 rather than 48 since the resolution bump: item art is 32 source pixels now, and 48 is not
// a whole multiple of it — a 32px frame in a 48px box either letterboxes or scales by 1.5 and
// goes soft, which is the one thing `image-rendering: pixelated` cannot save. 64 is 2x exactly.
const SLOT_ICON = 64;
const DETAIL_ICON = 64;

// --- the sidebar row (the opener) --------------------------------------------------------

/**
 * THE BAG row, under RESEARCH and THE STAND ([[089]]): item 069's always-open dock section
 * retires, and the row that was its header becomes a plain opener for the floating window —
 * same chrome as the other rows, wired to the same toggle I uses. It still lights up when
 * there is a boxed machine inside, which is the only teaching the feature gets: a player who
 * boxes their first Fryer sees the row change while they are still standing where the Fryer
 * was — and it lights while the window is up, exactly as the BUILD row does.
 */
export function BagToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const inventory = useHudSlice('inventory');
  const boxed = inventory.boxCount;
  const kinds = inventory.rows.length;

  return (
    <PanelRow
      name="The Bag"
      badge={
        boxed > 0
          ? `${boxed} boxed`
          : kinds === 0
            ? 'empty'
            : `${kinds} ${kinds === 1 ? 'kind' : 'kinds'}`
      }
      hotkey="I"
      title="The bag — everything you are carrying, centred over the lot"
      open={open}
      lit={boxed > 0}
      onToggle={onToggle}
    />
  );
}

// --- the floating window ([[089]]) -------------------------------------------------------

/**
 * The bag as a centred floating window over the canvas — the owner's ruling, amending item
 * 069's dock section knowingly: "Inventory and build should show as a floating window in
 * the middle of the screen." It claims the one-panel-anywhere invariant through
 * `panel-state.ts` exactly as the slot panels do, so opening it closes the build menu, the
 * shop or the tree, and vice versa.
 *
 * WHAT DID NOT COME BACK FROM THE MODAL DAYS, ON PURPOSE: the arrow-key grid cursor and
 * Enter-to-place stay gone. The window floats over a live, visible lot and must not stop
 * WASD/arrows from walking. Selection is a click; placing is the pane's button; the drag to
 * the hotbar ([[061]]) is untouched — it hit-tests registered slot rects, so it works from
 * any geometry the bag happens to occupy. Esc closes the window and so does the ESC button —
 * both are `PanelWindow`'s now ([[093]]), the same pair all four panels offer because it is
 * literally the same code; the input layer's own Esc — put the tool down — keeps firing
 * underneath, exactly as it does for the stand and the tree.
 */
export function InventoryWindow({ onClose }: { onClose: () => void }) {
  const inventory = useHudSlice('inventory');
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
  // `selectTool` rather than `dispatch`. It no longer closes anything afterwards: the bag is
  // docked beside a fully visible lot, so an armed build cursor is armed, not stuck — the
  // exact problem the old modal had to close itself to avoid.
  const place = useCallback((tool: number) => {
    hudStore.selectTool(tool as ToolMode);
  }, []);

  const boxed = inventory.boxCount;

  return (
    // `tag` is two words shorter than it was ("everything you are carrying") so that it and
    // the count both fit the shared head without ellipsis ([[093]]) — the bag is the one
    // panel with a tag AND a count and no money, so it has the room for exactly this much.
    <PanelWindow
      title="The Bag"
      tag="what you are carrying"
      count={
        boxed > 0
          ? `${boxed} boxed`
          : rows.length === 0
            ? 'empty'
            : `${rows.length} ${rows.length === 1 ? 'kind' : 'kinds'}`
      }
      hint="drag a cell onto the hotbar · I or ESC closes"
      onClose={onClose}
    >
      {active === null ? (
        <div className={s.invEmpty}>Your pockets are empty.</div>
      ) : (
        <div className={s.winScroll}>
          <div className={s.invBody}>
            {boxed > 0 ? (
              <div className={cx(s.shopStatus, s.shopStatusOpen)}>
                {boxed} boxed {boxed === 1 ? 'machine' : 'machines'} —{' '}
                {formatCents(inventory.scrapCents)} if you scrapped every one of them.
              </div>
            ) : null}

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
        </div>
      )}
    </PanelWindow>
  );
}

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

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(s.invSlot, boxed && s.invSlotBoxed, selected && s.invSlotOn)}
      // The name is not printed in the cell, so it has to be reachable some other way for a
      // player who cannot place a sprite — the pointer gets a tooltip, the screen reader gets
      // the label, and the pane gets the long form.
      title={`${row.name} — ${row.count}`}
      aria-label={`${row.name}, ${row.count}`}
      onMouseDown={keepFocus}
      // EVERY cell is draggable towards the hotbar, placeable or not — the refusal happens
      // at the DROP, as a flash on the slot ([[061]]), because "you cannot shortcut a
      // potato" is an answer worth giving where the player is looking, and a cell that
      // simply would not pick up would read as a dead mouse button. Under the movement
      // threshold this is inert and the ordinary select-click proceeds untouched.
      onPointerDown={(event) =>
        beginHotbarDrag(event, { type: 'item', item: row.id, placeTool: row.placeTool })
      }
      onClick={() => onSelect(row.id)}
    >
      <ItemIcon item={row.id} size={SLOT_ICON} />
      {boxed ? <span className={s.invSlotCrate} /> : null}
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
 * A stack of goods: what it is worth if the bin will take it.
 *
 * The value is dropped rather than zeroed when the bin refuses the stack, the same call
 * `Pouch.tsx` makes and for the same reason: "8 seeds · $4" is a price for a transaction that
 * cannot happen, and a price beside something unsellable reads as a promise.
 */
function GoodsDetail({ row }: { row: InventoryRow }) {
  return (
    <>
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
