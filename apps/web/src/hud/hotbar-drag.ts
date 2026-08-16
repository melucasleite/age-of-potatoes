// Drag and drop for the hotbar ([[061]]): bag cell → slot, slot → slot, slot → nowhere.
//
// PLAIN DOM, ONE POINTER, NO REACT MID-DRAG. A drag produces a pointermove per frame, and a
// ghost that re-rendered a component tree at that rate would be the exact storm the store's
// versioned slices exist to prevent. So the ghost is a `position: fixed` div owned by this
// module, moved by writing `transform`, and React hears exactly one thing about the whole
// gesture: the layout mutation at the end, via `hudStore.refreshTools()`.
//
// NOT THE HTML5 DRAG API, DELIBERATELY. `dragstart` is suppressed by the `mousedown`
// `preventDefault()` every HUD button already uses to keep focus on the canvas (the
// Toolbelt's spec-trap comment), and unsuppressing it would reopen the focus bug to gain a
// clumsier ghost. Pointer events compose with the existing discipline instead of fighting it.
//
// THE DROP IS HIT-TESTED AGAINST REGISTERED SLOT RECTS, not `elementFromPoint`, and the
// bag's travels are the argument for it: the bag has been a full-screen scrim, a docked
// sidebar section ([[069]]), and is now a floating window over the canvas ([[089]]), and
// this module never changed — a rect test keeps working wherever the cells are and however
// the stacking shifts, because the drop lands where the eye says the slot is, not where
// the paint order says the topmost element is.
//
// A CLICK IS NOT A DRAG. Nothing happens until the pointer has moved `DRAG_THRESHOLD_PX`;
// under that, this module cleans up silently and the ordinary `click` handler fires. That is
// what lets the same pointer-down serve "select this tool" and "start rearranging it".

import { hotbar } from '@/game/input/hotbar';
import { TOOL_INFO, toolIconFrame } from '@/game/input/tools';
import type { ToolMode } from '@/game/input/tools';

import { paintIcon, resolveFrameIcon, resolveItemIcon } from './item-art';
import { itemName } from './item-copy';
import { hudStore } from './store';
import { cx, s } from './styles';

/** Movement, in px, before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6;

/** Ghost box side, matching the bag's cell icon so the thing you grabbed keeps its size. */
const GHOST_PX = 48;

export type DragSource =
  /** A bag cell: the item and the cursor that places it (`InventoryRow.placeTool`). */
  | { readonly type: 'item'; readonly item: number; readonly placeTool: number }
  /** A belt slot being rearranged (tool or item shortcut — the model sorts it out). */
  | { readonly type: 'slot'; readonly index: number };

interface ActiveDrag {
  readonly pointerId: number;
  readonly source: DragSource;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
  ghost: HTMLElement | null;
}

let drag: ActiveDrag | null = null;

/** Slot index → its DOM node, registered by the Toolbelt's rendered buttons. */
const slotNodes = new Map<number, HTMLElement>();

/** Who to tell when a drop is refused, so the slot can flash. */
const refusalListeners = new Set<(index: number) => void>();

export function registerHotbarSlot(index: number, el: HTMLElement | null): void {
  if (el === null) slotNodes.delete(index);
  else slotNodes.set(index, el);
}

export function onHotbarRefusal(listener: (index: number) => void): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/**
 * Begin a potential drag. Call from a `pointerdown` on a bag cell or a belt slot; whether
 * it becomes one is decided by the threshold, not by the caller.
 */
export function beginHotbarDrag(
  event: { pointerId: number; clientX: number; clientY: number; button?: number },
  source: DragSource,
): void {
  // Only the primary button drags. Right-click has meanings elsewhere; it keeps them.
  if (event.button !== undefined && event.button !== 0) return;
  if (drag !== null) return;
  drag = {
    pointerId: event.pointerId,
    source,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    ghost: null,
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
}

function onMove(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  if (!drag.moved) {
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    drag.ghost = makeGhost(drag.source);
    document.body.appendChild(drag.ghost);
  }
  positionGhost(drag.ghost, event.clientX, event.clientY);
}

function onUp(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  const { source, moved } = drag;
  cleanup();
  if (!moved) return; // A click. The button's own handler owns it.

  const target = slotAt(event.clientX, event.clientY);
  let changed = false;

  if (source.type === 'item') {
    if (target !== null) {
      // The model re-derives placeability itself; `placeTool` came along only so a bag cell
      // could be draggable without a lookup. A refusal — non-placeable item, tool in the
      // slot — flashes the slot it was refused at.
      changed = hotbar.assignItem(target, source.item);
      if (!changed) notifyRefusal(target);
    }
    // Dropped on nothing: a bag drag that missed assigns nothing, silently.
  } else if (target !== null) {
    changed = hotbar.move(source.index, target);
  } else {
    // Off the bar: an item shortcut clears; a tool refuses inside the model and snaps back.
    changed = hotbar.clearItem(source.index);
  }

  if (changed) hudStore.refreshTools();
}

function onCancel(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  cleanup();
}

function cleanup(): void {
  if (drag?.ghost !== null && drag?.ghost !== undefined) drag.ghost.remove();
  drag = null;
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
}

function slotAt(x: number, y: number): number | null {
  for (const [index, el] of slotNodes) {
    const rect = el.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return index;
  }
  return null;
}

function notifyRefusal(index: number): void {
  for (const listener of refusalListeners) listener(index);
}

// --- the ghost -------------------------------------------------------------------------

function makeGhost(source: DragSource): HTMLElement {
  const el = document.createElement('div');
  el.className = s.dragGhost;

  const item =
    source.type === 'item'
      ? source.item
      : (() => {
          const entry = hotbar.entryAt(source.index);
          return entry?.kind === 'item' ? entry.item : -1;
        })();

  if (item !== -1) {
    el.appendChild(iconNode(item));
  } else if (source.type === 'slot') {
    // A tool being rearranged: its icon, exactly as its slot draws it ([[065]] — the slot
    // face is the sprite now, so the thing in your hand mid-drag is the same picture).
    const entry = hotbar.entryAt(source.index);
    if (entry?.kind === 'tool') el.appendChild(toolIconNode(entry.tool));
  }
  return el;
}

/** The same sprite the slot draws, painted without React — letter chip when art is absent. */
function toolIconNode(tool: ToolMode): HTMLElement {
  const frame = toolIconFrame(tool);
  const iconSource = frame === '' ? null : resolveFrameIcon(frame);
  const span = document.createElement('span');
  span.style.width = `${GHOST_PX}px`;
  span.style.height = `${GHOST_PX}px`;
  if (iconSource === null) {
    span.className = cx(s.icon, s.iconBlank);
    span.textContent = TOOL_INFO[tool].label.charAt(0).toUpperCase();
    return span;
  }
  const paint = paintIcon(iconSource, GHOST_PX);
  span.className = s.icon;
  span.style.backgroundImage = paint.backgroundImage;
  span.style.backgroundPosition = paint.backgroundPosition;
  span.style.backgroundSize = paint.backgroundSize;
  return span;
}

/** The same sprite the bag draws, painted without React — same atlas, same arithmetic. */
function iconNode(item: number): HTMLElement {
  const iconSource = resolveItemIcon(item);
  const span = document.createElement('span');
  span.style.width = `${GHOST_PX}px`;
  span.style.height = `${GHOST_PX}px`;
  if (iconSource === null) {
    span.className = cx(s.icon, s.iconBlank);
    span.textContent = itemName(item).charAt(0).toUpperCase();
    return span;
  }
  const paint = paintIcon(iconSource, GHOST_PX);
  span.className = s.icon;
  span.style.backgroundImage = paint.backgroundImage;
  span.style.backgroundPosition = paint.backgroundPosition;
  span.style.backgroundSize = paint.backgroundSize;
  return span;
}

function positionGhost(ghost: HTMLElement | null, x: number, y: number): void {
  if (ghost === null) return;
  // Centred under the pointer; `transform` so the browser never re-lays-out mid-drag.
  ghost.style.transform = `translate(${x - GHOST_PX / 2}px, ${y - GHOST_PX / 2}px)`;
}
