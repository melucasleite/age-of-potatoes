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

import type { Command, MachineView, WorldView } from '@snack/sim';
import {
  CropId,
  Direction,
  IntentAction,
  ItemId,
  LIQUID_SPECS,
  LampState,
  LiquidId,
  MachineKind,
  MachineRole,
  PIPE_PRICE_CENTS_PER_TILE,
  PortFlow,
  SUBTILE,
  TillMode,
  beltSpec,
  cropSpec,
  harvestItemFor,
  itemSpec,
  liquidSpec,
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
import type { DragRun, LineRun, RectRun, TilePoint } from './gesture';
import { grabberCardTarget } from './grabber-card';
import { grabberClicked } from './grabber-panel';
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
  DEFAULT_CROP,
  TOOL_INFO,
  ToolMode,
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

/**
 * A paint hold in progress ([[072]]): the left button is down on a `paint` tool, and every
 * NEW tile the cursor crosses gets the verb once. See `holdCommand` for the rules; this is
 * only the memory they need. Renderer-side state, never traced — what enters the trace is
 * the ordinary per-tile commands the hold emits.
 */
export interface HoldState {
  pointerId: number;
  tool: ToolMode;
  /**
   * The last CLIENT coordinates the pointer reported, kept so the per-frame step can
   * re-project them through the live camera. The mouse can sit perfectly still while WASD
   * walks the world underneath it — the camera is the player's body — so "which tile is
   * under the cursor" changes without a single pointer event, and a hold that only listened
   * to `pointermove` would go quiet the moment the player started walking the row.
   */
  clientX: number;
  clientY: number;
  /**
   * Tiles this hold has already fired on, as `"x,y"` keys, seeded with the anchor (the
   * press edge already dispatched it as an ordinary click). Once per tile per hold: dragging
   * back over a just-planted tile does not double-plant, and a tile that legally wants the
   * verb again mid-hold still fires only once, for predictability. Cleared by existing.
   */
  fired: Set<string>;
  /** `view.tick` when `watersEmitted` was last reset — see `holdCommand`. */
  viewTick: number;
  /** WaterTile commands emitted since the view last advanced, so the charge budget is live. */
  watersEmitted: number;
  /** The empty-can refusal has been shown this dry spell. One tell, not one per tile. */
  canRefusalTold: boolean;
  /**
   * The crop this hold sows, frozen at the press ([[103]]).
   *
   * FROZEN RATHER THAN READ LIVE, which is the rule the till's anchor already establishes: the
   * anchor picks the mode and the whole drag keeps it. A player who presses `C` halfway along a
   * row is not asking for the second half of one gesture to come up a different plant, and the
   * band under the cursor showed which crop before the button went down.
   */
  crop: CropId;
}

export class PointerInput {
  private attached = false;
  private drag: Drag | null = null;
  private hold: HoldState | null = null;
  /**
   * The out-of-reach work queue ([[074]]): tiles a paint hold crossed beyond arm's length,
   * walked to and worked one errand at a time by `stepQueue`. Created on every paint press
   * and deliberately NOT cleared on release — surviving the button is the point. Cleared by
   * the cancellation matrix: Esc, a new gesture, arming another tool, WASD after release.
   */
  private queue: WorkQueueState | null = null;
  /** Wall-clock deadline for the transient "already soaked" tell ([[081]]). */
  private soakedTellUntil = 0;
  /** The current gesture's soaked flag has been turned into a visible tell already. */
  private soakedAck = false;
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
    this.hold = null;
    this.queue = null;
    this.panReserved = false;
    this.hover = null;
    this.host.setHover(null);
  }

  /** Esc, and anything else that means "forget it". Emits nothing, by definition. */
  cancelDrag(): void {
    this.drag = null;
    this.hold = null;
    // The queue dies with the gesture ([[074]]'s matrix: Esc and right-click cancel it).
    this.queue = null;
    this.panReserved = false;
  }

  /**
   * A paint hold counts: Esc mid-row means "stop painting", not "disarm the tool". So does
   * a queue still working after release — Esc calls the farmer off, not the tool away.
   */
  get dragging(): boolean {
    return this.drag !== null || this.hold !== null || this.queueWorking;
  }

  /** The queue exists and still has anything left to do. */
  private get queueWorking(): boolean {
    return this.queue !== null && !workQueueDone(this.queue);
  }

  /**
   * Once per frame from `InputSystem.update()`, after the camera is applied. This is what
   * makes HOLDING WHILE WALKING work: the stored client coordinates are re-projected through
   * the transform that actually reached the display, so tiles scroll under a stationary
   * cursor as the farmer walks, enter reach, and fire — the long-row loop. The queue pump
   * runs after the hold for the same reason: both read the frame's live reach. A frame with
   * neither in progress is two null checks.
   */
  update(): void {
    this.stepHold();
    this.stepQueue();
    this.syncSoakedTell();
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
    const hold = this.hold;
    if (hold !== null && event.pointerId === hold.pointerId) {
      hold.clientX = event.clientX;
      hold.clientY = event.clientY;
      // Step on the move edge as well as per frame — pointer events can outpace the rAF
      // loop, and the extra samples catch tiles a fast drag would otherwise cross between
      // frames. A sample that lands on an already-fired tile costs one Set lookup.
      this.stepHold();
    }
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

    /*
      Right button: cancel a drag, a paint hold, or a working queue — OTHERWISE TEAR DOWN
      WHAT IS UNDER THE CURSOR ([[129]]).

      THE CANCEL RUNG STAYS FIRST, AND THAT ORDER IS THE WHOLE SAFETY ARGUMENT. It is the same
      reasoning as the Escape cascade in `escape.ts`: a half-drawn belt run is the thing the
      player wants back before anything else, and a teardown that ate the cancel press would
      DESTROY work in the exact moment the player asked to undo it. Cancel is not merely
      higher priority than teardown; it is the one rung that must never be reachable past.

      THE VERB THIS REPLACED WAS MAINTENANCE, and it did not lose its home — it moved to the
      machine's own card, first row, with its price on the button (`derive-service.ts`). The
      owner's ruling, verbatim: *"Make it teardown, maintenance by bots or clicking the machine
      has a maintenance at the top with a dollar cost."* Bots were already the automated route
      ([[034]], [[039]], [[090]]); the card is the manual one. Nothing about repair is a
      keybinding any more, deliberately.

      ONE PICKING RULE, NOT TWO — `teardownCommands` IS THE ARMED TOOL'S OWN CLICK PATH, called
      with the same 1×1 rect a left-click on the armed tool builds. Not a parallel
      implementation that agrees today: the identical function, so "what is under the cursor"
      has exactly one answer on a belt/pipe crossing ([[120]]) and the two gestures cannot
      drift into deleting different objects. It carries `loneMachineTile`'s walk-to errand with
      it, which is how `reachAdjusted` behaviour survives the swap — a right-click on a Fryer
      across the lot still walks there, exactly as the maintenance press used to.

      SAFE ON A NAKED BUTTON BECAUSE NOTHING IS DESTROYED ([[054]]): a machine goes into the bag
      as a box carrying its dials and its wear, and a belt, arm or pipe is refunded in full. A
      misclick costs a walk and a re-place, never a rebuild — which is why this needs no confirm
      and gets none. The one thing with no box is the sell bin, and `teardownTargetAt` already
      ships NO COMMAND for it rather than a refusal.
    */
    if (event.button === 2) {
      if (this.drag !== null || this.hold !== null || this.queueWorking || this.panReserved) {
        this.cancelDrag();
        return;
      }
      const commands = teardownCommands(view, {
        kind: 'rect',
        x: tile.tileX,
        y: tile.tileY,
        w: 1,
        h: 1,
      });
      for (let i = 0; i < commands.length; i++) this.host.queue.push(commands[i]!);
      return;
    }

    // The camera's reserved gestures. They paint nothing, ever, in any mode — and they do
    // not cancel a working queue either: looking around is not a new work intent.
    if (event.button === 1 || this.system.spaceHeld) {
      this.panReserved = true;
      return;
    }

    if (event.button !== 0) return;

    // A new manual gesture means new intent, so whatever the last gesture queued is over
    // ([[074]]'s matrix). A paint press below replaces it with a fresh queue of its own.
    this.queue = null;

    const tool = this.host.getTool();
    const kind = gestureFor(tool);
    if (kind === 'click' || kind === 'paint') {
      // One press is one command, on the press edge — a `paint` press is EXACTLY a click,
      // including the walk-to-act wrapper ([[050]]), so single clicks keep their meaning to
      // the byte. What `paint` adds happens after this dispatch: the hold begins, and each
      // NEW tile the held cursor crosses gets the verb once (`holdCommand`) — once per TILE,
      // never per frame, which is what keeps the trace from recording the mouse.
      const command = primaryCommand(view, tile, tool, this.system.placeDir, this.system.armedCrop);
      if (command !== null) {
        const pushed = reachAdjusted(view, tile, command);
        this.host.queue.push(pushed);
        if (kind === 'paint') this.beginHold(event, view, tile, tool, command, pushed);
        return;
      }
      // Nothing to do here with this tool — which for the sell bin is not "nothing", it is
      // the other half of the counter. See `counterPanelFor`.
      const panel = counterPanelFor(view, tile, tool);
      if (panel !== null) {
        requestPanel(panel);
        return;
      }
      // AN ARM UNDER THE HAND OPENS ITS CARD ([[099]]), on the same rung and for the same
      // reason the bin opens the board: the click had no verb, and now it has the obvious
      // one. This DOES reinterpret a click that already meant something — an out-of-reach
      // arm fell through to the walk below, because a grabber is not a machine and item
      // 070's fallback only refuses machine tiles — and that is deliberate rather than
      // overlooked. Walking to an arm was a side effect of arms not being machines, never a
      // designed verb; the ground beside it still walks, and `SetGrabberFilter` is not
      // reach-gated, so there is nothing the trip would have bought.
      const arm = grabberCardTarget(view, tile, tool);
      if (arm !== 0) {
        grabberClicked(arm);
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

    // A paint hold simply ENDS on release — every command it had to say was said per tile
    // while the button was down, so the release edge emits nothing and forgets the fired
    // set. The QUEUE does not end here ([[074]]): releasing the button is how the player
    // hands the rest of the row to the farmer, so it keeps pumping until worked dry.
    const hold = this.hold;
    if (hold !== null && event.button === 0) {
      this.hold = null;
      if (this.queue !== null) this.queue.holdDown = false;
      try {
        this.host.canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* Already released, or never captured. */
      }
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
    const commands = dragCommands(view, drag, this.system.armedCrop, this.system.pickedLiquid);
    for (let i = 0; i < commands.length; i++) this.host.queue.push(commands[i]!);
  };

  private tileUnder(event: PointerEvent): HoverTile {
    return screenToTile(this.host.canvas, this.host.camera, event.clientX, event.clientY);
  }

  // --- the paint hold ([[072]]) ----------------------------------------------------------

  /**
   * The press edge of a `paint` gesture has already dispatched as a click; remember enough
   * to repeat the verb on every new tile while the button stays down. Pointer capture for
   * the same reason a drag takes it: a row that ends past the canvas edge is an ordinary
   * gesture, and losing the `pointerup` would leave the hold painting with the button up.
   *
   * The WORK QUEUE is born here too ([[074]]), seeded from what the press became: an
   * out-of-reach anchor already went out as a WalkAndAct errand, and the pump must treat it
   * as the errand in flight or its very first dispatch would replace it unworked.
   */
  private beginHold(
    event: PointerEvent,
    view: WorldView,
    anchor: HoverTile,
    tool: ToolMode,
    pressed: Command,
    dispatched: Command,
  ): void {
    this.hold = createHold(
      event.pointerId,
      event.clientX,
      event.clientY,
      view,
      anchor,
      tool,
      pressed,
    );
    this.queue = createWorkQueue(view, tool, dispatched);
    this.soakedAck = false;
    // The press's own click on a soaked tile is the sim silently refusing ([[081]]), so the
    // tell that keeps 064's anti-silence promise has to come from here.
    if (pressed.type === 'WaterTile' && tileSaturated(view, anchor.tileX, anchor.tileY)) {
      this.queue.soakedTold = true;
    }
    try {
      this.host.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is a nicety; a browser that refuses it still gets a working hold inside. */
    }
  }

  /** Re-project the held cursor through the live camera and fire on the tile if it is new. */
  private stepHold(): void {
    const hold = this.hold;
    if (hold === null) return;
    // The keyboard can re-arm mid-hold. The new tool did not get this press, so it does not
    // inherit the hold — the player re-presses, which is the same contract a click has.
    if (this.host.getTool() !== hold.tool) {
      this.hold = null;
      return;
    }
    const view = this.host.latestView();
    if (view === null) return;
    const tile = screenToTile(this.host.canvas, this.host.camera, hold.clientX, hold.clientY);
    const command = holdCommand(view, hold, tile, this.queue);
    if (command !== null) this.host.queue.push(command);
  }

  /**
   * The queue pump ([[074]]), once per frame after the hold. `pumpWorkQueue` owns the
   * rules; this owns the lifetime — a pump that reports the tool changed cancels the queue,
   * and a queue that has finished with the button up is retired so the tell clears.
   */
  private stepQueue(): void {
    const queue = this.queue;
    if (queue === null) return;
    const view = this.host.latestView();
    if (view === null) return;
    const alive = pumpWorkQueue(
      view,
      queue,
      this.host.getTool(),
      this.hold?.fired ?? null,
      this.system.manualWalkHeld,
      (command) => this.host.queue.push(command),
    );
    // The soaked flag is read BEFORE the queue can be retired below, or a wet tile skipped
    // on the queue's very last step would lose its tell with the state that carried it.
    this.syncSoakedTell();
    if (!alive || (workQueueDone(queue) && !queue.holdDown)) this.queue = null;
  }

  /**
   * A direction KEYDOWN, from the keyboard by way of the system ([[074]]'s matrix): after
   * release it cancels the queue outright — grabbing the wheel is the new intent — and
   * mid-hold it stays legal, except that the sim is about to kill any errand in flight
   * (`applySetMoveDirection` clears the intent), so an unworked target is reclaimed to the
   * head of the queue rather than silently lost.
   */
  walkKeyPressed(): void {
    const queue = this.queue;
    if (queue === null) return;
    if (!walkKeyInterruptsQueue(queue, this.host.latestView())) this.queue = null;
  }

  /**
   * The one sentence over the canvas, or `null` for silence. Read once per frame by
   * `InputSystem.update()` into the chrome's tell line.
   *
   * **THE ORDER IS THE WHOLE DESIGN.** What you are DOING outranks what you are LOOKING AT: a
   * player mid-gesture wants "planting 6 more…" and would not thank a hover readout for taking
   * the line away from it. The machine under the cursor only speaks into a silence.
   */
  statusTell(): string | null {
    const view = this.host.latestView();
    // ⚠️ THERE WAS A THIRD RUNG HERE AND [[124]] REMOVED IT. `soilTell` printed the tile's
    // fertility as `★★☆` and ranked below the machine tell because dirt is the least specific
    // thing under a cursor. Soil has no quality to report now — every tile grows the same
    // crop at the same yield forever — so the rung is gone rather than left printing `★★★`
    // at every tile on the lot, which is the shape of readout item 057 was a whole wave about.
    return this.queueTell() ?? machineTell(view, this.hover);
  }

  /**
   * The queue's own half: "planting 6 more…" while the farmer marches, the pause reason while
   * the can is dry, and a brief "already soaked" when a wet tile was skipped ([[081]]).
   */
  private queueTell(): string | null {
    if (performance.now() < this.soakedTellUntil) return 'already soaked';
    const queue = this.queue;
    if (queue === null) return null;
    const remaining = workQueueRemaining(queue);
    if (remaining === 0) return null;
    if (queue.dryPaused) {
      return `can is empty — ${remaining} to water`;
    }
    const verb =
      queue.tool === ToolMode.Water
        ? 'watering'
        : queue.tool === ToolMode.Harvest
          ? 'harvesting'
          : 'planting';
    return `${verb} ${remaining} more…`;
  }

  /**
   * Turn the gesture's once-only soaked flag into a short-lived visible tell. The flag
   * lives on the queue state (pure, testable); the wall clock lives here, where cosmetic
   * timing is allowed. At most one tell per hold, by construction: the flag only rises
   * once and `soakedAck` swallows every later frame of it.
   */
  private syncSoakedTell(): void {
    const queue = this.queue;
    if (queue !== null && queue.soakedTold && !this.soakedAck) {
      this.soakedAck = true;
      this.soakedTellUntil = performance.now() + 1400;
    }
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
   *
   * A BELT TILE UNDER THE CURSOR ANSWERS TOO (item 084), after the arm: an arm and a belt
   * cannot share a tile — they are both the GROUND layer, which is exactly what `groundOccupied`
   * means — so the order is a search rather than a priority. The payload is the hovered TILE,
   * not a belt id — segment surgery mints fresh ids, so the tile is the stable name for the
   * thing the player owns (see `RotateBeltCommand`). A junction is a machine, so neither branch
   * answers on one and R keeps meaning the ghost there.
   *
   * **AND A PIPE OVERHEAD DOES NOT INTERCEPT IT** (item 120's picking rule, third surface). R
   * acts on the topmost thing that CAN turn, and a pipe is not one: there is no `RotatePipe`
   * command, because a pipe run is a SET of tiles with no facing to change. So R over a crossing
   * turns the belt underneath, which is the only reading that does anything at all — swallowing
   * the key to honour "topmost" would be a rule enforcing itself against the player for the sake
   * of its own symmetry. Teardown's topmost-wins rule exists because BOTH objects answer there
   * and one had to be chosen; here only one answers, so there is nothing to choose. Pinned in
   * `pipe-mirror.test.ts` so it stays a decision rather than reverting to an accident — until
   * today it was correct only because a comment claimed the two could never share a tile.
   */
  rotateCommand(): Command | null {
    const grabber = this.grabberUnderCursor();
    if (grabber !== null) return { type: 'RotateGrabber', grabberId: grabber.id };

    const belt = this.beltTileUnderCursor();
    return belt === null ? null : { type: 'RotateBelt', tileX: belt.tileX, tileY: belt.tileY };
  }

  /** The hovered tile, when a placed belt covers it. The pointer owns hover, so it answers. */
  private beltTileUnderCursor(): { tileX: number; tileY: number } | null {
    const view = this.host.latestView();
    const hover = this.hover;
    if (view === null || hover === null) return null;
    if (beltAtView(view, hover.tileX, hover.tileY) === null) return null;
    return { tileX: hover.tileX, tileY: hover.tileY };
  }

  /** True when R would do something the player can see. Drives the hint strip, nothing else. */
  rotateAdvertised(tool: ToolMode): boolean {
    if (toolGrabberTier(tool) !== null) return true;
    // A belt tool advertises R because a belt run can bend now and R chooses which way
    // ([[059]]). Advertised on the ARMED TOOL rather than only mid-drag, so the player finds
    // out before committing to a corner instead of during one.
    if (toolBeltTier(tool) !== null) return true;
    if (this.grabberUnderCursor() !== null) return true;
    // A placed belt tile advertises for the same reason a placed arm does: R will turn it.
    return this.beltTileUnderCursor() !== null;
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
    if (drag !== null) {
      return dragBand(view, drag, this.system.armedCrop, this.system.pickedLiquid);
    }

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
    // rip it out would be the wrong sentence about the right object. It outlines exactly what
    // one click removes — all four tiles of a Fryer, but only the hovered tile of a longer
    // belt, because belts come up tile by tile now (item 084).
    if (tool === ToolMode.Deconstruct) {
      return teardownBand(view, { x: hover.tileX, y: hover.tileY, w: 1, h: 1 });
    }

    // The till's hover ghost is its drag band at 1×1: what THIS tile would become, in the
    // mode the anchor-to-be would pick, before the button ever goes down.
    if (tool === ToolMode.Till) {
      const bounds = { x: hover.tileX, y: hover.tileY, w: 1, h: 1 };
      return tillBand(view, bounds, tillModeFor(view, { tileX: hover.tileX, tileY: hover.tileY }));
    }

    // The plant ghost ([[103]]), on the same 1×1 pattern the till's uses and for the same
    // reason: the ARMED CROP has to be legible before the button goes down, or a dial nobody
    // can see is a dial nobody will turn. It is also where a missing seed gets said out loud —
    // the sim refuses that click silently, since a refusal spends nothing.
    if (tool === ToolMode.Plant) return plantBand(view, hover, this.system.armedCrop);

    const grabber = this.grabberUnderCursor();
    if (grabber !== null && toolMachineKind(tool) === null) return grabberBand(hover, grabber);

    return ghostBand(view, hover, tool, this.system.placeDir);
  }
}

// --- commands ---------------------------------------------------------------------------

/**
 * Left click: the current tool's verb.
 *
 * `crop` IS THE ARMED CROP AND IT IS ONLY THE PLANT TOOL'S BUSINESS ([[103]]). It is a
 * parameter rather than a module constant for the same reason `placeDir` is one: both are
 * cursor state that lives in `system.ts`, and a function that reached for either of them
 * directly would stop being drivable from a test with a plain view and a tile.
 */
export function primaryCommand(
  view: WorldView,
  tile: HoverTile,
  tool: ToolMode,
  placeDir: Direction,
  crop: CropId = DEFAULT_CROP,
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
      // A BARREL SPRINKLER UNDER THE CURSOR MEANS "FILL THE BARREL" — the same
      // tile-says-the-verb rule the shore dip above runs on, and it outranks the pondless
      // empty-can fallback below because a machine under the cursor is more specific than a
      // fact about the whole world. Before machines could stand on farmland ([[067]]) this
      // case could not arise; after it, the pour fell through to `WaterTile` and soaked the
      // dirt while the barrel stood empty, which is how the owner found it. The sim
      // re-validates (an already-full barrel refuses the click).
      if (query.machine !== null && query.machine.kind === MachineKind.Sprinkler) {
        return { type: 'RefillHopper', machineId: query.machine.id };
      }
      if (view.reservoirs.length === 0 && view.player.canCharges === 0) {
        return { type: 'RefillCan' };
      }
      return { type: 'WaterTile', tileX: tile.tileX, tileY: tile.tileY };
    // The repair kit: one click spends one kit on a spot and services the cell around it.
    // The command carries the tile, never a machine id — plan §4's "one trip services a
    // cell" is the sim's shape, and this side only aims it.
    case ToolMode.UseRepairKit:
      return { type: 'UseRepairKit', tileX: tile.tileX, tileY: tile.tileY };
    // THE ARMED CROP, NOT A CONSTANT ([[103]]). This line read `crop: V01_CROP` — "the only
    // crop in v0.1" — for the whole of v0.2, which is how four researched crops, four
    // purchasable seeds and the $25 cane node came to have no way into the ground. The sim
    // never had this bug: `applyPlantTile` accepts any crop and gates on the spec's own node.
    case ToolMode.Plant:
      return { type: 'PlantTile', tileX: tile.tileX, tileY: tile.tileY, crop };
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

// --- the paint hold's brain ([[072]]) ---------------------------------------------------
//
// Both functions are PURE in the house sense: a `WorldView`, a plain state record, a tile —
// no DOM, no camera, no listeners — which is what lets the tests below drive a whole hold
// as a sequence of calls. `holdCommand` mutates only its own bookkeeping (the fired set and
// the charge guess); the world is the sim's, reached exclusively through the returned
// command.

/**
 * The memory a fresh hold starts with, from the press that began it.
 *
 * The anchor is seeded as FIRED because the press edge already dispatched it as an ordinary
 * click — including, when it was out of reach, as a walk-to-act errand ([[050]]); seeding it
 * means the arriving farmer and the hold cannot both perform the same tile. The charge guess
 * starts at one when the press poured directly, since that pour is in the queue and not yet
 * in the view; and a hold that BEGINS with a dry can starts with the refusal already told —
 * the press's own refused pour was the tell, and once is the contract.
 */
export function createHold(
  pointerId: number,
  clientX: number,
  clientY: number,
  view: WorldView,
  anchor: HoverTile,
  tool: ToolMode,
  pressed: Command,
): HoldState {
  return {
    pointerId,
    tool,
    clientX,
    clientY,
    fired: new Set([holdKey(anchor.tileX, anchor.tileY)]),
    viewTick: view.tick,
    watersEmitted:
      pressed.type === 'WaterTile' && tileWithinReach(view, anchor.tileX, anchor.tileY) ? 1 : 0,
    canRefusalTold: tool === ToolMode.Water && view.player.canCharges === 0,
    crop: cropOfPress(pressed),
  };
}

/**
 * The crop a press committed to, read back off the command it produced ([[103]]).
 *
 * READ OFF THE PRESS RATHER THAN PASSED IN, so a hold and its work queue cannot disagree with
 * each other or with the click that started them — there is one armed crop, it was consulted
 * once, and this is that answer travelling with the gesture. The walk-to form carries the crop
 * as `item`, which is `reachAdjusted`'s own encoding for a plant errand.
 */
function cropOfPress(pressed: Command): CropId {
  if (pressed.type === 'PlantTile') return pressed.crop;
  if (pressed.type === 'WalkAndAct' && pressed.action === IntentAction.Plant) {
    return pressed.item as CropId;
  }
  return DEFAULT_CROP;
}

/**
 * The command a held cursor over `tile` means right now, or `null` for silence. Called on
 * every pointer move and every frame while the button is down; almost every call is a Set
 * lookup and out.
 *
 * THE RULES, in the order they refuse:
 *   · Once per tile per hold. A re-crossed tile is silent even if it legally wants the verb
 *     again — predictability outranks thoroughness, and the player can always release and
 *     press again.
 *   · Only the tile verbs repeat. `primaryCommand`'s other answer on these tools is
 *     `RefillCan` — the Water tool crossing open water — and a drag that clipped the pond
 *     must not dip the can mid-row.
 *   · A SATURATED tile is skipped, not poured at ([[081]]): the sim now refuses the pour
 *     without spending, so the command would be pure noise — and the skip raises the
 *     once-per-hold "already soaked" flag on the queue instead of a tell per wet tile.
 *     Not marked fired: fast-draining soil can want the verb again seconds later.
 *   · Out of reach is never fired directly and never walked to FROM HERE — a hold must not
 *     emit walk errands per crossed tile; the sim holds ONE errand at a time ([[050]]).
 *     Since [[074]] the tile is QUEUED instead (crossing order, deduped against both the
 *     fired set and the queue), and the pump walks the farmer to it one errand at a time.
 *     Reach is still re-read on every call, so holding while WASD walks the row fires each
 *     tile directly as it comes into arm's length, and it never reaches the queue.
 *   · Per-tile legality is the sim's, same as a click (§12): the command goes and the
 *     reducer judges it. The ONE input-side gate is the dry can, because a refused pour has
 *     an audible tell and a nine-tile drag deserves it once, not nine times.
 */
export function holdCommand(
  view: WorldView,
  hold: HoldState,
  tile: HoverTile,
  queue: WorkQueueState | null = null,
): Command | null {
  // The queue drains at every tick boundary, so a view that has advanced already reflects
  // every pour emitted before it — the local spend guess starts over. Without the guess, a
  // fast drag inside one 50 ms tick would out-pour the can against a stale charge count and
  // ring the refusal tell for each overdraft.
  if (view.tick !== hold.viewTick) {
    hold.viewTick = view.tick;
    hold.watersEmitted = 0;
  }

  const key = holdKey(tile.tileX, tile.tileY);
  if (hold.fired.has(key)) return null;

  const direct = primaryCommand(view, tile, hold.tool, Direction.None, hold.crop);
  if (direct === null) return null;
  if (direct.type !== 'WaterTile' && direct.type !== 'PlantTile' && direct.type !== 'HarvestTile') {
    return null;
  }

  // The soaked filter ([[081]]) sits above the reach split on purpose: a wet tile is not
  // poured at in reach AND not queued out of reach — a walk across the lot to refuse would
  // be the silent dead click item 050 was filed about, with commuting.
  if (direct.type === 'WaterTile' && tileSaturated(view, tile.tileX, tile.tileY)) {
    if (queue !== null) queue.soakedTold = true;
    return null;
  }

  if (!tileWithinReach(view, tile.tileX, tile.tileY)) {
    if (queue !== null && !queue.keys.has(key)) {
      queue.keys.add(key);
      queue.tiles.push({ tileX: tile.tileX, tileY: tile.tileY });
    }
    return null;
  }

  if (direct.type === 'WaterTile') {
    const charges = view.player.canCharges - hold.watersEmitted;
    if (charges <= 0) {
      // Dry mid-row: ONE more pour goes through so the sim's refusal tell rings, then
      // silence. The tile is deliberately NOT marked fired — the refusal performed nothing,
      // so nothing is owed to predictability, and the tile can still fire properly in the
      // (rare) case the view was merely lagging a refill.
      if (hold.canRefusalTold) return null;
      hold.canRefusalTold = true;
      return direct;
    }
    hold.canRefusalTold = false;
    hold.watersEmitted += 1;
  }

  hold.fired.add(key);
  return direct;
}

function holdKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}

/**
 * Is this farm tile at its moisture ceiling? The sim's refusal surface for [[081]]: a pour
 * refuses exactly when `moisturePermille` reads 1000, so this probe and the reducer cannot
 * disagree. Only ever true of farmland — bare grass has no moisture to be full of.
 */
export function tileSaturated(view: WorldView, tileX: number, tileY: number): boolean {
  const query = tileAtView(view, tileX, tileY);
  return query.isField && query.moisturePermille >= 1000;
}

// --- the out-of-reach work queue ([[074]]) ------------------------------------------------
//
// The owner's ruling overrides 072's skip: a held Plant/Water/Harvest covers the WHOLE row,
// and tiles the cursor crossed beyond arm's length are walked to and worked — during the
// hold and after release, until the queue runs dry. The sim's single-errand model is
// load-bearing ([[050]]), so the queue lives HERE, input-side, and feeds the sim exactly
// one `WalkAndAct` at a time: the next one is dispatched only when the view shows the
// previous errand gone (`player.intentAction`/`intentTileX`/`intentTileY` — the projection
// publishes the live errand precisely so nobody has to sniff effects per verb). Everything
// below is pure in the house sense — a view, a state record, a push callback — so the
// tests drive whole pump sessions as sequences of calls.

export interface QueuedTile {
  tileX: number;
  tileY: number;
}

/** The one errand the pump currently has walking, matched against the view to detect its end. */
export interface WorkErrand {
  tileX: number;
  tileY: number;
  /** The `IntentAction` the dispatched WalkAndAct carries. */
  action: number;
  /** `view.tick` at dispatch. Resolution is judged only on strictly later ticks. */
  issuedViewTick: number;
}

export interface WorkQueueState {
  /** The verb the whole queue carries. A different armed tool cancels it. */
  tool: ToolMode;
  /**
   * The crop the queue sows, taken from what the press actually sent ([[103]]).
   *
   * THE QUEUE RE-DERIVES ITS COMMANDS (`primaryCommand`, twice below), so without this the
   * far half of a drag — every tile the player never got within arm's length of — would come
   * up as the default crop while the near half came up as the armed one. One row, two plants.
   */
  crop: CropId;
  /** Out-of-reach crossed tiles, in crossing order. The pump works the head. */
  tiles: QueuedTile[];
  /** Dedupe over `tiles` AND the in-flight errand, as `"x,y"` keys. */
  keys: Set<string>;
  /** The button is still down: mid-hold WASD stays legal and does not cancel ([[072]]). */
  holdDown: boolean;
  outstanding: WorkErrand | null;
  /** Charge-budget bookkeeping, mirroring the hold's (`viewTick`/`watersEmitted`). */
  viewTick: number;
  watersEmitted: number;
  /** The once-per-gesture "already soaked" tell has been raised ([[081]]). Never resets. */
  soakedTold: boolean;
  /** The pump declined to dispatch dry pours this frame; a refill resumes it. */
  dryPaused: boolean;
}

/**
 * A fresh queue for a paint press. `dispatched` is what the press ACTUALLY sent: when the
 * anchor was out of reach that is already a `WalkAndAct`, and seeding it as the outstanding
 * errand is what stops the pump's first dispatch from replacing it unworked — the sim
 * replaces errands wholesale, and the anchor is owed its turn.
 */
export function createWorkQueue(
  view: WorldView,
  tool: ToolMode,
  dispatched: Command,
): WorkQueueState {
  const outstanding: WorkErrand | null =
    dispatched.type === 'WalkAndAct'
      ? {
          tileX: dispatched.tileX,
          tileY: dispatched.tileY,
          action: dispatched.action,
          issuedViewTick: view.tick,
        }
      : null;
  return {
    tool,
    crop: cropOfPress(dispatched),
    tiles: [],
    keys: new Set<string>(
      outstanding === null ? [] : [holdKey(outstanding.tileX, outstanding.tileY)],
    ),
    holdDown: true,
    outstanding,
    viewTick: view.tick,
    watersEmitted: 0,
    soakedTold: false,
    dryPaused: false,
  };
}

/** Tiles still owed work: the queue plus the errand in flight. Drives the tell's count. */
export function workQueueRemaining(queue: WorkQueueState): number {
  return queue.tiles.length + (queue.outstanding === null ? 0 : 1);
}

export function workQueueDone(queue: WorkQueueState): boolean {
  return queue.tiles.length === 0 && queue.outstanding === null;
}

/**
 * One frame of pumping. Returns `false` when the armed tool no longer matches — the
 * caller's cue to cancel the queue (arming another tool is a cancellation-matrix row).
 *
 * THE PUMP'S CONTRACT, row by row:
 *   · ONE OUTSTANDING ERRAND, NEVER MORE, and no per-frame respawning: a new `WalkAndAct`
 *     is dispatched only when the view shows the previous one gone. "Gone" is read off
 *     `view.player.intentAction/intentTileX/intentTileY` — the completed, refused, timed
 *     out and blocked-abandoned ([[080]]) cases all end with the intent cleared, so one
 *     observation covers every way an errand can resolve. Judged only on ticks strictly
 *     after dispatch, so the tick that has not yet APPLIED the command cannot read as
 *     "already finished".
 *   · A resolved errand is NEVER retried: its tile left the queue at dispatch. A blocked
 *     or refused target therefore costs exactly one attempt.
 *   · A queued tile that comes INTO reach — the walk itself, or mid-hold WASD — fires
 *     directly and leaves the queue, marked into the hold's fired set so the hold cannot
 *     fire it twice.
 *   · A queued tile that stopped making sense is dropped at its turn: crossed water, a
 *     saturated tile ([[081]], raising the once-per-gesture soaked flag), anything whose
 *     verb no longer forms.
 *   · THE DRY CAN PAUSES WATER'S QUEUE rather than cancelling it (the documented choice on
 *     item 074): no dispatch, no charge-burning walk, `dryPaused` raised for the tell —
 *     and the pump re-checks `view.player.canCharges` every frame, so a refill resumes the
 *     row with no further input. Cancel-outright was the fallback if resume proved fiddly;
 *     with the charge count already on the view, pause is the simpler of the two.
 *   · While a direction key is held (`walkHeld`) nothing is dispatched: the sim refuses
 *     `WalkAndAct` under a held key and kills errands on `SetMoveDirection`, so dispatching
 *     would burn the queue one refused errand per frame. In-reach tiles still fire — that
 *     is the mid-hold long-row loop working as designed.
 */
export function pumpWorkQueue(
  view: WorldView,
  queue: WorkQueueState,
  armedTool: ToolMode,
  fired: Set<string> | null,
  walkHeld: boolean,
  push: (command: Command) => void,
): boolean {
  if (armedTool !== queue.tool) return false;

  if (view.tick !== queue.viewTick) {
    queue.viewTick = view.tick;
    queue.watersEmitted = 0;
  }
  queue.dryPaused = false;

  // 1. Has the errand in flight resolved? (Completed, refused, died — all read the same.)
  const outstanding = queue.outstanding;
  if (outstanding !== null && view.tick > outstanding.issuedViewTick) {
    const player = view.player;
    const live =
      player.intentAction === outstanding.action &&
      player.intentTileX === outstanding.tileX &&
      player.intentTileY === outstanding.tileY;
    if (!live) {
      queue.outstanding = null;
      queue.keys.delete(holdKey(outstanding.tileX, outstanding.tileY));
    }
  }

  // 2. The sweep: fire whatever reach (the walk, or mid-hold WASD) has brought within
  //    arm's length, and drop what stopped making sense. Order is preserved for the rest.
  const remaining: QueuedTile[] = [];
  for (let i = 0; i < queue.tiles.length; i++) {
    const tile = queue.tiles[i]!;
    const key = holdKey(tile.tileX, tile.tileY);
    if (fired !== null && fired.has(key)) {
      queue.keys.delete(key);
      continue;
    }
    if (!tileWithinReach(view, tile.tileX, tile.tileY)) {
      remaining.push(tile);
      continue;
    }
    const direct = primaryCommand(view, tile, queue.tool, Direction.None, queue.crop);
    if (
      direct === null ||
      (direct.type !== 'WaterTile' && direct.type !== 'PlantTile' && direct.type !== 'HarvestTile')
    ) {
      queue.keys.delete(key);
      continue;
    }
    if (direct.type === 'WaterTile') {
      if (tileSaturated(view, tile.tileX, tile.tileY)) {
        queue.soakedTold = true;
        queue.keys.delete(key);
        continue;
      }
      if (view.player.canCharges - queue.watersEmitted <= 0) {
        queue.dryPaused = true;
        remaining.push(tile);
        continue;
      }
      queue.watersEmitted += 1;
    }
    push(direct);
    fired?.add(key);
    queue.keys.delete(key);
  }
  queue.tiles = remaining;

  // 3. Dispatch the next errand, if the lane is clear and the player is not steering.
  if (queue.outstanding === null && !walkHeld) {
    while (queue.tiles.length > 0) {
      const tile = queue.tiles[0]!;
      const key = holdKey(tile.tileX, tile.tileY);
      const direct = primaryCommand(view, tile, queue.tool, Direction.None, queue.crop);
      if (
        direct === null ||
        (direct.type !== 'WaterTile' &&
          direct.type !== 'PlantTile' &&
          direct.type !== 'HarvestTile')
      ) {
        queue.tiles.shift();
        queue.keys.delete(key);
        continue;
      }
      if (direct.type === 'WaterTile') {
        if (tileSaturated(view, tile.tileX, tile.tileY)) {
          queue.soakedTold = true;
          queue.tiles.shift();
          queue.keys.delete(key);
          continue;
        }
        if (view.player.canCharges - queue.watersEmitted <= 0) {
          queue.dryPaused = true;
          break;
        }
      }
      const pushed = reachAdjusted(view, tile, direct);
      queue.tiles.shift();
      if (pushed.type === 'WalkAndAct') {
        push(pushed);
        queue.outstanding = {
          tileX: pushed.tileX,
          tileY: pushed.tileY,
          action: pushed.action,
          issuedViewTick: view.tick,
        };
        break;
      }
      // Slipped into reach since the sweep — fire it directly and keep dispatching.
      if (pushed.type === 'WaterTile') queue.watersEmitted += 1;
      push(pushed);
      fired?.add(key);
      queue.keys.delete(key);
    }
  }

  return true;
}

/**
 * A direction keydown's effect on the queue. Returns `true` when the queue survives
 * (mid-hold, [[072]]'s legality kept) and `false` when it is cancelled (after release,
 * [[074]]'s matrix). Mid-hold, an errand still shown live in the view is reclaimed to the
 * head of the queue — the `SetMoveDirection` this keystroke becomes will kill it sim-side
 * before it works its tile — while an errand the view already shows finished is simply
 * forgotten, so a worked tile is never worked twice.
 */
export function walkKeyInterruptsQueue(queue: WorkQueueState, view: WorldView | null): boolean {
  if (!queue.holdDown) return false;
  const outstanding = queue.outstanding;
  if (outstanding !== null) {
    queue.outstanding = null;
    const live =
      view !== null &&
      view.player.intentAction === outstanding.action &&
      view.player.intentTileX === outstanding.tileX &&
      view.player.intentTileY === outstanding.tileY;
    if (live) {
      queue.tiles.unshift({ tileX: outstanding.tileX, tileY: outstanding.tileY });
    } else {
      queue.keys.delete(holdKey(outstanding.tileX, outstanding.tileY));
    }
  }
  return true;
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
    // THE ITEM RIDES ALONG NOW ([[105]]), and its absence was half of the Root Cellar's bug: the
    // errand dropped `item` here and `intentCommand` rebuilt a `LoadMachine` naming nothing, which
    // a box refuses permanently. Every recipe machine was and stays unaffected — they take
    // "whatever fits", and a `LoadMachine` with no item still means exactly that.
    case 'LoadMachine':
      return machineErrand(view, direct, IntentAction.Load, tile, direct.item ?? 0, direct.count);
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
export function dragCommands(
  view: WorldView,
  drag: Drag,
  crop: CropId,
  picked: LiquidId = LiquidId.None,
): Command[] {
  const run = runFor(drag);

  if (run.kind === 'rect') {
    if (drag.tool === ToolMode.Deconstruct) return teardownCommands(view, run);
    // The till ([[066]], three rungs since [[127]]): one drag is ONE `TillTile`, and the
    // ANCHOR picked the mode at the press — grass tills, a laden farm tile un-plants, bare
    // farmland un-tills — the same commit-at-the-press rule zone painting uses, so the band
    // can label itself correctly the whole way. The command is formed and sent even when every
    // tile in it will be skipped; the sim is the authority and refuses a no-op drag untraced
    // (§12).
    //
    // THIS IS THE ONE LINE IN THIS FILE WHERE A MIRROR IS NOT MERELY A GHOST. `tillModeFor`'s
    // answer is not a colour — it is the verb the sim will perform, and §12's "the sim
    // re-checks it" is no backstop against a mode that is merely WRONG rather than illegal.
    // Swept against the real reducer in `till-mirror.test.ts` for exactly that reason.
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

  // The pipe run ([[101]]). ONE DRAG, ONE `PlacePipe`, path included — the same rule the belt
  // above follows and the shape `PlacePipeCommand` was built for ("a thirty-tile pipe run
  // appends ONE entry carrying its whole path"). The tiles come out of `runTiles` in travel
  // order, which is already contiguous, orthogonal and non-repeating, so it is the sim's
  // `path` verbatim.
  if (drag.tool === ToolMode.PlacePipe) {
    const tiles = runTiles(run);
    const carried = pipeRunLiquid(view, tiles, picked);
    // NOTHING AGREES ON A LIQUID, SO THERE IS NOTHING TO SAY — and this is not the input layer
    // deciding legality (§12), it is the input layer being unable to FORM a command. Every
    // other doomed drag in this file is still sent because it is a well-formed sentence the sim
    // gets to refuse; `LiquidId.None` is not a liquid, `pipePathRefusal` calls it `BadPath`, and
    // a `PlacePipe` carrying it would be a malformed payload rather than a rejected one. Same
    // rule, same silence, as an erase drag anchored on unzoned soil.
    //
    // SINCE [[109]] THE SILENT RUN LANDS HERE TOO (`source: 'untyped'`), and for the same
    // reason rather than a new one: a run nothing has typed and nobody has picked a liquid for
    // has no liquid to put in the payload. The band spent the whole drag saying so.
    if (carried.liquid === LiquidId.None) return [];
    return [
      {
        type: 'PlacePipe',
        liquid: carried.liquid,
        path: tiles.map((tile) => ({ x: tile.tileX, y: tile.tileY })),
      },
    ];
  }

  const tier = toolBeltTier(drag.tool);
  if (tier === null) return [];
  return [beltCommandFor(tier, run)];
}

// --- the pipe run's liquid ([[101]]) -------------------------------------------------------
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THERE IS ONE PIPE TOOL AND NO LIQUID PICKER, AND THE RUN WORKS OUT WHAT IT CARRIES.
//
//  `PlacePipeCommand` needs a `liquid`, and the obvious answers were both bad. FIVE TOOLS —
//  Water Pipe, Juice Pipe, Syrup Pipe, Fizz Pipe, Soda Pipe — asks the player to know which
//  liquid a machine emits BEFORE they have built the machine, and puts five rows in a menu that
//  is already nine groups long to sell one object the sim prices with one constant. A PICKER
//  KEY is a new keyboard binding for a choice that, it turns out, is almost never free.
//
//  So the rule is the sim's own rule, run forwards. `pipePathRefusal` refuses a run that would
//  join two liquids (`LiquidMismatch`) or present a liquid to a machine with no port for it
//  (`PortMismatch`); intersect those same constraints over everything the run touches and what
//  survives is the set of liquids this run COULD legally carry. Almost always it is exactly
//  one — which means the player was never making a choice, they were typing in an answer the
//  world already knew. Checked against the fixtures that are this feature's spec: all four of
//  `soda-line.json`'s stubs (cane juice, simple syrup, soda syrup, carbonated water) and both
//  water mains come out of this function with one candidate standing.
//
//  WHEN SEVERAL SURVIVE, THE DRAG'S DIRECTION BREAKS THE TIE, because a drag has a start and an
//  end and that is a real thing the player expressed: pipe dragged AWAY from a machine takes
//  what that machine sends out, pipe dragged INTO one takes what it draws in. A Kettle alone
//  accepts cane juice and emits simple syrup; drag away from it and you are laying a syrup line,
//  which is what you meant. If it still guesses wrong the fix is to drag from the other end, and
//  the band names the liquid in words the whole time the button is down — so the answer is
//  visible before the release, which is the criterion every other gesture in this file is held
//  to.
//
//  WHEN NOTHING SURVIVES the run is genuinely illegal — the same runs `pipePathRefusal` would
//  turn down — and the band says so instead of quoting a price.
// ────────────────────────────────────────────────────────────────────────────────────
//
// ────────────────────────────────────────────────────────────────────────────────────
//  AND WHEN THE RUN TOUCHES NOTHING AT ALL, THE INTERSECTION IS NOT AN ANSWER ([[109]]).
//
//  Every liquid survives a run laid across bare ground, because nothing was there to rule any
//  of them out — and this function used to read that silence as WATER ("the only liquid with a
//  source in the world rather than inside a machine"). The argument is a good one about water
//  and a bad one about the player: it converts "nobody has said yet" into a decision, spends
//  the money, and lays a water main down the middle of where the soda line was going to go.
//  The soda machine then refuses to stand beside it, correctly (`PortMismatch`), and nothing
//  on screen connects the two facts. **Both golden fixtures build in exactly this order** —
//  `water-works.json` lays its 17-tile main six thousand ticks before its pump, and
//  `soda-line.json` lays all seven of its runs before a single plumbed machine exists — so
//  pipe-first is not an unusual way to play, it is the way the design's own recordings play.
//
//  SO THE SILENCE IS ANSWERED BY THE PLAYER INSTEAD, WITH `L`, and only ever there. This is
//  the note's third route — ask when and only when the inference is genuinely ambiguous — and
//  it is the only one of the three that leaves the goldens' build order playable. The other
//  two were weighed and written down in the vault log: REFUSING outright is cheap and honest
//  but makes pipe-first illegal, which is the order the fixtures use; DEFERRING (a pipe laid
//  "undecided" that takes its liquid from the first machine to connect) needs `Liquid.None`
//  pipes and untyped networks in the sim — hashed state, a save format, a migration — and it
//  only moves the same disagreement later, to a pipe already paid for and in the ground.
//
//  `L` IS `C`'s TWIN, deliberately and to the letter: cursor state that cycles, emits nothing,
//  is never traced or hashed, and shows its answer in the band. A player who has met the crop
//  key has met this one. It starts on NOTHING PICKED, which is the half that fixes the bug —
//  an untouched run with no pick lays nothing and the band says why, so the water main is
//  never a thing that merely happened.
//
//  THE WORLD STILL OUTRANKS THE PICK, always. The pick is consulted only among liquids that
//  survived the intersection, so it can never argue with a machine or an existing run; it
//  breaks a tie the world left open and answers a silence, and it does nothing else. A picked
//  liquid is also LABELLED as picked on the band, so an expressed choice never reads like a
//  discovered fact.
// ────────────────────────────────────────────────────────────────────────────────────

const PIPE_NEIGHBOUR_DX: readonly number[] = [0, 1, 0, -1];
const PIPE_NEIGHBOUR_DY: readonly number[] = [-1, 0, 1, 0];

/**
 * Every liquid a machine will let a pipe present to it, or empty for one with no plumbing.
 *
 * The client's mirror of the sim's `specAcceptsLiquid`: the single `liquid` field is the
 * utility machines' one port (Pump, Tank, the heads, the Recirculator) and `ports` is a
 * converter's list, and `machineHasPorts` is exactly "this list is not empty". Read off the
 * spec, so a machine that gains a port gains it here too.
 */
function machineLiquids(kind: number): LiquidId[] {
  const spec = machineSpec(kind as MachineKind);
  if (spec === null) return [];
  const liquids: LiquidId[] = [];
  if (spec.liquid !== LiquidId.None) liquids.push(spec.liquid);
  for (let i = 0; i < spec.ports.length; i++) {
    const port = spec.ports[i]!;
    if (!liquids.includes(port.liquid)) liquids.push(port.liquid);
  }
  return liquids;
}

/**
 * Where a run's liquid came from — the fact [[109]] added, and the reason this function stopped
 * returning a bare integer.
 *
 * `LiquidId.None` reaches the band for two OPPOSITE reasons and they need opposite sentences:
 * everything was ruled out (the run is genuinely illegal) or nothing was ever ruled in (the run
 * is not a decision yet). One integer cannot tell those apart, and the band that has to explain
 * itself is the whole point of the item.
 *
 * - `world` — the machines and pipes beside the run settled it. Item 101's inference, unchanged.
 * - `picked` — the world left a choice open and `L` answered it. Labelled as such on the band.
 * - `untyped` — nothing beside the run said anything and nothing was picked. Lays nothing.
 * - `mismatch` — the intersection came out empty; no liquid could legally fill this path.
 */
export type PipeLiquidSource = 'world' | 'picked' | 'untyped' | 'mismatch';

export interface PipeRunLiquid {
  /** What the run carries, or `LiquidId.None` when it cannot be worked out at all. */
  readonly liquid: LiquidId;
  readonly source: PipeLiquidSource;
}

/**
 * What this run carries, where the answer came from, and `LiquidId.None` when there isn't one.
 *
 * `picked` is the player's standing answer to the ambiguous case (`L`, see the header) and is
 * `LiquidId.None` when they have not given one — which is the shipped default and the state a
 * fresh world starts in.
 *
 * Exported for the tests, which drive it against hand-built worlds and against the two golden
 * fixtures' geometry. Pure: a projection, a list of tiles and one integer in, a record out.
 */
export function pipeRunLiquid(
  view: WorldView,
  tiles: readonly TilePoint[],
  picked: LiquidId = LiquidId.None,
): PipeRunLiquid {
  // The sim's own order, so the last-resort pick below is stable rather than incidental.
  let candidates: LiquidId[] = LIQUID_SPECS.map((spec) => spec.id);
  // DID ANYTHING AT ALL HAVE AN OPINION? Not "how many survived" — a run beside nothing ends
  // with every liquid still standing, which looks identical to a wide-open choice and is not
  // one. This flag is the difference between an ambiguity and a silence ([[109]]).
  let typed = false;

  for (let i = 0; i < tiles.length && candidates.length > 0; i++) {
    const tile = tiles[i]!;
    for (let n = 0; n < 4; n++) {
      const nx = tile.tileX + PIPE_NEIGHBOUR_DX[n]!;
      const ny = tile.tileY + PIPE_NEIGHBOUR_DY[n]!;

      // A pipe already there decides outright: two liquids never meet, so joining it is the
      // only thing this run can be. (`BuildRefusal.LiquidMismatch`.)
      const pipe = pipeAtView(view, nx, ny);
      if (pipe !== null) {
        typed = true;
        candidates = candidates.filter((id) => id === pipe.liquid);
      }

      // A plumbed machine narrows to what its ports declare. An UNPLUMBED one narrows nothing
      // and must not — a water main is allowed to run past a Fryer, which is the sim's rule in
      // as many words: "Machines with no ports at all are invisible to this rule." It does not
      // set `typed` either, for exactly the same reason: a Fryer has no opinion about liquids.
      const machine = tileAtView(view, nx, ny).machine;
      if (machine === null) continue;
      const accepts = machineLiquids(machine.kind);
      if (accepts.length > 0) {
        typed = true;
        candidates = candidates.filter((id) => accepts.includes(id));
      }
    }
  }

  if (candidates.length === 0) return { liquid: LiquidId.None, source: 'mismatch' };

  // NOTHING SAID ANYTHING. The player's standing pick is the only thing that can speak here,
  // and if they have not made one this is not a run yet — the band explains, and `dragCommands`
  // forms no command. This is the line item 109 exists for; it used to say water.
  if (!typed) {
    return picked !== LiquidId.None && candidates.includes(picked)
      ? { liquid: picked, source: 'picked' }
      : { liquid: LiquidId.None, source: 'untyped' };
  }

  if (candidates.length === 1) return { liquid: candidates[0]!, source: 'world' };

  // THE PICK BREAKS A TIE THE WORLD LEFT OPEN, and only among liquids that survived it — so it
  // is checked here, after the intersection and before the direction heuristic. A player who
  // has said "cane juice" and drags off a Kettle (which sends syrup out and takes juice in)
  // means the juice line, and a guess about which end they dragged from should not outrank a
  // sentence they typed. It cannot reach a run the world already decided: one survivor returned
  // above, and a pick outside the survivors is not consulted at all.
  if (picked !== LiquidId.None && candidates.includes(picked)) {
    return { liquid: picked, source: 'picked' };
  }

  // The tie-break, in the drag's own direction: out of what you started at, then into what you
  // finished at. See the header — this is the half of the answer the player expressed.
  const sending = portLiquidBeside(view, tiles[0]!, PortFlow.Outlet, candidates);
  if (sending !== LiquidId.None) return { liquid: sending, source: 'world' };
  const drawing = portLiquidBeside(view, tiles[tiles.length - 1]!, PortFlow.Intake, candidates);
  if (drawing !== LiquidId.None) return { liquid: drawing, source: 'world' };

  // Several liquids survived a run that DOES touch plumbing, the drag's direction did not
  // separate them, and the player has not picked. Water first, because it is the only liquid
  // with a source in the world rather than inside a machine — and this is a different animal
  // from the silence above: every candidate here is one the machine beside the run genuinely
  // accepts, so the pipe connects to something real and the band names it in words.
  if (candidates.includes(LiquidId.Water)) return { liquid: LiquidId.Water, source: 'world' };
  return { liquid: candidates[0]!, source: 'world' };
}

/** A liquid a machine beside this tile moves in the given direction, and that is still legal. */
function portLiquidBeside(
  view: WorldView,
  tile: TilePoint,
  flow: PortFlow,
  candidates: readonly LiquidId[],
): LiquidId {
  for (let n = 0; n < 4; n++) {
    const machine = tileAtView(
      view,
      tile.tileX + PIPE_NEIGHBOUR_DX[n]!,
      tile.tileY + PIPE_NEIGHBOUR_DY[n]!,
    ).machine;
    if (machine === null) continue;
    const spec = machineSpec(machine.kind as MachineKind);
    if (spec === null) continue;
    for (let i = 0; i < spec.ports.length; i++) {
      const port = spec.ports[i]!;
      if (port.flow === flow && candidates.includes(port.liquid)) return port.liquid;
    }
  }
  return LiquidId.None;
}

/** The liquid's name in words, off the sim's own slug — never a second table of nouns. */
function liquidName(liquid: LiquidId): string {
  return (liquidSpec(liquid)?.slug ?? '').split('-').join(' ');
}

/**
 * Would every tile of this run take a pipe? A hint for the band, never a gate (§12).
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  A MIRROR OF `pipePathRefusal`'s PER-TILE LOOP, AND IT IS SHORT NOW BECAUSE THAT ONE IS
 *  (item 120). Plumbing moved to its own overhead layer, so four of the six checks that used
 *  to stand here are gone: farmland, the reservoir, the belt underneath and the arm underneath.
 *  A pipe crosses all four. What is left is the pair of rules that are about the PIPE rather
 *  than about the ground — there is only one overhead, so two pipes cannot share a tile — plus
 *  ownership and the machine footprint, which stays sacred because machines meet plumbing
 *  through typed ports on it.
 *
 *  THE SIM'S ORDER, TILE FOR TILE: `isInsideWorld`, `isOwnedTile`, `pipeAt`, `machineAt`
 *  (`packages/sim/src/pipes.ts`). Pinned against the real predicate in `pipe-mirror.test.ts`
 *  rather than by reading the two side by side, because this drifted once already and a mirror
 *  that drifts is a ghost that lies about what the click will do.
 *
 *  Ownership stays checked here even though it is not about the pipe, for the reason
 *  `tilesAreClear` gives: a run across the fence is refused WHOLE, so the band has to redden
 *  for the whole run rather than for the two tiles that crossed it.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
export function pipeTilesClear(view: WorldView, tiles: readonly TilePoint[]): boolean {
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const query = tileAtView(view, tile.tileX, tile.tileY);
    if (!query.insideWorld || !query.owned || query.machine !== null) return false;
    if (pipeAtView(view, tile.tileX, tile.tileY) !== null) return false;
  }
  return true;
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
 * Which of the THREE ways a till drag converts, decided by its ANCHOR ([[127]]).
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  Press on grass and the drag tills. Press on a farm tile with A CROP IN THE GROUND and the
 *  drag lifts that crop and leaves the ground as farmland. Press on BARE farmland and the drag
 *  goes back to grass.
 *
 *  THE MIDDLE RUNG IS WHY THIS STOPPED BEING A BOOLEAN. It used to be `isField ? Untill :
 *  Till`, and "is this farmland" is no longer enough of a question: the sim now splits the
 *  farm tiles in two, and `Unplant`/`Untill` are exact complements over them (`applyTillTile`,
 *  `packages/sim/src/tick.ts`). So this asks the sim's own laden test — `crop !== None`, which
 *  was `crop !== None || compost > 0` until [[124]] deleted compost — off the view column the
 *  sim projects for it.
 *
 *  NOT A GATE, AND MORE THAN A GHOST (§12). Every other mirror in this file only colours a
 *  preview, and the sim re-checks it. This one also picks the `mode` field the command
 *  actually carries (`dragCommands`), so a drift here does not merely mis-draw — it sends the
 *  wrong verb. That is precisely why it is swept tile-for-tile against the real reducer in
 *  `till-mirror.test.ts` rather than eyeballed against `applyTillTile`.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
export function tillModeFor(view: WorldView, anchor: TilePoint): TillMode {
  const query = tileAtView(view, anchor.tileX, anchor.tileY);
  if (!query.isField) return TillMode.Till;
  return query.crop !== 0 ? TillMode.Unplant : TillMode.Untill;
}

/**
 * Would the sim's `applyTillTile` convert this tile, in this mode? The ghost's per-tile
 * truth, mirroring the reducer's own skip list — owned ground only, `tileOccupied` (which
 * over there is machines, belts, arms, pipes and water in one question), and a tile that does
 * not match the mode the anchor picked is a skip.
 * A hint, never a gate (§12): the command goes regardless; this only colours the preview.
 *
 * THE THREE TAILS ARE WRITTEN OUT RATHER THAN LEFT TO A FALLTHROUGH ([[127]]). Before the
 * middle rung this ended `if (Till) …; return <untill test>`, so every mode that was not
 * `Till` was silently treated as `Untill` — which was true of a two-member union and became a
 * lie the moment `Unplant` existed. `TillMode` is a const object rather than an enum, so
 * nothing in the type system would have caught it: an `Unplant` drag would simply have drawn
 * the un-till ghost, green cells over the wrong tiles, while the reducer did the right thing.
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
  // LADEN and BARE, the sim's two halves of the farm tiles: `tile.crop === CropId.None` is the
  // line `applyTillTile` skips an `Unplant` on, and the one `untillTile` refuses on. Read here
  // off the same view column, so one predicate is negated rather than two written.
  const laden = query.crop !== 0;
  if (mode === TillMode.Unplant) return query.isField && laden;
  return query.isField && !laden;
}

/**
 * **WHAT THE MACHINE UNDER THE CURSOR HAS TO SAY FOR ITSELF**, or `null` for silence.
 *
 * IT WAS `idleMachineTell` AND IT IS NOT ONLY A COMPLAINT ANY MORE ([[097]]). Item 098 opened
 * this line to explain why a machine was doing nothing; item 097 needs a barrel sprinkler to
 * say how much watering it has left, which is a plain readout of a working machine. Two things
 * with one door, in one deliberate order: **a complaint outranks a readout**, because a
 * machine that is stuck has something to say that a number cannot, and nothing in the game can
 * currently raise both.
 *
 * NO REACH TEST, unlike the dock card: this is a reading of a thing you are POINTING at,
 * across the lot, and requiring the player to already be standing at the planter would answer
 * the question only for someone who had guessed the answer.
 *
 * ⚠️ HANDOFF: `machineStatus` in `game/render/index.ts` is the hover ribbon and is arguably
 * where all of this belongs — one sentence about the thing under the cursor rather than two
 * lines in two corners. That file is another agent's lane this round ([[095]]), so this stays
 * where the gesture layer already owns a line. If the two ever merge, this is the function to
 * move, and the two orderings to preserve are `statusTell`'s (doing beats looking) and this
 * one's (complaint beats readout).
 */
export function machineTell(view: WorldView | null, tile: HoverTile | null): string | null {
  if (view === null || tile === null) return null;
  const machine = tileAtView(view, tile.tileX, tile.tileY).machine;
  if (machine === null) return null;

  /*
    THE PLANTER DOCK'S COMPLAINT ([[098]]). A planter with no zone — or a zone with no crop
    picked — wants NO seed at all: `dockWantedSeed` returns 0, every seed bounces off
    `dockCanAcceptSeed`, and since item 085 an arm reads that refusal a swing early and simply
    never closes its claw. So the failure is a $50,000 machine, a working arm, a full harvester
    dock, and *nothing visibly happening*. The arm's lamp is red, which says "look downstream";
    this is what the player finds when they do.

    ⚠️ THIS MIRRORS `dockWantedSeed` AND CANNOT CALL IT: the sim's predicate takes `WorldState`
    and this side has only the projection. The mirror is exact — `boundZone === 0` is the sim's
    own "no orders", and `cropSpec(zone.crop) === null` is how `derive-dock.ts` already spells
    "no crop assigned" from the same two published fields. If a third reason to want no seed
    ever lands in `bots.ts`, it belongs on `MachineView` rather than in a third copy of this.
  */
  if (machine.kind === MachineKind.PlanterDock) {
    if (machine.boundZone === 0) return 'this planter has no zone — it wants no seed';
    const zone = view.zones.find((z) => z.id === machine.boundZone);
    if (zone === undefined || cropSpec(zone.crop as CropId) === null) {
      return "this planter's zone has no crop — it wants no seed";
    }
    return null;
  }

  /*
    THE BARREL'S CHARGES ([[097]], the owner's second sentence: "this sprinkler should show how
    many charges they have on hover on the bottom status bar"). A charge is one ACTIVATION now —
    one whole 5×5 watered — so "6 of 10" is a number the player can plan a walk around, which
    is precisely what a millilitre count never was.

    GATED ON `tankChargesMax`, NEVER ON THE KIND, because that is the contract `view.ts` writes
    down in as many words: *"a machine that has no charges reports `tankChargesMax === 0`, which
    is the flag to say nothing at all"*. The piped heads and the Irrigation Hub are ledger-fed
    and report 0 deliberately; a kind check here would be a second opinion about which machines
    are hauled to, and it would be wrong the day a second hand-filled machine lands.
  */
  if (machine.tankChargesMax > 0) {
    return `barrel — ${machine.tankCharges} of ${machine.tankChargesMax} charges`;
  }

  /*
    WHAT IS IN THE BOX ([[105]]). A machine you can click owes you a sentence, and a Root Cellar
    said nothing at all — `machineTell` had no branch and the render ribbon called it "root cellar
    idle", which is true of a shed with ninety potatoes in it in the least useful possible way.

    A READOUT, SO IT SITS BELOW THE COMPLAINT, per this function's stated order. Gated on the ROLE
    like the hand verb it explains, so the Hand Cart says the same thing about itself; named from
    the sim's own slugs, which is the game layer's idiom for machine and item names (see
    `render/index.ts`) rather than a copy table over here.
  */
  const spec = machineSpec(machine.kind as MachineKind);
  if (spec !== null && spec.role === MachineRole.Storage) {
    const name = spec.slug.split('-').join(' ');
    if (machine.cargoCount <= 0 || machine.cargoItem === 0) {
      return `${name} — empty, ${spec.inputCapacity} slots`;
    }
    const goods =
      itemSpec(machine.cargoItem as ItemId)
        ?.slug.split('-')
        .join(' ') ?? 'goods';
    return `${name} — ${machine.cargoCount} of ${spec.inputCapacity} ${goods}`;
  }

  return null;
}

/*
  `maintenanceCommand` STOOD HERE AND IS GONE ([[129]]). It was the right button's second rung
  — jammed → `WhackJam`, otherwise `RepairMachine` — and the right button now tears down. The
  rule itself did not die: it is `serviceCommand` in `hud/derive-service.ts`, unchanged to the
  branch, driving the first row of the machine's own card where the price can be read off the
  button. Deleted rather than left exported, because a repair verb the pointer no longer has any
  business with is exactly the kind of second door that drifts out of step with the first.
*/

/**
 * The Hand verb for a machine. One command, chosen from what the machine most obviously
 * needs — this is a convenience, not an authority: every branch below produces a command
 * the sim re-validates.
 */
function handCommand(view: WorldView, machine: MachineView): Command | null {
  if (isJammed(machine)) return { type: 'WhackJam', machineId: machine.id };

  /*
    **THE BOX** ([[105]]). A `MachineRole.Storage` machine kept its contents in
    `cargoItem`/`cargoCount` while `outputCount` stayed 0, so the unload branch below never
    fired; and a box has no recipe and therefore no hopper, so the load branch never fired
    either. A click on a $250 Root Cellar therefore produced **no command at all** —
    not a refusal, not a tell, nothing — and the same was true of the $80 Hand Cart.

    GATED ON THE ROLE, NEVER ON THE KIND, which is the whole shape of the fix: the cellar and the
    cart are one bug, and the cart is the test that it was fixed in the right place. The sim's
    doors are gated the same way (`putStorage`/`takeStorage`), so a machine that becomes a box
    tomorrow gets this verb with no edit here.

    THE TOW RULE IS THE ARM'S ALONE. `belts.ts` refuses a grabber at a cart the player is towing;
    the HAND must still load one, because loading the cart you are pushing is the entire point of
    pushing it. There is a sim test that fails if this branch ever inherits that gate.
  */
  // `MachineView.kind` crosses the seam as a plain number (§12), so the cast is the same one
  // every other spec lookup on this side makes.
  const spec = machineSpec(machine.kind as MachineKind);
  if (spec !== null && spec.role === MachineRole.Storage) {
    return storageCommand(view, machine, spec.inputCapacity);
  }

  if (machine.kind === MachineKind.SellBin) {
    const item = bestSellable(view);
    return item === null ? null : { type: 'SellItem', item: item.item, count: item.count };
  }

  if (machine.kind === MachineKind.Sprinkler) {
    return { type: 'RefillHopper', machineId: machine.id };
  }

  // The seed hopper ([[038]]): `applyRefillHopper` is the sim's "one door seeds enter by" for
  // hands, and until item 038 no click ever knocked on it — the planter dock fell through the
  // chip-line switch that used to stand where `hopperToFill` now does, so hand-loading seeds
  // was simply impossible, which is how the owner found it. The sim re-validates it (wrong seed,
  // full hopper, nothing in the bag), so this side only knocks. Before the `outputCount`
  // branch on purpose: the dock produces nothing, but a future one that did should still
  // prefer taking in what it exists to consume.
  //
  // THE DRONE BAY USED TO BE THE SECOND HALF OF THIS CONDITION, taking parts by hand the way
  // the planter takes seeds. Item 090 made drone service free and closed the bay's hopper in
  // the sim, so a click that still offered to fill it would open a door that is not there.
  if (machine.kind === MachineKind.PlanterDock) {
    return { type: 'RefillHopper', machineId: machine.id };
  }

  if (machine.outputCount > 0) {
    return { type: 'UnloadMachine', machineId: machine.id, count: machine.outputCount };
  }

  // Every converter takes its own input item, so the hand verb reads the recipe rather
  // than naming a machine: the Washer wants potatoes and the Seasoner wants plain chips,
  // and neither needed a new branch here when the line replaced the monolith.
  const load = hopperToFill(view, machine);
  if (load === null) return null;
  return { type: 'LoadMachine', machineId: machine.id, count: load.count };
}

/**
 * The first hopper this machine has room in that the player is actually carrying for — or
 * null, meaning a click here has nothing to say.
 *
 * **THE COMMENT ABOVE WAS TRUE AND THE CODE UNDER IT WAS NOT** (item 111). "The hand verb
 * reads the recipe rather than naming a machine" described a `switch` over six machine kinds
 * that named six machines, and it had been quietly wrong for a while in two directions:
 *
 *   · **A pepper could be belted into a Seasoner but never carried into one.** The switch
 *     answered `PlainChips` for a Seasoner, the player holding only chilis had none, and the
 *     click did nothing at all — the flavour tier reachable by conveyor and not by hand.
 *   · **The entire soda line was already unloadable BY HAND** and had been since it landed.
 *     The switch listed the chip line and returned null for everything else, so a Grinder
 *     with kola nuts in your arms, a Six-Packer with bottles, a Bottler with an empty
 *     one — every one of them ignored the click. This is the second time this exact hazard
 *     has been recorded on this function: [[038]]'s note above says the planter dock "fell
 *     through `machineInputItem`'s chip-line switch to null, so hand-loading seeds was
 *     simply impossible, which is how the owner found it." That fix added a branch for the
 *     dock. This one deletes the switch.
 *
 * SO IT ASKS THE MACHINE, and `mv.recipe` is every hopper it has (`machineHoppers`), in the
 * order `applyLoadMachine` walks them. A hand verb that offers exactly what the sim's door
 * accepts cannot go stale when a machine grows an ingredient, which is the whole reason the
 * chip-line switch had to go rather than gain three more cases.
 *
 * **IT STILL NAMES NO ITEM, AND THAT IS DELIBERATE** ([[105]]): the field means "whatever
 * fits", boxes require it because they have no recipe, and a recipe machine does not. It
 * matters more now than it did — a click may become a walk, and the sim re-decides which
 * hopper on ARRIVAL against a machine that has been running the whole time we were walking.
 * The count is a click-time snapshot for the same reason it always was, clamped by `Math.min`
 * at the far end.
 *
 * A FULL HOPPER IS SKIPPED rather than offered, matching `applyLoadMachine`'s own `space`
 * test. It is what makes a Seasoner with a packed chip hopper accept the peppers in your
 * other hand instead of refusing the click outright.
 */
function hopperToFill(
  view: WorldView,
  machine: MachineView,
): { item: ItemId; count: number } | null {
  for (let i = 0; i < machine.recipe.length; i++) {
    const line = machine.recipe[i]!;
    if (line.item === 0 || line.count >= machine.inputCapacity) continue;
    const have = countOf(view, line.item as ItemId);
    if (have > 0) return { item: line.item as ItemId, count: have };
  }
  return null;
}

/**
 * What one click on a box means ([[105]]). Load if there is anything sensible to put in, empty
 * it out otherwise, and `null` only when the box is empty and so are you.
 *
 * **THE COMMAND MUST NAME AN ITEM AND THE SIM REFUSES IT SILENTLY OTHERWISE.** A box has no
 * recipe, so nothing in the world could work out what an unnamed `LoadMachine` meant;
 * `applyLoadMachine` returns false on the spot. That refusal is exactly how the Root Cellar came
 * to be a shed that did nothing when clicked, so the item is set here and asserted in the tests.
 *
 * **UNLOADING TAKES EVERYTHING**, which is the open question this item asked, answered: the bag
 * has had no cap since [[068]], `applyUnloadMachine` clamps the ask with `Math.min` against what
 * is actually in there, and one click beats a picker for a verb whose whole job is "give me my
 * things back".
 *
 * **A PART-FULL BOX TOPS UP BEFORE IT EMPTIES.** A cellar holding potatoes with potatoes in your
 * arms is a player stocking it, not raiding it — and if the box is full, or you are carrying
 * something else, the click empties it instead, which is the only other thing it could mean.
 */
function storageCommand(view: WorldView, machine: MachineView, capacity: number): Command | null {
  const held = machine.cargoItem;
  if (machine.cargoCount > 0 && held !== 0) {
    const have = countOf(view, held as ItemId);
    if (have > 0 && machine.cargoCount < capacity) {
      return { type: 'LoadMachine', machineId: machine.id, count: have, item: held as ItemId };
    }
    return { type: 'UnloadMachine', machineId: machine.id, count: machine.cargoCount };
  }

  const stash = bestStorable(view);
  if (stash === null) return null;
  return { type: 'LoadMachine', machineId: machine.id, count: stash.count, item: stash.item };
}

/**
 * The stack an empty box gets: the BIGGEST one in the bag that is not a boxed machine.
 *
 * BIGGEST RATHER THAN MOST VALUABLE, which is the opposite of `bestSellable`'s rule and
 * deliberately so — a box is for bulk, and the thing overflowing your arms is the thing you
 * walked over to put down. The two verbs are answering different questions with the same gesture.
 *
 * BOXED MACHINES ARE EXCLUDED, gated on `boxedMachineKind` because that is the projection's own
 * type tag for the row. A box will physically hold them — the sim's door asks nothing about what
 * an item is — but "click your shed and the $50,000 dock in your arms goes in" is an accident a
 * hand verb must not have, and a boxed machine's verb is placing it. Ties break on the earliest
 * row, so the choice is stable between frames rather than flickering with the bag's order.
 */
function bestStorable(view: WorldView): { item: ItemId; count: number } | null {
  let best: { item: ItemId; count: number } | null = null;
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.count <= 0 || slot.boxedMachineKind !== 0) continue;
    if (best === null || slot.count > best.count) {
      best = { item: slot.item as ItemId, count: slot.count };
    }
  }
  return best;
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

/**
 * The band a live drag shows this frame.
 *
 * Exported for the tests since [[109]], on `ghostBand`'s precedent and for its reason: the
 * sentences a refused pipe run prints ARE the fix, and reaching them through `band()` would
 * mean standing up a canvas, a camera and a host to read a string.
 */
export function dragBand(view: WorldView, drag: Drag, crop: CropId, picked: LiquidId): BandState {
  const run = runFor(drag);
  const bounds = runBounds(run);

  if (run.kind === 'line') {
    if (drag.tool === ToolMode.PlacePipe) return pipeBand(view, run, bounds, picked);
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
 * The pipe band ([[101]]): the L the drag will lay, and — the whole reason it is its own
 * function — **what the run is going to carry, in words, before the button comes up**.
 *
 * THE LABEL IS THE LIQUID PICKER. There is no picker key (see `pipeRunLiquid`), so the one
 * thing this band owes the player is the answer the inference reached, spelled out and updated
 * every frame as the run grows past one machine and up to the next. "17 tiles · $34.00 · water
 * ←↑" is a sentence a player can disagree with while they still have a chance to — by dragging
 * the other way — which is the standard the belt's own "R flips the corner" tag set.
 *
 * WHOLE-RUN COLOURING, LIKE THE BELT AND FOR THE IDENTICAL REASON: `applyPlacePipe` accepts or
 * refuses the entire path and there is no partial lay ("A drag that clips a machine half way
 * along should not leave the player with a stub"). Colouring per tile would advertise a mostly
 * green L that builds nothing.
 */
function pipeBand(view: WorldView, run: LineRun, bounds: Bounds, picked: LiquidId): BandState {
  const tiles = runTiles(run);
  const length = runLength(run);
  const cost = PIPE_PRICE_CENTS_PER_TILE * length;
  const carried = pipeRunLiquid(view, tiles, picked);
  const clear = pipeTilesClear(view, tiles);
  const ok = carried.liquid !== LiquidId.None && clear && view.moneyCents >= cost;
  const tone: BandTone = ok ? 'pipe' : 'blocked';
  const bent = run.turnLengthTiles > 0;
  const heading = bent ? `${arrow(run.dir)}${arrow(run.turnDir)}` : arrow(run.dir);
  // "(picked)" IS NOT DECORATION — it is the difference between a fact the world told the
  // player and an answer the player gave, and a tag that says "cane juice" for both is a tag
  // that teaches the wrong lesson about which one they can change ([[109]]).
  const name = liquidName(carried.liquid) + (carried.source === 'picked' ? ' (picked)' : '');

  return {
    ...bounds,
    tone,
    cells: tiles.map((tile) => ({ x: tile.tileX, y: tile.tileY, tone })),
    // THE REFUSAL OUTRANKS THE PRICE. A run with no liquid is not a cheaper run, it is not a
    // run, and quoting "$34.00" under a red band would be the tag answering a question nobody
    // asked. The sentence names the rule the sim is about to enforce — one liquid per network,
    // typed ports — rather than the tone.
    //
    // AND THE TWO REFUSALS ARE DIFFERENT SENTENCES ([[109]]). "Nothing would share a liquid" is
    // a verdict about the world: these machines disagree and no pipe can join them, so there is
    // nothing to do but drag somewhere else. "Nothing SAYS what this carries" is a question,
    // and it is the only tag in this file that names its own way out — the tile count is
    // dropped from it deliberately, because a run that is not a decision yet has no size worth
    // quoting and the sentence needs the room.
    label:
      carried.source === 'untyped'
        ? 'nothing here says what this carries — press L, or start at a machine'
        : carried.source === 'mismatch'
          ? `${length} tiles · nothing here would share a liquid`
          : bent
            ? `${length} tiles · ${formatCents(cost)} · ${name} ${heading} · R flips the corner`
            : `${length} tile${length === 1 ? '' : 's'} · ${formatCents(cost)} · ${name} ${heading}`,
    // No chevron, for the belt's reason exactly: a pipe has no facing. Flow direction is the
    // network's ledger, decided by where the pump is, and a shape that means "R turns this"
    // must never appear on something R does not turn.
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
 * The tone each till mode fills its converting tiles with — and `box` is a BORROWED word, not
 * a new one ([[127]]).
 *
 * `zone` green is "this becomes farmland" and `erase` red is "this goes back to grass, ground
 * released", exactly as un-zoning releases a zone. The middle rung does NEITHER: the ground it
 * touches is farmland before and farmland after, and the only thing that moves is the crop —
 * off the tile and into your bag. That is the sentence teardown's `box` blue was invented to
 * say (`chrome.ts`: *"`erase` red is 'off the lot, money back' and this is 'into your bag'"*),
 * so an un-plant says it in the same colour rather than in a fourth one the player would have
 * to learn separately. A boxed Fryer and a lifted potato are the same promise.
 */
const TILL_TONE: Readonly<Record<TillMode, BandTone>> = {
  [TillMode.Till]: 'zone',
  [TillMode.Unplant]: 'box',
  [TillMode.Untill]: 'erase',
};

/**
 * What a rectangle that converts NOTHING says, per mode.
 *
 * A RECORD RATHER THAN A TERNARY, and that is the whole point of it: a `TillMode` this table
 * has no row for is a compile error, which is exactly what did not happen when the middle rung
 * landed in the sim and every two-way `mode === Till ? … : …` in this file silently kept
 * answering for a third case it had never heard of.
 */
const TILL_EMPTY_LABEL: Readonly<Record<TillMode, string>> = {
  [TillMode.Till]: 'nothing here to till',
  [TillMode.Unplant]: 'nothing here to lift',
  [TillMode.Untill]: 'nothing to return to grass',
};

/**
 * The till band: exactly the tiles this drag would convert, filled; everything the sim will
 * skip — machines, water, ground already in the asked-for state, tiles that do not match the
 * mode the anchor picked — shows through.
 *
 * PER-TILE, LIKE TEARDOWN AND FOR THE SAME REASON: a till is N independent conversions and
 * the tiles genuinely disagree, so a single fill would have to lie about the sprinkler
 * standing mid-rectangle. An empty result keeps the plain outline in the refusal tone, like a
 * teardown over bare dirt.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE UN-PLANT NAMES WHAT COMES BACK, AND IT IS SPENT ONLY WHERE THE LIFT HAPPENS ([[127]]).
 *
 *  Item 121 taught the placement ghost to say *"returns 1 potato seed"* before a sprinkler
 *  uproots a row, and a drag that lifts sixty tiles owes the player that sentence far more
 *  than a single click did. Same function, same nouns, same sim slugs — `handBackOver`, which
 *  is item 121's `handBackPhrase` with its footprint loop lifted out so both callers can hand
 *  it a set of tiles.
 *
 *  **AND THE TRAP THAT CAUGHT ITEM 121 CANNOT BE SPRUNG HERE, BY CONSTRUCTION.** Over there
 *  the tell was computed from the ghost's BOUNDS and then gated on a legality flag assembled
 *  separately — so when `footprintClear` (a refusal with no words) started failing, the gate
 *  and the tell disagreed and a blocked click went on advertising a seed it would never pay.
 *  The fix was to gate the tell on `free`. Here there is nothing to gate: the phrase is
 *  computed from `cells`, which IS the set of tiles `tillConverts` said the reducer will take.
 *  A tile the sim will skip is not in that list, so it cannot contribute a noun — and a
 *  rectangle that converts nothing returns above, before the phrase is ever built. The tell
 *  is not permitted to outlive the action because it is derived from the action.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
function tillBand(view: WorldView, bounds: Bounds, mode: TillMode): BandState {
  const tone = TILL_TONE[mode];
  const cells: BandCell[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (tillConverts(view, x, y, mode)) cells.push({ x, y, tone });
    }
  }

  if (cells.length === 0) {
    return { ...bounds, tone: 'blocked', label: TILL_EMPTY_LABEL[mode], dir: Direction.None };
  }

  const n = cells.length;
  const tiles = `${n} tile${n === 1 ? '' : 's'}`;
  let label: string;
  if (mode === TillMode.Till) {
    label = `till ${tiles}`;
  } else if (mode === TillMode.Untill) {
    label = `${tiles} → grass`;
  } else {
    // Every cell here is laden — that is what `tillConverts` asked — so the phrase is never
    // empty in practice. It is still checked, because "never in practice" is how the last
    // ghost that lied got written.
    const handBack = handBackOver(view, cells);
    label = handBack === '' ? `lift ${tiles}` : `lift ${tiles} · ${handBack}`;
  }

  return { ...bounds, tone, cells, label, dir: Direction.None };
}

/**
 * **THE PLANT GHOST** ([[103]]): which crop is armed, and why this tile will refuse it.
 *
 * THE ARMED CROP HAD NO SURFACE UNTIL THE BUTTON WAS DOWN. `C` has cycled a crop since zones
 * landed, and its only feedback was the label on a live zone drag — so a player hand-planting
 * had no way to find out what they were about to sow, and no way to discover the key at all.
 * This is the same 1×1 hover band the till already draws, saying the one thing the tool is
 * currently about.
 *
 * THE SEED COUNT IS A READOUT AND NOT A GATE, in the sense §12 means: the band goes red on an
 * empty bag because `applyPlantTile` will refuse the click, and it refuses SILENTLY (nothing is
 * spent, so there is no sound and no flash). Every refusal below mirrors a line of that reducer
 * — no crop on an occupied tile, no planting off the field, the tech gate — and the sim remains
 * the authority for all of them.
 */
export function plantBand(view: WorldView, hover: HoverTile, crop: CropId): BandState {
  const bounds = { x: hover.tileX, y: hover.tileY, w: 1, h: 1 };
  const name = cropName(crop);
  const spec = cropSpec(crop);
  const query = tileAtView(view, hover.tileX, hover.tileY);

  const refusal =
    spec === null
      ? 'no such crop'
      : !query.insideWorld || !query.owned
        ? 'not your land'
        : query.machine !== null
          ? 'a machine is in the way'
          : !query.isField
            ? 'till it first'
            : query.crop !== 0
              ? 'already planted'
              : countOf(view, spec.seedItem) <= 0
                ? 'no seed in the bag'
                : '';

  // "C" is on the green label only. A red band owes the player the reason it is red ([[067]]'s
  // rule for the placement ghost), and "already planted · C to change" would be answering a
  // question they did not ask with the answer to one they did not either.
  return {
    ...bounds,
    tone: refusal === '' ? 'zone' : 'blocked',
    label: refusal === '' ? `${name} · C to change` : `${name} · ${refusal}`,
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
  // The liquid layer's own three refusals, in words, BEFORE the click ([[109]]).
  const liquidReason = liquidRefusal(view, bounds, kind);
  // What this placement would lift out of the ground and hand back ([[121]]). Not a refusal —
  // the tile is legal — which is why it is kept apart from the two reasons above and only
  // reaches the label where they are silent.
  const handBack = handBackPhrase(view, bounds, fieldPlaceable);
  const free =
    farmReason === '' &&
    liquidReason === '' &&
    footprintClear(view, bounds) &&
    view.moneyCents >= cost;
  // Two red reasons cannot both fit on one tag, and farmland outranks plumbing for the same
  // reason it outranks the coverage boast below: "not on farmland" is about the ground the
  // player is pointing at, and the pipe two tiles away is the subtler complaint.
  const refusal = farmReason !== '' ? farmReason : liquidReason;
  // ONE CLAUSE, IN PRIORITY ORDER: why not, else what you give up, else what it does. The
  // hand-back sits above the coverage boast because it is a consequence of THIS click on THIS
  // tile, while "waters 5×5" is a fact about the machine that is true wherever it lands — and
  // a player about to uproot a row needs the first sentence more than the second ([[121]]).
  //
  // AND THE HAND-BACK IS GATED ON `free`, WHICH IS THE HALF ITEM 121 GOT WRONG. The comment
  // above `handBack` says "not a refusal — the tile is legal", and that was only ever true of
  // the two reasons that HAVE words. `footprintClear` is a third refusal and it is mute: when
  // it fails, `refusal` is still `''`, so the tell fell through and a blocked placement went on
  // advertising *"returns 1 potato seed"*. Item 120 made that reachable by letting a pipe lie
  // on farmland. Promising goods for a click that cannot happen is the one thing this tell
  // exists to prevent, so it is spent only where the click is genuinely free.
  const aside = refusal !== '' ? refusal : free ? handBack : '';
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
        aside !== ''
          ? `${TOOL_INFO[tool].label} · ${aside}`
          : `${TOOL_INFO[tool].label} · ${toolCoverageVerb(tool)} ${span}×${span}`,
      dir: Direction.None,
    };
  }

  return {
    ...bounds,
    tone,
    label:
      aside !== ''
        ? `${TOOL_INFO[tool].label} · ${aside}`
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
      // THE PIPE, AND ITEMS 120 AND 121 TOGETHER ARE WHY IT IS HERE. The sim's
      // `machineFootprintFree` asks `tileOccupied`, which counts a pipe; this mirror did not,
      // and before item 120 that could not matter, because a pipe could never be on farmland
      // and so never under a field-placeable machine's footprint. Item 120 made it reachable
      // and item 121 made it LOUD: the band went green and offered back a seed
      // ("Buy Sprinkler · returns 1 potato seed") for a click the reducer then refused. A
      // ghost that names goods it will not hand over is worse than one that simply refuses.
      if (pipeAtView(view, x, y) !== null) return false;
    }
  }
  return true;
}

/**
 * Why a footprint's overlap with FARMLAND refuses, phrased for the tag — or `''` when the
 * farmland raises no objection ([[067]]).
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  ONE CLAUSE, AND ITEM 121 IS WHY IT IS ONE. This used to refuse a flagged machine over a
 *  crop ("a crop is in the way"), on item 067's house rule that nothing is silently destroyed.
 *  The owner's ruling supersedes it and keeps the rule intact by paying instead: the placement
 *  lifts the crop and hands back the seed and the produce (`clearFieldTileForMachine` in the
 *  sim). So the clause is DELETED here, and what is left mirrors `machineFootprintFree`'s field
 *  branch exactly — `fieldPlaceable` is the whole test.
 *
 *  **DO NOT LET A SECOND CLAUSE GROW BACK.** A legality that read the crop would flicker from
 *  legal to illegal under a stationary cursor as a tile ripened, which is the worst shape a
 *  build rule can have and the reason the sim's own predicate reads nothing about what is
 *  growing. What the crop feeds is the TELL (`handBackPhrase`), never the tone.
 *
 *  Pinned against the sim's exported `machineFootprintFree` in `pipe-mirror.test.ts`.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
function farmRefusal(view: WorldView, bounds: Bounds, fieldPlaceable: boolean): string {
  if (fieldPlaceable) return '';
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (tileAtView(view, x, y).isField) return 'not on farmland';
    }
  }
  return '';
}

/**
 * What this placement would HAND BACK, named for the tag — or `''` when it takes nothing up
 * (item 121).
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE POINT IS THAT THE PLAYER IS NOT SURPRISED. A sprinkler dropped on a planted row is legal
 *  now and quietly performs a harvest, and "legal" plus "quiet" is how a player loses a crop
 *  they were saving. So the ghost names the goods before the click: *"Buy Sprinkler · returns 1
 *  potato seed"*.
 *
 *  EVERY NOUN COMES OFF THE SIM'S OWN SLUGS, never a second table — `harvestItemFor` is
 *  exported precisely so this does not keep its own opinion about what a crop yields, and the
 *  seed is `CropSpec.seedItem`. A tell that invented its own names would eventually name the
 *  wrong thing, which is worse than saying nothing.
 *
 *  COUNTS ARE GIVEN ONLY WHERE THEY ARE CERTAIN. Seeds are exact — one per cropped tile. The
 *  PRODUCE count is deliberately not quoted: it is `HARVEST_BASE_COUNT + a 0-or-1 RNG roll`,
 *  and the roll is drawn from a stream that `nextBelow` MUTATES, so peeking it for a tooltip
 *  would risk a determinism bug for a string. The produce is named and left uncounted, which
 *  is the honest half of what is known.
 *
 *  AGGREGATED OVER THE WHOLE FOOTPRINT, because a 2×2 Irrigation Hub lifts four tiles and a
 *  tell that described only the anchor would undercount by three.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
function handBackPhrase(view: WorldView, bounds: Bounds, fieldPlaceable: boolean): string {
  if (!fieldPlaceable) return '';
  // A footprint is 2×2 at the very largest (the Irrigation Hub), so this list costs four
  // objects on a hover frame that already builds twenty-five `BandCell`s for the coverage
  // square below. Spelling the tiles out is what lets the till hand its own set in.
  const tiles: TileXY[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) tiles.push({ x, y });
  }
  return handBackOver(view, tiles);
}

/** A tile named by the two coordinates `BandCell` already carries, so a cell list is one. */
interface TileXY {
  x: number;
  y: number;
}

/**
 * The body of `handBackPhrase`, over AN ARBITRARY SET OF TILES rather than a rectangle
 * ([[127]]).
 *
 * WHY THE LOOP CAME OUT. A placement lifts every tile of its footprint, so "the footprint" and
 * "the tiles that will actually be lifted" were the same list and the distinction did not
 * exist. A till drag breaks that: the rectangle is whatever the player waved over, and the
 * tiles the reducer will genuinely take are the subset `tillConverts` accepts — grass, water,
 * machines and bare dirt all sit inside the same rect and none of them hands anything back.
 * Passing the SET rather than the BOUNDS is what keeps this tell honest under a drag, and it
 * is the structural version of the `free` gate item 121 had to add after the fact.
 */
function handBackOver(view: WorldView, tiles: readonly TileXY[]): string {
  let seeds = 0;
  let crop = 0;
  let mixed = false;
  const produce: number[] = [];

  for (let i = 0; i < tiles.length; i++) {
    const at = tiles[i]!;
    const query = tileAtView(view, at.x, at.y);
    if (!query.isField) continue;
    if (query.crop === 0) continue;
    // ONE SEED PER PLANT IN THE GROUND, ripe or not — including a regrowing crop, which a
    // hand harvest leaves standing and a placement uproots (the sim's ruling).
    seeds += 1;
    if (crop === 0) crop = query.crop;
    else if (crop !== query.crop) mixed = true;
    if (!query.ready) continue;
    const spec = cropSpec(query.crop as CropId);
    if (spec === null) continue;
    const item = harvestItemFor(spec);
    if (!produce.includes(item)) produce.push(item);
  }

  if (seeds === 0) return '';

  const parts: string[] = [];
  for (let i = 0; i < produce.length; i++) parts.push(goodsName(produce[i]!));
  if (seeds > 0) {
    const seedSpec = mixed || crop === 0 ? null : cropSpec(crop as CropId);
    parts.push(
      seedSpec === null
        ? `${seeds} seed${seeds === 1 ? '' : 's'}`
        : `${seeds} ${goodsName(seedSpec.seedItem)}${seeds === 1 ? '' : 's'}`,
    );
  }
  return `returns ${parts.join(' + ')}`;
}

/**
 * An item's name in words, off the sim's own slug — the same trick `liquidName` plays, and for
 * the same reason: the game layer does not import the HUD's copy modules, and a hand-written
 * table here would be a second set of nouns to drift.
 */
function goodsName(item: number): string {
  return (itemSpec(item as ItemId)?.slug ?? 'goods').split('-').join(' ');
}

/**
 * Why the LIQUID LAYER refuses this footprint, phrased for the tag — or `''` when it does not
 * ([[109]]).
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE OTHER HALF OF THE BUG, AND THE HALF NOBODY COULD SEE.
 *
 *  `liquidPlacementRefusal` is the sim's rule for a machine landing beside plumbing, and it had
 *  NO MIRROR IN THIS APP AT ALL: every one of its three refusals reached the player as a click
 *  that did nothing. Drop a Carbonator beside a water main you did not mean to lay and the
 *  ghost stayed green, the click went out, the reducer said `PortMismatch`, and the machine
 *  simply did not appear — no red, no sentence, nothing to connect "the pipe" to "the refusal".
 *  That is the second half of the sentence item 109 is about: the run picked wrong in silence,
 *  and then the machine refused in silence.
 *
 *  A HINT, NEVER A GATE (§12), exactly like `farmRefusal` above. The sim re-checks all three
 *  and remains the authority; this only explains the red before the money is spent.
 *
 *  IT MIRRORS THE SIM FUNCTION IN THE SIM'S OWN ORDER — bank, then one-pump-per-network, then
 *  the port rule — so that when two of them are true at once the tag names the one the reducer
 *  would have named. Every input is view-readable: `reservoirs` for the bank,
 *  `PipeView.network` and `MachineView.network` for the pump count, and the spec's ports for
 *  the liquid, which is the same table `machineLiquids` reads for the run.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
function liquidRefusal(view: WorldView, bounds: Bounds, kind: MachineKind | null): string {
  if (kind === null) return '';
  const spec = machineSpec(kind);
  if (spec === null) return '';

  if (spec.role === MachineRole.Pump) {
    // The bank rule, off the ANCHOR TILE and not the footprint, because that is the tile the
    // sim asks about (`reservoirAdjacentToTile(state, command.tileX, command.tileY)`). A
    // mirror that checked the whole footprint would go green on a placement the reducer throws
    // away the moment a pump grows past 1×1.
    const onBank =
      reservoirAtTile(view, bounds.x, bounds.y) ||
      reservoirAtTile(view, bounds.x, bounds.y - 1) ||
      reservoirAtTile(view, bounds.x + 1, bounds.y) ||
      reservoirAtTile(view, bounds.x, bounds.y + 1) ||
      reservoirAtTile(view, bounds.x - 1, bounds.y);
    if (!onBank) return 'it has to stand on the reservoir bank';

    const touched = adjacentNetworks(view, bounds);
    for (let i = 0; i < view.machines.length; i++) {
      const machine = view.machines[i]!;
      if (machineSpec(machine.kind as MachineKind)?.role !== MachineRole.Pump) continue;
      if (machine.network !== 0 && touched.includes(machine.network)) {
        return 'that line already has a pump';
      }
    }
  }

  // THE PORT RULE, FROM THE MACHINE'S SIDE — the refusal item 109 was reported through. A
  // machine with no plumbing at all is invisible to it, which is why this reads the same
  // `machineLiquids` the run's inference does rather than a second copy of the rule.
  const accepts = machineLiquids(kind);
  if (accepts.length === 0) return '';
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      for (let n = 0; n < 4; n++) {
        const pipe = pipeAtView(view, x + PIPE_NEIGHBOUR_DX[n]!, y + PIPE_NEIGHBOUR_DY[n]!);
        if (pipe === null) continue;
        // `PipeView.liquid` crosses the seam as a bare number (§12), the same way
        // `GrabberView.dir` does for `arrow` — branded here, at the one place that reads it.
        const carried = pipe.liquid as LiquidId;
        if (accepts.includes(carried)) continue;
        // NAMES THE PIPE, because the pipe is the thing that has to move — or be picked up —
        // and "no port" alone would send the player looking at the machine.
        return `no port for the ${liquidName(carried)} pipe beside it`;
      }
    }
  }
  return '';
}

/** Every pipe network orthogonally touching this footprint. The pump's one-per-line check. */
function adjacentNetworks(view: WorldView, bounds: Bounds): number[] {
  const networks: number[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      for (let n = 0; n < 4; n++) {
        const pipe = pipeAtView(view, x + PIPE_NEIGHBOUR_DX[n]!, y + PIPE_NEIGHBOUR_DY[n]!);
        if (pipe !== null && !networks.includes(pipe.network)) networks.push(pipe.network);
      }
    }
  }
  return networks;
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

/**
 * Keyed on `CropId` rather than on bare numbers, and complete — the Gold Potato's absence here
 * was the second half of its exile ([[103]]): a crop the cycle could not reach and the band
 * could not name. The HUD spells the same names from `itemName(spec.yieldItem)`; this table
 * stays hand-written because the game layer does not import the HUD's copy modules.
 */
const CROP_NAMES: Readonly<Record<number, string>> = {
  [CropId.RussetPotato]: 'Russet Potato',
  [CropId.SugarCane]: 'Sugar Cane',
  [CropId.Corn]: 'Corn',
  [CropId.ChiliPepper]: 'Chili Pepper',
  [CropId.GoldPotato]: 'Gold Potato',
};

export function cropName(crop: number): string {
  return CROP_NAMES[crop] ?? 'unassigned';
}
