// What the input listeners are allowed to reach.
//
// Deliberately narrow. Input can read the last projection, read the applied camera
// transform, push a `Command`, and set UI state. It cannot reach `WorldState`, because
// there is nothing here that exposes it — that is the boundary made structural rather
// than remembered.

import type { WorldView } from '@snack/sim';

import type { Camera } from '../render/camera';
import type { CommandQueue } from './commands';
import type { ToolMode } from './tools';

export interface HoverTile {
  tileX: number;
  tileY: number;
}

export interface InputHost {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  readonly queue: CommandQueue;
  /** The most recent projection, or null before the first frame. */
  latestView(): WorldView | null;
  getTool(): ToolMode;
  /** UI state. Never a command, never in the trace (§12). */
  setTool(tool: ToolMode): void;
  /** UI state. Never a command, never in the trace (§12). */
  setHover(tile: HoverTile | null): void;
  toggleOverlay(): void;
}
