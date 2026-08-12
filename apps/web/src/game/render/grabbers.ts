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

import { TILE_PX } from './pixel';

import { Sprite } from 'pixi.js';
import { GRABBER_SPECS, grabberSpec } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import type { ItemPage } from './belt-items';
import type { WorldRect } from './camera';
import { stepX as dirStepX, stepY as dirStepY } from './directions';
import { ART } from './textures';
import type { ArtSet } from './textures';

interface GrabberVisual {
  base: Sprite;
  hand: Sprite;
  cargo: Sprite;
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

  update(view: WorldView, rect: WorldRect): void {
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
      if (!visible) continue;

      visual.base.position.set(originX, originY);

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
      visual.base.destroy();
      visual.hand.destroy();
      visual.cargo.destroy();
      this.visuals.delete(id);
    }
  }

  destroy(): void {
    for (const visual of this.visuals.values()) {
      visual.base.destroy();
      visual.hand.destroy();
      visual.cargo.destroy();
    }
    this.visuals.clear();
  }
}

export type { GrabberVisual };
