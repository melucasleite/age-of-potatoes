'use client';

// The hotbar. Ten slots, keyboard 1–9 and 0, clickable, and rearrangeable by drag ([[061]]).
//
// Clicking a slot is legal for exactly one reason: tool mode is UI STATE, not world state.
// It is never a `Command`, never enters the trace, and the sim does not know which button
// is lit — legality is decided from world state alone, so a replay does not depend on it
// (§12, and the comment at the top of `input/tools.ts` says the same thing). A HUD control
// that needed to change the WORLD would push a `Command` onto the host's queue instead —
// `hudStore.dispatch` is that door — and none may ever reach into `WorldState` directly.
//
// THE LAYOUT is likewise UI state, and it does not even live here: `input/hotbar.ts` owns
// which slot holds what, this component renders the priced projection of it (`tools` slice)
// and forwards gestures — click to arm, drag to rearrange, drop from the bag to assign,
// drag off to clear. After any mutation it calls `hudStore.refreshTools()`, because the
// store owns telling React.
//
// The cost line is the affordability tell: the price turns red before you click, rather
// than the click failing silently and leaving you to wonder whether you missed the tile.

import { useEffect, useState } from 'react';

import { hotbar } from '@/game/input/hotbar';
import type { ToolMode } from '@/game/input/tools';
import { activeWorldId } from '@/storage/worlds';

import { ItemIcon } from './ItemIcon';
import { formatCentsWhole } from './format';
import { beginHotbarDrag, onHotbarRefusal, registerHotbarSlot } from './hotbar-drag';
import { hudStore } from './store';
import { cx, s } from './styles';
import type { ToolSlot } from './types';
import { useHudSlice } from './use-hud';

/** How long a refused drop wears its flash. Matches the CSS animation, which does the work. */
const FLASH_MS = 450;

export function Toolbelt() {
  const tools = useHudSlice('tools');
  const flash = useRefusalFlash();

  // Adopt this world's saved layout once the registry says which world this is. The world
  // is activated before the game mounts (`play-client.tsx`) and switching worlds is a full
  // navigation, so once per mount is once per world. Until it resolves the default layout
  // renders — sub-frame on any healthy machine, and the default is never wrong, just plain.
  useEffect(() => {
    let cancelled = false;
    void activeWorldId().then(
      (id) => {
        if (cancelled) return;
        hotbar.bindWorld(id);
        hudStore.refreshTools();
      },
      () => {
        // No registry (blocked storage, odd boot path): the default layout, silently — the
        // same fallback a corrupt stored layout gets.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={s.belt}>
      {tools.slots.map((slot, index) => (
        <SlotButton key={index} index={index} slot={slot} flashing={flash === index} />
      ))}
    </div>
  );
}

/** Which slot is flashing a refusal, if any. Cleared on a timer; re-refusals restart it. */
function useRefusalFlash(): number | null {
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onHotbarRefusal((index) => {
      // Null first so a second refusal of the SAME slot re-triggers the CSS animation —
      // a class that never leaves the element only ever animates once.
      setFlash(null);
      requestAnimationFrame(() => setFlash(index));
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setFlash(null), FLASH_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return flash;
}

function SlotButton({
  index,
  slot,
  flashing,
}: {
  index: number;
  slot: ToolSlot;
  flashing: boolean;
}) {
  const empty = slot.tool === -1 && slot.item === -1;
  const className = cx(
    s.slot,
    empty && s.slotEmpty,
    slot.active === 1 && s.slotActive,
    !empty && slot.affordable === 0 && s.slotBroke,
    flashing && s.slotFlash,
  );

  return (
    <button
      type="button"
      className={className}
      title={slot.hint}
      // Every slot registers as a drop target, empty ones very much included — an empty
      // slot is what a drag from the bag is FOR. The registry lives in `hotbar-drag.ts`;
      // a ref callback with `null` on unmount keeps it honest across re-renders.
      ref={(el) => registerHotbarSlot(index, el)}
      // Keep focus on the canvas. The keyboard listeners live on `window` so it does not
      // strictly matter, but a HUD button stealing focus mid-game is the kind of thing
      // that only shows up as "sometimes my keys stop working".
      //
      // MOUSEDOWN, NOT POINTERDOWN, and this is not a style choice — it is a bug that was
      // in here and got caught by clicking the button. Per the Pointer Events spec,
      // `preventDefault()` on `pointerdown` suppresses the whole compatibility mouse-event
      // sequence that follows it, `click` included. The button silently stopped doing
      // anything at all. `mousedown` suppresses the focus change and leaves `click` alone.
      // (It also suppresses native HTML5 drag — which is why the hotbar's drag is pointer
      // events, see `hotbar-drag.ts`.)
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      // The drag begins as a *potential* on every press and becomes real only past the
      // movement threshold, so this coexists with `onClick` rather than replacing it.
      onPointerDown={(event) => {
        if (!empty) beginHotbarDrag(event, { type: 'slot', index });
      }}
      onClick={() => {
        if (empty || slot.tool === -1) return;
        // The slice carries plain numbers by rule (no enums, no class instances across the
        // boundary), so the tool id widens to `number` on the way out and narrows here.
        hudStore.selectTool(slot.tool as ToolMode);
      }}
    >
      <span className={s.slotKey}>{slot.digit}</span>
      {slot.item !== -1 ? <ItemIcon item={slot.item} size={24} className={s.slotIcon} /> : null}
      <span className={s.slotName}>{empty ? '·' : slot.label}</span>
      {/*
        "from the bag" outranks the price, because it IS the price: `PlaceMachine` opens a boxed
        machine before it charges anybody ([[054]]). A slot that kept quoting $100 over a box the
        player is about to spend would be contradicting the panel they just pressed Place in.
      */}
      {empty ? null : (
        <span className={s.slotCost}>
          {slot.fromBox === 1
            ? 'from the bag'
            : slot.costCents === 0
              ? 'free'
              : formatCentsWhole(slot.costCents)}
        </span>
      )}
    </button>
  );
}
