// The input system: one object the host attaches, detaches, and ticks.
//
// WHY THIS EXISTS RATHER THAN TWO MORE MEMBERS ON `InputHost`. The v0.2 gestures need a
// handful of pieces of cursor state — the crop a new zone gets, which way a grabber will
// face, whether space is down, where the build menu's cursor is. None of that is a
// capability the host grants; it is the input layer's own business. Threading each one
// through `InputHost` would widen the narrowest interface in the app once per feature until
// it stopped being narrow, so the host grants a canvas, a camera, a queue, a projection and
// a DOM node, and everything else lives here.
//
// NOTHING IN THIS FILE IS SIM STATE. Zoom, rotation, the armed crop and the menu are UI
// state: never a `Command`, never traced, never hashed, never saved (§12). The only door
// into the world is `host.queue.push`, and only `pointer.ts` and `keyboard.ts` use it.

import type { CropId, WorldView } from '@snack/sim';
import { CropId as Crop, Direction, cropSpec, techSatisfied } from '@snack/sim';

import { InputChrome } from './chrome';
import type { InputHost } from './context';
import { KeyboardInput } from './keyboard';
import { publishLod, viewLod, zoomInIndex, zoomOutIndex } from './lod';
import { PointerInput } from './pointer';
import { DEFAULT_ZONE_CROP, ToolMode } from './tools';

/** Cycle order for `C`. Locked crops are skipped, not shown greyed — this is a toggle. */
const CROP_CYCLE: readonly CropId[] = [
  Crop.RussetPotato,
  Crop.SugarCane,
  Crop.Corn,
  Crop.ChiliPepper,
];

/** Rotation order for `R`. Clockwise from north, because that is what a dial does. */
const DIR_CYCLE: readonly Direction[] = [
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];

export class InputSystem {
  private readonly chrome: InputChrome;
  private readonly pointer: PointerInput;
  private readonly keyboard: KeyboardInput;

  /** Held space turns any left-drag into the camera's gesture. See `pointer.ts`. */
  spaceHeld = false;
  /** The crop a brand-new zone is created with. */
  zoneCrop: CropId = DEFAULT_ZONE_CROP;
  /** The way the next grabber will face — the direction it moves goods. */
  placeDir: Direction = Direction.East;

  constructor(private readonly host: InputHost) {
    this.chrome = new InputChrome(host.overlayRoot, host.camera, {
      arm: (tool) => host.setTool(tool),
      latestView: () => host.latestView(),
    });
    this.pointer = new PointerInput(host, this);
    this.keyboard = new KeyboardInput(host, this);
  }

  attach(): void {
    this.chrome.mount();
    this.pointer.attach();
    this.keyboard.attach();
    // The camera ships at `DEFAULT_ZOOM_INDEX`; publish it so the renderer's LOD flag is
    // right on frame one rather than on the first scroll wheel notch.
    publishLod(this.host.camera.zoomIndex_);
  }

  detach(): void {
    this.pointer.detach();
    this.keyboard.detach();
    this.chrome.unmount();
  }

  /**
   * Called once per frame from the host's single rAF loop, AFTER the camera has been
   * applied — the band is positioned by inverting the transform that actually reached the
   * display this frame, exactly as picking does. Positioning it from a stale transform puts
   * the rectangle a tile off near the viewport edges, drifting as the player walks.
   */
  update(): void {
    const tool = this.host.getTool();
    this.chrome.setBand(this.pointer.band());
    this.chrome.setHint(tool, this.host.camera.transform.zoom, this.pointer.rotateAdvertised(tool));
    this.chrome.tick(tool);
  }

  // --- zoom ------------------------------------------------------------------------------

  /**
   * Move one rung along the integer ladder. `delta` is +1 in, −1 out.
   *
   * INTEGER LEVELS ONLY, AND NOTHING BETWEEN THEM (§13). A 2.4× zoom on 16 px tiles
   * shimmers and the cause is arithmetic, not filtering: fractional scaling maps source
   * pixels onto non-integer device pixels, so some source pixels get two device pixels and
   * their neighbours get three. No filter mode rescues that, so there is no smooth zoom, no
   * tween, and no pinch — the scale snaps and the camera keeps its whole-pixel snap at
   * every rung, which `Camera.apply()` already enforces.
   */
  stepZoom(delta: number): void {
    const camera = this.host.camera;
    const current = camera.zoomIndex_;
    const next = delta > 0 ? zoomInIndex(current) : zoomOutIndex(current);
    if (next === current) return;
    camera.setZoomIndex(next);
    publishLod(next);
  }

  get zoom(): number {
    return viewLod.zoom;
  }

  // --- the build menu ----------------------------------------------------------------------

  get menuOpen(): boolean {
    return this.chrome.menuOpen;
  }

  toggleBuildMenu(): void {
    if (this.chrome.menuOpen) {
      this.chrome.closeMenu();
      return;
    }
    // Stop walking as the menu opens. One command, on a real state edge — the character
    // genuinely stops, so the trace is not lying about anything.
    this.keyboard.stopWalking();
    this.chrome.openMenu(this.host.getTool());
  }

  closeBuildMenu(): void {
    this.chrome.closeMenu();
  }

  moveMenuCursor(delta: number): void {
    this.chrome.moveCursor(delta, this.host.getTool());
  }

  jumpMenuCursor(oneBased: number): void {
    this.chrome.jumpTo(oneBased, this.host.getTool());
  }

  armMenuCursor(): void {
    this.chrome.armCursor();
  }

  // --- cursor state ------------------------------------------------------------------------

  get dragging(): boolean {
    return this.pointer.dragging;
  }

  cancelDrag(): void {
    this.pointer.cancelDrag();
  }

  /**
   * R. One press, one quarter turn — of the arm under the cursor if there is one, and of the
   * ghost otherwise.
   *
   * THE PLACED ARM WINS, AND THE ORDER IS THE FEATURE. Item 052 exists because R only ever
   * meant "cycle a variable that nothing visible reads": rotating an arm you had already put
   * down was impossible, so a player who placed one facing the wrong way had to sell it and
   * place another. Hovering the thing you want to turn is the most direct statement of intent
   * available, so it outranks the ghost.
   *
   * THE ROTATE IS A COMMAND AND THE GHOST IS NOT, which is the whole seam in one method. One
   * press is one `RotateGrabber` in the trace, applied at a tick boundary and re-validated by
   * the sim; `placeDir` is cursor state that is never traced, never hashed and never saved.
   *
   * MID-DRAG R KEEPS ITS OLD MEANING, per the item's constraints. Nothing draggable rotates,
   * so this is a promise not to surprise a player halfway through a belt run rather than a
   * behaviour anybody will notice.
   */
  rotate(): void {
    if (!this.dragging) {
      const command = this.pointer.rotateCommand();
      if (command !== null) {
        this.host.queue.push(command);
        return;
      }
    }
    this.rotatePlacement();
  }

  /** Cycle the direction the NEXT arm will face. Cursor state; emits nothing. */
  rotatePlacement(): void {
    const index = DIR_CYCLE.indexOf(this.placeDir);
    this.placeDir = DIR_CYCLE[(index + 1) % DIR_CYCLE.length]!;
  }

  /**
   * Cycle the crop a new zone will be assigned, skipping anything unresearched.
   *
   * Skipping rather than offering-and-refusing: `CreateZone` is rejected outright by the
   * reducer for a crop whose node is not unlocked, so arming one would build a gesture that
   * cannot possibly work. The tech tree is where you learn chili exists; this is a dial.
   */
  cycleZoneCrop(): void {
    const view = this.host.latestView();
    const unlocked = view?.unlocked ?? [];
    const start = CROP_CYCLE.indexOf(this.zoneCrop);

    for (let step = 1; step <= CROP_CYCLE.length; step++) {
      const candidate = CROP_CYCLE[(start + step) % CROP_CYCLE.length]!;
      const spec = cropSpec(candidate);
      if (spec === null) continue;
      if (!techSatisfied(unlocked, spec.requiresTech)) continue;
      this.zoneCrop = candidate;
      return;
    }
  }

  /** Handy for a future zone card; nothing reads it yet. */
  currentView(): WorldView | null {
    return this.host.latestView();
  }

  /** The armed tool, for anything that needs it without reaching for the host. */
  get tool(): ToolMode {
    return this.host.getTool();
  }
}
