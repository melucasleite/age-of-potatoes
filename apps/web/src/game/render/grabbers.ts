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
// `piece` cuts the authored frame into its three parts at the columns the art actually uses,
// and the layer reassembles them as a jointed arm: housing on the pivot, shaft repeated twice
// over as upper arm and forearm, claw split down its midline into two jaws that close. The
// tier's whole identity — amber Mk1, red Mk2, cyan Long, and each one's tick count — comes
// along for free, because it is the same paint. The Long arm reads heavier as well as longer:
// its bars are scaled by its reach, which is an exact 2× and therefore still pixel-crisp.
//
// The slice columns are a fact ABOUT THE ART, and `make-factory-parts.mjs` asserts the same
// partition from its end, against the procedural bodies in `textures.ts` painted to the same
// grid. That is what keeps a grey-box build from producing an arm chopped in the wrong places,
// and it is the one thing here that a re-authored atlas could quietly break.
//
// ── "THE ARMS LOOK LIKE FLOPPY DICKS" — TWO CAUSES, ONE OF THEM IN THIS FILE ───────────
//
// The owner, 2026-08-21, watching his factory: "the arms look like floppy dicks, can you
// address the animation? And also the sprites". Crude, and a precise note: the arm read as
// SOFT AND ORGANIC where it should read as rigid machinery. Both halves of the sentence were
// right, and neither was the arc — item 094's sweep, tuck and endpoints are untouched.
//
// 1. THE SPRITE. The bar was a smooth cylinder of constant cross-section, because the shaft
//    was STRETCHED rather than tiled. `shaftBar`'s note has the full story; the art half is
//    in `make-factory-parts.mjs`.
//
// 2. THE WRIST, AND THIS ONE WAS A BUG. The claw was rotated to `pose.handAngle` — the
//    PIVOT-TO-HAND direction — and positioned along that same chord, while the forearm it
//    hangs off runs at `pose.foreAngle`. Those differ by the elbow's own bend: 41.4° at the
//    deepest part of the tuck, which put the claw's body 6.6 source pixels off the forearm's
//    centreline, on a bar 8 pixels thick. (Both figures move with `SWING_TUCK`, and both are
//    `acos(1 - SWING_TUCK)` and `clawW * sin` of it. They read 33.6° and 5.8px when this was
//    written, because the tuck was a sixth then; c0c7ad0 deepened it to a quarter.) So the
//    arm bent one way at the elbow and the
//    OTHER WAY at the wrist, every single swing — an S-curve, in a smooth tube, which is
//    about the floppiest thing a linkage can do. The claw now wears `foreAngle` and hangs off
//    the forearm's tip, so the arm has the two joints it is drawn to have.
//
//    Costless at the ends, which is why it is safe: at both endpoints of the stroke the tuck
//    is zero, so `upperAngle`, `foreAngle` and `handAngle` are all the same number and the
//    claw lands exactly where it always did. The change is invisible at rest and only edits
//    the middle of the swing — the part that was wrong.
//
// ── "STABILIZED LIKE A GIMBAL" — AND WHY THE CLAW WEARS A THIRD ANGLE NOW ──────────────
//
// The owner, after the motion pass: "I feel like the head of the grabber needs to be always
// pointing at the object like stabilized by a gimbal."
//
// The claw now wears `pose.clawAngle`, which is neither of the two above. The argument is in
// `grabber-swing.ts` section 6 and is not repeated here; what matters at THIS end is the one
// rule that keeps the fix above intact, because the two are easy to confuse:
//
//   **ROTATION FROM THE HEAD. POSITION FROM THE FOREARM.**
//
// The S-curve bug took the claw's rotation AND its position from the pivot-hand chord, which
// lifted the claw's whole body — root included — off the bar. The wrist below still comes off
// `foreAngle`, so the claw's root stays on the forearm's centreline to 3.6e-15px; only its
// aim is decoupled. A part that pivots on its mount is a wrist. A part that has left its
// mount is the thing the owner called floppy. If you are ever tempted to compute the wrist
// from `clawAngle` "for consistency", that is the bug, and it is a five-character edit.
//
// Worth knowing before you weigh the trade: the gimbal swings the claw's FAR END 6.6px off
// the bar's axis, and that is the same `clawW * sin(bend)` the S-curve bug moved the claw's
// ROOT by. Identical magnitude. What separates them is which end of the part moves — a hand
// that pivots about a wrist that stays put is a joint, and a hand that has left the wrist is
// a hand that fell off. Numbers alone will not tell those two apart, which is exactly why
// this note exists.
//
// Three things ride the head's frame rather than the forearm's, and all three must move
// together or the claw comes apart: the claw's `rotation`, the jaws' closing direction, and
// the cargo's seat between them. All three are below, within a dozen lines of each other.

import { TILE_PX } from './pixel';

import { Rectangle, Sprite, Texture, TilingSprite } from 'pixi.js';
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
const CLAW_TRAVEL = 4;

/**
 * Half a shaft module, in source pixels: how far the FOREARM's tiling is phase-shifted.
 *
 * The module carries its segment ring on its last two columns and a bar is exactly two
 * modules (`make-factory-parts.mjs` proves the arithmetic), so an unshifted bar wears rings
 * at its midpoint and at its outboard tip. That is what puts the upper arm's ring ON the
 * elbow — and it would put the forearm's ring on the wrist, on top of the claw's own collar,
 * where it says nothing that is not already said and hides a joint that already reads.
 *
 * Shifted by half a module, the forearm's rings land just PAST the elbow and mid-forearm
 * instead. So the bend gets hardware on both sides of it, the wrist keeps one collar rather
 * than two, and the two bars stop being the same picture twice — which is most of what makes
 * the arm read as having a direction rather than being a symmetrical noodle.
 */
const SHAFT_PHASE = ARM_SLICE.linkW / 2;

interface GrabberVisual {
  /** The housing, on the pivot. Quarter-turns with facing ([[082]]) and never swings. */
  mount: Sprite;
  /**
   * Shoulder → elbow. A `TilingSprite`, and that is the whole of this item's renderer fix:
   * see the note above `shaftBar`.
   */
  upper: TilingSprite;
  /** Elbow → wrist. Same texture, phase-shifted by `SHAFT_PHASE`. */
  fore: TilingSprite;
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
          upper: new TilingSprite(),
          fore: new TilingSprite(),
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
      // One module of shaft, which `shaftBar` repeats along each bar rather than stretching.
      const link = this.piece(body, ARM_SLICE.linkX, 0, ARM_SLICE.linkW, TILE_PX);
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
      visual.lamp.position.set(originX + TILE_PX - LAMP_PX - 2, originY + 2);
      visual.lamp.tint = lampTint(g.lamp);
      visual.lamp.alpha = lampAlpha(g.lamp, nowMs);

      const pose = armPose(g.dir, g.tier, g.held, g.swingPermille);

      // Exact 2× on the Long arm and 1× on the others, so a heavier arm is still crisp.
      const heft = reachTiles;
      shaftBar(visual.upper, link, pivotX, pivotY, pose.upperAngle, pose.upperLength, heft, 0);

      const elbowX = pivotX + pose.elbowX;
      const elbowY = pivotY + pose.elbowY;
      shaftBar(
        visual.fore,
        link,
        Math.round(elbowX),
        Math.round(elbowY),
        pose.foreAngle,
        pose.foreLength,
        heft,
        SHAFT_PHASE,
      );

      // THE WRIST IS A POINT ON THE FOREARM, AND THE GIMBAL DOES NOT GET TO MOVE IT. The
      // claw is mounted `clawW` back from the hand point along the FOREARM — that is where
      // the bar ends, so that is where a wrist can be. Position from `foreAngle`, rotation
      // from `pose.clawAngle`, and keeping those two apart is the entire safety argument:
      // the old S-curve bug took BOTH from the pivot-hand chord and floated the claw's whole
      // body 6.6px off the bar. Here the claw's root sits on the forearm's centreline at
      // every frame and only pivots about it, the way a wrist does.
      const foreX = Math.cos(pose.foreAngle);
      const foreY = Math.sin(pose.foreAngle);
      const handPx = pivotX + Math.cos(pose.handAngle) * pose.radius;
      const handPy = pivotY + Math.sin(pose.handAngle) * pose.radius;
      const wristX = handPx - foreX * ARM_SLICE.clawW;
      const wristY = handPy - foreY * ARM_SLICE.clawW;

      // Everything from here is in the CLAW's frame, not the forearm's — see `clawAngle`.
      const alongX = Math.cos(pose.clawAngle);
      const alongY = Math.sin(pose.clawAngle);
      // Screen-down in the claw's own frame; the jaws travel along it, toward each other.
      // It has to be the CLAW's perpendicular: taken off the forearm, a gimballed head would
      // shut its jaws across its own bite, up to 41.4° sideways at the deepest tuck.
      const perpX = -alongY;
      const perpY = alongX;
      const shut = CLAW_TRAVEL * pose.grip;

      visual.clawUpper.position.set(
        Math.round(wristX + perpX * shut),
        Math.round(wristY + perpY * shut),
      );
      visual.clawUpper.rotation = pose.clawAngle;
      visual.clawLower.position.set(
        Math.round(wristX - perpX * shut),
        Math.round(wristY - perpY * shut),
      );
      visual.clawLower.rotation = pose.clawAngle;

      if (g.held !== 0) {
        visual.cargo.texture = this.items.texture(g.held);
        // Between the jaws, not on the wrist: the item rides where the claw is holding it —
        // half a claw out from the wrist along the HEAD's aim, so a stabilized head carries
        // a stabilized item rather than swinging it around a point it no longer points at.
        visual.cargo.position.set(
          Math.round(wristX + alongX * (ARM_SLICE.clawW / 2)),
          Math.round(wristY + alongY * (ARM_SLICE.clawW / 2)),
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
 * Place one bar of the linkage: a length of shaft, hinged at its inboard end.
 *
 * ── WHY THIS IS A `TilingSprite` AND NOT A STRETCHED `Sprite` ──────────────────────────
 *
 * The shaft slice is 8 source pixels wide and a bar is 16 (Mk1, Mk2) or 32 (Long). The old
 * code set `Sprite.width` and let the quad stretch, which is 2× or 4× along the bar against
 * an integer `heft` across it — ANISOTROPIC, so a rivet came out twice as wide as it was
 * tall and a seam came out as a stripe. Item 135 measured that correctly and drew the wrong
 * conclusion from it: it made the shaft column-uniform so the stretch had nothing left to
 * destroy, and left the stretch in place. Its own note recorded the `TilingSprite` as "a
 * no-op and was not written" — true of a column-uniform texture, and circular, because the
 * texture was only column-uniform because of the stretch. What shipped was a smooth tube of
 * constant cross-section hinged in the middle, which is the shape the owner named.
 *
 * Tiling repeats the module at 1:1 (times the integer `heft`) instead of smearing it, so
 * structure ALONG the bar survives to the screen — which is what let the art be redrawn with
 * a waist, segment rings, a bolt and rivets. Exactly two modules fit each bar at every tier;
 * the arithmetic is proved in `make-factory-parts.mjs`.
 *
 * `height` and `tileScale` are set rather than `scale`, because on a `TilingSprite` `scale`
 * would resize the tiles along with the area and undo the 1:1 the whole change is for.
 * `phase` shifts which columns land where — see `SHAFT_PHASE`.
 */
function shaftBar(
  bar: TilingSprite,
  texture: Texture,
  x: number,
  y: number,
  rotation: number,
  length: number,
  heft: number,
  phase: number,
): void {
  bar.texture = texture;
  bar.position.set(x, y);
  bar.rotation = rotation;
  bar.width = length;
  bar.height = TILE_PX * heft;
  bar.tileScale.set(heft, heft);
  bar.tilePosition.set(-phase * heft, 0);
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
