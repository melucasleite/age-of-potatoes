// Keyboard: a held direction, the zoom ladder, the build menu, and tool selection.
//
// Plan §12: player movement is a HELD DIRECTION, never a position delta. `SetMoveDirection`
// says which way the stick is pushed and the sim owns how far that goes in a tick.
// Sending deltas would let input frequency leak into world state — a dropped frame or a
// 144 Hz monitor would change how fast the character walks.
//
// And the corollary that matters for the trace: the command is emitted ON KEY-STATE EDGES
// ONLY, never once per frame. Walking north for ten seconds must add ONE trace entry, not
// six hundred. A per-frame emission would bloat the trace to nothing-per-second and make
// the diff between two sessions unreadable, which is the whole value of having it.
//
// ALMOST EVERYTHING ELSE IN THIS FILE IS UI STATE AND ENTERS NOTHING. Zoom is not a command
// and is never traced or hashed (§12, and the header of `packages/sim/src/commands.ts` says
// so by name). Nor is the build menu, the armed tool, the placement rotation, or the crop a
// new zone will be assigned. A replay must not depend on which panel was open.
//
// THE EXCEPTION, AND IT IS EXACTLY ONE: R over a placed grabber emits `RotateGrabber` ([[052]]).
// Turning an arm that is standing on the lot is a change to the WORLD — it changes where goods
// go on the next tick — so it is a command, at a tick boundary, in the trace, like every other
// verb. R with no arm under the cursor still only cycles the ghost's facing and still enters
// nothing. Both live behind `system.rotate()` so this file never has to know which is which.
//
// THE BUILD MENU IS MODAL OVER EXACTLY TWO THINGS — the digits and the arrow keys — and it
// stops the player walking while it is up. That last part is a deliberate courtesy rather
// than an implementation limit: arrows move the menu cursor while it is open, so leaving
// WASD live would let you walk away from a menu you are reading using one hand while the
// other browses. Opening the menu emits one `SetMoveDirection None`, which is honest — the
// character really does stop.

import { Direction } from '@snack/sim';

import type { InputHost } from './context';
import { digitToSlotIndex, hotbar, itemPlaceTool } from './hotbar';
import type { InputSystem } from './system';
import { TOOL_INFO, ToolMode } from './tools';

const DIRECTION_KEYS: Readonly<Record<string, Direction>> = {
  KeyW: Direction.North,
  ArrowUp: Direction.North,
  KeyS: Direction.South,
  ArrowDown: Direction.South,
  KeyA: Direction.West,
  ArrowLeft: Direction.West,
  KeyD: Direction.East,
  ArrowRight: Direction.East,
};

export class KeyboardInput {
  /** Held direction keys in press order. The most recent one still held wins. */
  private readonly held: string[] = [];
  private emitted: Direction = Direction.None;
  private attached = false;

  constructor(
    private readonly host: InputHost,
    private readonly system: InputSystem,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // A tab switch mid-walk must not leave the player walking forever. Neither event
    // fires a `keyup`, so both have to release everything by hand.
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.held.length = 0;
    // Do not emit here: the host is going away and the queue drains into nothing.
    this.emitted = Direction.None;
  }

  /** Called when the menu opens: the character stops, once, honestly. */
  stopWalking(): void {
    this.releaseAll();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return; // Auto-repeat is not a state edge.

    // Space is the camera's modifier. Held, it turns any left-drag into a pan gesture that
    // paints nothing — see the header of `pointer.ts` for why that seat is kept warm.
    if (event.code === 'Space') {
      event.preventDefault();
      this.system.spaceHeld = true;
      return;
    }

    if (this.system.menuOpen && this.handleMenuKey(event)) return;

    const direction = DIRECTION_KEYS[event.code];
    if (direction !== undefined) {
      event.preventDefault();
      // Arrows drive the menu cursor while it is open, and WASD is stilled with it.
      if (this.system.menuOpen) return;
      if (!this.held.includes(event.code)) this.held.push(event.code);
      this.syncDirection();
      return;
    }

    // Everything below is UI state. None of it is a command and none of it is recorded.
    // The menu-open check is for Digit0 alone: the menu swallows 1–9 in `handleMenuKey`,
    // but 0 is not a menu jump, and arming a slot behind a modal would be a stealth click.
    const digit = digitOf(event.code);
    if (digit !== null) {
      if (!this.system.menuOpen) this.armHotbarSlot(digit);
      return;
    }

    switch (event.code) {
      case 'KeyB':
        event.preventDefault();
        this.system.toggleBuildMenu();
        return;
      // The one key in this switch that can emit a command. `rotate()` decides which of the two
      // things R means here — turning the placed arm under the cursor is a `RotateGrabber`,
      // turning the ghost is cursor state — and the decision needs hover, which is the
      // pointer's business rather than this file's.
      case 'KeyR':
        this.system.rotate();
        return;
      case 'KeyC':
        this.system.cycleZoneCrop();
        return;
      case 'Equal':
      case 'NumpadAdd':
        event.preventDefault();
        this.system.stepZoom(1);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        event.preventDefault();
        this.system.stepZoom(-1);
        return;
      case 'Escape':
        // Three meanings, in the order the player most likely wants them: close the menu,
        // abandon the drag, put the tool down. Each step is one press.
        if (this.system.menuOpen) this.system.closeBuildMenu();
        else if (this.system.dragging) this.system.cancelDrag();
        else this.host.setTool(ToolMode.Hand);
        return;
      case 'F3':
      case 'Backquote':
        event.preventDefault();
        this.host.toggleOverlay();
        return;
      default:
        return;
    }
  };

  /** Returns true when the menu swallowed the key. */
  private handleMenuKey(event: KeyboardEvent): boolean {
    switch (event.code) {
      case 'ArrowUp':
      case 'KeyW':
        event.preventDefault();
        this.system.moveMenuCursor(-1);
        return true;
      case 'ArrowDown':
      case 'KeyS':
        event.preventDefault();
        this.system.moveMenuCursor(1);
        return true;
      case 'Enter':
      case 'NumpadEnter':
        event.preventDefault();
        this.system.armMenuCursor();
        return true;
      default:
        break;
    }

    const digit = digitOf(event.code);
    if (digit !== null && digit >= 1) {
      event.preventDefault();
      this.system.jumpMenuCursor(digit);
      return true;
    }
    return false;
  }

  /**
   * A digit, 1–9 or 0, outside the build menu: arm what the hotbar slot holds.
   *
   * An empty slot is a deliberate no-op — not a fall-through to some other meaning, because
   * the digits belong to the bar now and a key that did something different depending on
   * which slots were full would be a bar the fingers cannot learn.
   *
   * AN ITEM SHORTCUT CAN REFUSE, and the refusal is the belt's red price, not a surprise
   * mid-click: with none of the item in the bag and not enough money to buy the machine
   * outright, arming the cursor would offer a placement the sim is certain to throw away.
   * With a box in the bag the placement is free (`PlaceMachine` opens the box first,
   * [[054]]); with money it is a purchase; with neither, the press selects nothing. The
   * check reads the latest projection — the same 150 ms-stale reading every price on the
   * belt already runs on.
   */
  private armHotbarSlot(digit: number): void {
    const entry = hotbar.entryAt(digitToSlotIndex(digit));
    if (entry === null) return;
    if (entry.kind === 'tool') {
      this.host.setTool(entry.tool);
      return;
    }

    const tool = itemPlaceTool(entry.item);
    if (tool === -1) return;
    const view = this.host.latestView();
    if (view !== null) {
      let bagged = 0;
      for (const slot of view.inventory) {
        if (slot.item === entry.item) {
          bagged = slot.count;
          break;
        }
      }
      const cost = TOOL_INFO[tool].costCents;
      if (bagged <= 0 && cost > 0 && view.moneyCents < cost) return;
    }
    this.host.setTool(tool);
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      this.system.spaceHeld = false;
      return;
    }
    if (DIRECTION_KEYS[event.code] === undefined) return;
    const index = this.held.indexOf(event.code);
    if (index >= 0) this.held.splice(index, 1);
    this.syncDirection();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAll();
  };

  private readonly releaseAll = (): void => {
    this.system.spaceHeld = false;
    if (this.held.length === 0 && this.emitted === Direction.None) return;
    this.held.length = 0;
    this.syncDirection();
  };

  /** The only place a movement command is produced, and only on a change. */
  private syncDirection(): void {
    const last = this.held[this.held.length - 1];
    const next = last === undefined ? Direction.None : (DIRECTION_KEYS[last] ?? Direction.None);
    if (next === this.emitted) return;
    this.emitted = next;
    this.host.queue.push({ type: 'SetMoveDirection', dir: next });
  }
}

function digitOf(code: string): number | null {
  if (!code.startsWith('Digit')) return null;
  const digit = Number(code.slice(5));
  return Number.isInteger(digit) ? digit : null;
}
