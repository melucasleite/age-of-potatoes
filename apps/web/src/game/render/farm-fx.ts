// The field's tactile juice: the drink-bounce, and the harvest pop with its item-magnet.
//
// ── WHY THIS IS A DIFFER AND NOT A SIM EVENT CHANNEL ───────────────────────────────
// Same reasoning as `audio/observer.ts`, and deliberately the same shape. The sim
// publishes no per-tick event list, so both effects are derived from the projection it
// already publishes: `lastPouredTick` that moved forward, and a ready crop that vanished.
//
// THE POUR IS A SIGNAL NOW, NOT AN INFERENCE (item 064). This file used to guess a pour
// from a moisture RISE between frames, which was structurally blind to the one case the
// item is named after: a pour on a saturated tile clamps, produces no rise, and played
// nothing — a spent can charge with zero acknowledgement. `FieldView.lastPouredTick` is
// written by the sim at every point water actually lands (hand can, sprinkler, Hub), so
// "this tile's value is newer than last frame's" catches every pour including that one,
// and never fires on a moisture rise that was not a pour.
//
// The property that matters is that this only ever READS. Item 009 is explicit that the
// pop and the flight are "purely visual — the item is already in the sim inventory at the
// harvest tick, and the flight is write-only (§12)". Nothing in this file constructs a
// command, and the potato's position is never read back by anything.
//
// ── COSMETIC RANDOMNESS ────────────────────────────────────────────────────────────
// `Math.random` is used freely here and is CORRECT here. AGENTS.md: "Particle jitter,
// idle animation offsets, and lamp flicker use `Math.random` freely — in `apps/web`,
// never in `packages/sim`." The droplet burst next door already sets that precedent.
// None of it may touch a sim RNG stream, and none of it does — this file cannot reach one.
//
// ── POOLED, NOT ALLOCATED ──────────────────────────────────────────────────────────
// Every flying potato comes out of a fixed pool built once. A tween allocated per harvest
// would be a sprite allocated per harvest, and a player clearing a ripe 8x8 field is 64 of
// them inside a few seconds — which is exactly the shape of leak that only shows up in the
// session where somebody is finally enjoying the game.

import { TILE_PX } from './pixel';

import { Sprite } from 'pixi.js';

import { ItemId, WiltStage, worldTileKey } from '@snack/sim';
import type { FieldView } from '@snack/sim';

import type { ItemPage } from './belt-items';

/** Flying potatoes in the air at once. A ripe field cleared fast never needs more. */
const POP_POOL = 32;

/** How long one drink-bounce runs, before per-pour jitter. */
const BOUNCE_MS = 420;

/** Squash-stretch depth. Deep enough to read at 3x zoom, shallow enough not to wobble. */
const BOUNCE_DEPTH = 0.19;

/** Oscillations inside one bounce. Just over one: a gulp and a settle, not a jelly. */
const BOUNCE_CYCLES = 1.35;

/** How long a harvested potato is in the air. Item 009: every action resolves under 1.5s. */
const POP_MS = 620;

/** How high the pop throws the potato, in world px, before the magnet takes over. */
const POP_RISE = 13;

interface Pop {
  sprite: Sprite;
  /** Milliseconds remaining. `<= 0` means this slot is free. */
  life: number;
  /** Total lifetime, so progress is derivable without a second field. */
  total: number;
  /** Where it launched from, in world px. */
  fromX: number;
  fromY: number;
  /** Cosmetic sideways drift and spin, rolled once per pop. */
  driftX: number;
  wobble: number;
  spin: number;
}

/**
 * One frame of bounce for a tile, as a transform to apply to that tile's crop sprite.
 *
 * Returned rather than applied so this class never touches sprites it does not own — the
 * crop sprites belong to the scene and are positioned by the wilt/stage logic in
 * `index.ts`, which would silently fight a second writer.
 */
export interface BounceTransform {
  scaleX: number;
  scaleY: number;
}

const REST: BounceTransform = { scaleX: 1, scaleY: 1 };

export class FarmFx {
  private readonly page: ItemPage;
  private readonly pops: Pop[] = [];

  /** Per-tile bounce clocks. Index is the field's CURRENT collection index. */
  private readonly bounceLife: number[] = [];
  private readonly bounceTotal: number[] = [];

  /** Last frame's field, for the harvest and pour diffs. Owned here, not on the scene. */
  private readonly prevReady: number[] = [];
  private readonly prevCrop: number[] = [];
  private readonly prevCompost: number[] = [];
  private readonly prevWilt: number[] = [];
  private readonly prevPoured: number[] = [];
  /**
   * The world tile key each index held last frame ([[066]]). Farmland is a collection now
   * and a till SHIFTS EVERY INDEX AFTER IT — diffed positionally across that frame, tile 12's
   * pour would land on tile 13's plant and a potato could launch out of bare dirt. When the
   * keys move, `realign` re-files every remembered value under its tile's new index and
   * primes tiles this differ has never seen, so a till fires exactly nothing.
   */
  private readonly keys: number[] = [];
  private primed = false;

  /** Scratch, reused every frame so the getter allocates nothing. */
  private readonly scratch: BounceTransform = { scaleX: 1, scaleY: 1 };

  constructor(page: ItemPage, tileCount: number, attach: (sprite: Sprite) => void) {
    this.page = page;

    for (let i = 0; i < tileCount; i++) {
      this.bounceLife.push(0);
      this.bounceTotal.push(BOUNCE_MS);
      this.prevReady.push(0);
      this.prevCrop.push(0);
      this.prevCompost.push(0);
      this.prevWilt.push(0);
      this.prevPoured.push(0);
    }

    for (let i = 0; i < POP_POOL; i++) {
      const sprite = new Sprite(page.texture(ItemId.RussetPotato));
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      attach(sprite);
      this.pops.push({
        sprite,
        life: 0,
        total: POP_MS,
        fromX: 0,
        fromY: 0,
        driftX: 0,
        wobble: 0,
        spin: 0,
      });
    }
  }

  /**
   * Diff the field and start whatever effects it implies.
   *
   * The FIRST call only snapshots. A world restored from disk arrives with a field full of
   * ripe crops and wet soil, and treating that as sixty-four simultaneous pours would open
   * the save with the entire field convulsing. (Priming also covers a renderer torn down
   * and rebuilt against a RUNNING world, whose pour ticks are already non-zero.)
   *
   * `onPour` fires once per tile whose pour signal moved forward this frame — the caller
   * sprays the droplets there, so ONE diff still drives both halves of the feedback. The
   * bounce is started here directly. One caveat, inherited from the signal itself: a pour
   * applied at tick 0 equals the "never" sentinel, which no frame can precede anyway.
   */
  observe(field: FieldView, onPour?: (index: number) => void): void {
    const count = field.crop.length;

    if (!this.primed) {
      this.snapshot(field);
      this.primed = true;
      return;
    }

    this.realign(field);

    for (let i = 0; i < count; i++) {
      const ready = field.ready[i] ?? 0;
      const crop = field.crop[i] ?? 0;
      const compost = field.compost[i] ?? 0;

      // Water landed here since last frame — INCLUDING on a tile already at full moisture,
      // which the old moisture-rise diff could not see and item 064 exists to fix.
      const poured = field.lastPouredTick[i] ?? 0;
      if (poured > (this.prevPoured[i] ?? 0)) {
        this.pour(i);
        if (onPour !== undefined) onPour(i);
      }

      // A ready crop that vanished. The sim clears the tile outright on harvest, so "was
      // ripe, is gone" is unambiguous — EXCEPT for the one case where the crop collapsed
      // into compost on its own, which looks identical from here and is emphatically not a
      // harvest. The compost heap that appeared on the same tile is what tells them apart,
      // and skipping that check would fire a potato out of a rotting plant nobody touched.
      const wasReady = this.prevReady[i] ?? 0;
      const wasCrop = this.prevCrop[i] ?? 0;
      const grewCompost = compost > (this.prevCompost[i] ?? 0);
      if (wasReady === 1 && ready === 0 && wasCrop !== 0 && crop === 0 && !grewCompost) {
        const wilt = this.prevWilt[i] ?? WiltStage.Fresh;
        this.spawnPop(field, i, wilt);
      }
    }

    this.snapshot(field);
  }

  /**
   * A tile just drank. Bounce it.
   *
   * Driven by the pour diff in `observe` — one diff, two effects, rather than a second
   * pass over the same 64 numbers. Public so the test can pin the bounce curve directly.
   */
  pour(index: number): void {
    if (index < 0 || index >= this.bounceLife.length) return;

    // Item 009 asks for a "cosmetic `Math.random` phase offset so a row watered in sequence
    // does not bounce in lockstep". Implemented as a start DELAY plus a duration jitter
    // rather than as a literal offset into the sine, because offsetting the phase starts the
    // plant mid-stretch — it reads as a plant that was already moving, not one that just got
    // hit with a can. Delay and rate desynchronise the row just as well and each bounce
    // still begins on the squash.
    const total = BOUNCE_MS * (0.88 + Math.random() * 0.28);
    this.bounceTotal[index] = total;
    // Life runs past the total by the stagger; `bounceAt` holds at rest until it catches up.
    this.bounceLife[index] = total + Math.random() * 80;
  }

  /**
   * Advance every live effect.
   *
   * `playerX/playerY` are the player's INTERPOLATED world-pixel position — the same
   * write-only value the sprite was drawn at this frame. Reading it live each frame is what
   * makes this a magnet rather than a tween to wherever the player happened to be standing
   * when the potato left the ground.
   */
  update(deltaMs: number, playerX: number, playerY: number): void {
    const dt = Math.min(deltaMs, 64);

    for (let i = 0; i < this.bounceLife.length; i++) {
      const life = this.bounceLife[i] ?? 0;
      if (life > 0) this.bounceLife[i] = life - dt;
    }

    for (const pop of this.pops) {
      if (pop.life <= 0) continue;
      pop.life -= dt;
      if (pop.life <= 0) {
        pop.sprite.visible = false;
        continue;
      }

      const t = 1 - pop.life / pop.total;

      // Phase one: the pop. An ease-out rise, so it leaves the soil fast and hangs — the
      // "easing curve" item 009 asks for by name. It overlaps the magnet rather than
      // handing off cleanly, which is what stops the flight having a visible kink in it.
      const rise = easeOutCubic(clamp01(t / 0.35));
      const launchX = pop.fromX + pop.driftX * rise;
      const launchY = pop.fromY - POP_RISE * rise;

      // Phase two: the magnet. Ease-IN, so the pull starts as a drift and finishes as a
      // snatch. A linear lerp here reads as a potato on a string.
      const pull = easeInCubic(clamp01((t - 0.22) / 0.78));
      const wobble = Math.sin(t * 9 + pop.wobble) * 3 * (1 - pull);

      pop.sprite.x = launchX + (playerX - launchX) * pull + wobble;
      pop.sprite.y = launchY + (playerY - launchY) * pull;

      // A squash on the way out and a shrink on the way in: it pops into being, then gets
      // absorbed. The last fifth fades, so nothing ever visibly winks out mid-air.
      const puff = t < 0.2 ? 0.55 + easeOutCubic(t / 0.2) * 0.6 : 1.15 - pull * 0.55;
      pop.sprite.scale.set(puff, puff);
      pop.sprite.rotation = pop.spin * t;
      pop.sprite.alpha = t > 0.8 ? clamp01((1 - t) / 0.2) : 1;
      pop.sprite.visible = true;
    }
  }

  /** Potatoes currently in the air. For the structural test and for debugging a leak. */
  get flying(): number {
    let count = 0;
    for (const pop of this.pops) if (pop.life > 0) count += 1;
    return count;
  }

  /** This tile's squash-stretch for this frame, or a flat transform when it is at rest. */
  bounceAt(index: number): BounceTransform {
    const life = this.bounceLife[index] ?? 0;
    if (life <= 0) return REST;

    const total = this.bounceTotal[index] ?? BOUNCE_MS;
    // Still inside the per-pour stagger: hold at rest rather than starting early.
    if (life > total) return REST;

    const t = 1 - life / total;

    // A damped oscillation, squash first. `Math.sin` is fine on this side of the seam — it
    // is banned in `packages/sim` because transcendentals disagree in the last bits between
    // engines and desync replays, which is not a hazard a wobbling potato plant can create.
    const decay = (1 - t) * (1 - t);
    const s = Math.sin(t * BOUNCE_CYCLES * Math.PI * 2) * decay;

    // Volume-ish preserving: wider is shorter. The sprite is anchored at its BASE, so this
    // squashes the plant into the soil instead of shrinking it toward its own middle.
    this.scratch.scaleX = 1 + s * BOUNCE_DEPTH;
    this.scratch.scaleY = 1 - s * BOUNCE_DEPTH;
    return this.scratch;
  }

  destroy(): void {
    for (const pop of this.pops) pop.sprite.destroy();
    this.pops.length = 0;
  }

  // --- internals -----------------------------------------------------------------------

  /**
   * Re-file the remembered field under the collection's CURRENT indexing.
   *
   * Runs only on a frame where the keys moved — a till or an un-till — which is a hand
   * gesture, not a loop. Values follow their TILE: a bounce mid-wobble on tile (5,7) keeps
   * wobbling on tile (5,7) whatever index it wakes up at, a position this differ has never
   * seen is primed from the projection so it fires nothing, and a position that stopped
   * being farmland takes its memory with it.
   */
  private realign(field: FieldView): void {
    const count = field.crop.length;

    let same = count === this.keys.length;
    if (same) {
      for (let i = 0; i < count; i++) {
        if (this.keys[i] !== worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0)) {
          same = false;
          break;
        }
      }
    }
    if (same) return;

    interface Held {
      ready: number;
      crop: number;
      compost: number;
      wilt: number;
      poured: number;
      bounceLife: number;
      bounceTotal: number;
    }
    const remembered = new Map<number, Held>();
    for (let i = 0; i < this.keys.length; i++) {
      remembered.set(this.keys[i]!, {
        ready: this.prevReady[i] ?? 0,
        crop: this.prevCrop[i] ?? 0,
        compost: this.prevCompost[i] ?? 0,
        wilt: this.prevWilt[i] ?? WiltStage.Fresh,
        poured: this.prevPoured[i] ?? 0,
        bounceLife: this.bounceLife[i] ?? 0,
        bounceTotal: this.bounceTotal[i] ?? BOUNCE_MS,
      });
    }

    for (let i = 0; i < count; i++) {
      const key = worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0);
      const held = remembered.get(key);
      if (held === undefined) {
        // Fresh dirt: primed exactly as the first frame primes, so the till emits nothing.
        this.prevReady[i] = field.ready[i] ?? 0;
        this.prevCrop[i] = field.crop[i] ?? 0;
        this.prevCompost[i] = field.compost[i] ?? 0;
        this.prevWilt[i] = field.wilt[i] ?? WiltStage.Fresh;
        this.prevPoured[i] = field.lastPouredTick[i] ?? 0;
        this.bounceLife[i] = 0;
        this.bounceTotal[i] = BOUNCE_MS;
      } else {
        this.prevReady[i] = held.ready;
        this.prevCrop[i] = held.crop;
        this.prevCompost[i] = held.compost;
        this.prevWilt[i] = held.wilt;
        this.prevPoured[i] = held.poured;
        this.bounceLife[i] = held.bounceLife;
        this.bounceTotal[i] = held.bounceTotal;
      }
      this.keys[i] = key;
    }

    this.keys.length = count;
    this.prevReady.length = count;
    this.prevCrop.length = count;
    this.prevCompost.length = count;
    this.prevWilt.length = count;
    this.prevPoured.length = count;
    this.bounceLife.length = count;
    this.bounceTotal.length = count;
  }

  private spawnPop(field: FieldView, index: number, wilt: number): void {
    // Per-entry coordinates ARE the addressing scheme ([[066]]); the bounding-box
    // arithmetic this replaces is wrong the moment the field is non-rectangular.
    const tileX = field.tileX[index] ?? 0;
    const tileY = field.tileY[index] ?? 0;

    for (const pop of this.pops) {
      if (pop.life > 0) continue;

      // What flies is what you actually got. A Day-Old harvest yields the Day-Old item, and
      // a potato that looks wrong on the way to your pocket is a small lie about the sim.
      const item = wilt === WiltStage.Wilted ? ItemId.DayOldPotato : ItemId.RussetPotato;
      pop.sprite.texture = this.page.texture(item);

      pop.total = POP_MS * (0.9 + Math.random() * 0.2);
      pop.life = pop.total;
      pop.fromX = tileX * TILE_PX + TILE_PX / 2;
      pop.fromY = tileY * TILE_PX + TILE_PX / 2;
      pop.driftX = (Math.random() - 0.5) * 7;
      pop.wobble = Math.random() * Math.PI * 2;
      pop.spin = (Math.random() - 0.5) * 1.6;
      pop.sprite.alpha = 1;
      pop.sprite.visible = true;
      return;
    }
    // Pool exhausted: drop the effect. Silently doing nothing is the right failure — the
    // potato is already in the inventory, and the alternative is allocating under load.
  }

  private snapshot(field: FieldView): void {
    const count = field.crop.length;
    for (let i = 0; i < count; i++) {
      this.prevReady[i] = field.ready[i] ?? 0;
      this.prevCrop[i] = field.crop[i] ?? 0;
      this.prevCompost[i] = field.compost[i] ?? 0;
      this.prevWilt[i] = field.wilt[i] ?? WiltStage.Fresh;
      this.prevPoured[i] = field.lastPouredTick[i] ?? 0;
      this.keys[i] = worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0);
    }
    this.keys.length = count;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function easeInCubic(t: number): number {
  return t * t * t;
}
