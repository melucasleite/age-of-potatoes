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
import {
  Direction,
  IntentAction,
  ItemId,
  LampState,
  MachineKind,
  SUBTILE,
  beltSpec,
  listPriceCents,
} from '@snack/sim';

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
import type { PanelRequest } from './panels';
import { requestPanel } from './panels';
import {
  grabberAtView,
  machineWithinReach,
  screenToTile,
  tileAtView,
  tileWithinReach,
} from './picking';
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
      if (command !== null) this.host.queue.push(reachAdjusted(view, tile, command));
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
      if (command !== null) {
        this.host.queue.push(reachAdjusted(view, tile, command));
        return;
      }
      // Nothing to do here with this tool — which for the sell bin is not "nothing", it is
      // the other half of the counter. See `counterPanelFor`.
      const panel = counterPanelFor(view, tile, tool);
      if (panel !== null) requestPanel(panel);
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

  // --- what R acts on ----------------------------------------------------------------------

  /**
   * The arm under the cursor, or `null`. The pointer owns hover, so it owns this question.
   *
   * REGARDLESS OF THE ARMED TOOL, and that is the right rule rather than a shortcut. Work item
   * 052 asks for R over a placed grabber with "the Hand tool or grabber tool", but a
   * grabber-placement tool hovering an occupied tile cannot place anything there anyway, so
   * the two cases the item names are the only two that can arise — and a player who hovers an
   * arm while holding a Fryer and presses R is asking to turn the arm, not to nudge a ghost
   * that is currently refusing to be placed on top of it.
   */
  private grabberUnderCursor(): { id: number; dir: number; withinReach: boolean } | null {
    const view = this.host.latestView();
    const hover = this.hover;
    if (view === null || hover === null) return null;
    const grabber = grabberAtView(view, hover.tileX, hover.tileY);
    if (grabber === null) return null;
    return {
      id: grabber.id,
      dir: grabber.dir,
      // A grabber is one tile and has no footprint, so this is the tile check — the same
      // measurement `applyRotateGrabber` makes on the other side of the seam.
      withinReach: tileWithinReach(view, grabber.tileX, grabber.tileY),
    };
  }

  /**
   * The command R means right now, or `null` for "R still means the ghost".
   *
   * OUT OF REACH STILL EMITS, and unlike a click this one does not walk. There is no
   * `IntentAction` for turning an arm — the sim has nine walk-to verbs and rotate is
   * deliberately not among them (item 052: "refusing with the existing 'too far' affordance is
   * fine") — so the refusal is the sim's, the band under the cursor goes red before the press,
   * and the ribbon says why. Sending it anyway keeps the authority in one place (§12): a
   * refused command changes nothing and writes nothing to the trace.
   */
  rotateCommand(): Command | null {
    const grabber = this.grabberUnderCursor();
    return grabber === null ? null : { type: 'RotateGrabber', grabberId: grabber.id };
  }

  /** True when R would do something the player can see. Drives the hint strip, nothing else. */
  rotateAdvertised(tool: ToolMode): boolean {
    if (toolGrabberTier(tool) !== null) return true;
    return this.grabberUnderCursor() !== null;
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

    // An arm under the cursor outranks the ghost, because it is what R will act on and
    // because the band is the only place the refusal can be seen BEFORE the press. The one
    // exception is a machine ghost: that is a footprint the player is aiming, it can cover the
    // arm's tile from three tiles away, and hiding a 2×2 outline to draw a one-tile chevron
    // would be answering a question nobody asked.
    const tool = this.host.getTool();
    const grabber = this.grabberUnderCursor();
    if (grabber !== null && toolMachineKind(tool) === null) return grabberBand(hover, grabber);

    return ghostBand(view, hover, tool, this.system.placeDir);
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
    // Boxing is a machine verb like repair, so it names the machine and lets the sim decide
    // ([[054]]): jammed, mid-batch, or the sell bin are all refusals in `tick.ts`, and none of
    // them are re-implemented here. Out of reach becomes an errand in `reachAdjusted`.
    case ToolMode.Deconstruct:
      return query.machine === null
        ? null
        : { type: 'DeconstructMachine', machineId: query.machine.id };
    default:
      return null;
  }
}

/**
 * The panel a click that produced NO command should open, if any.
 *
 * ONE CASE TODAY, AND IT IS THE SELL BIN. The bin is a counter with two sides: the sim gates
 * `BuyItem` on standing next to it exactly as it gates `SellItem`, and until now a Hand click
 * on it could only ever sell. A player with an empty pouch clicking the stand got nothing at
 * all, which is the same dead click item 050 was filed about.
 *
 * WHY "SELL FIRST, OPEN WHEN THERE IS NOTHING TO SELL" rather than always opening. Selling is
 * the reason anyone walks to the bin and it is done in a rhythm — arrive, click, click, click.
 * A full-screen board with a scrim over the lot, thrown up on every one of those clicks, is a
 * modal fighting the loop it is attached to. Empty-handed there is nothing to fight: the click
 * had no meaning, and now it has the obvious one.
 */
export function counterPanelFor(
  view: WorldView,
  tile: HoverTile,
  tool: ToolMode,
): PanelRequest | null {
  if (tool !== ToolMode.Hand) return null;
  const machine = tileAtView(view, tile.tileX, tile.tileY).machine;
  if (machine === null || machine.kind !== MachineKind.SellBin) return null;
  return 'shop';
}

/**
 * OUT OF REACH IS NOT "NOTHING". Send the farmer instead.
 *
 * A click on a thing you cannot quite touch used to build the direct command anyway, and the
 * sim's reducer would refuse it on the reach check without a sound — the single most common
 * way this game felt broken, because the cursor said "too far" and the click still did
 * nothing about it. This wrapper is the whole fix, and it deliberately sits BESIDE
 * `primaryCommand` rather than inside it: that function's job is "what does this tool mean
 * here", which is a question about the tool, and this one's is "can he touch it from there",
 * which is a question about the player. Keeping them apart is what lets the test drive the
 * reach decision without constructing a tool.
 *
 * IN REACH STILL EMITS THE DIRECT COMMAND, and that is not an optimisation. Routing every
 * click through an errand would make the ordinary case — standing on the tile you are
 * watering — take a trip through the walk loop and arrive a tick later, which is a feel
 * regression the player would describe as lag and nobody would find by reading this file.
 *
 * NO PATHING LIVES HERE. This chooses a command; the sim does the walking, straight at the
 * target, over the next hundred-odd ticks (see `advanceErrand`). The input layer never learns
 * where the farmer is going to put his feet, which is what keeps the walk replayable.
 *
 * A verb that is not reach-gated in `tick.ts` falls out of the `default` untouched — belt and
 * zone drags, placements, research. Walking somewhere to place a machine you can place from
 * across the lot would be a new rule, not a fix.
 */
export function reachAdjusted(view: WorldView, tile: HoverTile, direct: Command): Command {
  switch (direct.type) {
    case 'WaterTile':
      return tileErrand(view, direct, IntentAction.Water, direct.tileX, direct.tileY, 0, 0);
    case 'PlantTile':
      return tileErrand(
        view,
        direct,
        IntentAction.Plant,
        direct.tileX,
        direct.tileY,
        direct.crop,
        0,
      );
    case 'HarvestTile':
      return tileErrand(view, direct, IntentAction.Harvest, direct.tileX, direct.tileY, 0, 0);

    // The counts below are SNAPSHOTTED AT CLICK TIME and may be stale by the time the farmer
    // arrives — the machine can finish another batch mid-walk. That is safe rather than
    // merely tolerable: `applyLoadMachine` and `applyUnloadMachine` clamp with `Math.min`, so
    // a stale count moves less than it could and never fails outright.
    case 'LoadMachine':
      return machineErrand(view, direct, IntentAction.Load, tile, 0, direct.count);
    case 'UnloadMachine':
      return machineErrand(view, direct, IntentAction.Unload, tile, 0, direct.count);
    case 'RefillHopper':
      return machineErrand(view, direct, IntentAction.RefillHopper, tile, 0, 0);
    case 'RepairMachine':
      return machineErrand(view, direct, IntentAction.Repair, tile, 0, 0);
    case 'WhackJam':
      return machineErrand(view, direct, IntentAction.WhackJam, tile, 0, 0);
    // Boxing is reach-gated in `tick.ts` exactly as repair is, so it walks exactly as repair
    // does — same target tile, same re-resolution from that tile on arrival ([[054]]).
    case 'DeconstructMachine':
      return machineErrand(view, direct, IntentAction.Deconstruct, tile, 0, 0);

    // `SellItem` names no machine, but `handCommand` only ever produces it from a click ON
    // the Sell Bin — so the clicked tile is the bin, and the bin is what to walk to. The sim
    // agrees: `intentTargetSubtiles` refuses a Sell errand whose target tile is not a bin.
    case 'SellItem':
      return machineErrand(view, direct, IntentAction.Sell, tile, direct.item, direct.count);

    // `BuyItem` names no machine either, but unlike a sell it does not arrive from a click on
    // one — the board is a HUD panel, so the `tile` argument means nothing here and the stand
    // has to be found. Same counter, same reach rule, opposite direction.
    case 'BuyItem':
      return standErrand(view, direct, direct.item, direct.count);

    default:
      return direct;
  }
}

function tileErrand(
  view: WorldView,
  direct: Command,
  action: IntentAction,
  tileX: number,
  tileY: number,
  item: number,
  count: number,
): Command {
  if (tileWithinReach(view, tileX, tileY)) return direct;
  return { type: 'WalkAndAct', action, tileX, tileY, item, count };
}

/**
 * The errand's payload is the CLICKED TILE, never the machine id, and that is the sim's
 * design rather than a shortcut here: `intentTargetSubtiles` re-resolves the machine from
 * that tile every single tick, so an errand aimed at a machine that gets picked up and moved
 * mid-walk goes stale and ends instead of marching the player to an empty slab. Any tile the
 * footprint covers is a correct payload; a machine id would defeat the mechanism.
 */
function machineErrand(
  view: WorldView,
  direct: Command,
  action: IntentAction,
  tile: HoverTile,
  item: number,
  count: number,
): Command {
  const machine = tileAtView(view, tile.tileX, tile.tileY).machine;
  if (machine === null || machineWithinReach(view, machine)) return direct;
  return { type: 'WalkAndAct', action, tileX: tile.tileX, tileY: tile.tileY, item, count };
}

/**
 * Walk to the roadside stand and buy there.
 *
 * THE NEAREST BIN, not the first one in the array. There is exactly one on a lot today — it is
 * the world's gift and cannot be boxed — so this costs nothing and is written this way so that
 * the day a second one exists the errand does not march past it to the one that happens to have
 * the lower id.
 *
 * A world with no bin at all returns the direct command and lets the sim refuse it. Inventing
 * an errand with no destination would put a walk in the trace that can never complete.
 */
function standErrand(view: WorldView, direct: Command, item: number, count: number): Command {
  let nearest: MachineView | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < view.machines.length; i++) {
    const machine = view.machines[i]!;
    if (machine.kind !== MachineKind.SellBin) continue;
    if (machineWithinReach(view, machine)) return direct;
    const dx = view.player.xSub - machine.tileX * SUBTILE;
    const dy = view.player.ySub - machine.tileY * SUBTILE;
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = machine;
    }
  }

  if (nearest === null) return direct;
  return {
    type: 'WalkAndAct',
    action: IntentAction.Buy,
    tileX: nearest.tileX,
    tileY: nearest.tileY,
    item,
    count,
  };
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
 * The most valuable stack the bin will actually take.
 *
 * GATED ON `slot.sellable`, WHICH IS DATA, not on a list of item ids kept over here. The bin
 * refuses seeds — plan §4's anti-softlock floor is that a harvested potato hands a seed back,
 * and a bin that bought seeds at the same price the stand sells them would turn a misclick into
 * a world that can no longer plant — and it refuses boxed machines, which are scrapped from the
 * inventory panel at 40% of their invoice rather than sold at a list price they do not have.
 * Both facts are already projected onto every row (`InventoryView.sellable`), so this asks the
 * sim rather than re-deriving it: the old hard-coded `PotatoSeed` check was right about one of
 * the four seeds in the game and would have built a refused `SellItem` for the other three.
 */
export function bestSellable(view: WorldView): { item: ItemId; count: number } | null {
  let best: { item: ItemId; count: number } | null = null;
  let bestValue = 0;
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.sellable !== 1 || slot.count <= 0) continue;
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
      // No chevron on a belt run, and that is the point of the chevron. A belt's direction is
      // the direction it was dragged and R does not touch it (item 052's constraints say so
      // outright), so the shape that means "R turns this" must never appear on one.
      dir: Direction.None,
    };
  }

  const inField = tilesInsideField(view, bounds);
  if (drag.tool === ToolMode.EraseZone) {
    const zoneId = zoneIdAt(view, drag.anchor.tileX, drag.anchor.tileY);
    return {
      ...bounds,
      tone: zoneId > 0 && inField > 0 ? 'erase' : 'blocked',
      label: zoneId > 0 ? `− ${inField} tiles from zone ${zoneId}` : 'start on a zoned tile',
      dir: Direction.None,
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
    dir: Direction.None,
  };
}

/**
 * The band over an arm the cursor is on: which way it points, and whether R will be obeyed.
 *
 * THIS IS THE AFTER-PLACEMENT HALF OF "MAKE ROTATION LEGIBLE". The ghost gets a chevron so the
 * player can see the arm turn before it exists; this is the same chevron on the arm that does,
 * so the answer to "which way is this thing facing" is the same shape in both cases. It also
 * carries the reach refusal, which is the whole reason it is worth drawing under the Hand:
 * red before the press beats nothing after it.
 */
function grabberBand(hover: HoverTile, grabber: { dir: number; withinReach: boolean }): BandState {
  return {
    x: hover.tileX,
    y: hover.tileY,
    w: 1,
    h: 1,
    tone: grabber.withinReach ? 'zone' : 'blocked',
    label: grabber.withinReach
      ? `arm ${arrow(grabber.dir)} · R turns it`
      : `arm ${arrow(grabber.dir)} · too far to turn`,
    dir: grabber.dir,
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
    label: isGrabber ? `${TOOL_INFO[tool].label} ${arrow(placeDir)} · R` : TOOL_INFO[tool].label,
    // The fix for the complaint that started item 052: rotating before placement "technically
    // worked", but the only feedback was this label's arrow, which is a character in a string
    // and reads as nothing happening. The chevron is the same fact drawn as a shape that
    // physically turns under the cursor.
    dir: isGrabber ? placeDir : Direction.None,
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

/** Takes a plain number: `GrabberView.dir` crosses the view boundary unbranded (§12). */
function arrow(dir: number): string {
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
