// The armed tool, published for the renderer ([[065]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THIS FILE IS A CONTRACT BETWEEN INPUT AND THE RENDERER, on the `lod.ts` precedent.
//
//  Input owns tool state — it is UI state, never a `Command`, never traced, never hashed,
//  never saved (§12) — and the renderer needs exactly one fact out of it: what to draw in
//  the avatar's hands. So input publishes what it did into `armedTool` below, and the
//  renderer reads it. Neither reaches into the other: the render lane must NOT import
//  `hotbar.ts`, `system.ts` or the host to learn the tool, and this module must never
//  learn what a sprite is.
// ────────────────────────────────────────────────────────────────────────────────────
//
// WHY A MODULE SINGLETON, VERBATIM FROM `viewLod`: it is pure presentation, it is written
// by exactly one live host, and threading it through `RenderUiState` would make every
// renderer signature depend on input's release schedule. Under React StrictMode two hosts
// exist for a few milliseconds and both write here — they write the same value, and nothing
// downstream is stateful, so last-writer-wins is correct.
//
// WHEN IT IS WRITTEN: on every tool-arming edge (a digit, a hotbar click, the build menu's
// Enter, Esc's put-the-tool-down) — so the held sprite changes in the same frame as the
// slot highlight — and once per `InputSystem.update()` besides, as the safety net that
// catches any arming path added later. `publish` compares first; the steady state costs
// one equality check per frame and writes nothing.

import { ToolMode, toolHeldFrame } from './tools';

/**
 * What the renderer may know about the armed tool. Plain data, mutated in place.
 *
 * `heldFrame` is the atlas frame to draw in the avatar's hands, or `''` for empty hands
 * (the Hand tool, and any cursor without hand art — placement cursors, the zone brushes).
 * It is derived through `toolHeldFrame`, the SAME table the hotbar slot art comes from, so
 * the bar and the hands cannot disagree about what a tool looks like.
 */
export interface ArmedToolView {
  /** Bumped on every change, so a consumer can cheaply skip untouched frames. */
  version: number;
  /** The armed `ToolMode`, for a consumer that branches on the verb itself. */
  tool: ToolMode;
  /** Atlas frame for the held-tool overlay, or `''` for nothing in hand. */
  heldFrame: string;
}

export const armedTool: ArmedToolView = {
  version: 0,
  tool: ToolMode.Hand,
  heldFrame: '',
};

/** Called by the input layer on every arming edge, and once per frame besides. */
export function publishArmedTool(tool: ToolMode): void {
  if (armedTool.tool === tool && armedTool.version > 0) return;
  armedTool.tool = tool;
  armedTool.heldFrame = toolHeldFrame(tool);
  armedTool.version += 1;
}
