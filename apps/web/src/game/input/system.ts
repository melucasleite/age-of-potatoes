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

import { publishArmedTool } from './armed-tool';
import { BUILD_GRID_COLS, buildRows, moveGridCursor } from './build-menu';
import type { BuildRow, GridDirection } from './build-menu';
import { publishBuildMenu, registerBuildMenuHooks } from './build-panel';
import { InputChrome } from './chrome';
import type { InputHost } from './context';
import { publishDebugPanel, registerDebugPanelHooks } from './debug-panel';
import { firstRunSigns } from './first-run';
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

  // --- the build menu's state, owned here since [[071]] ------------------------------------
  //
  // The SURFACE is React now (`hud/BuildMenu.tsx`, in the sidebar's contextual slot), but the
  // modality — arrows and digits are the menu's while it is up, walking stops — belongs to
  // this layer, so the state does too. Every mutation below ends in `publishMenu()`, which
  // hands a frozen snapshot across the seam (`build-panel.ts`).
  private menuVisible = false;
  private menuCursor = 0;
  private menuRows: BuildRow[] = [];
  /** Frames until the open menu re-reads the projection. The old chrome's cadence, kept. */
  private menuRefresh = 0;
  private unregisterMenuHooks: (() => void) | null = null;

  // --- the debug panel's state, owned here since [[075]] -----------------------------------
  //
  // Backquote's panel follows the build menu's split exactly: the SURFACE is the HUD's
  // (rendered off `debug-panel.ts`'s snapshot), the key and the command are this layer's.
  // The verdict counters are observations of `view.stats.cheatsUsed` — see the seam's
  // header for why input never keeps a code table of its own.
  private debugVisible = false;
  private cheatAccepted = 0;
  private cheatRejected = 0;
  private lastRejectedCode = '';
  /** The submitted code whose verdict the next projections will reveal, if any. */
  private cheatPending: { code: string; before: number; issuedViewTick: number } | null = null;
  private unregisterDebugHooks: (() => void) | null = null;

  constructor(private readonly host: InputHost) {
    this.chrome = new InputChrome(host.overlayRoot, host.camera);
    this.pointer = new PointerInput(host, this);
    this.keyboard = new KeyboardInput(host, this);
  }

  attach(): void {
    this.chrome.mount();
    this.pointer.attach();
    this.keyboard.attach();
    // The click path in from the React grid. Registered per attach so a StrictMode remount
    // ends up with the LIVE system holding the doors, not the disposed one.
    this.unregisterMenuHooks = registerBuildMenuHooks({
      armAt: (index) => this.armMenuIndex(index),
      close: () => this.closeBuildMenu(),
    });
    // The debug panel's doors, same lifetime discipline as the menu's ([[075]]).
    this.unregisterDebugHooks = registerDebugPanelHooks({
      submitCode: (code) => this.submitCheatCode(code),
      close: () => this.closeDebugPanel(),
    });
    this.publishDebug();
    // The camera ships at `DEFAULT_ZOOM_INDEX`; publish it so the renderer's LOD flag is
    // right on frame one rather than on the first scroll wheel notch. Same for the armed
    // tool: the held-tool overlay must be right before the first key is ever pressed.
    publishLod(this.host.camera.zoomIndex_);
    publishArmedTool(this.host.getTool());
  }

  detach(): void {
    this.closeBuildMenu();
    this.closeDebugPanel();
    this.unregisterMenuHooks?.();
    this.unregisterMenuHooks = null;
    this.unregisterDebugHooks?.();
    this.unregisterDebugHooks = null;
    this.cheatPending = null;
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
    // The safety net for the armed-tool contract (`armed-tool.ts`): every arming edge
    // publishes at the edge, and this catches any path a later feature forgets to wire.
    // A no-change publish is one comparison.
    publishArmedTool(tool);
    // The paint hold ([[072]]) steps here, after the camera is applied for the same reason
    // the band is positioned here: while WASD walks the row, tiles scroll under a stationary
    // cursor, and only the frame loop can see that happen. No hold in progress is one check.
    this.pointer.update();
    this.chrome.setBand(this.pointer.band());
    // The deed signs stand on the land rather than following the cursor, so they are driven by
    // the frame loop like the band and unlike anything hover-driven — the camera moves while
    // the player walks, and a sign that only updated on pointer moves would drift off its own
    // parcel the moment somebody put the mouse down and used the keyboard.
    const view = this.host.latestView();
    this.chrome.setDeedSigns(view);
    // The first-run pointers stand on the world exactly as the deed signs do, and retire
    // themselves by reading the same projection — see `first-run.ts` for the gates.
    this.chrome.setGuideSigns(firstRunSigns(view));
    this.chrome.setHint(tool, this.host.camera.transform.zoom, this.pointer.rotateAdvertised(tool));
    // The work-queue tell ([[074]]): "planting 6 more…" while the farmer marches the row,
    // the pause reason while the can is dry, one brief "already soaked" ([[081]]).
    this.chrome.setQueueTell(this.pointer.queueTell());
    // A submitted cheat's verdict, read off the projection once the sim has spoken.
    this.judgePendingCheat(view);

    // The open menu re-reads the projection a few times a second — prices, locks and the
    // deed's ladder are live while you shop. `publishMenu` compares before it notifies, so
    // the common no-change case costs a field walk and no React work at all.
    if (this.menuVisible) {
      if (this.menuRefresh > 0) {
        this.menuRefresh -= 1;
      } else {
        this.menuRefresh = 20;
        this.menuRows = buildRows(view);
        this.publishMenu();
      }
    }
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
    return this.menuVisible;
  }

  toggleBuildMenu(): void {
    if (this.menuVisible) {
      this.closeBuildMenu();
      return;
    }
    // Stop walking as the menu opens. One command, on a real state edge — the character
    // genuinely stops, so the trace is not lying about anything.
    this.keyboard.stopWalking();
    this.menuRows = buildRows(this.host.latestView());
    this.menuRefresh = 20;
    // The cursor lands on the tool you are holding — reopening the menu resumes the
    // conversation — or on the first unlocked cell for a hand tool that has no cell here.
    const armed = this.menuRows.findIndex((row) => row.tool === this.host.getTool());
    this.menuCursor = armed >= 0 ? armed : Math.max(0, this.firstUnlockedIndex());
    this.menuVisible = true;
    this.publishMenu();
  }

  closeBuildMenu(): void {
    if (!this.menuVisible) return;
    this.menuVisible = false;
    this.publishMenu();
  }

  moveMenuCursor(dir: GridDirection): void {
    if (!this.menuVisible || this.menuRows.length === 0) return;
    this.menuCursor = moveGridCursor(this.menuRows, BUILD_GRID_COLS, this.menuCursor, dir);
    this.publishMenu();
  }

  /** Digit shortcut. 1-based over the whole catalogue; out of range is simply ignored. */
  jumpMenuCursor(oneBased: number): void {
    if (!this.menuVisible) return;
    const index = oneBased - 1;
    if (index < 0 || index >= this.menuRows.length) return;
    this.menuCursor = index;
    this.publishMenu();
  }

  armMenuCursor(): void {
    this.armMenuIndex(this.menuCursor);
  }

  /**
   * Arm the cell at `index` — Enter and the React grid's click both land here, so there is
   * exactly one code path that can arm a tool from the menu, the same property the old
   * in-canvas surface kept.
   *
   * A LOCKED CELL REFUSES rather than arming a tool whose command the sim will throw away.
   * This is the one place a UI-side legality check is right: it is not deciding what the
   * world does, it is declining to pretend the player did something.
   */
  private armMenuIndex(index: number): void {
    if (!this.menuVisible) return;
    const row = this.menuRows[index];
    if (row === undefined || row.locked) return;
    this.menuCursor = index;
    this.host.setTool(row.tool);
    // Same frame as the arming edge, so the held sprite never lags the slot highlight.
    publishArmedTool(row.tool);
    this.closeBuildMenu();
  }

  private firstUnlockedIndex(): number {
    return this.menuRows.findIndex((row) => !row.locked);
  }

  private publishMenu(): void {
    publishBuildMenu(this.menuVisible, this.menuCursor, this.host.getTool(), this.menuRows);
  }

  // --- the debug panel ([[075]]) ------------------------------------------------------------

  get debugPanelOpen(): boolean {
    return this.debugVisible;
  }

  /**
   * Backquote. The perf overlay rides the panel — `host.toggleOverlay()` is called on
   * exactly the open and close edges, so the numbers appear and vanish with the cheat
   * input. (F3 still flips the overlay alone; see `keyboard.ts`.)
   */
  toggleDebugPanel(): void {
    if (this.debugVisible) {
      this.closeDebugPanel();
      return;
    }
    this.debugVisible = true;
    this.host.toggleOverlay();
    this.publishDebug();
  }

  closeDebugPanel(): void {
    if (!this.debugVisible) return;
    this.debugVisible = false;
    this.host.toggleOverlay();
    this.publishDebug();
  }

  /**
   * The HUD's input submitted a code. The code becomes a `Cheat` COMMAND — never a direct
   * mutation, that is the determinism rule the whole item hangs on — and the verdict is
   * read back off `view.stats.cheatsUsed` by `judgePendingCheat`. A second submit while
   * one is pending replaces the watch; the sim still applies both, and the counter jump
   * resolves the newer one accepted, which is the only line the player is still reading.
   */
  private submitCheatCode(code: string): void {
    const trimmed = code.trim();
    if (trimmed === '') return;
    const view = this.host.latestView();
    this.host.queue.push({ type: 'Cheat', code: trimmed });
    this.cheatPending = {
      code: trimmed,
      before: view?.stats.cheatsUsed ?? 0,
      issuedViewTick: view?.tick ?? -1,
    };
  }

  /**
   * The verdict, one projection at a time. Judged only once the view is TWO ticks past the
   * submission: the command lands at the next tick boundary and its projection follows a
   * frame later, and judging a tick early would print a rejection line over money that is
   * about to jump. 100 ms of patience, at most, for a verdict that cannot lie.
   */
  private judgePendingCheat(view: WorldView | null): void {
    const pending = this.cheatPending;
    if (pending === null || view === null) return;
    if (view.tick <= pending.issuedViewTick + 1) return;
    this.cheatPending = null;
    if (view.stats.cheatsUsed > pending.before) {
      this.cheatAccepted += 1;
    } else {
      this.cheatRejected += 1;
      this.lastRejectedCode = pending.code;
    }
    this.publishDebug();
  }

  private publishDebug(): void {
    publishDebugPanel(
      this.debugVisible,
      this.cheatAccepted,
      this.cheatRejected,
      this.lastRejectedCode,
    );
  }

  // --- cursor state ------------------------------------------------------------------------

  get dragging(): boolean {
    return this.pointer.dragging;
  }

  cancelDrag(): void {
    this.pointer.cancelDrag();
  }

  /** A direction key genuinely held right now. The work-queue pump waits on this ([[074]]). */
  get manualWalkHeld(): boolean {
    return this.keyboard.walking;
  }

  /** A direction keydown, before it becomes a command — the queue's cancellation edge. */
  noteWalkKey(): void {
    this.pointer.walkKeyPressed();
  }

  /**
   * R. One press, one quarter turn — of the arm or belt tile under the cursor if there is
   * one, and of the ghost otherwise.
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
   * MID-DRAG, R NOW FLIPS A BELT RUN'S CORNER — and this is the one place item 052's
   * "nothing draggable rotates" stopped being true. A belt drag can lay an L since [[059]],
   * so there is now exactly one draggable thing with an orientation to change, and R is the
   * key the player already reaches for to change an orientation. It is still not a command:
   * the corner belongs to a gesture that has not been released, and an in-progress band emits
   * nothing by the rule at the top of `gesture.ts`.
   *
   * THE ORDER IS STILL THE FEATURE. A drag in progress is the most specific statement of
   * intent on screen, so it outranks the arm under the cursor exactly as the arm outranks
   * the ghost — and turning a placed arm mid-drag was never reachable anyway, because the
   * old code refused to look for one while dragging.
   */
  rotate(): void {
    if (this.pointer.flipDragAxis()) return;
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
