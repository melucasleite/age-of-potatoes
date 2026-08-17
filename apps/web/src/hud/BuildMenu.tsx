'use client';

// The build menu: every entry in the catalogue, drawn as itself ([[071]]).
//
// A GRID OF PICTURES, NOT A LIST OF TEXT ROWS. Opening it and finding the Fryer is
// recognition, not reading — the same ruling the hotbar icons got in [[065]]. Each cell is
// the entry's own world sprite (`BuildEntry.frame`, resolved through `item-art.ts`), its
// price sits under the picture and reads red when the money is not there — per cell, at a
// glance, never behind hover — and the focused cell's name, price and hint are spoken in
// full by the detail line at the bottom.
//
// THE SURFACE IS HERE; THE BRAIN IS NOT. `B`, the arrow keys, Enter, the digit jumps and
// Esc all live in the input layer (`keyboard.ts` → `system.ts`), because the menu is modal
// over the digits and stops the player walking, and that modality is the input system's to
// enforce. This component renders `build-panel.ts`'s snapshot and sends clicks back through
// its doors — `buildMenuArmAt` is the same code path Enter takes, so there is exactly one
// way a cell can arm a tool.
//
// It renders as a centred floating window over the canvas ([[089]] — it lived in the
// sidebar's contextual slot from [[069]] until the owner ruled the floats in), claiming
// its place through the same one-panel-anywhere invariant as everything else
// (`panel-state.ts`): opening it closes the bag, the shop or the tree, and vice versa.
// No scrim, no Esc listener of its own — the input layer already owns Esc while the menu
// is up, which is one better than a listener: it also keeps Esc from reaching the
// put-the-tool-down fallthrough.

import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { BuildRow } from '@/game/input/build-menu';
import { BUILD_GRID_COLS } from '@/game/input/build-menu';
import {
  buildMenuArmAt,
  buildMenuClose,
  buildMenuServerSnapshot,
  buildMenuSnapshot,
  subscribeBuildMenu,
} from '@/game/input/build-panel';
import { ToolMode } from '@/game/input/tools';

import { paintIcon, resolveFrameIcon } from './item-art';
import { keepFocus, PanelWindow } from './PanelFrame';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';

/**
 * The cell's icon box. Machine frames are 64×64 and draw at ½; tiles and items are 32×32 and
 * draw at 1× — both exact samples, both landing on the same 32 painted pixels, per `paintIcon`.
 *
 * 40 IS A CSS PIXEL COUNT AND DID NOT MOVE when the tile went 16→32. The art doubled underneath
 * it and the painted result is identical; a build menu twice the size was never the ask.
 */
const CELL_ICON = 40;

export function BuildMenuPanel() {
  const menu = useSyncExternalStore(subscribeBuildMenu, buildMenuSnapshot, buildMenuServerSnapshot);
  const economy = useHudSlice('economy');
  const focusRef = useRef<HTMLButtonElement | null>(null);

  // Keep the focused cell in view while the player arrow-keys through a catalogue taller
  // than the slot. `nearest` so a cell already visible is left exactly where it is.
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'nearest' });
  }, [menu.cursor, menu.open]);

  if (!menu.open) return null;

  const focused = menu.rows[menu.cursor];

  // Group boundaries, walked once per render. Each group renders its own CSS grid, which
  // is exactly the geometry `gridPlaces` computes for the arrow keys: a group always
  // starts a fresh row and never shares one with its neighbour.
  const groups: { name: string; start: number; rows: BuildRow[] }[] = [];
  for (let i = 0; i < menu.rows.length; i++) {
    const row = menu.rows[i]!;
    const last = groups[groups.length - 1];
    if (last === undefined || last.name !== row.group) {
      groups.push({ name: row.group, start: i, rows: [row] });
    } else {
      last.rows.push(row);
    }
  }

  // `closeOnEsc={false}` IS LOAD-BEARING ([[093]]). Every other panel lets `PanelWindow`
  // listen for Escape; this one must not, because the input layer's Escape is a strict
  // cascade (`keyboard.ts`: close the menu, ELSE the debug panel, ELSE abandon the drag,
  // ELSE put the tool down). A HUD listener closing the menu first would leave that cascade
  // looking at a shut menu and falling through, so one press would close the menu AND
  // disarm the player's tool. The ESC BUTTON still works — it calls `onClose` directly.
  return (
    // `tag` was "everything that goes on the lot" — thirty-one characters into a slot that
    // holds seventeen beside six figures of money, so it ellipsized ([[093]]). Trimmed to
    // what the row badge already promises rather than left trailing off mid-sentence.
    <PanelWindow
      title="Build"
      tag="placeable, priced"
      moneyCents={economy.moneyCents}
      hint="arrows move · Enter build · B or ESC closes"
      onClose={buildMenuClose}
      closeOnEsc={false}
    >
      <div className={s.winScroll}>
        {groups.map((group) => (
          <div key={group.name}>
            <div className={s.buildGroup}>{group.name}</div>
            <div
              className={s.buildGrid}
              style={{ gridTemplateColumns: `repeat(${BUILD_GRID_COLS}, 1fr)` }}
            >
              {group.rows.map((row, offset) => {
                const index = group.start + offset;
                return (
                  <Cell
                    key={row.tool}
                    row={row}
                    focused={index === menu.cursor}
                    armed={row.tool === menu.armedTool}
                    focusRef={index === menu.cursor ? focusRef : null}
                    onArm={() => buildMenuArmAt(index)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/*
        The focused entry, in words. The cells carry the picture and the price; the name,
        the lock reason and the hint live here so a 70px cell never has to whisper them.
      */}
      <div className={s.buildDetail}>
        {focused === undefined ? null : (
          <>
            <div className={s.buildDetailHead}>
              <span className={s.buildDetailName}>{focused.label}</span>
              <span
                className={cx(
                  s.buildDetailPrice,
                  focused.locked && s.buildDetailLocked,
                  !focused.locked && !focused.affordable && s.buildDetailBroke,
                )}
              >
                {focused.locked
                  ? focused.lockReason
                  : focused.price === ''
                    ? 'free'
                    : focused.price}
              </span>
            </div>
            <div className={s.buildDetailHint}>{focused.hint}</div>
          </>
        )}
      </div>
    </PanelWindow>
  );
}

function Cell({
  row,
  focused,
  armed,
  focusRef,
  onArm,
}: {
  row: BuildRow;
  focused: boolean;
  armed: boolean;
  focusRef: React.RefObject<HTMLButtonElement | null> | null;
  onArm: () => void;
}) {
  return (
    <button
      type="button"
      ref={focusRef}
      className={cx(
        s.buildCell,
        focused && s.buildCellOn,
        armed && s.buildCellArmed,
        row.locked && s.buildCellLocked,
      )}
      // The icon is `aria-hidden` and the visible text is a price, so the name lives here —
      // same division of labour as `ItemIcon`'s header prescribes for every slot that owns one.
      aria-label={row.label}
      title={row.locked ? `${row.label} — ${row.lockReason}` : `${row.label} — ${row.hint}`}
      onMouseDown={keepFocus}
      onClick={onArm}
    >
      <CellIcon frame={row.frame} label={row.label} erase={row.tool === ToolMode.EraseZone} />
      <span
        className={cx(
          s.buildCellPrice,
          row.locked && s.buildCellPriceLocked,
          !row.locked && !row.affordable && s.buildCellPriceBroke,
        )}
      >
        {row.locked ? 'locked' : row.price === '' ? 'free' : row.price}
      </span>
    </button>
  );
}

/**
 * The sprite, or the same quiet lettered chip the bag uses for art that has not landed
 * ([[037]]: never magenta). The erase cell wears a red strike over the zone overlay —
 * same picture as paint, because it is about the same thing, with the verb drawn on top.
 */
function CellIcon({ frame, label, erase }: { frame: string; label: string; erase: boolean }) {
  const source = resolveFrameIcon(frame);

  if (source === null) {
    return (
      <span
        className={cx(s.icon, s.iconBlank, s.buildCellIcon)}
        style={{ width: CELL_ICON, height: CELL_ICON }}
        aria-hidden="true"
      >
        {label.charAt(0).toUpperCase()}
      </span>
    );
  }

  const paint = paintIcon(source, CELL_ICON);
  return (
    <span
      className={cx(s.icon, s.buildCellIcon, erase && s.buildCellStrike)}
      style={{
        width: CELL_ICON,
        height: CELL_ICON,
        backgroundImage: paint.backgroundImage,
        backgroundPosition: paint.backgroundPosition,
        backgroundSize: paint.backgroundSize,
      }}
      aria-hidden="true"
    />
  );
}
