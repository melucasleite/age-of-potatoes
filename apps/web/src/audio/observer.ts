// Turning world changes into sound events, by watching the projection.
//
// ── WHY THIS IS A DIFFER AND NOT A SIM EVENT CHANNEL ───────────────────────────────
// The plan's sketch for this feature had the sim push a per-tick list of
// `{ kindId, tileX, tileY }` through `view()`. That is a fine design and remains the
// better one — but `packages/sim` belongs to another work item, and inventing a new field
// on `WorldView` from here would collide with it. So this file derives the same
// information from the projection the sim already publishes: moisture that rose, a crop
// that stopped being ready, a tank that dropped, a progress bar that wrapped.
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
//   moisture rises within arm's reach of the player  → a hand pour        (immediate)
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

import { HAND_REACH_SUBTILES, LampState, MachineKind, SUBTILE } from '@snack/sim';
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

/** A moisture reading must climb by more than this to count as water arriving. */
const MOISTURE_RISE_PERMILLE = 20;

/** Consecutive harvests inside this many ticks keep the pitch ladder climbing. 3 seconds. */
const STREAK_WINDOW_TICKS = 60;

/** Where the ladder stops. Eight steps of a semitone each is a minor sixth — plenty. */
const MAX_STREAK_STEPS = 8;

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

  private readonly prevMoisture: number[] = [];
  private readonly prevReady: number[] = [];
  private readonly prevCrop: number[] = [];
  private readonly prevMachines = new Map<number, MachineMemory>();

  private prevItemsSold = 0;

  /** Audio-only, per plan §2's "feel, not math". Nothing mechanical reads this. */
  private harvestStreak = 0;
  private lastHarvestTick = -1000;

  /** §3's ceremony fires once a session, the first time a sprinkler ever pours. */
  private sprinklerHasRun = false;

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
      this.initialized = true;
      this.prevTick = view.tick;
      this.rebuildEnsemble(view, rect);
      return;
    }

    if (view.tick !== this.prevTick) {
      this.diffField(view, rect);
      this.diffMachines(view, rect);
      this.diffStats(view, rect);
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
  }

  // --- the diffs ------------------------------------------------------------------------

  private diffField(view: WorldView, rect: WorldRect): void {
    const field = view.field;
    const count = field.crop.length;

    let harvests = 0;
    let harvestX = 0;
    let harvestY = 0;

    for (let i = 0; i < count; i++) {
      const tileX = field.originX + (i % field.tilesWide);
      const tileY = field.originY + Math.floor(i / field.tilesWide);

      const moisture = field.moisturePermille[i] ?? 0;
      const wasMoisture = this.prevMoisture[i] ?? 0;
      // A hand pour slams the tile to full; a sprinkler does the same to a 5×5 patch. The
      // two are told apart by REACH rather than by counting tiles: only the player's own
      // pour can land within arm's length of the player, and the sprinkler's own pour is
      // detected far more precisely from its tank level in `diffMachines`.
      if (moisture > wasMoisture + MOISTURE_RISE_PERMILLE && this.withinReach(view, tileX, tileY)) {
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

      // A batch landing. `progress -= workPerOperation` wraps the bar downward, and nothing
      // else moves it backwards, so a drop is a completed operation and only that.
      if (machine.progressPermille < previous.progressPermille) {
        if (machine.kind === MachineKind.ChipKitchen) {
          this.emitAtMachine(SoundId.MachineCycleKitchen, view.tick, machine, 1, 1, rect);
        }
      }

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
      this.prevMoisture[i] = field.moisturePermille[i] ?? 0;
      this.prevReady[i] = field.ready[i] ?? 0;
      this.prevCrop[i] = field.crop[i] ?? 0;
    }
    this.prevMoisture.length = count;
    this.prevReady.length = count;
    this.prevCrop.length = count;

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

/** Which instrument a machine kind plays, or `null` for the ones that just sit there. */
function ensemblePart(kind: number): SoundId | null {
  return kind === MachineKind.ChipKitchen ? SoundId.MachineWorkKitchen : null;
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
