// Turning world changes into sound events, by watching the projection.
//
// ── WHY THIS IS A DIFFER AND NOT A SIM EVENT CHANNEL ───────────────────────────────
// The plan's sketch for this feature had the sim push a per-tick list of
// `{ kindId, tileX, tileY }` through `view()`. That is a fine design and remains the
// better one — but `packages/sim` belongs to another work item, and inventing a new field
// on `WorldView` from here would collide with it. So this file derives the same
// information from the projection the sim already publishes: a pour tick that moved, a
// crop that stopped being ready, a tank that dropped, a progress bar that wrapped.
// (The pour IS a real signal now — `FieldView.lastPouredTick`, item 064 — because the
// moisture-rise diff it replaced was blind to a pour on an already-saturated tile: the
// clamp produces no rise, and a spent can charge played nothing.)
//
// The important property is unchanged, and it is the only one that is load-bearing:
// AUDIO READS SIM OUTPUT AND NEVER CALLS INTO THE SIM. A differ is, if anything, further
// from the forbidden direction than an event channel would be — it cannot write, because
// it never holds anything but numbers it copied.
//
// If and when the sim grows a real event channel, this file is what gets deleted, and the
// seam it feeds (`QueuedEvent` into the scheduler) does not move.
//
// ── WHAT IT WATCHES ────────────────────────────────────────────────────────────────
//   a pour lands within arm's reach of the player    → a hand pour        (immediate)
//   `ready` 1→0 with the crop cleared                → a harvest          (immediate, streak)
//   crop 0→something                                 → a seed going in    (immediate)
//   `itemsSold` climbing                             → the ka-ching       (immediate)
//   a sprinkler's tank dropping                      → a sprinkler pour   (sixteenth)
//   a sprinkler's tank refilling                     → the can into the barrel (immediate)
//   `progressPermille` wrapping downward             → a batch completing (beat)
//   the lamp turning Jammed                          → the jam buzz       (beat)
//   condition climbing                               → the wrench         (immediate)
//   a machine id appearing                           → the thunk          (immediate)
//   every machine whose lamp is Running              → its part in the groove (every beat)
//
// The last line is the one the design is actually about.

import {
  ContractPhase,
  HAND_REACH_SUBTILES,
  LampState,
  MachineKind,
  SUBTILE,
  worldTileKey,
} from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

// `TILE_PX` is the renderer's single source of truth for tile size and is imported rather
// than repeated. The module also sets Pixi's default scale mode as a side effect, which is
// safe from here: the hazard that comment warns about is importing a TEXTURE-CREATING
// module too early, and this file creates nothing.
import type { WorldRect } from '../game/render/camera';
import { TILE_PX } from '../game/render/pixel';

import { SoundId } from './sounds';
import type { EnsembleVoice, QueuedEvent, Scheduler } from './scheduler';

/** Beyond the viewport by this much, a sound is simply not played. Two tiles of slack. */
const CULL_MARGIN_PX = TILE_PX * 2;

/** Quietest a still-audible, still-on-screen sound gets, at the very edge of the view. */
const EDGE_GAIN = 0.55;

/** Machines that may hold a part in the groove at once. Sorted nearest-first. */
const MAX_ENSEMBLE = 8;

/** Consecutive harvests inside this many ticks keep the pitch ladder climbing. 3 seconds. */
const STREAK_WINDOW_TICKS = 60;

/** Where the ladder stops. Eight steps of a semitone each is a minor sixth — plenty. */
const MAX_STREAK_STEPS = 8;

/**
 * Ticks between the two honks: 400 ms at 20 Hz.
 *
 * Long enough to clear `MachinePlace`'s 200 ms floor in the voice pool — below that the pool
 * drops the second blast and the ceremony's whole rhythm with it — and short enough that the
 * pair still reads as one gesture rather than as two separate events at the same dock.
 */
const HONK_GAP_TICKS = 8;

const HAND_REACH_SQUARED = HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;

interface MachineMemory {
  kind: number;
  lamp: number;
  progressPermille: number;
  conditionPermille: number;
  tankPermille: number;
}

export class WorldObserver {
  private readonly scheduler: Scheduler;

  private prevTick = -1;
  private initialized = false;

  private readonly prevPoured: number[] = [];
  private readonly prevReady: number[] = [];
  private readonly prevCrop: number[] = [];
  /**
   * The world tile key each index held last frame ([[066]]). Farmland is a collection and a
   * till shifts every index after it; diffed positionally across that frame, a pour sound
   * could play off a tile nobody watered and a phantom harvest could pop. `alignField`
   * re-files the memory by key before any diff runs on a frame where the dirt moved.
   */
  private readonly prevKeys: number[] = [];
  private readonly prevMachines = new Map<number, MachineMemory>();

  private prevItemsSold = 0;

  /** Audio-only, per plan §2's "feel, not math". Nothing mechanical reads this. */
  private harvestStreak = 0;
  private lastHarvestTick = -1000;

  /**
   * Whether a sprinkler has ever poured in THIS WORLD — not in this session.
   *
   * It used to be the latter, and that made §3's first-run fanfare replay every time the
   * page was reloaded, which is the precise opposite of what a ceremony is. It is primed in
   * `primeCeremonies` from `wateredCount`, a lifetime counter that lives in `WorldState` and
   * is therefore hashed and saved — so a world whose sprinkler has already run opens quietly.
   *
   * The honest fix is still one line in `packages/sim`: `advanceSprinkler` should call
   * `markCeremony` the way the piped head and the Irrigation Hub already do, and this should
   * read `view.ceremonies`. See the note in `game/render/ceremony.ts`. Until then this reads
   * the closest persisted fact there is, and gets one corner wrong: demolish the only
   * sprinkler after it has poured, build a new one, and the fanfare plays again.
   */
  private sprinklerHasRun = false;

  /**
   * Whether the first truck has ever left THIS WORLD — read off the sim's own ceremony flag.
   *
   * Unlike `sprinklerHasRun` above, this needs no reconstruction from a lifetime counter and
   * gets none: `commerce.firstDepartureSeen` IS `CeremonyId.FirstTruck` in `WorldState`,
   * hashed, saved and sorted, projected as a number so nothing scans a string array per frame.
   * Primed on the same branch that snapshots without emitting, so opening an old world is
   * quiet — a first time that happens again is not a first time.
   */
  private firstDepartureSeen = false;

  /**
   * THE SECOND HONK. Plan §3 names this ceremony by example and it is two blasts, not one —
   * one thud is a machine settling, two is a vehicle telling you it is leaving.
   *
   * A tick rather than a timer, and this is the whole trick: an `Immediate` sound answers
   * `now`, so pushing both at once would put them in the same millisecond and the voice pool's
   * `minIntervalMs` would drop the second outright. Owing the second honk to a FUTURE TICK
   * spaces them on the sim's own clock, which is the one clock in this file that is allowed to
   * decide when anything happens. -1 means nothing is owed.
   */
  private honkDueTick = -1;
  private honkMachineId = 0;

  private readonly ensemble: EnsembleVoice[] = [];

  constructor(scheduler: Scheduler) {
    this.scheduler = scheduler;
  }

  /**
   * Called once per rendered frame with the projection the renderer just drew.
   *
   * Cheap by construction: 64 field tiles and a handful of machines, and the whole diff is
   * skipped entirely on frames where the tick has not advanced — which at 60 fps and 20 Hz
   * is two frames in three.
   */
  observe(view: WorldView, rect: WorldRect, nowMs: number): void {
    this.scheduler.setTick(view.tick, nowMs);

    // A fresh host, or a world restored from disk at a different tick. Snapshot without
    // emitting, or loading a save would fire every sound in the catalogue at once.
    if (!this.initialized || view.tick < this.prevTick) {
      this.snapshot(view);
      this.primeCeremonies(view);
      this.initialized = true;
      this.prevTick = view.tick;
      this.rebuildEnsemble(view, rect);
      return;
    }

    if (view.tick !== this.prevTick) {
      this.alignField(view);
      this.diffField(view, rect);
      this.diffMachines(view, rect);
      this.diffStats(view, rect);
      this.diffCommerce(view, rect);
      this.snapshot(view);
      this.prevTick = view.tick;
    }

    // Rebuilt every frame rather than every tick: the camera moves on frames, and a part
    // panned to where the machine used to be is worse than one panned a frame late.
    this.rebuildEnsemble(view, rect);
  }

  /** Forget everything. Used when audio is torn down. */
  reset(): void {
    this.initialized = false;
    this.prevMachines.clear();
    this.ensemble.length = 0;
    this.harvestStreak = 0;
    // Cleared so that `primeCeremonies` is the ONLY thing that can set it. Left true, a
    // teardown followed by a fresh world would silently suppress that world's first run.
    this.sprinklerHasRun = false;
    this.firstDepartureSeen = false;
    this.honkDueTick = -1;
  }

  /**
   * Read the world's own memory of what has already happened, so a reload is not a first time.
   *
   * Runs on the same branch that snapshots without emitting — a restored save must neither
   * fire every sound in the catalogue nor forget which fanfares it has already earned.
   */
  private primeCeremonies(view: WorldView): void {
    // Nothing is owed across a reload. A honk queued on the tick before a save would otherwise
    // sound on the tick after the load, at a depot that has been quiet for a fortnight.
    this.honkDueTick = -1;
    this.firstDepartureSeen = view.commerce.firstDepartureSeen === 1;

    for (const machine of view.machines) {
      if (machine.kind === MachineKind.Sprinkler && machine.wateredCount > 0) {
        this.sprinklerHasRun = true;
        return;
      }
    }
  }

  // --- the diffs ------------------------------------------------------------------------

  /**
   * Re-file the field memory under the collection's CURRENT indexing ([[066]]).
   *
   * Runs only on a tick where the keys moved — a till or an un-till, a hand gesture. Values
   * follow their TILE; a position this observer has never heard is primed from the
   * projection so the till itself makes no sound (tilling has no sim signal to voice, and a
   * misattributed pour would be worse than silence).
   */
  private alignField(view: WorldView): void {
    const field = view.field;
    const count = field.crop.length;

    let same = count === this.prevKeys.length;
    if (same) {
      for (let i = 0; i < count; i++) {
        if (this.prevKeys[i] !== worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0)) {
          same = false;
          break;
        }
      }
    }
    if (same) return;

    const remembered = new Map<number, { poured: number; ready: number; crop: number }>();
    for (let i = 0; i < this.prevKeys.length; i++) {
      remembered.set(this.prevKeys[i]!, {
        poured: this.prevPoured[i] ?? 0,
        ready: this.prevReady[i] ?? 0,
        crop: this.prevCrop[i] ?? 0,
      });
    }

    for (let i = 0; i < count; i++) {
      const key = worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0);
      const held = remembered.get(key);
      this.prevPoured[i] = held?.poured ?? field.lastPouredTick[i] ?? 0;
      this.prevReady[i] = held?.ready ?? field.ready[i] ?? 0;
      this.prevCrop[i] = held?.crop ?? field.crop[i] ?? 0;
      this.prevKeys[i] = key;
    }
    this.prevPoured.length = count;
    this.prevReady.length = count;
    this.prevCrop.length = count;
    this.prevKeys.length = count;
  }

  private diffField(view: WorldView, rect: WorldRect): void {
    const field = view.field;
    const count = field.crop.length;

    let harvests = 0;
    let harvestX = 0;
    let harvestY = 0;

    for (let i = 0; i < count; i++) {
      // Per-entry coordinates are the addressing scheme ([[066]]) — the bounding-box
      // arithmetic this replaces panned sounds wrongly the moment the field went non-rect.
      const tileX = field.tileX[i] ?? 0;
      const tileY = field.tileY[i] ?? 0;

      // The sim's own pour signal (item 064): newer than last frame means water landed
      // here, INCLUDING on a tile already at full moisture — the case the old moisture
      // diff missed and the whole reason the field exists. A hand pour and a sprinkler's
      // are still told apart by REACH rather than by counting tiles: only the player's
      // own pour can land within arm's length of the player, and the sprinkler's own pour
      // is detected far more precisely from its tank level in `diffMachines`.
      const poured = field.lastPouredTick[i] ?? 0;
      if (poured > (this.prevPoured[i] ?? 0) && this.withinReach(view, tileX, tileY)) {
        this.emit(SoundId.WaterPour, view.tick, tileX, tileY, 1, 1, rect);
      }

      const ready = field.ready[i] ?? 0;
      const wasReady = this.prevReady[i] ?? 0;
      const crop = field.crop[i] ?? 0;
      const wasCrop = this.prevCrop[i] ?? 0;

      // Harvest clears the crop outright (`tile.crop = CropId.None`), so "was ready, is
      // not, and the crop is gone" is unambiguous — it cannot be confused with growth.
      if (wasReady === 1 && ready === 0 && wasCrop !== 0 && crop === 0) {
        harvests++;
        harvestX = tileX;
        harvestY = tileY;
      } else if (wasCrop === 0 && crop !== 0) {
        this.emit(SoundId.PlantSeed, view.tick, tileX, tileY, 1, 1, rect);
      }
    }

    if (harvests > 0) this.emitHarvest(view.tick, harvestX, harvestY, rect);
  }

  /**
   * The pitch ladder.
   *
   * AUDIO ONLY. Plan §2 is explicit that a harvest streak is feel, not math: it raises the
   * pitch and it does nothing else. There is no yield bonus, no multiplier, and no path
   * from this counter into a `Command`. It also uses `Math.pow`, which is exactly why it
   * lives here and could never live in the sim.
   */
  private emitHarvest(tick: number, tileX: number, tileY: number, rect: WorldRect): void {
    this.harvestStreak =
      tick - this.lastHarvestTick <= STREAK_WINDOW_TICKS ? this.harvestStreak + 1 : 0;
    this.lastHarvestTick = tick;

    const steps = Math.min(this.harvestStreak, MAX_STREAK_STEPS);
    const rate = Math.pow(2, steps / 12);
    this.emit(SoundId.HarvestPop, tick, tileX, tileY, 1, rate, rect);
  }

  private diffMachines(view: WorldView, rect: WorldRect): void {
    for (const machine of view.machines) {
      const previous = this.prevMachines.get(machine.id);

      if (previous === undefined) {
        this.emitAtMachine(SoundId.MachinePlace, view.tick, machine, 1, 1, rect);
        continue;
      }

      // The Chip Kitchen's batch-complete accent fired here on `progress` wrapping downward,
      // until [[145]] cut the machine and both its sounds.

      if (machine.lamp === LampState.Jammed && previous.lamp !== LampState.Jammed) {
        this.emitAtMachine(SoundId.MachineJam, view.tick, machine, 1, 1, rect);
      }

      if (machine.conditionPermille > previous.conditionPermille) {
        this.emitAtMachine(SoundId.MachineRepair, view.tick, machine, 1, 1, rect);
      }

      if (machine.kind === MachineKind.Sprinkler) {
        if (machine.tankPermille < previous.tankPermille) {
          // The whole v0.1 design gate, making a noise. The first one gets the ceremony.
          const id = this.sprinklerHasRun ? SoundId.SprinklerPour : SoundId.SprinklerFirstRun;
          this.sprinklerHasRun = true;
          this.emitAtMachine(id, view.tick, machine, 1, 1, rect);
        } else if (machine.tankPermille > previous.tankPermille) {
          this.emitAtMachine(SoundId.WaterPour, view.tick, machine, 1, 1, rect);
        }
      }
    }
  }

  private diffStats(view: WorldView, rect: WorldRect): void {
    if (view.stats.itemsSold > this.prevItemsSold) {
      // At the bin if there is one, otherwise at the player — either way it is a sound the
      // player just caused, standing right there.
      const bin = view.machines.find((m) => m.kind === MachineKind.SellBin);
      if (bin === undefined) {
        this.emitAtPlayer(SoundId.SellKaching, view, rect);
      } else {
        this.emitAtMachine(SoundId.SellKaching, view.tick, bin, 1, 1, rect);
      }
    }
  }

  /**
   * The first truck leaving, and the second honk it owes.
   *
   * ────────────────────────────────────────────────────────────────────────────────────
   *  IT IS A HORN NOW ([[057]]). It used to be `MachinePlace` played twice — "something heavy
   *  meeting dirt", picked because it was the one thing in the catalogue that was not a lie
   *  about a truck, and recorded here as a debt rather than left to look deliberate.
   *
   *  `SoundId.TruckHorn` is that debt paid, and the constraint it was written against is
   *  unchanged and still the interesting part: the nearest timbre in the game is `MachineJam`,
   *  because two reeds beating against each other genuinely is how an air horn works — and
   *  that is the sound this game uses for SOMETHING IS BROKEN. Spending the factory's one
   *  alarm on its proudest moment would teach the player the wrong thing on the exact frame
   *  they are paying most attention. See the recipe in `synth.ts` for the three things that
   *  keep the two apart.
   *
   *  Nothing else about this moved: still two blasts, still `HONK_GAP_TICKS` apart, still the
   *  second one a shade lower.
   * ────────────────────────────────────────────────────────────────────────────────────
   */
  private diffCommerce(view: WorldView, rect: WorldRect): void {
    if (this.honkDueTick >= 0 && view.tick >= this.honkDueTick) {
      this.honkDueTick = -1;
      // A shade lower and longer than the first, so the pair reads as deliberate rather than
      // as one sound double-triggering.
      this.honkAt(view, this.honkMachineId, rect, 0.94);
    }

    if (this.firstDepartureSeen || view.commerce.firstDepartureSeen !== 1) return;
    this.firstDepartureSeen = true;

    this.honkMachineId = departingDepotId(view);
    this.honkAt(view, this.honkMachineId, rect, 1);
    this.honkDueTick = view.tick + HONK_GAP_TICKS;
  }

  /** One blast, at the dock if we can find it and at the player if the depot has gone. */
  private honkAt(view: WorldView, machineId: number, rect: WorldRect, rate: number): void {
    const depot = view.machines.find((m) => m.id === machineId);
    if (depot === undefined) {
      this.emitAtPlayer(SoundId.TruckHorn, view, rect);
      return;
    }
    this.emitAtMachine(SoundId.TruckHorn, view.tick, depot, 1, rate, rect);
  }

  // --- the ensemble ---------------------------------------------------------------------

  /**
   * Who is holding a part this beat.
   *
   * A machine is in the ensemble if, and only if, its lamp is green. Starved, blocked,
   * jammed, halted, or off-screen and its instrument simply is not there — which is the
   * entire diagnostic: the mix is a readout of real machine state, not a decoration laid
   * over it.
   */
  private rebuildEnsemble(view: WorldView, rect: WorldRect): void {
    this.ensemble.length = 0;

    const centreX = rect.x + rect.width / 2;
    const candidates: { voice: EnsembleVoice; distance: number }[] = [];

    for (const machine of view.machines) {
      if (machine.lamp !== LampState.Running) continue;
      const soundId = ensemblePart(machine.kind);
      if (soundId === null) continue;

      const worldX = (machine.tileX + machine.tilesWide / 2) * TILE_PX;
      const worldY = (machine.tileY + machine.tilesHigh / 2) * TILE_PX;
      if (!onScreen(worldX, worldY, rect)) continue;

      candidates.push({
        voice: {
          soundId,
          pan: panFor(worldX, rect),
          gain: gainFor(worldX, worldY, rect),
          // A few cents of cosmetic detune per machine so two kitchens side by side read as
          // two machines rather than one loud one. `Math.random` is free on this side of
          // the seam and must never touch a sim RNG stream — a sound that consumed one
          // would make the mute button change world outcomes.
          rate: 0.98 + Math.random() * 0.04,
        },
        distance: Math.abs(worldX - centreX),
      });
    }

    candidates.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < candidates.length && i < MAX_ENSEMBLE; i++) {
      const candidate = candidates[i];
      if (candidate !== undefined) this.ensemble.push(candidate.voice);
    }

    this.scheduler.setEnsemble(this.ensemble);
  }

  // --- emitting -------------------------------------------------------------------------

  private emit(
    soundId: SoundId,
    tick: number,
    tileX: number,
    tileY: number,
    gain: number,
    rate: number,
    rect: WorldRect,
  ): void {
    const worldX = (tileX + 0.5) * TILE_PX;
    const worldY = (tileY + 0.5) * TILE_PX;
    this.emitAtWorld(soundId, tick, worldX, worldY, gain, rate, rect);
  }

  private emitAtMachine(
    soundId: SoundId,
    tick: number,
    machine: MachineView,
    gain: number,
    rate: number,
    rect: WorldRect,
  ): void {
    const worldX = (machine.tileX + machine.tilesWide / 2) * TILE_PX;
    const worldY = (machine.tileY + machine.tilesHigh / 2) * TILE_PX;
    this.emitAtWorld(soundId, tick, worldX, worldY, gain, rate, rect);
  }

  private emitAtPlayer(soundId: SoundId, view: WorldView, rect: WorldRect): void {
    const worldX = (view.player.xSub * TILE_PX) / SUBTILE;
    const worldY = (view.player.ySub * TILE_PX) / SUBTILE;
    this.emitAtWorld(soundId, view.tick, worldX, worldY, 1, 1, rect);
  }

  private emitAtWorld(
    soundId: SoundId,
    tick: number,
    worldX: number,
    worldY: number,
    gain: number,
    rate: number,
    rect: WorldRect,
  ): void {
    // VIEWPORT CULLING, and it happens here rather than in the pool on purpose: an event
    // that is off-screen should never reach the scheduler at all, so it cannot consume a
    // rate-limit budget that an audible sound needed.
    if (!onScreen(worldX, worldY, rect)) return;

    const event: QueuedEvent = {
      soundId,
      tick,
      pan: panFor(worldX, rect),
      gain: gain * gainFor(worldX, worldY, rect),
      rate,
    };
    this.scheduler.push(event);
  }

  // --- bookkeeping ----------------------------------------------------------------------

  private withinReach(view: WorldView, tileX: number, tileY: number): boolean {
    const centreXSub = tileX * SUBTILE + SUBTILE / 2;
    const centreYSub = tileY * SUBTILE + SUBTILE / 2;
    const dx = view.player.xSub - centreXSub;
    const dy = view.player.ySub - centreYSub;
    return dx * dx + dy * dy <= HAND_REACH_SQUARED;
  }

  private snapshot(view: WorldView): void {
    const field = view.field;
    const count = field.crop.length;
    for (let i = 0; i < count; i++) {
      this.prevPoured[i] = field.lastPouredTick[i] ?? 0;
      this.prevReady[i] = field.ready[i] ?? 0;
      this.prevCrop[i] = field.crop[i] ?? 0;
      this.prevKeys[i] = worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0);
    }
    this.prevPoured.length = count;
    this.prevReady.length = count;
    this.prevCrop.length = count;
    this.prevKeys.length = count;

    // `view.machines` is a REUSED buffer of reused objects, so only copied primitives are
    // safe to keep. Holding the `MachineView` itself would silently compare a machine with
    // its own future self.
    this.prevMachines.clear();
    for (const machine of view.machines) {
      this.prevMachines.set(machine.id, {
        kind: machine.kind,
        lamp: machine.lamp,
        progressPermille: machine.progressPermille,
        conditionPermille: machine.conditionPermille,
        tankPermille: machine.tankPermille,
      });
    }

    this.prevItemsSold = view.stats.itemsSold;
  }
}

/**
 * The depot whose truck is on the road, or the first one on the lot.
 *
 * Same reasoning as `ceremony.ts`'s own version, and the same fallback: the projection does not
 * name the departing depot, but a contract in `Rolling` is a truck out THIS INSTANT, and on the
 * frame the flag first appears that is the truck being celebrated. Two depots and one moving
 * truck is the case where honking at whichever was built first is wrong half the time.
 */
function departingDepotId(view: WorldView): number {
  for (const contract of view.commerce.contracts) {
    if (contract.phase === ContractPhase.Rolling) return contract.depotId;
  }
  const depot = view.commerce.depots[0];
  return depot === undefined ? 0 : depot.id;
}

/**
 * Which instrument a machine kind plays, or `null` for the ones that just sit there.
 *
 * EMPTY SINCE [[145]]: the Chip Kitchen was the only kind with a part, and it went with the
 * cut. The ensemble plumbing (rebuild, scheduler voices, culling) is kept warm on purpose —
 * the next machine that earns a heartbeat gets it by adding one branch here.
 */
function ensemblePart(_kind: number): SoundId | null {
  return null;
}

function onScreen(worldX: number, worldY: number, rect: WorldRect): boolean {
  return (
    worldX >= rect.x - CULL_MARGIN_PX &&
    worldX <= rect.x + rect.width + CULL_MARGIN_PX &&
    worldY >= rect.y - CULL_MARGIN_PX &&
    worldY <= rect.y + rect.height + CULL_MARGIN_PX
  );
}

function panFor(worldX: number, rect: WorldRect): number {
  const half = rect.width / 2;
  if (half <= 0) return 0;
  const offset = (worldX - (rect.x + half)) / half;
  return offset < -1 ? -1 : offset > 1 ? 1 : offset;
}

/** Quieter towards the edges of the view, so the middle of the screen is the mix. */
function gainFor(worldX: number, worldY: number, rect: WorldRect): number {
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  if (halfW <= 0 || halfH <= 0) return 1;
  const dx = Math.abs(worldX - (rect.x + halfW)) / halfW;
  const dy = Math.abs(worldY - (rect.y + halfH)) / halfH;
  const distance = Math.min(1, Math.max(dx, dy));
  return 1 - (1 - EDGE_GAIN) * distance;
}
