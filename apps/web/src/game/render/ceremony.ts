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

import { BitmapText, Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';

import { BotKind, CeremonyId, ContractPhase, MachineKind } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

// NOTE: this module deliberately does NOT import `./textures`. It takes its one frame as a
// `Texture` instead, for the same reason `pipe-shape.ts` and `liquids.ts` are separate from
// the layer that draws them: `textures.ts` pulls in the generated atlas manifest through the
// `@/` alias, and a module that touches it cannot be loaded by a test. The frame this wants
// is `ART.uiHover`, and `world.ts` is where that is looked up.
//
// It does not import `./font` either, for exactly the same reason — so the family name and
// the base size are spelled out below. `BitmapText` with an uninstalled family is inert
// rather than fatal, which is what keeps `ceremony.test.ts` able to construct one; in the
// game `world.ts` installs the font before this is ever built. Plain literals rather than
// imports IS the cost of that, and it is the same cost `ART.uiHover` already pays.

/**
 * The game's bitmap font, spelled out rather than imported — see the note above about why
 * this module cannot reach `./font`. `UI_FONT.family` and `UI_FONT.fontSize` are the source
 * of truth; if they ever move, these move with them.
 */
const PLAQUE_FONT = 'snack';
const PLAQUE_BASE_SIZE = 10;

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

interface CeremonyCopy {
  title: string;
  subtitle: string;
  tint: number;
}

/** What each celebration says. Short: it is read at a glance, mid-stride, while playing. */
const COPY: Record<string, CeremonyCopy> = {
  [CeremonyId.Sprinkler]: {
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
  // THE ONLY WARM ONE, and that is the point rather than a coincidence. The other three are
  // water — cool blues and a green — because all three are the same promise about the same
  // chore. This one is the lot's goods leaving without the player standing at the bin, so it
  // takes the Commerce row's own colour: timber and brand red, which is what the cart and the
  // depot are painted in. The plaque tells you which ladder you just climbed before you read it.
  [CeremonyId.FirstTruck]: {
    title: 'THE FIRST TRUCK',
    subtitle: 'it sells while you are elsewhere',
    tint: 0xe0674a,
  },
  /**
   * The first crop pulled by something that is not your hand ([[038]]).
   *
   * THE SUBTITLE IS THE ONLY ONE HERE WRITTEN IN THE SECOND PERSON PAST TENSE, and that is the
   * point of it: the other four are promises about what a machine will do from now on, because
   * that is what those machines are. This one is about a chore ENDING. §8's gate for the feature
   * is whether the player watches with pride or alt-tabs, and "it farms for you now" is a claim
   * about the future that the player has just this second watched come true.
   *
   * Harvest amber, the colour of the ready-mark and of the harvester's own chassis, so the
   * plaque names the ladder before anybody reads it — the same job the truck's timber red does.
   */
  [CeremonyId.FirstBot]: {
    title: 'IT PULLED ONE',
    subtitle: 'nobody has to walk the rows now',
    tint: 0xe8b53d,
  },
};

/**
 * How far west the departure trail runs, in tiles, and how long each tile holds the eye.
 *
 * West because that is where the road is: `cartRunTicks` charges ten ticks per tile between the
 * vehicle and the lot's WEST edge, so the direction goods leave in is a fact about the sim and
 * not a flourish. The step is slow on purpose — a truck pulling out is a heavier thing than
 * water arriving down a row, and at the sweep's 90 ms it read as a spark running along a fuse.
 */
const TRAIL_TILES = 12;
const TRAIL_STEP_MS = 240;

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
  private readonly title: BitmapText;
  private readonly subtitle: BitmapText;
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

    // Exactly 2x the font's base size, and 1x for the subtitle. An integer multiple is the
    // whole reason the plaque no longer shimmers: at 19px of a browser face the glyph grid
    // landed between screen pixels and the title crawled as it faded in.
    this.title = new BitmapText({
      text: '',
      style: {
        fontFamily: PLAQUE_FONT,
        fontSize: PLAQUE_BASE_SIZE * 2,
        letterSpacing: 2,
        fill: 0xffffff,
      },
    });
    this.title.anchor.set(0.5, 0);

    this.subtitle = new BitmapText({
      text: '',
      style: { fontFamily: PLAQUE_FONT, fontSize: PLAQUE_BASE_SIZE, fill: 0xc6b8a0 },
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
      this.primed = true;
      return;
    }

    for (const id of view.ceremonies) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.start(id, view);
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
   * NOTE, AND IT USED TO CUT THE OTHER WAY: `clampToWorld` CENTRES the world on any axis
   * where it fits, and v0.1's 16x16 lot (256 world px) fitted at 3x on any viewport wider
   * than 768 CSS px — so the camera was pinned to the middle of the lot and this bias was
   * silently discarded except at 4x and 6x. Land deeds took the world to 64x64 tiles = 1,024
   * world px, which fits nothing at 3x, so the bias now lands at every zoom rung. The framing
   * is still not the ceremony's main event — the in-world sweep and the plaque carry it — but
   * it is no longer a no-op, and a ten-second lean toward the far corner of a big lot is a
   * more noticeable thing than it was when it did nothing at all.
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
      flashes: this.buildSweep(id, machine),
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

    // Rounded, because half a pixel is all it takes to blur a bitmap glyph — the plaque's
    // width follows the viewport and lands on odd numbers half the time.
    const centre = Math.round(width / 2);
    this.title.position.set(centre, 14);
    this.subtitle.position.set(centre, 40);
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

  /**
   * The in-world half of a ceremony: what lights up, and in what order.
   *
   * TWO GESTURES, because there are two kinds of first time. Everything the sprinklers celebrate
   * is water reaching a PATCH, so it sweeps the coverage square a tile at a time. The truck
   * celebrates something LEAVING, so it runs a trail out to the road instead — the same pooled
   * sprites, told to go in a line rather than fill a square.
   */
  private buildSweep(id: string, machine: MachineView): Flash[] {
    const flashes =
      machine.coverageRadius > 0 ? this.coverageSweep(machine) : this.departureTrail(id, machine);
    // Parked HERE rather than inside each gesture, so an early return in either one cannot leave
    // the last ceremony's tiles lit under this one. Both build from index 0 of the same pool, so
    // the count is always the prefix that is in use.
    this.parkUnused(flashes.length);
    return flashes;
  }

  /**
   * The truck pulling out: one tile at a time, west, toward the road at the lot's edge.
   *
   * Stops at the map edge rather than running off it — `tileX` tiles is exactly how far there is
   * to go, and a trail that kept flashing past the fence would be celebrating a truck driving
   * through a hedge. A depot sitting hard against the west edge gets a trail of nothing, which
   * is honest: the plaque and the halo still play.
   */
  private departureTrail(id: string, machine: MachineView): Flash[] {
    const flashes: Flash[] = [];
    if (id !== CeremonyId.FirstTruck) return flashes;

    const length = Math.min(TRAIL_TILES, machine.tileX);
    const y = (machine.tileY + (machine.tilesHigh - 1) / 2) * TILE_PX;

    let used = 0;
    for (let step = 1; step <= length; step++) {
      if (used >= MAX_FLASHES) break;
      const sprite = this.flashSprite(used);
      used += 1;
      flashes.push({
        sprite,
        x: (machine.tileX - step) * TILE_PX,
        y,
        // A little jitter, exactly as the sweep has, so the trail reads as a vehicle rather
        // than as a progress bar. Cosmetic `Math.random`, never a sim stream — see the header.
        atMs: SWEEP_START_MS + step * TRAIL_STEP_MS + Math.random() * 70,
      });
    }

    return flashes;
  }

  private coverageSweep(machine: MachineView): Flash[] {
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

    return flashes;
  }

  /** Anything the previous ceremony lit that this one does not: park it off screen. */
  private parkUnused(used: number): void {
    for (let i = used; i < this.flashPool.length; i++) {
      this.flashPool[i]!.visible = false;
    }
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

/** The machine a ceremony is about, or null when nothing in the world matches. */
function locate(id: string, view: WorldView): MachineView | null {
  // THE TRUCK IS ANSWERED BEFORE THE COVERAGE SCAN, not inside it. Every other ceremony is about
  // water, so the loop below opens by skipping anything that waters nothing — which is every
  // depot on the lot. Reached through that filter the truck ceremony would have haloed a
  // sprinkler on the far side of the map and called it the first departure.
  if (id === CeremonyId.FirstTruck) return locateDepartingDepot(view);
  // And the bot, for exactly the same reason: a dock waters nothing, so reached through the
  // coverage filter below the first harvest would have haloed a sprinkler and called it a robot.
  if (id === CeremonyId.FirstBot) return locateHarvesterDock(view);

  let fallback: MachineView | null = null;

  for (const machine of view.machines) {
    if (machine.coverageRadius <= 0) continue;
    if (fallback === null) fallback = machine;

    if (id === CeremonyId.Sprinkler) {
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

/**
 * The depot whose truck just left, or the first one on the lot.
 *
 * The projection does not name the departing depot — the ceremony flag is a bare id — but it
 * does publish every contract's phase, and `Rolling` means "out on the road" this instant. On the
 * frame the flag first appears that is the truck being celebrated, so the halo lands on the dock
 * it actually rolled out of rather than on whichever depot was built first. With two depots and
 * one truck moving, guessing would be wrong half the time.
 */
function locateDepartingDepot(view: WorldView): MachineView | null {
  let depotId = 0;
  for (const contract of view.commerce.contracts) {
    if (contract.phase === ContractPhase.Rolling) {
      depotId = contract.depotId;
      break;
    }
  }

  let fallback: MachineView | null = null;
  for (const machine of view.machines) {
    if (machine.kind !== MachineKind.TruckDepot) continue;
    if (machine.id === depotId) return machine;
    if (fallback === null) fallback = machine;
  }
  return fallback;
}

/**
 * The shed the bot that just harvested came out of, or the first harvester dock on the lot.
 *
 * THE DOCK RATHER THAN THE BOT, and the bot is the thing that did it — so this is a choice. The
 * ceremony frames a MACHINE: it haloes a footprint, leans the camera at it, and holds for ten
 * seconds. A bot is a moving 16px sprite that spends most of those ten seconds walking somewhere
 * else, so a halo pinned to it would either chase it around the field or sit on the dirt it left.
 * The dock is where the bot came from and where it is heading back to with the crop, which means
 * the shot contains both the machine and, before long, the robot walking into it.
 *
 * Found THROUGH the bot rather than by taking the first dock, so a lot with two docks haloes the
 * one that actually did the work. `view.bots` is in id order and the first harvester is the
 * oldest one, which on the frame this fires is the only one that can have harvested anything.
 */
function locateHarvesterDock(view: WorldView): MachineView | null {
  let dockId = 0;
  for (const bot of view.bots) {
    if (bot.kind !== BotKind.Harvester) continue;
    dockId = bot.dockId;
    break;
  }

  let fallback: MachineView | null = null;
  for (const machine of view.machines) {
    if (machine.kind !== MachineKind.HarvesterDock) continue;
    if (machine.id === dockId) return machine;
    if (fallback === null) fallback = machine;
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
