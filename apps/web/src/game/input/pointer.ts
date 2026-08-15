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
  TillMode,
  beltSpec,
  listPriceCents,
  machineSpec,
} from '@snack/sim';

import { formatCents, formatCentsWhole } from '../../format/money';

import type { BandCell, BandState, BandTone } from './chrome';
import type { HoverTile, InputHost } from './context';
import {
  beltCommandFor,
  elbowBetween,
  eraseCommandFor,
  paintCommandFor,
  rectBetween,
  runBounds,
  runLength,
  runTiles,
  zoneIdAt,
} from './gesture';
import type { DragRun, RectRun, TilePoint } from './gesture';
import type { PanelRequest } from './panels';
import { requestPanel } from './panels';
import {
  beltAtView,
  grabberAtView,
  machineWithinReach,
  parcelOrigin,
  pipeAtView,
  screenToTile,
  tileAtView,
  tileWithinReach,
} from './picking';
import { teardownPlan } from './teardown';
import type { InputSystem } from './system';
import {
  TOOL_INFO,
  ToolMode,
  V01_CROP,
  gestureFor,
  toolBeltTier,
  toolCoverageRadius,
  toolCoverageVerb,
  toolFootprint,
  toolGrabberTier,
  toolMachineKind,
} from './tools';

interface Drag {
  pointerId: number;
  anchor: TilePoint;
  cursor: TilePoint;
  tool: ToolMode;
  /**
   * Which axis the belt run leads with: false for the one the cursor moved further along,
   * true for the other. R toggles it mid-drag.
   *
   * DRAG STATE, NOT TOOL STATE, so it resets with every press. A player who flipped one
   * corner is not asking for every corner after it to come out backwards — and the ghost
   * shows the answer before the release either way, so there is nothing to remember.
   */
  flipped: boolean;
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

  /**
   * R during a belt drag: swap which axis the run leads with.
   *
   * Returns false when there is nothing to flip — no drag, or a drag whose tool does not lay
   * an L — so `InputSystem.rotate()` can fall through to R's other meanings without knowing
   * what a belt run is. Emits NOTHING: the corner is part of a gesture that has not been
   * released yet, and an in-progress band is renderer state that never enters the trace.
   */
  flipDragAxis(): boolean {
    const drag = this.drag;
    if (drag === null || toolBeltTier(drag.tool) === null) return false;
    drag.flipped = !drag.flipped;
    return true;
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
      if (panel !== null) {
        requestPanel(panel);
        return;
      }
      // STILL nothing — so the click is a place, not a job, and the farmer just goes there
      // ([[070]]). Strictly a fallback: it runs only after the tool's verb and the counter
      // both declined, so every click that had a meaning keeps exactly that meaning.
      const walk = walkFallback(view, tile);
      if (walk !== null) this.host.queue.push(walk);
      return;
    }

    this.drag = { pointerId: event.pointerId, anchor: tile, cursor: tile, tool, flipped: false };
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

    // ONE COMMAND FOR EVERY BUILDING GESTURE, AND THAT IS STILL THE RULE. A forty-tile paint,
    // a thirty-tile pipe run and a belt run that turns a corner are one entry each. A gesture
    // that formed nothing meaningful — an erase started on bare soil — appends nothing, which
    // is the same outcome as cancelling and is deliberately not a special case in the trace.
    //
    // TEARDOWN IS THE ONE THAT RETURNS SEVERAL, because it is several removals rather than one
    // decision; the argument is written out in full at the top of `teardown.ts`.
    const commands = dragCommands(view, drag, this.system.zoneCrop);
    for (let i = 0; i < commands.length; i++) this.host.queue.push(commands[i]!);
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
    // A belt tool advertises R because a belt run can bend now and R chooses which way
    // ([[059]]). Advertised on the ARMED TOOL rather than only mid-drag, so the player finds
    // out before committing to a corner instead of during one.
    if (toolBeltTier(tool) !== null) return true;
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
    // The deed band outlines a whole parcel, so it outranks the arm-under-the-cursor rule for
    // the same reason a machine ghost does: the player is aiming at sixteen tiles a side, and
    // a one-tile chevron under that is answering a question nobody asked.
    if (tool === ToolMode.BuyDeed) return deedBand(view, hover);

    // The teardown ghost outranks the arm-under-the-cursor band, and has to: an arm is one of
    // the four things this tool takes, so "arm → · R turns it" under a cursor that is about to
    // rip it out would be the wrong sentence about the right object. It outlines the WHOLE
    // thing under the cursor — all four tiles of a Fryer, all sixteen of a belt — because that
    // is what one click removes.
    if (tool === ToolMode.Deconstruct) {
      return teardownBand(view, { x: hover.tileX, y: hover.tileY, w: 1, h: 1 });
    }

    // The till's hover ghost is its drag band at 1×1: what THIS tile would become, in the
    // mode the anchor-to-be would pick, before the button ever goes down.
    if (tool === ToolMode.Till) {
      const bounds = { x: hover.tileX, y: hover.tileY, w: 1, h: 1 };
      return tillBand(view, bounds, tillModeFor(view, { tileX: hover.tileX, tileY: hover.tileY }));
    }

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

  // The deed names the PARCEL under the cursor rather than the tile, because that is what is
  // being bought. Every refusal — already owned, not adjacent, not affordable — is the sim's
  // (§12); the command is built for any parcel on the map and the reducer decides.
  if (tool === ToolMode.BuyDeed) {
    return query.parcel < 0 ? null : { type: 'BuyDeed', parcel: query.parcel };
  }

  switch (tool) {
    case ToolMode.Water:
      // THE CAN REFILLS ON THE SAME TOOL, per [[009]]'s ruling: clicking the water with the
      // watering can armed is a dip, not a pour. No separate refill tool exists and none
      // should — the can is one object and the tile under the cursor says which verb it
      // means. The sim re-checks everything (`applyRefillCan` never fails AT a shore, and
      // refuses a full can rather than consuming the click).
      if (reservoirAtTile(view, tile.tileX, tile.tileY)) return { type: 'RefillCan' };
      // A world with NO water at all is the one place the refill is legal anywhere (§4's
      // guarantee is about the can, not the pond) — and the one place the water-tile gate
      // above could never fire. An empty can there dips on the next pour-click instead of
      // dead-clicking forever; a can with pours left keeps pouring.
      if (view.reservoirs.length === 0 && view.player.canCharges === 0) {
        return { type: 'RefillCan' };
      }
      return { type: 'WaterTile', tileX: tile.tileX, tileY: tile.tileY };
    // The repair kit: one click spends one kit on a spot and services the cell around it.
    // The command carries the tile, never a machine id — plan §4's "one trip services a
    // cell" is the sim's shape, and this side only aims it.
    case ToolMode.UseRepairKit:
      return { type: 'UseRepairKit', tileX: tile.tileX, tileY: tile.tileY };
    case ToolMode.Plant:
      return { type: 'PlantTile', tileX: tile.tileX, tileY: tile.tileY, crop: V01_CROP };
    case ToolMode.Harvest:
      return { type: 'HarvestTile', tileX: tile.tileX, tileY: tile.tileY };
    case ToolMode.Hand:
      return query.machine === null ? null : handCommand(view, query.machine);
    // No `Deconstruct` case any more, and its absence is the change [[060]] made: teardown is
    // a rect gesture now, so it never reaches this function. Its verb lives in `teardown.ts`,
    // which dispatches on all four things a tile can hold rather than on machines alone, and a
    // plain click gets there as a one-tile drag.
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
 * A click that means NOTHING ELSE walks the farmer there ([[070]]).
 *
 * THE LAST RUNG OF THE CLICK DISPATCH, and the order is the contract: the tool's verb
 * (`primaryCommand`) is asked first, the counter (`counterPanelFor`) second, and only a
 * click both declined reaches here — so this adds a meaning to dead clicks and never
 * reinterprets a live one. In practice that is the Hand over ground with no machine on it;
 * the other click-gesture verbs always form a command and let the sim judge it.
 *
 * WHAT REFUSES, input-side: a machine tile (the Hand declining it means "nothing to do",
 * not "go stand on it"), a crop tile (the same — the Hand has no crop verb, and stomping
 * toward a plant you clicked by accident reads as the game mishearing you), water, unowned
 * land, and off-world — the same standability the sim's `intentTargetSubtiles` enforces,
 * mirrored so the click is a quiet no rather than a refused command. A click already within
 * arm's reach emits nothing: the errand would complete on the spot, and a trace entry that
 * does nothing is noise.
 *
 * The command is the EXISTING `WalkAndAct` with `IntentAction.Walk` (17) — arrival IS
 * completion, no new command type, no sound, no flash; the walk itself is the feedback.
 * A second click mid-walk retargets through the sim's ordinary errand replacement.
 */
export function walkFallback(view: WorldView, tile: HoverTile): Command | null {
  const query = tileAtView(view, tile.tileX, tile.tileY);
  if (!query.insideWorld || !query.owned) return null;
  if (query.machine !== null || query.crop !== 0) return null;
  if (reservoirAtTile(view, tile.tileX, tile.tileY)) return null;
  if (tileWithinReach(view, tile.tileX, tile.tileY)) return null;
  return {
    type: 'WalkAndAct',
    action: IntentAction.Walk,
    tileX: tile.tileX,
    tileY: tile.tileY,
    item: 0,
    count: 0,
  };
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

    // The refill carries no tile of its own — "fill the can" is a fact about the player, not
    // about a tile — so the errand is aimed at the WATER TILE THE PLAYER CLICKED. The sim
    // re-aims the walk at the nearest point of that reservoir's shoreline
    // (`intentTargetSubtiles`), so arrival and "can actually dip" are the same fact; this
    // side only needs to know whether the click is already within arm's reach. The clicked
    // tile IS part of the reservoir (see `primaryCommand`), so tile-reach implies water-reach.
    case 'RefillCan':
      // Pondless world: the refill is legal from anywhere and the walk-to errand would have
      // no shoreline to aim at (`intentTargetSubtiles` returns null and the errand dies), so
      // the direct command is both sufficient and the only one that works.
      if (view.reservoirs.length === 0) return direct;
      return tileErrand(view, direct, IntentAction.RefillCan, tile.tileX, tile.tileY, 0, 0);

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

/**
 * What a completed drag becomes. Empty for "nothing to say".
 *
 * Returns a LIST because one gesture in the game is genuinely many removals — see the header
 * of `teardown.ts`. Every other branch here returns exactly one command or none, and the
 * plural signature is what keeps that visible rather than hiding it behind a helper.
 */
export function dragCommands(view: WorldView, drag: Drag, crop: CropId): Command[] {
  const run = runFor(drag);

  if (run.kind === 'rect') {
    if (drag.tool === ToolMode.Deconstruct) return teardownCommands(view, run);
    // The till ([[066]]): one drag is ONE `TillTile`, and the ANCHOR picked the mode at the
    // press — grass anchor tills, farmland anchor un-tills — the same commit-at-the-press
    // rule zone painting uses, so the band can label itself correctly the whole way. The
    // command is formed and sent even when every tile in it will be skipped; the sim is the
    // authority and refuses a no-op drag untraced (§12).
    if (drag.tool === ToolMode.Till) {
      return [
        {
          type: 'TillTile',
          rect: { x: run.x, y: run.y, w: run.w, h: run.h },
          mode: tillModeFor(view, drag.anchor),
        },
      ];
    }
    const command =
      drag.tool === ToolMode.EraseZone
        ? eraseCommandFor(view, drag.anchor, run)
        : paintCommandFor(view, drag.anchor, run, crop);
    return command === null ? [] : [command];
  }

  const tier = toolBeltTier(drag.tool);
  if (tier === null) return [];
  return [beltCommandFor(tier, run)];
}

/**
 * The teardown drag's commands, with the single-machine case still able to walk.
 *
 * A CLICK IS A 1×1 DRAG, so this is also the path a plain click on a Fryer takes — and a
 * click on a machine across the lot has walked there since [[054]]. Losing that to a gesture
 * change would be a silent regression: the command is not reach-gated in the input layer, so
 * it would simply be built, sent, and refused. Anything larger than one machine does not
 * walk, because the sim holds ONE errand at a time and there is no honest way to walk to six
 * things — the ghost reddens what is out of reach instead, and the ribbon says so.
 */
function teardownCommands(view: WorldView, rect: RectRun): Command[] {
  const plan = teardownPlan(view, rect);
  const lone = plan.loneMachineTile;
  if (lone !== null && plan.commands.length === 1) {
    return [reachAdjusted(view, lone, plan.commands[0]!)];
  }
  return plan.commands;
}

function runFor(drag: Drag): DragRun {
  return gestureFor(drag.tool) === 'line'
    ? elbowBetween(drag.anchor, drag.cursor, drag.flipped)
    : rectBetween(drag.anchor, drag.cursor);
}

// --- the till ----------------------------------------------------------------------------

/**
 * Which way a till drag converts, decided by its ANCHOR: press on farmland and the drag
 * un-tills, press on anything else and it tills. Exported for the pointer tests.
 */
export function tillModeFor(view: WorldView, anchor: TilePoint): TillMode {
  return tileAtView(view, anchor.tileX, anchor.tileY).isField ? TillMode.Untill : TillMode.Till;
}

/**
 * Would the sim's `applyTillTile` convert this tile, in this mode? The ghost's per-tile
 * truth, mirroring the reducer's own skip list — owned ground only, `tileOccupied` (which
 * over there is machines, belts, arms, pipes and water in one question), farmland keeps a
 * planted or compost-bearing tile, and a tile already in the asked-for state is a skip.
 * A hint, never a gate (§12): the command goes regardless; this only colours the preview.
 */
export function tillConverts(
  view: WorldView,
  tileX: number,
  tileY: number,
  mode: TillMode,
): boolean {
  const query = tileAtView(view, tileX, tileY);
  if (!query.insideWorld || !query.owned) return false;
  if (query.machine !== null) return false;
  if (reservoirAtTile(view, tileX, tileY)) return false;
  if (beltAtView(view, tileX, tileY) !== null) return false;
  if (grabberAtView(view, tileX, tileY) !== null) return false;
  if (pipeAtView(view, tileX, tileY) !== null) return false;
  if (mode === TillMode.Till) return !query.isField;
  return query.isField && query.crop === 0 && query.compost === 0;
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

/**
 * Is this tile open water? Rect containment against the projected reservoirs — the water is
 * the one terrain the tile query does not carry, and the reservoir list is tiny (one pond
 * today). Deliberately the tile itself and not "adjacent to water": a click on the BANK still
 * means "water this dirt", and a bank tile is exactly where a thirsty crop can be standing.
 * Exported for the pointer tests.
 */
export function reservoirAtTile(view: WorldView, tileX: number, tileY: number): boolean {
  for (let i = 0; i < view.reservoirs.length; i++) {
    const r = view.reservoirs[i]!;
    if (
      tileX >= r.tileX &&
      tileX < r.tileX + r.tilesWide &&
      tileY >= r.tileY &&
      tileY < r.tileY + r.tilesHigh
    ) {
      return true;
    }
  }
  return false;
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
    const tiles = runTiles(run);
    const length = runLength(run);
    const cost = perTile * length;
    // THE WHOLE RUN GOES RED TOGETHER, and with a bend that is no longer merely tidy — it is
    // the truth. `applyPlaceBelt` judges both legs before laying either, so one tile crossing
    // the fence at the far end of the second leg refuses the near leg too. Colouring per tile
    // here would show a mostly-green L that builds nothing.
    const clear = tilesAreClear(view, tiles);
    const tone = clear && view.moneyCents >= cost ? 'belt' : 'blocked';
    const bent = run.turnLengthTiles > 0;
    return {
      ...bounds,
      tone,
      // The L is painted tile by tile rather than as its bounding box: a bent run's box is
      // mostly ground the belt never touches, and a preview that covers it is a preview that
      // lies about where the belt is going.
      cells: tiles.map((tile) => ({ x: tile.tileX, y: tile.tileY, tone })),
      // THE PENNIES ARE THE POINT ON A BELT RUN. Basic belt is 150 cents a tile, so an
      // odd-length run costs a round number of dollars and fifty cents, and this label used to
      // round it — a three-tile run cost $4.50 and advertised "$5", which is a quote the tone
      // beside it can contradict: `moneyCents >= cost` is exact, so $4.60 in the pouch drew a
      // green band under a label saying five dollars. It quotes the charge now.
      //
      // AND ON A BENT RUN THE LABEL CARRIES THE RULE. Which axis leads is a choice the player
      // has to be able to find, and the only place it can be found while the button is still
      // down is here — so the tag says both arrows in order and says what flips them.
      label: bent
        ? `${length} tiles · ${formatCents(cost)} ${arrow(run.dir)}${arrow(run.turnDir)} · R flips the corner`
        : `${length} tile${length === 1 ? '' : 's'} · ${formatCents(cost)} ${arrow(run.dir)}`,
      // No chevron on a belt run, and that is the point of the chevron. A belt's direction is
      // the direction it was dragged and R does not turn a placed one (item 052's constraints
      // say so outright), so the shape that means "R turns this" must never appear on one —
      // including now that R does something else entirely while a belt drag is in progress.
      dir: Direction.None,
    };
  }

  if (drag.tool === ToolMode.Deconstruct) return teardownBand(view, bounds);
  if (drag.tool === ToolMode.Till) return tillBand(view, bounds, tillModeFor(view, drag.anchor));

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
 * The teardown band: every object the rectangle would take, toned by what happens to it.
 *
 * PER-TILE COLOURING IS RIGHT HERE AND WRONG ON A BELT RUN, and the difference is the whole
 * reason both bands exist. A belt run is refused WHOLE, so one bad tile reddens all of them —
 * colouring per tile there would advertise a mostly-green L that builds nothing. A teardown is
 * N independent removals, so the tiles genuinely disagree: this belt is coming up for cash,
 * that Fryer is going in the bag, and the jammed one over there is going nowhere.
 *
 * AN EMPTY RECTANGLE KEEPS THE PLAIN OUTLINE. With no cells the chrome would draw nothing at
 * all, and a drag with no visible band is not a drag — so bare ground gets the rectangle, in
 * the refusal tone, saying there is nothing in it.
 */
function teardownBand(view: WorldView, bounds: Bounds): BandState {
  const plan = teardownPlan(view, bounds);
  if (plan.cells.length === 0) {
    return { ...bounds, tone: 'blocked', label: plan.label, dir: Direction.None };
  }
  return {
    ...bounds,
    // The summary tone is the majority outcome, and it only shows through where a cell does
    // not: the tag reads it, the cells carry the real answer per object.
    tone: plan.boxCount > 0 && plan.refundCents === 0 ? 'box' : 'erase',
    cells: plan.cells,
    label: plan.label,
    dir: Direction.None,
  };
}

/**
 * The till band: exactly the tiles this drag would convert, filled; everything the sim will
 * skip — machines, water, crops, ground already in the asked-for state — shows through.
 *
 * PER-TILE, LIKE TEARDOWN AND FOR THE SAME REASON: a till is N independent conversions and
 * the tiles genuinely disagree, so a single fill would have to lie about the sprinkler
 * standing mid-rectangle. Green (`zone`) going to farmland, red (`erase`) going back to
 * grass — the erase tone because un-tilling releases ground exactly as un-zoning does. An
 * empty result keeps the plain outline in the refusal tone, like a teardown over bare dirt.
 */
function tillBand(view: WorldView, bounds: Bounds, mode: TillMode): BandState {
  const tone: BandTone = mode === TillMode.Till ? 'zone' : 'erase';
  const cells: BandCell[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (tillConverts(view, x, y, mode)) cells.push({ x, y, tone });
    }
  }

  if (cells.length === 0) {
    return {
      ...bounds,
      tone: 'blocked',
      label: mode === TillMode.Till ? 'nothing here to till' : 'nothing to return to grass',
      dir: Direction.None,
    };
  }

  const n = cells.length;
  return {
    ...bounds,
    tone,
    cells,
    label:
      mode === TillMode.Till
        ? `till ${n} tile${n === 1 ? '' : 's'}`
        : `${n} tile${n === 1 ? '' : 's'} → grass`,
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

/**
 * The parcel under the cursor, outlined whole, with its price on the tag.
 *
 * THE BAND IS THE PRICE TAG AT THE MOMENT OF BUYING, and the sign standing on the parcel is
 * the one that is there before the player ever arms the tool (`chrome.ts`). Both read the same
 * `land.nextPriceCents`, so they cannot disagree about what a deed costs.
 *
 * They could still disagree about how to SAY it, and did: this label rounded and grouped via
 * `toLocaleString`, the build-menu row rounded and did not group, and the ribbon in
 * `render/index.ts` printed the pennies. Every deed price is a whole number of dollars, so all
 * three were correct and only one could be right. They share `format/money.ts` now.
 */
function deedBand(view: WorldView, hover: HoverTile): BandState | null {
  const query = tileAtView(view, hover.tileX, hover.tileY);
  if (query.parcel < 0) return null;

  const origin = parcelOrigin(view, query.parcel);
  const bounds = {
    x: origin.tileX,
    y: origin.tileY,
    w: view.land.parcelTiles,
    h: view.land.parcelTiles,
  };
  const price = view.land.nextPriceCents;
  const buyable = view.land.buyable.includes(query.parcel);
  const affordable = price >= 0 && view.moneyCents >= price;

  return {
    ...bounds,
    tone: buyable && affordable ? 'zone' : 'blocked',
    label: query.owned
      ? 'already yours'
      : !buyable
        ? 'buy the parcel next to it first'
        : affordable
          ? `land deed · ${formatCentsWhole(price)}`
          : `need ${formatCentsWhole(price)}`,
    dir: Direction.None,
  };
}

/**
 * The footprint the armed placement tool would occupy under the cursor.
 *
 * Exported for the tests, which drive it directly rather than through `band()` — the method
 * needs a host, and this function needs only a view and a tile.
 */
export function ghostBand(
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
  // A machine whose spec says so may stand ON farmland ([[067]]) — the sprinkler family,
  // read off `fieldPlaceable` exactly as the sim's footprint rule reads it, never by kind.
  const kind = toolMachineKind(tool);
  const fieldPlaceable = kind !== null && (machineSpec(kind)?.fieldPlaceable ?? false);
  const farmReason = farmRefusal(view, bounds, fieldPlaceable);
  const free = farmReason === '' && footprintClear(view, bounds) && view.moneyCents >= cost;
  const isGrabber = toolGrabberTier(tool) !== null;
  const tone: BandTone = free ? 'zone' : 'blocked';

  // A MACHINE WITH AN AREA OF EFFECT SHOWS IT BEFORE THE CLICK (item 011: the sprinkler's
  // real coverage, not its one-tile footprint). Derived from the spec's radius, never
  // hardcoded, and the geometry is the sim's own: `advanceSprinkler` waters every tile
  // within Chebyshev `radius` of the machine's anchor tile — the tile under the cursor —
  // so these cells are exactly the tiles the machine will wet. The footprint keeps the
  // ghost's legality tone; the surrounding coverage is drawn in `mist`, which never turns
  // red, because "where the water lands" is a fact about the machine, not a refusal.
  const radius = toolCoverageRadius(tool);
  if (radius > 0) {
    const cells: BandCell[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = hover.tileX + dx;
        const y = hover.tileY + dy;
        const inFootprint =
          x >= bounds.x && x < bounds.x + bounds.w && y >= bounds.y && y < bounds.y + bounds.h;
        cells.push({ x, y, tone: inFootprint ? tone : 'mist' });
      }
    }
    // A footprint wider than the coverage square is nothing in this game today, but the day
    // it exists its tiles must not silently vanish from their own ghost.
    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
        if (Math.max(Math.abs(x - hover.tileX), Math.abs(y - hover.tileY)) > radius) {
          cells.push({ x, y, tone });
        }
      }
    }
    const span = radius * 2 + 1;
    const left = Math.min(bounds.x, hover.tileX - radius);
    const top = Math.min(bounds.y, hover.tileY - radius);
    return {
      x: left,
      y: top,
      w: Math.max(bounds.x + bounds.w, hover.tileX + radius + 1) - left,
      h: Math.max(bounds.y + bounds.h, hover.tileY + radius + 1) - top,
      tone,
      cells,
      // "waters" for the sprinklers, "services" for the Maintenance Station — the verb comes
      // off the spec's role (`toolCoverageVerb`) so the preview never claims the wrong deed.
      // A farm refusal outranks the coverage boast: the one fact a red band owes the player
      // is WHY ([[067]]), and "waters 5×5" is not an answer to "why not here".
      label:
        farmReason !== ''
          ? `${TOOL_INFO[tool].label} · ${farmReason}`
          : `${TOOL_INFO[tool].label} · ${toolCoverageVerb(tool)} ${span}×${span}`,
      dir: Direction.None,
    };
  }

  return {
    ...bounds,
    tone,
    label:
      farmReason !== ''
        ? `${TOOL_INFO[tool].label} · ${farmReason}`
        : isGrabber
          ? `${TOOL_INFO[tool].label} ${arrow(placeDir)} · R`
          : TOOL_INFO[tool].label,
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

/**
 * Farm tiles inside a paint rectangle — counted PER TILE, because farmland has been
 * non-rectangular since the till tool ([[066]]) and intersecting the bounding box counts
 * holes as field. The rect is span-capped (`ZONE_PAINT_MAX_SPAN`), so this is at most a few
 * hundred binary-searched lookups per frame while a drag is live.
 */
function tilesInsideField(view: WorldView, bounds: Bounds): number {
  let count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (tileAtView(view, x, y).isField) count += 1;
    }
  }
  return count;
}

/**
 * A hint, never a gate. Belts refuse to sit on the field or on an occupied tile in the
 * sim; this mirrors the cheap half of that so the band turns red before the click rather
 * than after. Belts and arms already down are not in `TileQuery`, so a run laid across one
 * still shows green and is still correctly refused — the sim is the authority (§12).
 *
 * TAKES THE RUN'S TILES RATHER THAN ITS BOX, since a run can now bend: an L's bounding
 * rectangle contains ground the belt never touches, and a machine standing in the empty
 * quarter of it would have reddened a run that is in fact perfectly legal.
 */
function tilesAreClear(view: WorldView, tiles: readonly TilePoint[]): boolean {
  for (let i = 0; i < tiles.length; i++) {
    const query = tileAtView(view, tiles[i]!.tileX, tiles[i]!.tileY);
    // Ownership is checked here as well as in the sim, because a run dragged over the fence
    // is refused WHOLE (`applyPlaceBelt`) — so the band has to go red for the whole run
    // rather than for the two tiles that crossed it.
    if (!query.insideWorld || !query.owned || query.isField || query.machine !== null) {
      return false;
    }
  }
  return true;
}

function footprintClear(view: WorldView, bounds: Bounds): boolean {
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const query = tileAtView(view, x, y);
      if (!query.insideWorld || !query.owned || query.machine !== null) return false;
    }
  }
  return true;
}

/**
 * Why a footprint's overlap with FARMLAND refuses, phrased for the tag — or `''` when the
 * farmland raises no objection ([[067]]).
 *
 * Mirrors the sim's `footprintFree` exactly: a machine whose spec is not `fieldPlaceable`
 * may not touch a farm tile at all, and a flagged one may take only EMPTY farm tiles — a
 * crop or compost refuses per tile, because nothing is silently destroyed (house rule).
 * Every input is view-readable (`TileQuery.isField`/`crop`/`compost` + the spec flag); the
 * sim re-checks all of it and this string only explains the red (§12).
 */
function farmRefusal(view: WorldView, bounds: Bounds, fieldPlaceable: boolean): string {
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const query = tileAtView(view, x, y);
      if (!query.isField) continue;
      if (!fieldPlaceable) return 'not on farmland';
      if (query.crop !== 0) return 'a crop is in the way';
      if (query.compost > 0) return 'compost in the way';
    }
  }
  return '';
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
