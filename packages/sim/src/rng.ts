// xoshiro128** and splitmix32, vendored deliberately.
//
// THIS FILE MUST NEVER BE REPLACED BY AN NPM PACKAGE, and the algorithms in it must never
// be "improved". The reason is not bundle size — it is that a dependency upgrade which
// improves the generator would silently invalidate every world ever seeded with the old
// one. Roughly forty lines copied in, once, is the price of that guarantee. If a future
// version needs a better generator, it gets a *new* stream derivation alongside this one,
// never a replacement for it.
//
// Generator state is plain serializable data so an RNG caught mid-stream survives a save
// and reloads exactly where it was.
//
// Cosmetic randomness — particle jitter, idle animation offsets, lamp flicker — belongs to
// the renderer and may use `Math.random` freely. Nothing here is for visuals.

/** A xoshiro128** generator, as plain data. */
export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

/**
 * The systems that draw from the world's randomness. Each gets an independent stream, so
 * adding a consumer here never perturbs what any existing system rolls.
 *
 * No `enum` — Node's native type stripping cannot run them, and these ids are hashed into
 * stream derivation, so their *string values* are load-bearing and must not change.
 */
export const SystemId = {
  /** One-time field generation: soil fertility. */
  FieldInit: 'field-init',
  /** Per-tile growth-duration variance, rolled when a crop is planted. */
  CropGrowth: 'crop-growth',
  /** Harvest yield bonuses. */
  Harvest: 'harvest',
  /** Reserved for demand saturation (plan §4). Unused in v0.1. */
  Economy: 'economy',
} as const;

export type SystemId = (typeof SystemId)[keyof typeof SystemId];

/** Canonical order for iteration and hashing. Never iterate a stream map directly. */
export const SYSTEM_IDS: readonly SystemId[] = [
  SystemId.CropGrowth,
  SystemId.Economy,
  SystemId.FieldInit,
  SystemId.Harvest,
];

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Advance the generator and return the next uint32. Mutates `state` in place. */
export function nextUint32(state: RngState): number {
  const result = Math.imul(rotl(Math.imul(state.s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (state.s1 << 9) >>> 0;

  state.s2 = (state.s2 ^ state.s0) >>> 0;
  state.s3 = (state.s3 ^ state.s1) >>> 0;
  state.s1 = (state.s1 ^ state.s2) >>> 0;
  state.s0 = (state.s0 ^ state.s3) >>> 0;
  state.s2 = (state.s2 ^ t) >>> 0;
  state.s3 = rotl(state.s3, 11);

  return result;
}

/**
 * A uniform integer in `[0, bound)`, by rejection sampling. Rejection keeps the result
 * unbiased without touching a float, and the loop is deterministic because the rejected
 * draws are part of the stream.
 */
export function nextBelow(state: RngState, bound: number): number {
  if (bound <= 1) return 0;
  // 2^32 is exactly representable, so this modulus is exact integer arithmetic.
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
  let draw = nextUint32(state);
  while (draw >= limit) {
    draw = nextUint32(state);
  }
  return draw % bound;
}

/** A uniform integer in `[low, high]`, inclusive at both ends. */
export function nextRange(state: RngState, low: number, high: number): number {
  if (high <= low) return low;
  return low + nextBelow(state, high - low + 1);
}

/** True with probability `numerator / denominator`. */
export function nextChance(state: RngState, numerator: number, denominator: number): boolean {
  if (numerator <= 0) return false;
  if (numerator >= denominator) return true;
  return nextBelow(state, denominator) < numerator;
}

/** splitmix32 — one scramble of a 32-bit counter. Used only to seed xoshiro. */
export function splitmix32(x: number): number {
  let z = (x + 0x9e37_79b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Fold a system id into a 32-bit value (FNV-1a over its UTF-16 code units).
 *
 * This is deliberately private to the RNG rather than shared with `hash.ts`: stream
 * derivation must survive any future retuning of the state digest. Two functions that
 * happen to be the same algorithm are cheaper than one function two subsystems can
 * accidentally couple through.
 */
function foldSystemId(systemId: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < systemId.length; i++) {
    h = (h ^ systemId.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x0100_0193) >>> 0;
  }
  return h;
}

/**
 * Seed an independent generator for one system of one world.
 *
 * Derivation goes through the system id's *string*, not a registration index, so adding
 * crop-disease RNG in v0.4 leaves every stream that already exists bit-identical. That
 * property is a one-way door per plan §12 — it cannot be recovered once worlds exist.
 */
export function deriveStream(worldSeed: number, systemId: SystemId): RngState {
  let x = ((worldSeed >>> 0) ^ foldSystemId(systemId)) >>> 0;
  const state: RngState = { s0: 0, s1: 0, s2: 0, s3: 0 };

  x = (x + 0x9e37_79b9) >>> 0;
  state.s0 = splitmix32(x);
  x = (x + 0x9e37_79b9) >>> 0;
  state.s1 = splitmix32(x);
  x = (x + 0x9e37_79b9) >>> 0;
  state.s2 = splitmix32(x);
  x = (x + 0x9e37_79b9) >>> 0;
  state.s3 = splitmix32(x);

  // xoshiro is degenerate at all-zero state; astronomically unlikely, cheap to exclude.
  if ((state.s0 | state.s1 | state.s2 | state.s3) === 0) {
    state.s0 = 1;
  }

  // Discard a short warm-up so low-entropy seeds (0, 1, 2 …) diverge immediately.
  for (let i = 0; i < 8; i++) {
    nextUint32(state);
  }

  return state;
}

/** Deep copy of a generator, for speculative rolls that must not advance the world. */
export function cloneRng(state: RngState): RngState {
  return { s0: state.s0, s1: state.s1, s2: state.s2, s3: state.s3 };
}

/** Normalise a world seed to the uint32 the generator actually consumes. */
export function normaliseSeed(seed: number): number {
  return Math.trunc(seed) >>> 0;
}
