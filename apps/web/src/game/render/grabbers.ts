// Grabber arms.
//
// An arm is a MOUNT that never moves, two bars that hinge at an elbow, a two-piece claw that
// opens and shuts, the item in the claw, and a lamp. Every one of those follows from
// `swingPermille` and nothing else — the renderer owns no animation clock of its own, so an
// arm cannot drift out of step with the machine it feeds, and a paused world holds its pose.
// The maths lives in `grabber-swing.ts`, which is where the reasoning behind the sweep, the
// tuck, the elbow and the grip is written down; this file only turns a pose into sprites.
//
// The one piece of interpretation, and it is what makes the arm readable at a glance:
//
//   held ≠ 0  →  the arm is on its way FORWARD, carrying. Draw the item, shut the claw.
//   held = 0  →  the arm is on its way BACK, empty. Open the claw.
//
// which follows from the sim: a grabber sets `cooldown` at the moment it picks up (holding)
// and again at the moment it puts down (empty). At rest the permille reads full and the
// hand parks over its source with the claw open, waiting.
//
// ── THE STALL IS NO LONGER THE DIAGNOSTIC. THE LAMP IS ([[085]]) ───────────────────────
//
// This header used to say that an arm stuck holding an item, clamped shut over a full
// destination, was plan §5's "look downstream" told without a word of UI. **That arm barely
// exists now.** Item 085's owner ruling — "if it grabs something that the machine can't take,
// it shouldn't grab it" — means a blocked arm stands EMPTY-HANDED with the goods left on the
// belt, and the only arm still holding one is an arm the world changed under mid-swing.
//
// So the whole message rides `GrabberView.lamp`, which is computed in the sim and needs no
// interpretation here: green mid-swing, amber nothing to take, red — look downstream —
// whenever the next pickup would be refused, hands full or empty. Drawn with `lamps.ts`'s
// shapes and colours, not a second vocabulary for arms: an amber arm and an amber Fryer mean
// the identical thing, and a player who has learned one has learned both.
//
// ── THE ARM IS THE AUTHORED FRAME, TAKEN APART ([[094]]) ───────────────────────────────
//
// The owner: "the arm doesn't have enough oomph to it. It's just like a little rectangle."
// He was right, and the fix did not need one new pixel drawn. The atlas already ships each
// tier as a COMPLETE arm in a single 16px tile — housing, shaft, claw, all pointing east —
// and the old renderer drew that whole picture as a static pedestal with a separate 6px brick
// sliding around on top of it. So there were two arms on screen, one of them rigid.
//
// `armPieces` cuts the authored frame into its three parts at the columns the art actually
// uses, and the layer reassembles them as a jointed arm: housing on the pivot, shaft stretched
// twice over as upper arm and forearm, claw split down its midline into two jaws that close.
// The tier's whole identity — amber Mk1, red Mk2, cyan Long, and each one's tick count — comes
// along for free, because it is the same paint. The Long arm reads heavier as well as longer:
// its bars are scaled by its reach, which is an exact 2× and therefore still pixel-crisp.
//
// The slice columns are a fact ABOUT THE ART, so they are asserted in `grabbers.test.ts`
// against the procedural bodies in `textures.ts`, which are painted to the same grid on
// purpose. That is what keeps a grey-box build from producing an arm chopped in the wrong
// places, and it is the one thing here that a re-authored atlas could quietly break.

import { TILE_PX } from './pixel';

import { Rectangle, Sprite, Texture } from 'pixi.js';
import { LampState } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import type { ItemPage } from './belt-items';
import type { WorldRect } from './camera';
import { grabberBodyFrame, grabberBodyRotation } from './grabber-facing';
import { ARM_SLICE, armPose, reachTilesOf } from './grabber-swing';
import { LAMP_PX, lampAlpha, lampTint } from './lamps';
import { ART } from './textures';
import type { ArtSet } from './textures';

/** How far each jaw travels toward the midline when the claw shuts, in source pixels. */
const CLAW_TRAVEL = 2;

interface GrabberVisual {
  /** The housing, on the pivot. Quarter-turns with facing ([[082]]) and never swings. */
  mount: Sprite;
  /** Shoulder → elbow. */
  upper: Sprite;
  /** Elbow → wrist. */
  fore: Sprite;
  clawUpper: Sprite;
  clawLower: Sprite;
  cargo: Sprite;
  /** Plan §5's status lamp, on the arm. Same seven shapes, same tints, same pulse. */
  lamp: Sprite;
}

export class GrabberLayer {
  private readonly visuals = new Map<number, GrabberVisual>();
  /**
   * Sub-textures cut out of the tier frames, one set per tier, made once.
   *
   * These are WINDOWS onto a source this layer does not own — the atlas page, or a texture
   * the `ArtSet` generated and will free itself — so `destroy(false)` is the only correct
   * teardown. `destroy(true)` here would take the whole atlas down with the last arm the
   * player demolished.
   */
  private readonly slices = new Map<string, Texture>();

  constructor(
    private readonly art: ArtSet,
    private readonly items: ItemPage,
    private readonly attach: (visual: GrabberVisual) => void,
  ) {}

  /** One piece of one tier's frame, cached. */
  private piece(frame: string, x: number, y: number, w: number, h: number): Texture {
    const key = `${frame}:${x},${y},${w},${h}`;
    const cached = this.slices.get(key);
    if (cached !== undefined) return cached;
    const whole = this.art.get(frame);
    // `whole.frame` rather than (0,0): a real atlas frame is a window onto a shared page, so
    // the slice has to be taken relative to where that window already sits.
    const made = new Texture({
      source: whole.source,
      frame: new Rectangle(whole.frame.x + x, whole.frame.y + y, w, h),
    });
    this.slices.set(key, made);
    return made;
  }

  update(view: WorldView, rect: WorldRect, nowMs: number): void {
    const seen = new Set<number>();

    for (let i = 0; i < view.grabbers.length; i++) {
      const g = view.grabbers[i]!;
      seen.add(g.id);

      let visual = this.visuals.get(g.id);
      if (visual === undefined) {
        visual = {
          mount: new Sprite(),
          upper: new Sprite(),
          fore: new Sprite(),
          clawUpper: new Sprite(),
          clawLower: new Sprite(),
          cargo: new Sprite(this.items.texture(g.held)),
          lamp: new Sprite(this.art.get(ART.lamp(g.lamp))),
        };
        // The housing is CENTRED because the whole body rotates with facing ([[082]]) and a
        // rotation about a sprite's top-left corner throws the tile into its neighbour — the
        // junction body's rule, for the junction body's reason.
        visual.mount.anchor.set(0.5, 0.5);
        visual.cargo.anchor.set(0.5, 0.5);
        // The bars hinge about their INBOARD end and run outward along +x, so each one is
        // placed at its joint and rotated; its length is its width.
        visual.upper.anchor.set(0, 0.5);
        visual.fore.anchor.set(0, 0.5);
        // The jaws meet on the midline: the upper one hangs above it, the lower one below.
        visual.clawUpper.anchor.set(0, 1);
        visual.clawLower.anchor.set(0, 0);
        this.visuals.set(g.id, visual);
        this.attach(visual);
      }

      const originX = g.tileX * TILE_PX;
      const originY = g.tileY * TILE_PX;
      const pivotX = originX + TILE_PX / 2;
      const pivotY = originY + TILE_PX / 2;
      const reachTiles = reachTilesOf(g.tier);

      // Off-screen arms keep their positions but draw nothing: an arm is seven sprites, so a
      // hundred of them off-camera is seven hundred quads that need not be submitted. The
      // margin follows the tier, because a Long arm reaches two tiles either side and would
      // otherwise pop into existence with its hand already across the screen edge.
      const margin = (reachTiles + 1) * TILE_PX;
      const visible =
        originX - margin < rect.x + rect.width &&
        originX + margin + TILE_PX > rect.x &&
        originY - margin < rect.y + rect.height &&
        originY + margin + TILE_PX > rect.y;
      visual.mount.visible = visible;
      visual.upper.visible = visible;
      visual.fore.visible = visible;
      visual.clawUpper.visible = visible;
      visual.clawLower.visible = visible;
      visual.cargo.visible = visible && g.held !== 0;
      visual.lamp.visible = visible && g.lamp !== LampState.Off;
      if (!visible) continue;

      // The tier body ([[082]]), taken apart. `grabberBodyFrame` falls back to the Mk1 name
      // for a tier this build has never heard of, and `art.get` falls back to the procedural
      // paint for a build with no atlas — both of which are cut on the same grid, so an arm
      // assembled from either one is an arm rather than a handful of offcuts.
      const body = grabberBodyFrame(g.tier);
      visual.mount.texture = this.piece(body, ARM_SLICE.mountX, 0, ARM_SLICE.mountW, TILE_PX);
      const link = this.piece(body, ARM_SLICE.linkX, 0, ARM_SLICE.linkW, TILE_PX);
      visual.upper.texture = link;
      visual.fore.texture = link;
      const half = TILE_PX / 2;
      visual.clawUpper.texture = this.piece(body, ARM_SLICE.clawX, 0, ARM_SLICE.clawW, half);
      visual.clawLower.texture = this.piece(body, ARM_SLICE.clawX, half, ARM_SLICE.clawW, half);

      visual.mount.position.set(pivotX, pivotY);
      // The housing keeps its quarter-turn toward the PICKUP side — see `grabber-facing.ts`
      // for why that sign is the whole module. It does NOT follow the arm: a mount that spun
      // with the swing would erase the one thing the facing was added to say.
      visual.mount.rotation = grabberBodyRotation(g.dir);

      // Top-right of the pedestal — the same corner of the same footprint a machine's lamp
      // sits in, so the eye finds every status light in the factory in the same place. It
      // rides the tile rather than the hand on purpose: a lamp that swung with the arm
      // would be hardest to read at exactly the moment the arm is stalled at full extension.
      visual.lamp.texture = this.art.get(ART.lamp(g.lamp));
      visual.lamp.position.set(originX + TILE_PX - LAMP_PX - 1, originY + 1);
      visual.lamp.tint = lampTint(g.lamp);
      visual.lamp.alpha = lampAlpha(g.lamp, nowMs);

      const pose = armPose(g.dir, g.tier, g.held, g.swingPermille);

      // Exact 2× on the Long arm and 1× on the others, so a heavier arm is still crisp.
      const heft = reachTiles;
      visual.upper.position.set(pivotX, pivotY);
      visual.upper.rotation = pose.upperAngle;
      visual.upper.width = pose.upperLength;
      visual.upper.scale.y = heft;

      const elbowX = pivotX + pose.elbowX;
      const elbowY = pivotY + pose.elbowY;
      visual.fore.position.set(Math.round(elbowX), Math.round(elbowY));
      visual.fore.rotation = pose.foreAngle;
      visual.fore.width = pose.foreLength;
      visual.fore.scale.y = heft;

      // The claw occupies the LAST `clawW` pixels of the reach, so its jaws close on the
      // hand point and its tip lands on the tile the arm is working — the same two tile
      // centres the old straight-line code hit, which is why no golden anything moved.
      const wrist = pose.radius - ARM_SLICE.clawW;
      const alongX = Math.cos(pose.handAngle);
      const alongY = Math.sin(pose.handAngle);
      // Screen-down in the claw's own frame; the jaws travel along it, toward each other.
      const perpX = -alongY;
      const perpY = alongX;
      const shut = CLAW_TRAVEL * pose.grip;
      const wristX = pivotX + alongX * wrist;
      const wristY = pivotY + alongY * wrist;

      visual.clawUpper.position.set(
        Math.round(wristX + perpX * shut),
        Math.round(wristY + perpY * shut),
      );
      visual.clawUpper.rotation = pose.handAngle;
      visual.clawLower.position.set(
        Math.round(wristX - perpX * shut),
        Math.round(wristY - perpY * shut),
      );
      visual.clawLower.rotation = pose.handAngle;

      if (g.held !== 0) {
        visual.cargo.texture = this.items.texture(g.held);
        // Between the jaws, not on the wrist: the item rides where the claw is holding it.
        visual.cargo.position.set(
          Math.round(pivotX + alongX * (pose.radius - ARM_SLICE.clawW / 2)),
          Math.round(pivotY + alongY * (pose.radius - ARM_SLICE.clawW / 2)),
        );
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
    // `false`: windows onto a source this layer does not own. See the field's own note.
    for (const texture of this.slices.values()) texture.destroy(false);
    this.slices.clear();
  }
}

/**
 * Free one arm's sprites.
 *
 * `destroy()` with no argument leaves the TEXTURE alone — every one of these points at the
 * shared atlas, a slice of it, or the item page, none of which is this sprite's to free. One
 * function rather than seven copies of the list, because the copy that gets a new sprite added
 * to it and the copy that does not is how a lamp leaks on every arm the player ever demolishes.
 */
function destroyVisual(visual: GrabberVisual): void {
  visual.mount.destroy();
  visual.upper.destroy();
  visual.fore.destroy();
  visual.clawUpper.destroy();
  visual.clawLower.destroy();
  visual.cargo.destroy();
  visual.lamp.destroy();
}

export type { GrabberVisual };
