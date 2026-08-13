'use client';

// The toolbelt. Six slots, keyboard 1–6, and clickable.
//
// Clicking a slot is legal for exactly one reason: tool mode is UI STATE, not world state.
// It is never a `Command`, never enters the trace, and the sim does not know which button
// is lit — legality is decided from world state alone, so a replay does not depend on it
// (§12, and the comment at the top of `input/tools.ts` says the same thing). A HUD control
// that needed to change the WORLD would push a `Command` onto the host's queue instead;
// none does yet, and none may ever reach into `WorldState` directly.
//
// The cost line is the affordability tell: the price turns red before you click, rather
// than the click failing silently and leaving you to wonder whether you missed the tile.

import type { ToolMode } from '@/game/input/tools';

import { formatCentsWhole } from './format';
import { cx, s } from './styles';
import { hudStore } from './store';
import { useHudSlice } from './use-hud';
import type { ToolSlot } from './types';

export function Toolbelt() {
  const tools = useHudSlice('tools');

  return (
    <div className={s.belt}>
      {tools.slots.map((slot) => (
        <SlotButton key={slot.tool} slot={slot} />
      ))}
    </div>
  );
}

function SlotButton({ slot }: { slot: ToolSlot }) {
  const className = cx(
    s.slot,
    slot.active === 1 && s.slotActive,
    slot.affordable === 0 && s.slotBroke,
  );

  return (
    <button
      type="button"
      className={className}
      title={slot.hint}
      // Keep focus on the canvas. The keyboard listeners live on `window` so it does not
      // strictly matter, but a HUD button stealing focus mid-game is the kind of thing
      // that only shows up as "sometimes my keys stop working".
      //
      // MOUSEDOWN, NOT POINTERDOWN, and this is not a style choice — it is a bug that was
      // in here and got caught by clicking the button. Per the Pointer Events spec,
      // `preventDefault()` on `pointerdown` suppresses the whole compatibility mouse-event
      // sequence that follows it, `click` included. The button silently stopped doing
      // anything at all. `mousedown` suppresses the focus change and leaves `click` alone.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        // The slice carries plain numbers by rule (no enums, no class instances across the
        // boundary), so the tool id widens to `number` on the way out and narrows here.
        hudStore.selectTool(slot.tool as ToolMode);
      }}
    >
      <span className={s.slotKey}>{slot.digit}</span>
      <span className={s.slotName}>{slot.label}</span>
      {/*
        "from the bag" outranks the price, because it IS the price: `PlaceMachine` opens a boxed
        machine before it charges anybody ([[054]]). A slot that kept quoting $100 over a box the
        player is about to spend would be contradicting the panel they just pressed Place in.
      */}
      <span className={s.slotCost}>
        {slot.fromBox === 1
          ? 'from the bag'
          : slot.costCents === 0
            ? 'free'
            : formatCentsWhole(slot.costCents)}
      </span>
    </button>
  );
}
