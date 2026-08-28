// The sound catalogue: what exists, how loud, how often, and whether it rides the grid.
//
// This file is metadata only — no Web Audio, no synthesis. `synth.ts` owns how each id
// actually sounds, `scheduler.ts` owns `quantize`, and `voice-pool.ts` owns `maxConcurrent`
// and `minIntervalMs`. Splitting it this way means retuning the mix is an edit to a table
// rather than a hunt through the engine.
//
// ── THE ONE RULE THIS TABLE ENCODES ────────────────────────────────────────────────
// Machine work-cycle sounds are `beat`. Every player verb is `immediate`.
//
// Plan §2's tactile spec is a hard rule: a manual action resolves in under 1.5 s with a
// start sound, a visible state change, and a completion sound. Quantizing a watering-can
// pour to the next beat would add up to 600 ms of latency to the verbs the entire first
// era is built on, and hand-farming would feel broken. So the grid is for machines, whose
// sounds are *reporting* rather than *responding*, and the player's hands are never on it.

export const SoundId = {
  /** Hand pour from the watering can. */
  WaterPour: 'water-pour',
  PlantSeed: 'plant-seed',
  /** Rises in pitch on a streak — audio only, never a mechanical bonus. */
  HarvestPop: 'harvest-pop',
  SellKaching: 'sell-kaching',
  // The Chip Kitchen's chug and its batch-complete accent sat here until [[145]] cut the
  // machine. The kitchen was the only instrument in the ensemble; the plumbing survives it.
  /** The sprinkler doing the thing the whole v0.1 design gate is about. */
  SprinklerPour: 'sprinkler-pour',
  /** Plan §3's ~10 seconds of in-world ceremony, first time a sprinkler runs. */
  SprinklerFirstRun: 'sprinkler-first-run',
  MachinePlace: 'machine-place',
  /**
   * The first truck pulling out. Plan §3's Hall of Hands, and the ONLY thing that plays it.
   *
   * A PLAYER SOUND RATHER THAN A MACHINE ONE, which is why it sits in this half of the table
   * even though nobody pressed anything: it is a ceremony, it happens exactly once per world,
   * and quantizing it would slide the horn off the departure it is supposed to be the sound of.
   */
  TruckHorn: 'truck-horn',
  MachineJam: 'machine-jam',
  MachineRepair: 'machine-repair',
  UiClick: 'ui-click',
  UiSelect: 'ui-select',
} as const;

export type SoundId = (typeof SoundId)[keyof typeof SoundId];

/**
 * Where on the Music Box grid a sound is allowed to land.
 *
 * `beat` is every 12 ticks, `sixteenth` every 3 — both exported from `@snack/sim`, both
 * integer, both derived from the sim's tick counter. `immediate` means "the next scheduler
 * pass", which is at most ~25 ms away.
 */
export const Quantize = {
  Immediate: 'immediate',
  Sixteenth: 'sixteenth',
  Beat: 'beat',
} as const;

export type Quantize = (typeof Quantize)[keyof typeof Quantize];

export interface SoundSpec {
  readonly id: SoundId;
  readonly quantize: Quantize;
  /**
   * Voices of THIS id that may sound at once. When it is reached the new voice is dropped,
   * never stolen: a dropped sound in a dense factory is inaudible, a stolen one clicks.
   */
  readonly maxConcurrent: number;
  /**
   * Floor on the gap between two starts of this id. With a field of crops and a kitchen
   * running you cannot play a sound per event — one fryer chug per beat conveys exactly as
   * much as forty, and costs a fortieth of the mix.
   */
  readonly minIntervalMs: number;
  /** Catalogue-level trim, before per-event distance attenuation. */
  readonly gain: number;
}

const SPECS: readonly SoundSpec[] = [
  // --- the player's hands. Never quantized. -----------------------------------------
  {
    id: SoundId.WaterPour,
    quantize: Quantize.Immediate,
    maxConcurrent: 3,
    minIntervalMs: 55,
    gain: 0.55,
  },
  {
    id: SoundId.PlantSeed,
    quantize: Quantize.Immediate,
    maxConcurrent: 3,
    minIntervalMs: 60,
    gain: 0.5,
  },
  {
    id: SoundId.HarvestPop,
    quantize: Quantize.Immediate,
    maxConcurrent: 4,
    minIntervalMs: 45,
    gain: 0.6,
  },
  {
    id: SoundId.SellKaching,
    quantize: Quantize.Immediate,
    maxConcurrent: 2,
    minIntervalMs: 140,
    gain: 0.5,
  },
  {
    id: SoundId.MachinePlace,
    quantize: Quantize.Immediate,
    maxConcurrent: 2,
    minIntervalMs: 200,
    gain: 0.6,
  },
  {
    id: SoundId.MachineRepair,
    quantize: Quantize.Immediate,
    maxConcurrent: 2,
    minIntervalMs: 110,
    gain: 0.45,
  },
  {
    id: SoundId.SprinklerFirstRun,
    quantize: Quantize.Immediate,
    maxConcurrent: 1,
    minIntervalMs: 4000,
    gain: 0.6,
  },
  // TWO CONCURRENT VOICES AND A SHORT FLOOR, because the ceremony honks TWICE, 8 ticks apart
  // (`HONK_GAP_TICKS` — 400 ms). A `maxConcurrent` of 1 or a `minIntervalMs` above 400 would
  // silently eat the second blast, and one honk is a different sound from two.
  {
    id: SoundId.TruckHorn,
    quantize: Quantize.Immediate,
    maxConcurrent: 2,
    minIntervalMs: 120,
    gain: 0.62,
  },
  {
    id: SoundId.UiClick,
    quantize: Quantize.Immediate,
    maxConcurrent: 3,
    minIntervalMs: 30,
    gain: 0.35,
  },
  {
    id: SoundId.UiSelect,
    quantize: Quantize.Immediate,
    maxConcurrent: 3,
    minIntervalMs: 40,
    gain: 0.35,
  },

  // --- the factory. On the grid, which is the entire point. --------------------------
  // The kitchen's two beat-quantized rows sat here until [[145]]; the jam alarm below is
  // the machine sound that still rides the grid.
  // A sixteenth is 150 ms, so the sprinkler still reads as a response to the machine
  // rather than a downbeat, while staying locked to the same grid everything else is on.
  {
    id: SoundId.SprinklerPour,
    quantize: Quantize.Sixteenth,
    maxConcurrent: 3,
    minIntervalMs: 110,
    gain: 0.4,
  },
  {
    id: SoundId.MachineJam,
    quantize: Quantize.Beat,
    maxConcurrent: 1,
    minIntervalMs: 500,
    gain: 0.5,
  },
];

const BY_ID = new Map<SoundId, SoundSpec>(SPECS.map((spec) => [spec.id, spec]));

export const ALL_SOUND_IDS: readonly SoundId[] = SPECS.map((spec) => spec.id);

export function soundSpec(id: SoundId): SoundSpec {
  const spec = BY_ID.get(id);
  if (spec === undefined) throw new Error(`audio: no catalogue entry for "${id}"`);
  return spec;
}
