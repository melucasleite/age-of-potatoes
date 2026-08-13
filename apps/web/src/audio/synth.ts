// Placeholder sounds, synthesized in code. Zero files, zero licensing exposure, zero bytes
// on the wire.
//
// ── WHY THERE ARE NO ASSETS ────────────────────────────────────────────────────────
// Plan §14 records that audio is a separate provider, a separate licensing question, and a
// separate budget line from the art pipeline. None of that is settled and v0.1 does not
// need it settled, so v0.1 renders its own buffers out of oscillators and noise. The bank
// below is deliberately shaped like a sample loader — `SoundBank.get(id): AudioBuffer` —
// so swapping in real audio later is a provider change behind an unchanged seam, exactly
// the way §15 wanted an asset pipeline with an AI adapter rather than an AI asset pipeline.
//
// THE ASSET SHOPPING LIST, for whoever makes the licensing call:
//   - machine work-cycle loops, one per machine kind (washer / slicer / fryer at v0.3)
//   - hand verbs: watering-can pour, harvest pop, seed pat, footstep
//   - the sale ka-ching
//   - the sprinkler's first-activation theatre (§3: ~10 s of in-world ceremony)
//   - UI clicks
//   - an ambient bed (NOT in v0.1 — §14 defers music and ambience entirely)
//
// Everything here may use `Math.sin`, `Math.pow`, `Math.exp`, and `Math.random` freely.
// This is the audio side of the seam. The ban in AGENTS.md is on `packages/sim`, where a
// transcendental's last bit desyncs a replay; here the worst case is a slightly different
// hiss, which is what hiss is.

import { ALL_SOUND_IDS, SoundId } from './sounds';

// --- layer recipes --------------------------------------------------------------------

type Wave = 'sine' | 'square' | 'triangle' | 'saw';

interface ToneLayer {
  readonly kind: 'tone';
  readonly wave: Wave;
  /** Start frequency in Hz. */
  readonly f0: number;
  /** End frequency; the glide between them is exponential, which is how ears hear pitch. */
  readonly f1?: number;
  readonly gain: number;
  readonly attack: number;
  /** Exponential decay time constant, in seconds. */
  readonly decay: number;
  /** Offset from the start of the buffer, for stacking a chord or an arpeggio. */
  readonly at?: number;
}

interface NoiseLayer {
  readonly kind: 'noise';
  readonly gain: number;
  readonly attack: number;
  readonly decay: number;
  /** One-pole lowpass cutoff, swept from `lp0` to `lp1` across the layer. */
  readonly lp0?: number;
  readonly lp1?: number;
  /** One-pole highpass cutoff, fixed. */
  readonly hp?: number;
  readonly at?: number;
}

type Layer = ToneLayer | NoiseLayer;

interface Recipe {
  readonly duration: number;
  readonly layers: readonly Layer[];
}

/**
 * Every sound in the game, as arithmetic.
 *
 * The timbres are chosen to be *distinguishable*, not pretty: a player needs to tell a
 * kitchen chug from a sprinkler hiss with their eyes on the other side of the map, which
 * is the whole diagnostic premise of the Music Box (§2).
 */
const RECIPES: Readonly<Record<SoundId, Recipe>> = {
  // Water: a broadband rush closing down as the can empties, over a low gurgle.
  [SoundId.WaterPour]: {
    duration: 0.32,
    layers: [
      { kind: 'noise', gain: 0.5, attack: 0.012, decay: 0.13, lp0: 3200, lp1: 700 },
      { kind: 'tone', wave: 'sine', f0: 210, f1: 120, gain: 0.14, attack: 0.005, decay: 0.09 },
    ],
  },
  // A dull pat of soil. Deliberately unmusical so it never competes with the grid.
  [SoundId.PlantSeed]: {
    duration: 0.14,
    layers: [
      { kind: 'noise', gain: 0.4, attack: 0.002, decay: 0.045, lp0: 1400, lp1: 320 },
      { kind: 'tone', wave: 'sine', f0: 150, f1: 95, gain: 0.2, attack: 0.002, decay: 0.04 },
    ],
  },
  // The pop. Its pitch is multiplied by the streak ladder at play time, never here.
  [SoundId.HarvestPop]: {
    duration: 0.2,
    layers: [
      { kind: 'tone', wave: 'triangle', f0: 520, f1: 900, gain: 0.45, attack: 0.002, decay: 0.055 },
      { kind: 'noise', gain: 0.16, attack: 0.001, decay: 0.012, hp: 3000 },
    ],
  },
  // Money. A bright fifth, the upper note arriving late enough to read as two hits.
  [SoundId.SellKaching]: {
    duration: 0.75,
    layers: [
      { kind: 'noise', gain: 0.22, attack: 0.001, decay: 0.02, hp: 4000 },
      { kind: 'tone', wave: 'sine', f0: 1046.5, gain: 0.3, attack: 0.002, decay: 0.3 },
      { kind: 'tone', wave: 'sine', f0: 1568, gain: 0.24, attack: 0.002, decay: 0.34, at: 0.055 },
      { kind: 'tone', wave: 'sine', f0: 2093, gain: 0.1, attack: 0.002, decay: 0.18, at: 0.055 },
    ],
  },
  // The kitchen's heartbeat. Low, short, and felt more than heard — this is the sound the
  // player learns to miss when a line starves.
  [SoundId.MachineWorkKitchen]: {
    duration: 0.24,
    layers: [
      { kind: 'tone', wave: 'sine', f0: 132, f1: 68, gain: 0.55, attack: 0.003, decay: 0.07 },
      { kind: 'noise', gain: 0.3, attack: 0.002, decay: 0.055, lp0: 950, lp1: 300 },
    ],
  },
  // A batch actually landing. Brighter, and up a fifth from the chug so it reads as a
  // resolution rather than another beat.
  [SoundId.MachineCycleKitchen]: {
    duration: 0.32,
    layers: [
      { kind: 'tone', wave: 'triangle', f0: 392, f1: 588, gain: 0.34, attack: 0.003, decay: 0.09 },
      { kind: 'noise', gain: 0.2, attack: 0.002, decay: 0.03, hp: 2500 },
    ],
  },
  // Airy and high, so it sits above the kitchen instead of fighting it.
  [SoundId.SprinklerPour]: {
    duration: 0.34,
    layers: [
      { kind: 'noise', gain: 0.42, attack: 0.018, decay: 0.11, lp0: 9000, lp1: 3800, hp: 1800 },
    ],
  },
  // §3's ceremony: a rising arpeggio under a long hiss. It plays once, the first time a
  // sprinkler ever runs, and then never again in that session.
  [SoundId.SprinklerFirstRun]: {
    duration: 1.0,
    layers: [
      { kind: 'noise', gain: 0.3, attack: 0.05, decay: 0.32, lp0: 6000, lp1: 2600, hp: 1400 },
      { kind: 'tone', wave: 'sine', f0: 523.25, gain: 0.26, attack: 0.006, decay: 0.2, at: 0.0 },
      { kind: 'tone', wave: 'sine', f0: 659.25, gain: 0.26, attack: 0.006, decay: 0.2, at: 0.09 },
      { kind: 'tone', wave: 'sine', f0: 783.99, gain: 0.26, attack: 0.006, decay: 0.22, at: 0.18 },
      { kind: 'tone', wave: 'sine', f0: 1046.5, gain: 0.3, attack: 0.006, decay: 0.34, at: 0.27 },
    ],
  },
  // Something heavy meeting dirt.
  [SoundId.MachinePlace]: {
    duration: 0.42,
    layers: [
      { kind: 'tone', wave: 'sine', f0: 92, f1: 44, gain: 0.65, attack: 0.002, decay: 0.12 },
      { kind: 'noise', gain: 0.38, attack: 0.001, decay: 0.075, lp0: 520, lp1: 120 },
    ],
  },
  /**
   * The air horn on the first truck out ([[032]], [[057]]).
   *
   * ── WHY IT IS NOT THE JAM WITH A NEW NAME ─────────────────────────────────────────────
   * A real air horn is two reeds sounding at once, which is also exactly what `MachineJam`
   * below is — and that is the whole problem this recipe had to solve, because the factory's
   * one alarm must not be its proudest moment. THREE THINGS SEPARATE THEM, and each is doing
   * a job:
   *
   *   · A MAJOR THIRD, NOT A BEAT FREQUENCY. The jam's pair is 5 Hz apart, which is not an
   *     interval at all — it is one note wobbling, and a wobble is what "wrong" sounds like.
   *     These two are 233 and 293 Hz, a real chord, and a chord cannot be mistaken for a fault.
   *     It is also how dual truck horns are actually tuned, so the reference costs nothing.
   *   · IT PULLS UP TO PITCH INSTEAD OF SAGGING. The jam glides DOWN (162→138): a thing
   *     losing power. This glides up a few Hz as the pressure arrives and then holds.
   *   · IT OPENS WITH AIR. A short filtered hiss before the reeds speak — the valve, not the
   *     horn — which is the detail that makes it read as pneumatic rather than as a synth.
   *
   * The attack is 18–26 ms rather than the ~2 ms every other sound here uses. A horn SWELLS;
   * an instant onset is a hit, and a hit is what `MachinePlace` was standing in as.
   */
  [SoundId.TruckHorn]: {
    // ~4.7 decay constants long, per `envelope`'s note: enough that the tail is gone before
    // the buffer ends. The pair lands 400 ms apart, so consecutive blasts overlap slightly,
    // which is what two horns on one truck do.
    duration: 0.7,
    layers: [
      { kind: 'noise', gain: 0.18, attack: 0.004, decay: 0.035, hp: 1200, lp0: 6000, lp1: 3000 },
      { kind: 'tone', wave: 'saw', f0: 226, f1: 233, gain: 0.36, attack: 0.018, decay: 0.15 },
      { kind: 'tone', wave: 'saw', f0: 284, f1: 293, gain: 0.29, attack: 0.026, decay: 0.15 },
      // An octave over the lower reed, quiet: what carries the horn across a lot when the
      // camera is nowhere near the dock.
      { kind: 'tone', wave: 'square', f0: 466, gain: 0.1, attack: 0.02, decay: 0.12 },
      // And the chest of it, under everything. A truck is heavy.
      { kind: 'tone', wave: 'sine', f0: 116.5, gain: 0.24, attack: 0.02, decay: 0.16 },
    ],
  },
  // Two detuned saws a couple of Hz apart. The beating is the unpleasantness, and it is
  // meant to be unpleasant — a jam is a thing you should want to walk over and hit.
  [SoundId.MachineJam]: {
    duration: 0.45,
    layers: [
      { kind: 'tone', wave: 'saw', f0: 162, f1: 138, gain: 0.26, attack: 0.004, decay: 0.17 },
      { kind: 'tone', wave: 'square', f0: 167, f1: 141, gain: 0.18, attack: 0.004, decay: 0.15 },
    ],
  },
  // A wrench on a housing.
  [SoundId.MachineRepair]: {
    duration: 0.12,
    layers: [
      { kind: 'tone', wave: 'square', f0: 1500, f1: 1050, gain: 0.16, attack: 0.001, decay: 0.018 },
      { kind: 'noise', gain: 0.16, attack: 0.001, decay: 0.02, hp: 3200 },
    ],
  },
  [SoundId.UiClick]: {
    duration: 0.07,
    layers: [
      { kind: 'tone', wave: 'square', f0: 900, f1: 700, gain: 0.2, attack: 0.001, decay: 0.014 },
    ],
  },
  [SoundId.UiSelect]: {
    duration: 0.09,
    layers: [
      { kind: 'tone', wave: 'square', f0: 620, f1: 940, gain: 0.2, attack: 0.001, decay: 0.02 },
    ],
  },
};

// --- rendering ------------------------------------------------------------------------

function waveform(wave: Wave, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase * Math.PI * 2);
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'triangle':
      return 4 * Math.abs(phase - 0.5) - 1;
    case 'saw':
      return 2 * phase - 1;
  }
}

/**
 * A one-pole coefficient for a cutoff in Hz. `1 - e^(-2πf/sr)`, the standard RC
 * approximation — good enough for a placeholder and about forty times cheaper than
 * building a `BiquadFilterNode` graph per sound at load.
 */
function poleCoefficient(cutoffHz: number, sampleRate: number): number {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

function renderTone(out: Float32Array, layer: ToneLayer, sampleRate: number): void {
  const start = Math.floor((layer.at ?? 0) * sampleRate);
  const f1 = layer.f1 ?? layer.f0;
  // Exponential glide: constant musical interval per unit time, which is what a slide
  // sounds like. A linear ramp between the same endpoints sounds like it stalls at the top.
  const ratio = f1 / layer.f0;
  const span = out.length - start;
  if (span <= 0) return;

  let phase = Math.random();
  for (let i = 0; i < span; i++) {
    const t = i / sampleRate;
    const progress = i / span;
    const freq = layer.f0 * Math.pow(ratio, progress);
    phase += freq / sampleRate;
    if (phase >= 1) phase -= Math.floor(phase);

    const env = envelope(t, layer.attack, layer.decay);
    out[start + i] = (out[start + i] ?? 0) + waveform(layer.wave, phase) * env * layer.gain;
  }
}

function renderNoise(out: Float32Array, layer: NoiseLayer, sampleRate: number): void {
  const start = Math.floor((layer.at ?? 0) * sampleRate);
  const span = out.length - start;
  if (span <= 0) return;

  const lp0 = layer.lp0 ?? 0;
  const lp1 = layer.lp1 ?? lp0;
  const hpA = layer.hp === undefined ? 0 : poleCoefficient(layer.hp, sampleRate);

  let lpState = 0;
  let hpState = 0;
  let hpPrevIn = 0;

  for (let i = 0; i < span; i++) {
    const t = i / sampleRate;
    const progress = i / span;
    let sample = Math.random() * 2 - 1;

    if (lp0 > 0) {
      const cutoff = lp0 + (lp1 - lp0) * progress;
      lpState += poleCoefficient(cutoff, sampleRate) * (sample - lpState);
      sample = lpState;
    }
    if (hpA > 0) {
      // One-pole highpass as the difference of the signal and its own lowpass tail.
      hpState = (1 - hpA) * (hpState + sample - hpPrevIn);
      hpPrevIn = sample;
      sample = hpState;
    }

    const env = envelope(t, layer.attack, layer.decay);
    out[start + i] = (out[start + i] ?? 0) + sample * env * layer.gain;
  }
}

/** Linear attack into an exponential tail. The tail never truly reaches zero, so the
 * buffer length in the recipe is what actually ends the sound — keep it ≥ ~4 decays or
 * the cut is audible as a click. */
function envelope(t: number, attack: number, decay: number): number {
  if (t < attack) return attack <= 0 ? 1 : t / attack;
  return Math.exp(-(t - attack) / decay);
}

function renderRecipe(ctx: BaseAudioContext, recipe: Recipe): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const frames = Math.max(1, Math.ceil(recipe.duration * sampleRate));
  // Mono on purpose: the `StereoPannerNode` in the voice pool places the sound, so a
  // stereo buffer would only double the memory and then get collapsed anyway.
  const buffer = ctx.createBuffer(1, frames, sampleRate);
  const data = buffer.getChannelData(0);

  for (const layer of recipe.layers) {
    if (layer.kind === 'tone') renderTone(data, layer, sampleRate);
    else renderNoise(data, layer, sampleRate);
  }

  // Normalise only downward. Scaling a quiet sound up would undo the catalogue's mix
  // decisions, which are the part a human tuned.
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const magnitude = Math.abs(data[i] ?? 0);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak > 1) {
    const scale = 1 / peak;
    for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) * scale;
  }

  // A 2 ms fade at the tail. Without it the buffer ends on a non-zero sample and every
  // single playback ticks — which sounds like a bug in the voice pool and is not.
  const fade = Math.min(Math.floor(sampleRate * 0.002), frames);
  for (let i = 0; i < fade; i++) {
    data[frames - 1 - i] = (data[frames - 1 - i] ?? 0) * (i / fade);
  }

  return buffer;
}

/**
 * Every sound, rendered once at start.
 *
 * The whole bank is a few hundred kilobytes of Float32 and takes single-digit
 * milliseconds to build, which is why it happens eagerly on the start gesture rather than
 * lazily on first play — a lazy first pour would stutter, and the first pour is the one
 * that has to feel good (§2).
 */
export class SoundBank {
  private readonly buffers = new Map<SoundId, AudioBuffer>();

  constructor(ctx: BaseAudioContext) {
    for (const id of ALL_SOUND_IDS) {
      const recipe = RECIPES[id];
      if (recipe === undefined) continue;
      this.buffers.set(id, renderRecipe(ctx, recipe));
    }
  }

  /** The seam a real sample loader would drop into unchanged. */
  get(id: SoundId): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }
}
