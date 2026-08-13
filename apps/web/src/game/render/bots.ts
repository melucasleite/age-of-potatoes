// Agri-Bots: the first thing in this game that moves without the player ([[038]]).
//
// ── IT IS DRAWN THE WAY THE PLAYER IS DRAWN, DELIBERATELY ────────────────────────────────
//
// A bot has `xSub`/`ySub` in subtiles and a `facing`, exactly as the farmer does, and it is
// stepped by the same `stepToward` in the sim's `movement.ts` that walks him. So this file
// copies `render/index.ts`'s player treatment rather than inventing a second way to move a
// character across a lot:
//
//   · TWO POSITIONS PER BOT, folded in on the tick (`recordTick`), interpolated by the frame's
//     `alpha`. Not one position smoothed by a renderer-side easing — the player already proved
//     which of those reads as walking, and a second answer would have the farmer and his robot
//     moving at visibly different qualities across the same field.
//   · `Math.round` ON THE FINAL POSITION, so the sprite lands on whole SOURCE pixels. Without
//     it the world root sits on an exact device pixel and the bot shimmers inside it.
//   · ANCHORED AT THE FEET (0.5, 1) and offset half a tile down, which is the same anchor and
//     the same offset the player sprite uses, so a bot standing on a tile stands on the tile.
//
// These positions are WRITE-ONLY (§12). They live here, are never read back into the sim,
// never persisted, and never hashed.
//
// ── THE WALK CYCLE IS DRIVEN BY DISTANCE, NOT BY A CLOCK ────────────────────────────────
//
// Locked decision 10 asks for a 2-frame walk, and the art came back as exactly that: two cells
// per pose, one per foot. Which cell is showing is derived from how far the bot has WALKED —
// `(xSub + ySub) / STRIDE_SUB` — rather than from `performance.now()`. A wall-clock cycle keeps
// stepping while the bot stands still working, which reads as a machine marching on the spot;
// keyed to distance it plants a foot every 64 subtiles and stops dead when the bot does, for
// free, with no state and nothing to reset when a save is loaded mid-stride.
//
// A bot that is NOT walking is pinned to cell 1 rather than left on whichever foot it stopped
// on, because a parked robot frozen mid-stride reads as one that has broken down — which is a
// sentence this game's visual grammar reserves for machines that actually have.
//
// ── THREE FACINGS AND A MIRROR ──────────────────────────────────────────────────────────
//
// The art is `down` and `side`, in two-cell walk strips, which is the shape this pipeline has
// used for the player since v0.1 — so east is west with `scale.x = -1` rather than a frame of
// its own, and north is pointed at the side pose because no `up` pose exists for any character
// in this game. `textures.ts`'s `STRIPS` note carries that gap and the handoff that closes it.
//
// The two kinds are two sets of frames rather than one tinted set, and that is the art's call
// rather than this file's: a harvester carries a basket and a planter carries a seed funnel,
// which is a silhouette difference, and no tint produces a silhouette.

import { TILE_PX } from './pixel';

import { Sprite } from 'pixi.js';
import { BotKind, BotPhase, CONDITION_EFFECT_THRESHOLD, Direction, SUBTILE } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import type { ItemPage } from './belt-items';
import type { WorldRect } from './camera';
import { ART } from './textures';
import type { ArtSet } from './textures';

/**
 * One published bot.
 *
 * READ OFF `WorldView` RATHER THAN IMPORTED, because `BotView` is declared in the sim's
 * `view.ts` and is the one projection interface its `index.ts` does not re-export — every
 * sibling (`MachineView`, `GrabberView`, `BeltView`…) is there and this one was missed. Indexing
 * the array is the same type by construction, so it cannot drift while the omission stands, and
 * it needs no edit in a lane that is not this one. HANDOFF: export `BotView` from
 * `packages/sim/src/index.ts` beside `BeltView`, and this alias becomes an ordinary import.
 */
type BotView = WorldView['bots'][number];

/** Subtiles per footfall. A tile is 256, so a bot plants four feet crossing one. */
const STRIDE_SUB = 64;

/**
 * The art vocabulary's name for each kind. A kind this build has never heard of draws the
 * harvester rather than a magenta box — a save from a newer version is a real thing, and the
 * wrong robot walking correctly is a far better failure than no robot at all.
 */
const KIND_SLUG: Readonly<Record<number, string>> = {
  [BotKind.Harvester]: 'harvester',
  [BotKind.Planter]: 'planter',
};

interface BotVisual {
  body: Sprite;
  /** What it is carrying, over its head. Hidden the whole way out; drawn the whole way back. */
  cargo: Sprite;
  /** The same wrench a worn machine wears, in the same corner of the same footprint. */
  wrench: Sprite;
  /** Subtile position at the previous tick and at the current one. Write-only (§12). */
  prevXSub: number;
  prevYSub: number;
  currXSub: number;
  currYSub: number;
}

export class BotLayer {
  private readonly visuals = new Map<number, BotVisual>();

  constructor(
    private readonly art: ArtSet,
    private readonly items: ItemPage,
    private readonly attach: (visual: BotVisual) => void,
  ) {}

  /**
   * Fold one simulated tick into the interpolation state.
   *
   * Called by the host immediately after each `step()`, for the same reason `recordTick` in
   * `index.ts` is: when several ticks run in one frame the "previous" position must be the tick
   * before the last, not the position from the last frame — otherwise `alpha` overshoots
   * backwards during catch-up and every bot on the lot moonwalks whenever the tab was hidden.
   *
   * A BOT SEEN FOR THE FIRST TIME IS PRIMED TO ITS OWN POSITION, both ends, so a bot that has
   * just been built does not slide in from the world origin on its first frame.
   */
  recordTick(view: WorldView): void {
    for (let i = 0; i < view.bots.length; i++) {
      const bot = view.bots[i]!;
      const visual = this.visuals.get(bot.id);
      if (visual === undefined) continue;
      visual.prevXSub = visual.currXSub;
      visual.prevYSub = visual.currYSub;
      visual.currXSub = bot.xSub;
      visual.currYSub = bot.ySub;
    }
  }

  update(view: WorldView, alpha: number, rect: WorldRect): void {
    const seen = new Set<number>();

    for (let i = 0; i < view.bots.length; i++) {
      const bot = view.bots[i]!;
      seen.add(bot.id);

      let visual = this.visuals.get(bot.id);
      if (visual === undefined) {
        visual = this.build(bot);
        this.visuals.set(bot.id, visual);
        this.attach(visual);
      }

      const xSub = visual.prevXSub + (visual.currXSub - visual.prevXSub) * alpha;
      const ySub = visual.prevYSub + (visual.currYSub - visual.prevYSub) * alpha;
      const worldX = (xSub * TILE_PX) / SUBTILE;
      const worldY = (ySub * TILE_PX) / SUBTILE;

      // Three sprites each, so a dozen bots off-camera is three dozen quads not submitted.
      // The interpolation above still runs: a bot that walks off screen and back must not
      // reappear having teleported, and the arithmetic is four multiplies.
      const visible =
        worldX + TILE_PX > rect.x &&
        worldX - TILE_PX < rect.x + rect.width &&
        worldY + TILE_PX > rect.y &&
        worldY - TILE_PX < rect.y + rect.height;
      visual.body.visible = visible;
      visual.cargo.visible = visible && bot.carryCount > 0;
      visual.wrench.visible = visible && bot.condition < CONDITION_EFFECT_THRESHOLD;
      if (!visible) continue;

      const drawX = Math.round(worldX);
      const drawY = Math.round(worldY) + TILE_PX / 2;

      // A standing bot holds step 1 rather than freezing on whichever foot it happened to
      // stop on: a robot parked mid-stride looks broken, and `phase` already knows.
      const step = walking(bot.phase) ? stridePhase(bot) + 1 : 1;
      const kind = KIND_SLUG[bot.kind] ?? 'harvester';
      visual.body.texture = this.art.get(ART.bot(kind, poseFor(bot.facing), step));
      // East is the side pose mirrored. Anchored at 0.5 across, so the flip is about the
      // bot's own centre line and it does not shuffle sideways when it turns around.
      visual.body.scale.x = bot.facing === Direction.East ? -1 : 1;
      visual.body.position.set(drawX, drawY);

      if (bot.carryCount > 0) {
        visual.cargo.texture = this.items.texture(bot.carryItem);
        // Over the head, not in front of the chest: the chip is 8px and the chassis is 16, so
        // anything lower is a sticker on the robot rather than an armful being carried.
        visual.cargo.position.set(drawX, drawY - TILE_PX - 1);
      }

      // Top-right of the tile it is standing in — the same corner every status light and
      // wrench in the factory sits in, so the eye finds it in the same place on a thing that
      // moves as on a thing that does not.
      visual.wrench.position.set(drawX + 2, drawY - TILE_PX - 2);
    }

    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;
      destroyVisual(visual);
      this.visuals.delete(id);
    }
  }

  destroy(): void {
    for (const visual of this.visuals.values()) destroyVisual(visual);
    this.visuals.clear();
  }

  private build(bot: BotView): BotVisual {
    const kind = KIND_SLUG[bot.kind] ?? 'harvester';
    const body = new Sprite(this.art.get(ART.bot(kind, poseFor(bot.facing), 1)));
    body.anchor.set(0.5, 1);

    const cargo = new Sprite(this.items.texture(bot.carryItem));
    cargo.anchor.set(0.5, 1);

    const wrench = new Sprite(this.art.get(ART.uiWrench));
    wrench.visible = false;

    return {
      body,
      cargo,
      wrench,
      prevXSub: bot.xSub,
      prevYSub: bot.ySub,
      currXSub: bot.xSub,
      currYSub: bot.ySub,
    };
  }
}

/** Which half of the stride the bot is on, from distance walked. See the header. */
function stridePhase(bot: BotView): number {
  return Math.floor((bot.xSub + bot.ySub) / STRIDE_SUB) & 1;
}

function walking(phase: number): boolean {
  return phase === BotPhase.Outbound || phase === BotPhase.Returning;
}

/**
 * Which drawn pose a facing uses. Takes a plain number: `BotView.facing` crosses the view
 * boundary unbranded (§12), and a direction this build has never heard of faces the camera.
 *
 * EAST IS ABSENT ON PURPOSE — it returns the west pose, and the caller mirrors it.
 */
function poseFor(facing: number): 'north' | 'south' | 'west' {
  switch (facing) {
    case Direction.North:
      return 'north';
    case Direction.East:
    case Direction.West:
      return 'west';
    default:
      return 'south';
  }
}

/**
 * Free one bot's sprites.
 *
 * `destroy()` with no argument leaves the TEXTURE alone — all three point at the shared atlas
 * or the item page, neither of which is this sprite's to free. Same rule, same reason, as
 * `grabbers.ts`: one function rather than two copies of the list.
 */
function destroyVisual(visual: BotVisual): void {
  visual.body.destroy();
  visual.cargo.destroy();
  visual.wrench.destroy();
}

export type { BotVisual };
