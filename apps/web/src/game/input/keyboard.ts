// Keyboard: a held direction, plus tool selection that never leaves the renderer.
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

import { Direction } from '@snack/sim';

import type { InputHost } from './context';
import { TOOL_ORDER, ToolMode } from './tools';

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

  constructor(private readonly host: InputHost) {}

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

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return; // Auto-repeat is not a state edge.

    const direction = DIRECTION_KEYS[event.code];
    if (direction !== undefined) {
      event.preventDefault();
      if (!this.held.includes(event.code)) this.held.push(event.code);
      this.syncDirection();
      return;
    }

    // Everything below is UI state. None of it is a command and none of it is recorded.
    const tool = numberKeyToTool(event.code);
    if (tool !== null) {
      this.host.setTool(tool);
      return;
    }
    if (event.code === 'Escape') {
      this.host.setTool(ToolMode.Hand);
      return;
    }
    if (event.code === 'F3' || event.code === 'Backquote') {
      event.preventDefault();
      this.host.toggleOverlay();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (DIRECTION_KEYS[event.code] === undefined) return;
    const index = this.held.indexOf(event.code);
    if (index >= 0) this.held.splice(index, 1);
    this.syncDirection();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAll();
  };

  private readonly releaseAll = (): void => {
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

function numberKeyToTool(code: string): ToolMode | null {
  const digit = code.startsWith('Digit') ? Number(code.slice(5)) : NaN;
  if (!Number.isInteger(digit)) return null;
  return TOOL_ORDER[digit - 1] ?? null;
}
