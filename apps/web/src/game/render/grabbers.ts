// Grabber arms.
//
// An arm is three sprites: a pedestal that never moves, a hand that swings, and the item
// in the hand. The swing is read straight out of `swingPermille` — the renderer owns no
// animation clock of its own, so an arm cannot drift out of step with the machine it feeds.
//
// The one piece of interpretation, and it is what makes the arm readable at a glance:
//
//   held ≠ 0  →  the arm is on its way FORWARD, carrying. Draw the item.
//   held = 0  →  the arm is on its way BACK, empty.
//
// which follows from the sim: a grabber sets `cooldown` at the moment it picks up (holding)
// and again at the moment it puts down (empty). At rest the permille reads full and the
// hand parks over its source, waiting — so an arm stuck holding an item, hovering over a
// full destination, is plan §5's "look downstream" told without a single word of UI.
//
// ── AND NOW IT IS TOLD WITH THE SAME LAMP EVERY MACHINE WEARS ──────────────────────────
//
// "Without a single word of UI" was doing a lot of work above, because reading a stall off an
// arm's resting pose requires already knowing the rule. `GrabberView.lamp` publishes the same
// three states the sim's own grammar uses — green mid-swing, amber empty and waiting, red
// holding with nowhere to put it — and this file draws them with `lamps.ts`'s shapes and
// `lamps.ts`'s colours. Not a second vocabulary for arms: an amber arm and an amber Fryer mean
// the identical thing, look upstream, and a player who has learned one has learned both.

import { TILE_PX } from './pixel';

import { Sprite } from 'pixi.js';
import { GRABBER_SPECS, LampState, grabberSpec } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import type { ItemPage } from './belt-items';
import type { WorldRect } from './camera';
import { stepX as dirStepX, stepY as dirStepY } from './directions';
import { LAMP_PX, lampAlpha, lampTint } from './lamps';
import { ART } from './textures';
import type { ArtSet } from './textures';

interface GrabberVisual {
  base: Sprite;
  hand: Sprite;
  cargo: Sprite;
  /** Plan §5's status lamp, on the arm. Same seven shapes, same tints, same pulse. */
  lamp: Sprite;
}

/** Reach in tiles, defaulting to the shortest arm when a tier is unknown to this build. */
function reachOf(tier: number): number {
  return grabberSpec(tier as never)?.reachTiles ?? GRABBER_SPECS[0]!.reachTiles;
}

export class GrabberLayer {
  private readonly visuals = new Map<number, GrabberVisual>();

  constructor(
    private readonly art: ArtSet,
    private readonly items: ItemPage,
    private readonly attach: (visual: GrabberVisual) => void,
  ) {}

  update(view: WorldView, rect: WorldRect, nowMs: number): void {
    const seen = new Set<number>();

    for (let i = 0; i < view.grabbers.length; i++) {
      const g = view.grabbers[i]!;
      seen.add(g.id);

      let visual = this.visuals.get(g.id);
      if (visual === undefined) {
        visual = {
          base: new Sprite(this.art.get(ART.grabberBase)),
          hand: new Sprite(this.art.get(ART.grabberHand)),
          cargo: new Sprite(this.items.texture(g.held)),
          lamp: new Sprite(this.art.get(ART.lamp(g.lamp))),
        };
        visual.hand.anchor.set(0.5, 0.5);
        visual.cargo.anchor.set(0.5, 0.5);
        this.visuals.set(g.id, visual);
        this.attach(visual);
      }

      const originX = g.tileX * TILE_PX;
      const originY = g.tileY * TILE_PX;
      const reach = reachOf(g.tier);
      const stepX = dirStepX(g.dir) * reach * TILE_PX;
      const stepY = dirStepY(g.dir) * reach * TILE_PX;

      // Off-screen arms keep their positions but draw nothing: an arm is three sprites, so
      // a hundred of them off-camera is three hundred quads that need not be submitted.
      const visible =
        originX - TILE_PX * 2 < rect.x + rect.width &&
        originX + TILE_PX * 3 > rect.x &&
        originY - TILE_PX * 2 < rect.y + rect.height &&
        originY + TILE_PX * 3 > rect.y;
      visual.base.visible = visible;
      visual.hand.visible = visible;
      visual.cargo.visible = visible && g.held !== 0;
      visual.lamp.visible = visible && g.lamp !== LampState.Off;
      if (!visible) continue;

      visual.base.position.set(originX, originY);

      // Top-right of the pedestal — the same corner of the same footprint a machine's lamp
      // sits in, so the eye finds every status light in the factory in the same place. It
      // rides the pedestal rather than the hand on purpose: a lamp that swung with the arm
      // would be hardest to read at exactly the moment the arm is stalled at full extension.
      visual.lamp.texture = this.art.get(ART.lamp(g.lamp));
      visual.lamp.position.set(originX + TILE_PX - LAMP_PX - 1, originY + 1);
      visual.lamp.tint = lampTint(g.lamp);
      visual.lamp.alpha = lampAlpha(g.lamp, nowMs);

      // 0 at the far end of the current half-swing, 1 at rest. Carrying runs source→dest;
      // empty runs dest→source, which is the return stroke.
      const t = g.swingPermille / 1000;
      const from = g.held !== 0 ? -1 : 1;
      const to = g.held !== 0 ? 1 : -1;
      const lerp = from + (to - from) * t;

      const handX = originX + TILE_PX / 2 + stepX * lerp;
      const handY = originY + TILE_PX / 2 + stepY * lerp;
      visual.hand.position.set(Math.round(handX), Math.round(handY));
      visual.hand.rotation = Math.atan2(stepY, stepX);

      if (g.held !== 0) {
        visual.cargo.texture = this.items.texture(g.held);
        visual.cargo.position.set(Math.round(handX), Math.round(handY) - 3);
      }
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
}

/**
 * Free one arm's sprites.
 *
 * `destroy()` with no argument leaves the TEXTURE alone — every one of these points at the
 * shared atlas or the item page, neither of which is this sprite's to free. One function rather
 * than two copies of the list, because the copy that gets a new sprite added to it and the copy
 * that does not is how a lamp leaks on every belt the player ever demolishes.
 */
function destroyVisual(visual: GrabberVisual): void {
  visual.base.destroy();
  visual.hand.destroy();
  visual.cargo.destroy();
  visual.lamp.destroy();
}

export type { GrabberVisual };
