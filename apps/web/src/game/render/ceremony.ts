// Plan §3's Hall of Hands: ~10 seconds of in-world theatre the first time a machine that
// matters ever runs.
//
// ── THE THREE CONSTRAINTS ARE THE WHOLE DESIGN ─────────────────────────────────────
//
//  1. THE SIM KEEPS RUNNING. This is theatre, not a cutscene. Nothing here pauses the
//     tick, locks input, slows time, or queues a command — it cannot, because it holds no
//     reference to anything that could. Sim-speed controls are cut forever (§6), and a
//     "cinematic" that stopped the factory would be one by the back door.
//
//     It is also why there is NO LETTERBOX. Black bars are the universal grammar for "you
//     are not in control", and they would be a lie: the player is in control the entire
//     time. The celebration is a PLAQUE — §3's own vocabulary — which says "something is
//     being commemorated" without ever saying "hands off the wheel".
//
//  2. IT PLAYS ONCE, EVER. The flag lives in `WorldState.ceremonies` — hashed, saved, and
//     sorted — so it survives a reload. "A first time that happens again is not a first
//     time" is `view.ts`'s own phrasing, and this file's job is to trust it: the renderer
//     never decides whether a ceremony is owed, it only notices an id it has not seen.
//
//     THE FIRST FRAME ONLY PRIMES. Loading a save whose ceremonies have all played must
//     add them to `seen` without firing, or opening an old world replays its whole history
//     at once.
//
//  3. IT IS SKIPPABLE. Ten seconds is long, and the second time a player sees it — a new
//     world, a fresh save — it is in the way. Any key or any click ends it. The listeners
//     are passive and non-capturing and never call `preventDefault`, so the input that
//     skipped it ALSO does its normal job: pressing W skips the ceremony and walks. That
//     is the correct behaviour rather than a compromise. A player who wants to move is
//     precisely the player who is done watching.
//
// ── COSMETIC RANDOMNESS ────────────────────────────────────────────────────────────
// `Math.random` is used freely and never touches a sim RNG stream (§12). A ceremony that
// consumed one would make watching the theatre change what the world grew.

import { TILE_PX } from './pixel';

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';

import { CeremonyId, MachineKind } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

// NOTE: this module deliberately does NOT import `./textures`. It takes its one frame as a
// `Texture` instead, for the same reason `pipe-shape.ts` and `liquids.ts` are separate from
// the layer that draws them: `textures.ts` pulls in the generated atlas manifest through the
// `@/` alias, and a module that touches it cannot be loaded by a test. The frame this wants
// is `ART.uiHover`, and `world.ts` is where that is looked up.

/** The whole show, in milliseconds. §3 says "~10 seconds"; this is that. */
const CEREMONY_MS = 10_000;

/** Where the outro starts. Everything retracts over the remaining time. */
const OUTRO_AT_MS = 8_800;

/** A skip does not snap — it jumps to here, so the plaque retracts instead of vanishing. */
const SKIP_TO_MS = CEREMONY_MS - 320;

/** The camera lean is fully applied by here, and starts returning at `OUTRO_AT_MS`. */
const CAMERA_IN_MS = 900;

/** How far toward the machine the camera leans, at most. Never all the way. */
const CAMERA_BIAS = 0.62;

/** The sweep across the coverage patch: when it starts, and how long one tile's flash is. */
const SWEEP_START_MS = 1_100;
const SWEEP_ROW_MS = 340;
const SWEEP_COL_MS = 90;
const FLASH_MS = 900;

/** Never grow the flash pool past this. Radius 4 is a 9x9 patch and nothing covers more. */
const MAX_FLASHES = 81;

/**
 * The v0.1 barrel sprinkler's trigger, derived rather than published.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THIS ONE IS A STAND-IN, AND THE REAL FIX IS ONE LINE IN `packages/sim`.
 *
 *  `CeremonyId` has ids for the v0.4 piped head and the Irrigation Hub, and `tick.ts`
 *  calls `markCeremony` for both. The v0.1 barrel sprinkler — the machine this entire
 *  project is a delivery mechanism for — has NEITHER. `advanceSprinkler` never marks
 *  anything, so its first activation is not recorded in world state at all.
 *
 *  The correct fix is `CeremonyId.Sprinkler` plus one `markCeremony` call in
 *  `advanceSprinkler`. That is sim-lane work and is not done here.
 *
 *  Until then this derives the same fact from state that IS hashed and saved: a sprinkler
 *  whose lifetime `wateredCount` has left zero. Priming on the first frame makes it
 *  survive a reload correctly, which is the property the acceptance criterion names. The
 *  one case it gets wrong and the sim's own flag would not: demolish the only sprinkler
 *  after it has watered, build another, and the ceremony plays a second time. That is a
 *  real gap, it is deliberate, and it closes the moment the sim marks the ceremony itself.
 *
 *  Deliberately NOT a value from `CeremonyId` — this string is renderer-local and must
 *  never be mistaken for save surface.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
const DERIVED_SPRINKLER = 'renderer:barrel-sprinkler-first-run';

interface CeremonyCopy {
  title: string;
  subtitle: string;
  tint: number;
}

/** What each celebration says. Short: it is read at a glance, mid-stride, while playing. */
const COPY: Record<string, CeremonyCopy> = {
  [DERIVED_SPRINKLER]: {
    title: 'THE SPRINKLER',
    subtitle: 'it waters without you',
    tint: 0x7ac8f0,
  },
  [CeremonyId.PipedSprinkler]: {
    title: 'PLUMBED',
    subtitle: 'the water comes to it now',
    tint: 0x6fc0e8,
  },
  [CeremonyId.IrrigationHub]: {
    title: 'THE IRRIGATION HUB',
    subtitle: 'it waters only what is thirsty',
    tint: 0x9ef0a8,
  },
};

interface Flash {
  sprite: Sprite;
  /** World px of the tile's top-left. */
  x: number;
  y: number;
  /** When this tile lights up, relative to the ceremony's start. */
  atMs: number;
}

interface Active {
  id: string;
  copy: CeremonyCopy;
  elapsedMs: number;
  /** The machine being celebrated, in world px, captured at the start. */
  focusX: number;
  focusY: number;
  flashes: Flash[];
}

export class Ceremony {
  /** Screen-space chrome: the plaque. Added BELOW the HUD by the scene. */
  readonly screenRoot = new Container();

  /** The frame used for both the halo and the sweep flashes: a white box, tinted at draw. */
  private readonly frame: Texture;
  private readonly attach: (sprite: Sprite) => void;

  private readonly plaque = new Graphics();
  private readonly title: Text;
  private readonly subtitle: Text;
  private readonly halo: Sprite;

  /** Grown on demand, reused across ceremonies, never shrunk. */
  private readonly flashPool: Sprite[] = [];

  private readonly seen = new Set<string>();
  private primed = false;
  private active: Active | null = null;

  private viewWidth = 1;
  private viewHeight = 1;

  private readonly onSkip: () => void;

  constructor(frame: Texture, attach: (sprite: Sprite) => void) {
    this.frame = frame;
    this.attach = attach;

    this.title = new Text({
      text: '',
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 19,
        fontWeight: 'bold',
        letterSpacing: 2,
        fill: 0xf2ecdd,
      },
    });
    this.title.anchor.set(0.5, 0);

    this.subtitle = new Text({
      text: '',
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        fill: 0xb9ae97,
      },
    });
    this.subtitle.anchor.set(0.5, 0);

    this.screenRoot.addChild(this.plaque, this.title, this.subtitle);
    this.screenRoot.visible = false;

    // A ring that pulses on the machine for the whole show. `ui_hover` is a white frame
    // drawn to be tinted at draw time, which is exactly what this wants.
    this.halo = new Sprite(frame);
    this.halo.anchor.set(0.5, 0.5);
    this.halo.visible = false;
    attach(this.halo);

    this.onSkip = () => {
      this.skip();
    };
  }

  /** Whether theatre is running. The host needs this for nothing; it is for tests and debug. */
  get playing(): boolean {
    return this.active !== null;
  }

  /**
   * Notice a ceremony that has just become owed.
   *
   * Called once per frame with the projection. Cheap: two short arrays and a set lookup.
   */
  observe(view: WorldView): void {
    // Prime without firing. See constraint 2 in the header.
    if (!this.primed) {
      for (const id of view.ceremonies) this.seen.add(id);
      if (derivedSprinklerFired(view)) this.seen.add(DERIVED_SPRINKLER);
      this.primed = true;
      return;
    }

    for (const id of view.ceremonies) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.start(id, view);
    }

    if (!this.seen.has(DERIVED_SPRINKLER) && derivedSprinklerFired(view)) {
      this.seen.add(DERIVED_SPRINKLER);
      this.start(DERIVED_SPRINKLER, view);
    }
  }

  /** Viewport size in CSS px, for the plaque's layout. */
  layout(viewWidth: number, viewHeight: number): void {
    this.viewWidth = Math.max(1, viewWidth);
    this.viewHeight = Math.max(1, viewHeight);
  }

  /**
   * The camera's look-at target, biased toward whatever is being celebrated.
   *
   * Returns the player's own position untouched when nothing is playing, so the caller can
   * hand its result straight to `lookAt` with no branch.
   *
   * NOTE, because it is easy to be surprised by: v0.1's lot is 16x16 tiles = 256 world px,
   * and `clampToWorld` CENTRES the world on any axis where it fits. At the default 3x zoom
   * on a viewport wider than 768 CSS px, that means the camera is already pinned to the
   * middle of the lot and this bias is silently discarded. It becomes visible at 4x and 6x,
   * where the lot no longer fits. That is correct behaviour rather than a bug — but it does
   * mean the framing cannot be the ceremony's main event, which is why the in-world sweep
   * and the plaque carry it.
   */
  cameraTarget(playerX: number, playerY: number, out: { x: number; y: number }): void {
    out.x = playerX;
    out.y = playerY;

    const active = this.active;
    if (active === null) return;

    const blend = this.cameraBlend(active.elapsedMs) * CAMERA_BIAS;
    if (blend <= 0) return;

    out.x = playerX + (active.focusX - playerX) * blend;
    out.y = playerY + (active.focusY - playerY) * blend;
  }

  /** Advance the show. Does nothing at all on frames where none is running. */
  update(deltaMs: number): void {
    const active = this.active;
    if (active === null) return;

    active.elapsedMs += Math.min(deltaMs, 64);
    if (active.elapsedMs >= CEREMONY_MS) {
      this.stop();
      return;
    }

    const t = active.elapsedMs;
    this.updatePlaque(active, t);
    this.updateHalo(t);
    this.updateSweep(active, t);
  }

  destroy(): void {
    this.detachSkip();
    this.halo.destroy();
    for (const sprite of this.flashPool) sprite.destroy();
    this.flashPool.length = 0;
    // `screenRoot` is a child of the scene's own screen root and is destroyed with it.
    this.active = null;
  }

  // --- starting and stopping -------------------------------------------------------------

  private start(id: string, view: WorldView): void {
    const copy = COPY[id];
    if (copy === undefined) return;

    const machine = locate(id, view);
    // No machine to point at means no theatre. Playing a celebration framed on empty dirt
    // is worse than playing none, and this can legitimately happen if a save arrives with
    // a ceremony owed for something that has since been removed.
    if (machine === null) return;

    // One at a time. A second ceremony landing mid-show replaces the first rather than
    // overlapping it — two plaques stacked on each other is not a case worth designing for.
    if (this.active !== null) this.stop();

    const focusX = (machine.tileX + machine.tilesWide / 2) * TILE_PX;
    const focusY = (machine.tileY + machine.tilesHigh / 2) * TILE_PX;

    this.active = {
      id,
      copy,
      elapsedMs: 0,
      focusX,
      focusY,
      flashes: this.buildSweep(machine),
    };

    this.title.text = copy.title;
    this.subtitle.text = copy.subtitle;
    this.title.tint = copy.tint;
    this.screenRoot.visible = true;
    this.halo.visible = true;
    this.halo.tint = copy.tint;
    this.halo.position.set(focusX, focusY);

    this.attachSkip();
  }

  private stop(): void {
    this.detachSkip();
    this.screenRoot.visible = false;
    this.halo.visible = false;
    const active = this.active;
    if (active !== null) {
      for (const flash of active.flashes) flash.sprite.visible = false;
    }
    this.active = null;
  }

  private skip(): void {
    const active = this.active;
    if (active === null) return;
    // Jump to the outro rather than cutting: a plaque that blinks out of existence reads as
    // a crash. It is gone in a third of a second either way.
    if (active.elapsedMs < SKIP_TO_MS) active.elapsedMs = SKIP_TO_MS;
  }

  private attachSkip(): void {
    if (typeof window === 'undefined') return;
    // Passive, non-capturing, and no `preventDefault` anywhere: the keystroke that skips the
    // ceremony still walks the farmer. See constraint 3.
    window.addEventListener('keydown', this.onSkip, { passive: true });
    window.addEventListener('pointerdown', this.onSkip, { passive: true });
  }

  private detachSkip(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.onSkip);
    window.removeEventListener('pointerdown', this.onSkip);
  }

  // --- the pieces --------------------------------------------------------------------------

  /**
   * The plaque: slides up from the bottom edge, holds, slides back down.
   *
   * Bottom-centre rather than centre-screen, because the middle of the screen is where the
   * player is standing and the field they are working is.
   */
  private updatePlaque(active: Active, t: number): void {
    const enter = clamp01(t / 620);
    const exit = t < OUTRO_AT_MS ? 0 : clamp01((t - OUTRO_AT_MS) / (CEREMONY_MS - OUTRO_AT_MS));
    const shown = easeOutCubic(enter) * (1 - easeInCubic(exit));

    const width = Math.min(360, this.viewWidth - 32);
    const height = 62;
    const restY = this.viewHeight - height - 28;

    this.plaque.clear();
    this.plaque
      .roundRect(0, 0, width, height, 7)
      .fill({ color: 0x14100c, alpha: 0.86 * shown })
      .roundRect(0, 0, width, 2, 1)
      .fill({ color: active.copy.tint, alpha: 0.9 * shown });

    // Slides up out of the bottom edge. `shown` drives both the offset and the fade, so the
    // two can never disagree about whether it is on screen.
    const x = Math.round((this.viewWidth - width) / 2);
    const y = Math.round(restY + (height + 40) * (1 - shown));
    this.screenRoot.position.set(x, y);

    this.title.position.set(width / 2, 13);
    this.subtitle.position.set(width / 2, 38);
    this.title.alpha = shown;
    this.subtitle.alpha = shown * 0.9;
  }

  /** A ring breathing on the machine, so the plaque's subject is never ambiguous. */
  private updateHalo(t: number): void {
    const fade = t < OUTRO_AT_MS ? 1 : clamp01((CEREMONY_MS - t) / (CEREMONY_MS - OUTRO_AT_MS));
    const pulse = (t % 1400) / 1400;
    this.halo.scale.set(1 + easeOutCubic(pulse) * 1.35);
    this.halo.alpha = (1 - pulse) * 0.75 * fade;
  }

  /**
   * §3's "sprinklers pop on down the rows", with one sprinkler: the water arriving across
   * the coverage patch, a tile at a time, top row first.
   */
  private updateSweep(active: Active, t: number): void {
    for (const flash of active.flashes) {
      const local = t - flash.atMs;
      if (local < 0 || local > FLASH_MS) {
        flash.sprite.visible = false;
        continue;
      }
      const p = local / FLASH_MS;
      flash.sprite.visible = true;
      flash.sprite.position.set(flash.x + TILE_PX / 2, flash.y + TILE_PX / 2);
      flash.sprite.scale.set(0.8 + easeOutCubic(p) * 0.45);
      flash.sprite.alpha = (1 - p) * 0.8;
    }
  }

  private buildSweep(machine: MachineView): Flash[] {
    const flashes: Flash[] = [];
    const radius = machine.coverageRadius;
    if (radius <= 0) return flashes;

    let used = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (used >= MAX_FLASHES) break;
        const sprite = this.flashSprite(used);
        used += 1;
        flashes.push({
          sprite,
          x: (machine.tileX + dx) * TILE_PX,
          y: (machine.tileY + dy) * TILE_PX,
          // Down the rows, then along each row — plus a few milliseconds of jitter so the
          // sweep reads as water rather than as a spreadsheet filling in.
          atMs:
            SWEEP_START_MS +
            (dy + radius) * SWEEP_ROW_MS +
            (dx + radius) * SWEEP_COL_MS +
            Math.random() * 60,
        });
      }
    }

    // Anything the previous ceremony lit that this one does not: park it off screen.
    for (let i = used; i < this.flashPool.length; i++) {
      this.flashPool[i]!.visible = false;
    }
    return flashes;
  }

  private flashSprite(index: number): Sprite {
    const existing = this.flashPool[index];
    if (existing !== undefined) return existing;
    const sprite = new Sprite(this.frame);
    sprite.anchor.set(0.5, 0.5);
    sprite.tint = 0xd8f4ff;
    sprite.visible = false;
    this.attach(sprite);
    this.flashPool.push(sprite);
    return sprite;
  }

  private cameraBlend(t: number): number {
    if (t < CAMERA_IN_MS) return easeOutCubic(t / CAMERA_IN_MS);
    if (t < OUTRO_AT_MS) return 1;
    return 1 - easeInCubic(clamp01((t - OUTRO_AT_MS) / (CEREMONY_MS - OUTRO_AT_MS)));
  }
}

/**
 * Has a v0.1 barrel sprinkler ever poured in this world?
 *
 * `wateredCount` is lifetime and lives in `WorldState`, so it is hashed and saved — which
 * is the property that makes this survive a reload. See `DERIVED_SPRINKLER` for why this is
 * derived at all and what it gets wrong.
 */
function derivedSprinklerFired(view: WorldView): boolean {
  for (const machine of view.machines) {
    if (machine.kind === MachineKind.Sprinkler && machine.wateredCount > 0) return true;
  }
  return false;
}

/** The machine a ceremony is about, or null when nothing in the world matches. */
function locate(id: string, view: WorldView): MachineView | null {
  let fallback: MachineView | null = null;

  for (const machine of view.machines) {
    if (machine.coverageRadius <= 0) continue;
    if (fallback === null) fallback = machine;

    if (id === DERIVED_SPRINKLER) {
      if (machine.kind === MachineKind.Sprinkler && machine.wateredCount > 0) return machine;
    } else if (id === CeremonyId.IrrigationHub) {
      if (machine.moistureSensing === 1 && machine.wateredCount > 0) return machine;
    } else if (id === CeremonyId.PipedSprinkler) {
      if (machine.moistureSensing === 0 && machine.network !== 0 && machine.wateredCount > 0) {
        return machine;
      }
    }
  }

  return fallback;
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
