// Machines act while they work ([[091]]) — the motion table, the working detector, and
// the speck pool.
//
// ── EVERY KIND GETS A NAMED MOTION (owner ruling, 2026-08-15) ───────────────────────
// "I want every machine to have an animation." So `MACHINE_MOTION` is a
// `Record<MachineKind, MotionSpec>` on purpose: the day the sim adds a kind, the build
// fails here until somebody names its motion. The generic bob survives only as a wave
// SHAPE some kinds share at their own period — never as the whole answer.
//
// ── THE WORKING DETECTOR (§12-clean) ────────────────────────────────────────────────
// A machine moves only while it is honestly doing something, and each kind names the
// signal that proves it:
//
//   'progress'  — `progressPermille` advanced recently AND the lamp is green. The diff
//                 is renderer-local last-value memory on the `farm-fx.ts` pour-differ
//                 precedent: first sight primes and emits nothing, so a loaded save does
//                 not open with the whole factory flinching. The lamp gate is what makes
//                 stillness CRISP — starved, blocked, halted and jammed all leave
//                 `Running`, so the machine freezes the same frame the lamp changes
//                 rather than a hold-window later.
//   'running'   — the lamp alone, for the utility machines whose Running lamp IS the
//                 activity fact (sprinklers, pump, hub, recirculator — see `lampFor`).
//   'flow'      — `flowMlPerMinute !== 0`, for the Tank, whose Running lamp only means
//                 "not empty" and would breathe a parked tank forever.
//   'bot'       — a bot docked to this machine is out (`phase !== 0`). Docks and the bay
//                 have no operation of their own; the robot is the operation.
//   'towed'     — the machine's own tile moved (the hand cart being dragged).
//   'beltItem'  — a good is on the junction's tile right now.
//   event pulses — a one-shot burst when the diffed fact moves: a sale for the bin, the
//                 cart's away flag flipping, a depot's floor stock dropping (the truck),
//                 the cellar's contents changing, the station spending a kit.
//
// Jammed and Halted are still under EVERY driver — a broken machine performs nothing.
//
// ── BUDGET AND PIXEL DISCIPLINE ─────────────────────────────────────────────────────
// Motion is position/size writes on the sprites the machine already owns; every offset
// is a WHOLE source pixel (the waves return integers by construction, and the test pins
// it), so the snap rules in `pixel.ts` are never in play. The one allocation is the
// speck pool, built once and shared by the fryer's boil, the kettle's steam, the
// carbonator's fizz and the kitchen's sizzle; specks follow the droplet idiom in
// `index.ts` (transient, sub-pixel drift, pool-bounded, dropped silently when full).
// Readouts — lamp, wrench, progress bar, hopper, pip, ports — never move: they are
// instruments, not parts of the machine.

import { Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';

import { LampState, MachineKind } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

/**
 * The junction's activity probe, INJECTED rather than imported: `belt-items.ts` pulls the
 * generated art manifest in at module scope, which a vitest run has no resolver for — the
 * same seam `ceremony.ts` keeps to stay loadable by a test. The scene passes
 * `beltItemAtTile`; the test passes nothing and junctions simply never stamp.
 */
export type BeltItemProbe = (view: WorldView, tileX: number, tileY: number) => boolean;

/** How long after the last observed permille step a 'progress' machine keeps moving.
 * Generous because a long recipe's permille can step slower than the tick — the Running
 * lamp, not this window, is what stops a stalled machine on the very frame it stalls. */
export const PROGRESS_HOLD_MS = 650;

/** Hold for the towed cart and the junction, whose signals are naturally intermittent. */
const SIGNAL_HOLD_MS = 300;

/** Bounded speck pool, shared by every steaming, boiling, fizzing, sizzling machine. */
export const SPECK_POOL = 96;

/** Desynchronises a row of same-kind machines. Prime-ish, per the lamp/bob precedent. */
const PHASE_SALT_MS = 137;

export type SpeckStyle = 'oil' | 'steam' | 'boil' | 'fizz';

type Driver =
  | 'progress'
  | 'running'
  | 'flow'
  | 'bot'
  | 'towed'
  | 'beltItem'
  | 'sales'
  | 'away'
  | 'stockedDrop'
  | 'stockChange'
  | 'kitSpend';

type WaveId =
  | 'still'
  | 'chop'
  | 'press'
  | 'piston'
  | 'sineX'
  | 'sineY'
  | 'shake'
  | 'grind'
  | 'squeeze'
  | 'clamp'
  | 'crimp'
  | 'throb'
  | 'swirl'
  | 'lift'
  | 'doubleTap'
  | 'flutter'
  | 'hop'
  | 'shudder'
  | 'jitter'
  | 'crank';

export interface MotionSpec {
  /** The motion's name — documentation, the report table, and the uniqueness test. */
  readonly name: string;
  readonly driver: Driver;
  readonly wave: WaveId;
  /** Continuous drivers: the loop period. Pulse drivers: the burst's whole duration. */
  readonly periodMs: number;
  /** Speck flavour emitted while working, from the one shared pool. */
  readonly specks?: SpeckStyle;
  /** Tank only: breathe the fill column's alpha instead of moving the body. */
  readonly fillPulse?: boolean;
}

/** One frame of motion: whole-pixel offsets for the body and its paint decals. */
export interface MotionSample {
  dx: number;
  dy: number;
  /** Width/height deltas, applied through `setSize` — a squeeze keeps its base planted
   * because the wave pairs every `dh` with the `dy` that pins the bottom edge. */
  dw: number;
  dh: number;
  specks: SpeckStyle | null;
  fillPulse: boolean;
}

/**
 * THE TABLE. kind → named motion, driver, wave, period. Exhaustive by type: a new
 * `MachineKind` will not compile until it has a row, which is the point.
 */
export const MACHINE_MOTION: Record<MachineKind, MotionSpec> = {
  [MachineKind.SellBin]: { name: 'kaching', driver: 'sales', wave: 'hop', periodMs: 480 },
  [MachineKind.ChipKitchen]: {
    name: 'chop-and-sizzle',
    driver: 'progress',
    wave: 'chop',
    periodMs: 520,
    specks: 'oil',
  },
  [MachineKind.Sprinkler]: { name: 'wag', driver: 'running', wave: 'sineX', periodMs: 1300 },
  [MachineKind.Washer]: { name: 'slosh', driver: 'progress', wave: 'sineX', periodMs: 760 },
  [MachineKind.Slicer]: { name: 'chop', driver: 'progress', wave: 'chop', periodMs: 440 },
  [MachineKind.Fryer]: {
    name: 'bubble',
    driver: 'progress',
    wave: 'still',
    periodMs: 600,
    specks: 'boil',
  },
  [MachineKind.Seasoner]: { name: 'shake', driver: 'progress', wave: 'shake', periodMs: 620 },
  [MachineKind.Bagger]: { name: 'squeeze', driver: 'progress', wave: 'squeeze', periodMs: 680 },
  [MachineKind.Pump]: { name: 'throb', driver: 'running', wave: 'throb', periodMs: 420 },
  [MachineKind.Tank]: {
    name: 'fill-breathe',
    driver: 'flow',
    wave: 'still',
    periodMs: 900,
    fillPulse: true,
  },
  [MachineKind.PipedSprinkler]: {
    name: 'mist-wag',
    driver: 'running',
    wave: 'sineX',
    periodMs: 1100,
  },
  [MachineKind.IrrigationHub]: { name: 'surge', driver: 'running', wave: 'sineY', periodMs: 950 },
  [MachineKind.Recirculator]: { name: 'churn', driver: 'running', wave: 'sineX', periodMs: 420 },
  [MachineKind.Juicer]: { name: 'press', driver: 'progress', wave: 'press', periodMs: 900 },
  [MachineKind.Kettle]: {
    name: 'simmer',
    driver: 'progress',
    wave: 'lift',
    periodMs: 1150,
    specks: 'steam',
  },
  [MachineKind.Grinder]: { name: 'grind', driver: 'progress', wave: 'grind', periodMs: 260 },
  [MachineKind.SyrupMixer]: { name: 'swirl', driver: 'progress', wave: 'swirl', periodMs: 820 },
  [MachineKind.Carbonator]: {
    name: 'fizz',
    driver: 'progress',
    wave: 'throb',
    periodMs: 460,
    specks: 'fizz',
  },
  [MachineKind.Bottler]: { name: 'piston', driver: 'progress', wave: 'piston', periodMs: 540 },
  [MachineKind.SixPacker]: { name: 'clamp', driver: 'progress', wave: 'clamp', periodMs: 760 },
  [MachineKind.ComboPacker]: { name: 'crimp', driver: 'progress', wave: 'crimp', periodMs: 900 },
  [MachineKind.DeliveryCart]: { name: 'jounce', driver: 'away', wave: 'shudder', periodMs: 450 },
  [MachineKind.TruckDepot]: {
    name: 'dispatch-shudder',
    driver: 'stockedDrop',
    wave: 'shudder',
    periodMs: 520,
  },
  [MachineKind.BeltJunction]: { name: 'shunt', driver: 'beltItem', wave: 'lift', periodMs: 300 },
  [MachineKind.RootCellar]: {
    name: 'chill-shiver',
    driver: 'stockChange',
    wave: 'jitter',
    periodMs: 420,
  },
  [MachineKind.Composter]: { name: 'heave', driver: 'progress', wave: 'lift', periodMs: 1400 },
  [MachineKind.HandCart]: { name: 'trundle', driver: 'towed', wave: 'lift', periodMs: 260 },
  [MachineKind.OrangeTree]: {
    name: 'orange-sway',
    driver: 'progress',
    wave: 'sineX',
    periodMs: 1900,
  },
  [MachineKind.LemonTree]: {
    name: 'lemon-sway',
    driver: 'progress',
    wave: 'sineX',
    periodMs: 2100,
  },
  [MachineKind.KolaTree]: { name: 'kola-sway', driver: 'progress', wave: 'sineX', periodMs: 2300 },
  [MachineKind.HarvesterDock]: { name: 'hum', driver: 'bot', wave: 'lift', periodMs: 800 },
  [MachineKind.PlanterDock]: { name: 'chug', driver: 'bot', wave: 'doubleTap', periodMs: 800 },
  [MachineKind.MaintenanceStation]: {
    name: 'crank',
    driver: 'kitSpend',
    wave: 'crank',
    periodMs: 700,
  },
  [MachineKind.DroneBay]: { name: 'rotor-whir', driver: 'bot', wave: 'flutter', periodMs: 220 },
  [MachineKind.PartsBench]: {
    name: 'tap-tap',
    driver: 'progress',
    wave: 'doubleTap',
    periodMs: 540,
  },
};

/**
 * One wave, sampled at phase `t` in [0, 1). PURE, and every offset a whole pixel: these
 * are the functions the test pins, and the only place motion arithmetic lives.
 *
 * Amplitude ceiling is 2 source px on every axis — presence, not carnival ([[091]]),
 * and small enough that no wave can walk a machine off its own footprint.
 */
export function sampleWave(wave: WaveId, t: number, out: MotionSample): void {
  out.dx = 0;
  out.dy = 0;
  out.dw = 0;
  out.dh = 0;
  switch (wave) {
    case 'still':
      return;
    case 'chop':
      // The blade: a long rest, a fast two-pixel bite, a one-pixel recover.
      out.dy = t < 0.55 ? 0 : t < 0.7 ? 1 : t < 0.85 ? 2 : 1;
      return;
    case 'press':
      // The inverse of the chop: a slow lean into the fruit, a slow release.
      out.dy = t < 0.2 ? 0 : t < 0.4 ? 1 : t < 0.7 ? 2 : t < 0.85 ? 1 : 0;
      return;
    case 'piston':
      // Slam down, DWELL on the bottle, come back up. The dwell is what reads as a piston.
      out.dy = t < 0.35 ? 0 : t < 0.45 ? 1 : t < 0.8 ? 2 : t < 0.9 ? 1 : 0;
      return;
    case 'sineX':
      // ±1px side-to-side. `Math.round(sin)` spends most of the cycle AT the extremes
      // with a beat of rest at each crossing — a slosh, not a slide.
      out.dx = Math.round(Math.sin(t * Math.PI * 2));
      return;
    case 'sineY':
      out.dy = Math.round(Math.sin(t * Math.PI * 2));
      return;
    case 'shake':
      // A burst of ±1 rattles, then a rest — a seasoning pass, not a permanent tremor.
      out.dx = t < 0.45 ? (Math.floor(t / 0.075) % 2 === 0 ? 1 : -1) : 0;
      return;
    case 'grind':
      // Continuous 1px rattle at the table's fast period. The period IS the character.
      out.dx = t < 0.5 ? 1 : -1;
      return;
    case 'squeeze':
      // Two-pixel vertical squash with the base pinned: dh always pairs with dy = -dh.
      if (t < 0.12 || (t >= 0.34 && t < 0.46)) {
        out.dh = -1;
        out.dy = 1;
      } else if (t < 0.34) {
        out.dh = -2;
        out.dy = 2;
      }
      return;
    case 'clamp':
      // The horizontal squeeze, centred: dw -2 with dx +1 pinches both sides equally.
      if (t < 0.28) {
        out.dw = -2;
        out.dx = 1;
      }
      return;
    case 'crimp':
      // Clamp, then squeeze: the combo packer folds sideways and presses down, in turn.
      if (t < 0.2) {
        out.dw = -2;
        out.dx = 1;
      } else if (t >= 0.5 && t < 0.7) {
        out.dh = -2;
        out.dy = 2;
      }
      return;
    case 'throb':
      // A quick 1px base-planted compression — a pump beat.
      if (t >= 0.5) {
        out.dh = -1;
        out.dy = 1;
      }
      return;
    case 'swirl':
      // A 1px circle in four quarter-steps. The one wave that moves both axes at once.
      switch (Math.floor(t * 4) % 4) {
        case 0:
          out.dx = 1;
          break;
        case 1:
          out.dy = 1;
          break;
        case 2:
          out.dx = -1;
          break;
        default:
          out.dy = -1;
      }
      return;
    case 'lift':
      // The 1px bob — a COMPONENT, never a whole answer: each kind that borrows it does
      // so at its own named period (simmer, heave, hum, shunt, trundle).
      out.dy = t < 0.5 ? 0 : 1;
      return;
    case 'doubleTap':
      out.dy = t < 0.15 ? 1 : t < 0.3 ? 0 : t < 0.45 ? 1 : 0;
      return;
    case 'flutter':
      // 1px horizontal flicker at rotor speed.
      out.dx = t < 0.5 ? 0 : 1;
      return;
    case 'hop':
      // The sale: a 2px jump that settles. Negative dy — the one wave that goes UP.
      out.dy = t < 0.25 ? -2 : t < 0.5 ? -1 : 0;
      return;
    case 'shudder':
      // The departure: three quick sideways knocks as something heavy gets moving.
      out.dx = t < 0.15 ? 1 : t < 0.3 ? -1 : t < 0.45 ? 1 : 0;
      return;
    case 'jitter':
      // The cold shiver: fast ±1 rattle that dies off inside the pulse.
      out.dx = t < 0.6 ? (Math.floor(t * 8) % 2 === 0 ? 1 : -1) : 0;
      return;
    case 'crank':
      // Two quick 1px turns of the swirl circle — a wrench going round.
      switch (Math.floor(t * 8) % 4) {
        case 0:
          out.dx = 1;
          break;
        case 1:
          out.dy = 1;
          break;
        case 2:
          out.dx = -1;
          break;
        default:
          out.dy = -1;
      }
      return;
  }
}

/** The Tank's fill-column breath: alpha only, never a pixel. Pure for the test. */
export function fillPulseAlpha(nowMs: number, id: number): number {
  return 0.72 + 0.24 * Math.sin((nowMs + id * PHASE_SALT_MS) / 300);
}

interface Mem {
  /** 'progress' driver: last seen permille, and when it last changed. */
  progress: number;
  progressMoveMs: number;
  /** 'stockChange' / 'kitSpend': last seen buffer totals. */
  stock: number;
  inputCount: number;
  /** 'towed' / 'beltItem' / 'bot': when the intermittent signal was last true. */
  signalMs: number;
  tileX: number;
  tileY: number;
  /** Event pulses: when the current burst started. */
  pulseMs: number;
  /** 'away' / 'stockedDrop': last seen commerce facts, primed on first sight. */
  away: number;
  stocked: number;
  /** Speck emission throttle. */
  speckMs: number;
}

interface Speck {
  sprite: Sprite;
  life: number;
  total: number;
  vx: number;
  vy: number;
}

const NEVER = Number.NEGATIVE_INFINITY;

/** Per-style emission cadence and speck physics. Sub-pixel drift is the droplet idiom. */
const SPECK_INTERVAL_MS: Record<SpeckStyle, number> = {
  oil: 120,
  steam: 200,
  boil: 110,
  fizz: 70,
};

const SPECK_TINT = { oil: 0xd9a13b, steam: 0xf0e8d8, fizz: 0xcfe8f0 } as const;

/**
 * The renderer-local, write-only side of [[091]]: per-machine last-value memory, the
 * event differs, and the speck pool. Owned by the scene, fed by `updateMachines`,
 * and it never constructs a command or touches a sim RNG stream (§12).
 */
export class MachineMotion {
  private readonly mem = new Map<number, Mem>();
  private readonly specks: Speck[] = [];

  /** The bin's sale signal is GLOBAL (`stats.itemsSold`) — the view carries no per-bin
   * ledger, so a cart or depot sale also rings the stand. Commented as the known
   * approximation it is: the stand is where the money lands either way. */
  private itemsSold = -1;
  private salesPulseMs = NEVER;

  private readonly probeBeltItem: BeltItemProbe;

  constructor(texture: Texture, attach: (sprite: Sprite) => void, probeBeltItem?: BeltItemProbe) {
    this.probeBeltItem = probeBeltItem ?? (() => false);
    for (let i = 0; i < SPECK_POOL; i++) {
      const sprite = new Sprite(texture);
      sprite.visible = false;
      sprite.anchor.set(0.5, 0.5);
      attach(sprite);
      this.specks.push({ sprite, life: 0, total: 1, vx: 0, vy: 0 });
    }
  }

  /**
   * Once per frame, before the machine loop: the diffs whose facts live OUTSIDE
   * `MachineView` — the sales counter, the carts, the depots, and the bots.
   */
  beginFrame(view: WorldView, nowMs: number): void {
    // The sale pulse. Primed on first sight, exactly as the pour differ primes.
    const sold = view.stats.itemsSold;
    if (this.itemsSold >= 0 && sold > this.itemsSold) this.salesPulseMs = nowMs;
    this.itemsSold = sold;

    for (const cart of view.commerce.carts) {
      const mem = this.remember(cart.id);
      if (mem.away >= 0 && cart.away !== mem.away) mem.pulseMs = nowMs;
      mem.away = cart.away;
    }
    for (const depot of view.commerce.depots) {
      const mem = this.remember(depot.id);
      if (mem.stocked >= 0 && depot.stocked < mem.stocked) mem.pulseMs = nowMs;
      mem.stocked = depot.stocked;
    }
    // A bot that is out stamps its dock. `phase !== 0` covers walking out, working, and
    // walking home — the shed hums for the whole sortie, and goes quiet when it docks.
    for (const bot of view.bots) {
      if (bot.phase !== 0) this.remember(bot.dockId).signalMs = nowMs;
    }
  }

  /**
   * One machine's motion for this frame. Fills `out` and returns whether it is working;
   * a non-working machine gets all-zero offsets, which is the stillness criterion.
   */
  sample(m: MachineView, view: WorldView, nowMs: number, out: MotionSample): boolean {
    out.dx = 0;
    out.dy = 0;
    out.dw = 0;
    out.dh = 0;
    out.specks = null;
    out.fillPulse = false;

    // Widened: `m.kind` is a plain number off the wire, and a kind this build has never
    // heard of (a newer save) must degrade to stillness rather than crash the frame.
    const spec: MotionSpec | undefined = MACHINE_MOTION[m.kind as MachineKind];
    if (spec === undefined) return false;

    // A broken machine performs nothing, whatever its driver says.
    if (m.lamp === LampState.Jammed || m.lamp === LampState.Halted) return false;

    const mem = this.remember(m.id);
    let working = false;
    let pulseT = -1;

    switch (spec.driver) {
      case 'progress': {
        if (m.progressPermille !== mem.progress) {
          // Only a change AFTER the priming snapshot counts — `remember` seeds -1, so a
          // machine first seen mid-operation starts moving one permille-step later
          // rather than a save opening with everything flinching at once.
          if (mem.progress >= 0) mem.progressMoveMs = nowMs;
          mem.progress = m.progressPermille;
        }
        working = m.lamp === LampState.Running && nowMs - mem.progressMoveMs <= PROGRESS_HOLD_MS;
        break;
      }
      case 'running':
        working = m.lamp === LampState.Running;
        break;
      case 'flow':
        working = m.flowMlPerMinute !== 0;
        break;
      case 'bot':
        working = nowMs - mem.signalMs <= SIGNAL_HOLD_MS;
        break;
      case 'towed': {
        if (m.tileX !== mem.tileX || m.tileY !== mem.tileY) {
          if (mem.tileX >= 0) mem.signalMs = nowMs;
          mem.tileX = m.tileX;
          mem.tileY = m.tileY;
        }
        working = nowMs - mem.signalMs <= SIGNAL_HOLD_MS;
        break;
      }
      case 'beltItem': {
        // Junctions are few and belts are scanned only for them — the same helper the
        // hover ribbon already uses per frame, injected at scene build.
        if (this.probeBeltItem(view, m.tileX, m.tileY)) mem.signalMs = nowMs;
        working = nowMs - mem.signalMs <= SIGNAL_HOLD_MS;
        break;
      }
      case 'sales':
        pulseT = (nowMs - this.salesPulseMs) / spec.periodMs;
        break;
      case 'away':
      case 'stockedDrop':
        pulseT = (nowMs - mem.pulseMs) / spec.periodMs;
        break;
      case 'stockChange': {
        const stock = m.inputCount + m.outputCount + m.cargoCount;
        if (stock !== mem.stock) {
          if (mem.stock >= 0) mem.pulseMs = nowMs;
          mem.stock = stock;
        }
        pulseT = (nowMs - mem.pulseMs) / spec.periodMs;
        break;
      }
      case 'kitSpend': {
        // A kit CONSUMED, never one arriving: arrivals are the belt's story, and a
        // station that danced on every delivery would claim service it never did.
        if (m.inputCount < mem.inputCount && mem.inputCount >= 0) mem.pulseMs = nowMs;
        mem.inputCount = m.inputCount;
        pulseT = (nowMs - mem.pulseMs) / spec.periodMs;
        break;
      }
    }

    let t: number;
    if (pulseT >= 0) {
      if (pulseT >= 1) return false;
      working = true;
      t = pulseT;
    } else {
      if (!working) return false;
      // The phase salt keeps a row of same-kind machines out of lockstep, exactly as
      // the output pip's bob salts by id.
      t = ((nowMs + m.id * PHASE_SALT_MS) % spec.periodMs) / spec.periodMs;
    }

    sampleWave(spec.wave, t, out);
    out.specks = spec.specks ?? null;
    out.fillPulse = spec.fillPulse === true;
    return true;
  }

  /**
   * Emit specks over a working machine's footprint, throttled per machine, pooled and
   * silently dropped at the cap — the droplet pool's exact failure mode.
   */
  emitSpecks(
    id: number,
    style: SpeckStyle,
    left: number,
    top: number,
    width: number,
    height: number,
    nowMs: number,
  ): void {
    const mem = this.remember(id);
    if (nowMs - mem.speckMs < SPECK_INTERVAL_MS[style]) return;
    mem.speckMs = nowMs;

    // 'boil' is the fryer's mix: mostly oil bubbles, the odd steam wisp over the vat.
    const flavour: Exclude<SpeckStyle, 'boil'> =
      style === 'boil' ? (Math.random() < 0.3 ? 'steam' : 'oil') : style;

    for (const speck of this.specks) {
      if (speck.life > 0) continue;
      speck.total =
        flavour === 'oil'
          ? 420 + Math.random() * 200
          : flavour === 'steam'
            ? 600 + Math.random() * 250
            : 260 + Math.random() * 120;
      speck.life = speck.total;
      speck.vx = (Math.random() - 0.5) * 0.006;
      speck.vy =
        flavour === 'oil'
          ? -0.008 - Math.random() * 0.006
          : flavour === 'steam'
            ? -0.016 - Math.random() * 0.008
            : -0.02 - Math.random() * 0.01;
      speck.sprite.tint = SPECK_TINT[flavour];
      speck.sprite.alpha = flavour === 'steam' ? 0.55 : 0.85;
      speck.sprite.visible = true;
      // Over the vat's interior — inset from the edges, starting below the middle so a
      // bubble has somewhere to rise to before it fades.
      speck.sprite.position.set(
        left + 3 + Math.random() * Math.max(1, width - 6),
        top + height * 0.45 + Math.random() * height * 0.3,
      );
      return;
    }
    // Pool exhausted: drop the speck. Bubbles are not owed to anyone.
  }

  /** Advance and expire live specks. The droplet updater's shape, on the shared pool. */
  update(deltaMs: number): void {
    const dt = Math.min(deltaMs, 64);
    for (const speck of this.specks) {
      if (speck.life <= 0) continue;
      speck.life -= dt;
      if (speck.life <= 0) {
        speck.sprite.visible = false;
        continue;
      }
      speck.sprite.x += speck.vx * dt;
      speck.sprite.y += speck.vy * dt;
      const t = speck.life / speck.total;
      if (t < 0.4) speck.sprite.alpha = Math.min(speck.sprite.alpha, t / 0.4);
    }
  }

  /** Live specks right now. For the bounded-pool test and for chasing a leak. */
  get activeSpecks(): number {
    let count = 0;
    for (const speck of this.specks) if (speck.life > 0) count += 1;
    return count;
  }

  /** Drop a vanished machine's memory. Called beside the visual's own destroy. */
  forget(id: number): void {
    this.mem.delete(id);
  }

  destroy(): void {
    for (const speck of this.specks) speck.sprite.destroy();
    this.specks.length = 0;
    this.mem.clear();
  }

  private remember(id: number): Mem {
    const existing = this.mem.get(id);
    if (existing !== undefined) return existing;
    const fresh: Mem = {
      progress: -1,
      progressMoveMs: NEVER,
      stock: -1,
      inputCount: -1,
      signalMs: NEVER,
      tileX: -1,
      tileY: -1,
      pulseMs: NEVER,
      away: -1,
      stocked: -1,
      speckMs: NEVER,
    };
    this.mem.set(id, fresh);
    return fresh;
  }
}
