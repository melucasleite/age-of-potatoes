// Pointer: hover, one click → one command, and one drag → ONE command.
//
// Hover is renderer state. It never enters the sim and never enters the trace (§12) — a
// trace that recorded where the mouse was would stop being replayable at any useful size,
// and the state hash would start depending on mouse position.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  CAMERA-PAN VERSUS PAINT-MODE, THE CONFLICT §16 FLAGS — AND HOW IT IS RESOLVED HERE.
//
//  The stated problem is that a left-drag could mean "pan the camera" or "paint a zone",
//  and both are the natural gesture. In THIS codebase it currently cannot mean the first,
//  and the reason is a design decision that was already made and is worth stating plainly:
//
//      THE CAMERA IS THE PLAYER'S BODY. `render/index.ts` calls `camera.lookAt()` on the
//      interpolated player position every single frame and then clamps to the world. There
//      is no free-fly camera to pan, and adding one would be a real design change, not a
//      control-scheme tweak: this is Stardew's camera, not Factorio's. You look around by
//      WALKING, and — as of this change — by ZOOMING OUT. That is a complete answer to
//      "how does the player express looking around", so left-drag is unclaimed and the
//      paint gesture takes it outright.
//
//  The modal rules from work item 018 are implemented anyway, because they are the right
//  rules and because the day a free camera lands they must already be true:
//
//      · LEFT-DRAG PAINTS ONLY WHILE A DRAG TOOL IS ARMED. With a hand verb armed, a
//        left-drag does nothing at all — it does not water sixty tiles, and it does not
//        paint. That "nothing" is the pan gesture's reserved seat, kept warm.
//      · MIDDLE-DRAG AND SPACE-DRAG ARE PAN, ALWAYS, IN EVERY MODE. Today panning is a
//        no-op, so what they concretely do is SUPPRESS PAINTING — the reservation is
//        enforced, not merely documented, and a player who middle-drags across their field
//        does not discover a zone they did not ask for.
//      · RIGHT-CLICK OR ESC DURING A DRAG CANCELS IT and emits nothing.
//      · ESC WITH NO DRAG disarms back to the Hand.
//
//  §10 decision 5 — "desktop only, mouse and keyboard, no touch abstraction tax" — is what
//  makes this affordable: middle-drag, space-drag and modifier keys are all free here.
// ────────────────────────────────────────────────────────────────────────────────────
//
// POINTER CAPTURE IS LOAD-BEARING. A drag that starts on the field and ends past the edge
// of the canvas is an ordinary gesture — reaching for the last row and overshooting. Without
// capture the browser stops delivering `pointermove` and `pointerup` the moment the cursor
// leaves, and the band freezes mid-drag with the button still down. `setPointerCapture` on
// the press keeps both coming, so the release lands and the rect is the one you drew.

import type { Command, CropId, MachineView, WorldView } from '@snack/sim';
import { Direction, ItemId, LampState, MachineKind, beltSpec, listPriceCents } from '@snack/sim';

import type { BandState } from './chrome';
import type { HoverTile, InputHost } from './context';
import {
  beltCommandFor,
  eraseCommandFor,
  lineBetween,
  paintCommandFor,
  rectBetween,
  runBounds,
  zoneIdAt,
} from './gesture';
import type { DragRun, TilePoint } from './gesture';
import { screenToTile, tileAtView } from './picking';
import type { InputSystem } from './system';
import {
  TOOL_INFO,
  ToolMode,
  V01_CROP,
  gestureFor,
  toolBeltTier,
  toolFootprint,
  toolGrabberTier,
  toolMachineKind,
} from './tools';

interface Drag {
  pointerId: number;
  anchor: TilePoint;
  cursor: TilePoint;
  tool: ToolMode;
}

export class PointerInput {
  private attached = false;
  private drag: Drag | null = null;
  private hover: HoverTile | null = null;
  /** True while a gesture that belongs to the camera is in progress. Never paints. */
  private panReserved = false;

  constructor(
    private readonly host: InputHost,
    private readonly system: InputSystem,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const canvas = this.host.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const canvas = this.host.canvas;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    canvas.removeEventListener('wheel', this.onWheel);
    this.drag = null;
    this.panReserved = false;
    this.hover = null;
    this.host.setHover(null);
  }

  /** Esc, and anything else that means "forget it". Emits nothing, by definition. */
  cancelDrag(): void {
    this.drag = null;
    this.panReserved = false;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  // --- listeners -----------------------------------------------------------------------

  private readonly onPointerMove = (event: PointerEvent): void => {
    const tile = this.tileUnder(event);
    this.hover = tile;
    this.host.setHover(tile);
    if (this.drag !== null) this.drag.cursor = tile;
  };

  private readonly onPointerLeave = (): void => {
    // Hover clears, but a captured drag does NOT — see the header. Leaving the canvas
    // mid-drag is reaching for the far edge, not changing your mind.
    this.hover = null;
    this.host.setHover(null);
  };

  private readonly onPointerCancel = (): void => {
    this.cancelDrag();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  /**
   * The wheel zooms, one rung per notch, on the integer ladder and nowhere between.
   *
   * `passive: false` because this calls `preventDefault()`: without it the page scrolls
   * behind the canvas on a trackpad, and the game slides off screen while you are trying
   * to look at it.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (event.deltaY === 0) return;
    this.system.stepZoom(event.deltaY < 0 ? 1 : -1);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    const view = this.host.latestView();
    if (view === null) return;

    const tile = this.tileUnder(event);
    this.hover = tile;
    this.host.setHover(tile);

    // Right button: cancel a drag if there is one, otherwise the maintenance verb.
    if (event.button === 2) {
      if (this.drag !== null || this.panReserved) {
        this.cancelDrag();
        return;
      }
      const command = maintenanceCommand(view, tile);
      if (command !== null) this.host.queue.push(command);
      return;
    }

    // The camera's reserved gestures. They paint nothing, ever, in any mode.
    if (event.button === 1 || this.system.spaceHeld) {
      this.panReserved = true;
      return;
    }

    if (event.button !== 0) return;

    const tool = this.host.getTool();
    if (gestureFor(tool) === 'click') {
      // One press is one command, on the press edge. Nothing re-fires while it is held —
      // a hold-to-repeat water verb would put one command per frame in the trace.
      const command = primaryCommand(view, tile, tool, this.system.placeDir);
      if (command !== null) this.host.queue.push(command);
      return;
    }

    this.drag = { pointerId: event.pointerId, anchor: tile, cursor: tile, tool };
    // See the header: without capture the gesture dies at the canvas edge.
    try {
      this.host.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is a nicety; a browser that refuses it still gets a working drag inside. */
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.panReserved) {
      this.panReserved = false;
      return;
    }

    const drag = this.drag;
    this.drag = null;
    if (drag === null || event.button !== 0) return;

    try {
      this.host.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released, or never captured. */
    }

    const view = this.host.latestView();
    if (view === null) return;

    drag.cursor = this.tileUnder(event);
    const command = dragCommand(view, drag, this.system.zoneCrop);

    // EXACTLY ONE COMMAND, OR NONE. A forty-tile paint appends one entry to the trace.
    // A gesture that formed nothing meaningful — an erase started on bare soil — appends
    // nothing, which is the same outcome as cancelling and is deliberately not a special
    // case in the trace.
    if (command !== null) this.host.queue.push(command);
  };

  private tileUnder(event: PointerEvent): HoverTile {
    return screenToTile(this.host.canvas, this.host.camera, event.clientX, event.clientY);
  }

  // --- what the chrome draws -------------------------------------------------------------

  /**
   * The band for this frame: the live drag if there is one, otherwise the placement ghost
   * under the cursor. Presentation only — it is recomputed from scratch every frame and
   * nothing downstream remembers it.
   */
  band(): BandState | null {
    const view = this.host.latestView();
    if (view === null) return null;

    const drag = this.drag;
    if (drag !== null) return dragBand(view, drag, this.system.zoneCrop);

    const hover = this.hover;
    if (hover === null) return null;
    return ghostBand(view, hover, this.host.getTool(), this.system.placeDir);
  }
}

// --- commands ---------------------------------------------------------------------------

/** Left click: the current tool's verb. */
export function primaryCommand(
  view: WorldView,
  tile: HoverTile,
  tool: ToolMode,
  placeDir: Direction,
): Command | null {
  const kind = toolMachineKind(tool);
  if (kind !== null) {
    return { type: 'PlaceMachine', kind, tileX: tile.tileX, tileY: tile.tileY };
  }

  const grabber = toolGrabberTier(tool);
  if (grabber !== null) {
    return {
      type: 'PlaceGrabber',
      tier: grabber,
      tileX: tile.tileX,
      tileY: tile.tileY,
      dir: placeDir,
      // Unfiltered. Retuning a filtered arm is `SetGrabberFilter`, which belongs to the
      // machine card rather than to the act of placing one.
      filter: 0,
    };
  }

  const query = tileAtView(view, tile.tileX, tile.tileY);
  if (!query.insideWorld) return null;

  switch (tool) {
    case ToolMode.Water:
      return { type: 'WaterTile', tileX: tile.tileX, tileY: tile.tileY };
    case ToolMode.Plant:
      return { type: 'PlantTile', tileX: tile.tileX, tileY: tile.tileY, crop: V01_CROP };
    case ToolMode.Harvest:
      return { type: 'HarvestTile', tileX: tile.tileX, tileY: tile.tileY };
    case ToolMode.Hand:
      return query.machine === null ? null : handCommand(view, query.machine);
    default:
      return null;
  }
}

/** The single command a completed drag becomes, or `null` for "nothing to say". */
function dragCommand(view: WorldView, drag: Drag, crop: CropId): Command | null {
  const run = runFor(drag);

  if (run.kind === 'rect') {
    if (drag.tool === ToolMode.EraseZone) return eraseCommandFor(view, drag.anchor, run);
    return paintCommandFor(view, drag.anchor, run, crop);
  }

  const tier = toolBeltTier(drag.tool);
  if (tier === null) return null;
  return beltCommandFor(tier, run);
}

function runFor(drag: Drag): DragRun {
  return gestureFor(drag.tool) === 'line'
    ? lineBetween(drag.anchor, drag.cursor)
    : rectBetween(drag.anchor, drag.cursor);
}

/** Right click: maintenance, on whatever machine is under the cursor. */
export function maintenanceCommand(view: WorldView, tile: HoverTile): Command | null {
  const query = tileAtView(view, tile.tileX, tile.tileY);
  const machine = query.machine;
  if (machine === null) return null;
  if (isJammed(machine)) return { type: 'WhackJam', machineId: machine.id };
  return { type: 'RepairMachine', machineId: machine.id };
}

/**
 * The Hand verb for a machine. One command, chosen from what the machine most obviously
 * needs — this is a convenience, not an authority: every branch below produces a command
 * the sim re-validates.
 */
function handCommand(view: WorldView, machine: MachineView): Command | null {
  if (isJammed(machine)) return { type: 'WhackJam', machineId: machine.id };

  if (machine.kind === MachineKind.SellBin) {
    const item = bestSellable(view);
    return item === null ? null : { type: 'SellItem', item: item.item, count: item.count };
  }

  if (machine.kind === MachineKind.Sprinkler) {
    return { type: 'RefillHopper', machineId: machine.id };
  }

  if (machine.outputCount > 0) {
    return { type: 'UnloadMachine', machineId: machine.id, count: machine.outputCount };
  }

  // Every converter takes its own input item, so the hand verb reads the recipe rather
  // than naming a machine: the Washer wants potatoes and the Seasoner wants plain chips,
  // and neither needed a new branch here when the line replaced the monolith.
  const wanted = machineInputItem(machine.kind);
  if (wanted === null) return null;
  const have = countOf(view, wanted);
  if (have <= 0) return null;
  return { type: 'LoadMachine', machineId: machine.id, count: have };
}

function machineInputItem(kind: number): ItemId | null {
  switch (kind) {
    case MachineKind.ChipKitchen:
    case MachineKind.Washer:
      return ItemId.RussetPotato;
    case MachineKind.Slicer:
      return ItemId.WashedPotato;
    case MachineKind.Fryer:
      return ItemId.PotatoSlices;
    case MachineKind.Seasoner:
      return ItemId.PlainChips;
    case MachineKind.Bagger:
      return ItemId.SeasonedChips;
    default:
      return null;
  }
}

/**
 * The most valuable non-seed stack. Seeds are never auto-sold — selling the last seed is
 * the one irreversible mistake available in v0.1, and the sim's anti-softlock floor
 * (every harvest returns a seed) should not have to save the player from the UI.
 */
function bestSellable(view: WorldView): { item: ItemId; count: number } | null {
  let best: { item: ItemId; count: number } | null = null;
  let bestValue = 0;
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.item === ItemId.PotatoSeed || slot.count <= 0) continue;
    const value = listPriceCents(slot.item as ItemId) * slot.count;
    if (value > bestValue) {
      bestValue = value;
      best = { item: slot.item as ItemId, count: slot.count };
    }
  }
  return best;
}

function countOf(view: WorldView, item: ItemId): number {
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.item === item) return slot.count;
  }
  return 0;
}

function isJammed(machine: MachineView): boolean {
  return machine.lamp === LampState.Jammed;
}

/** Machine-view helper shared with the renderer's affordability hints. */
export function canAfford(view: WorldView, costCents: number): boolean {
  return view.moneyCents >= costCents;
}

// --- the band ----------------------------------------------------------------------------

function dragBand(view: WorldView, drag: Drag, crop: CropId): BandState {
  const run = runFor(drag);
  const bounds = runBounds(run);

  if (run.kind === 'line') {
    const tier = toolBeltTier(drag.tool);
    const perTile = tier === null ? 0 : (beltSpec(tier)?.priceCentsPerTile ?? 0);
    const cost = perTile * run.lengthTiles;
    const clear = runIsClearOfField(view, bounds);
    return {
      ...bounds,
      tone: clear && view.moneyCents >= cost ? 'belt' : 'blocked',
      label: `${run.lengthTiles} tile${run.lengthTiles === 1 ? '' : 's'} · $${Math.round(cost / 100)} ${arrow(run.dir)}`,
    };
  }

  const inField = tilesInsideField(view, bounds);
  if (drag.tool === ToolMode.EraseZone) {
    const zoneId = zoneIdAt(view, drag.anchor.tileX, drag.anchor.tileY);
    return {
      ...bounds,
      tone: zoneId > 0 && inField > 0 ? 'erase' : 'blocked',
      label: zoneId > 0 ? `− ${inField} tiles from zone ${zoneId}` : 'start on a zoned tile',
    };
  }

  const zoneId = zoneIdAt(view, drag.anchor.tileX, drag.anchor.tileY);
  return {
    ...bounds,
    tone: inField > 0 ? 'zone' : 'blocked',
    label:
      inField === 0
        ? 'the field only'
        : zoneId > 0
          ? `+ ${inField} tiles → zone ${zoneId}`
          : `new zone · ${inField} tiles · ${cropName(crop)}`,
  };
}

/** The footprint the armed placement tool would occupy under the cursor. */
function ghostBand(
  view: WorldView,
  hover: HoverTile,
  tool: ToolMode,
  placeDir: Direction,
): BandState | null {
  const footprint = toolFootprint(tool);
  if (footprint === null) return null;

  const bounds = {
    x: hover.tileX,
    y: hover.tileY,
    w: footprint.tilesWide,
    h: footprint.tilesHigh,
  };
  const cost = TOOL_INFO[tool].costCents;
  const free = footprintClear(view, bounds) && view.moneyCents >= cost;
  const isGrabber = toolGrabberTier(tool) !== null;

  return {
    ...bounds,
    tone: free ? 'zone' : 'blocked',
    label: isGrabber ? `${TOOL_INFO[tool].label} ${arrow(placeDir)}` : TOOL_INFO[tool].label,
  };
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function tilesInsideField(view: WorldView, bounds: Bounds): number {
  const f = view.field;
  const left = Math.max(bounds.x, f.originX);
  const top = Math.max(bounds.y, f.originY);
  const right = Math.min(bounds.x + bounds.w, f.originX + f.tilesWide);
  const bottom = Math.min(bounds.y + bounds.h, f.originY + f.tilesHigh);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * A hint, never a gate. Belts refuse to sit on the field or on an occupied tile in the
 * sim; this mirrors the cheap half of that so the band turns red before the click rather
 * than after. Belts and arms already down are not in `TileQuery`, so a run laid across one
 * still shows green and is still correctly refused — the sim is the authority (§12).
 */
function runIsClearOfField(view: WorldView, bounds: Bounds): boolean {
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const query = tileAtView(view, x, y);
      if (!query.insideWorld || query.isField || query.machine !== null) return false;
    }
  }
  return true;
}

function footprintClear(view: WorldView, bounds: Bounds): boolean {
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const query = tileAtView(view, x, y);
      if (!query.insideWorld || query.machine !== null) return false;
    }
  }
  return true;
}

function arrow(dir: Direction): string {
  switch (dir) {
    case Direction.North:
      return '↑';
    case Direction.South:
      return '↓';
    case Direction.West:
      return '←';
    case Direction.East:
      return '→';
    default:
      return '';
  }
}

const CROP_NAMES: Readonly<Record<number, string>> = {
  1: 'Russet Potato',
  2: 'Sugar Cane',
  3: 'Corn',
  4: 'Chili Pepper',
};

export function cropName(crop: number): string {
  return CROP_NAMES[crop] ?? 'unassigned';
}
