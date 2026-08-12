// Base units for the simulation.
//
// Every quantity in `WorldState` is an integer in one of the units declared here.
// There is no fixed-point layer and no rounding policy, because there is nothing to
// round. The reason is not hostile compilers: IEEE-754 float determinism holds only as
// long as the exact *sequence* of operations survives, so a routine cleanup that
// reorders `(a * b) + c` silently invalidates every stored replay. Integers make
// refactoring safe, which is the actual requirement over a multi-year project.
//
// MONEY IS CENTS AND NEVER DOLLARS. Nothing in this package divides by 100. Formatting
// `12345` as "$123.45" is a renderer concern and lives in `apps/web`.
//
// Stay in `number` (integers are exact to 2^53). Do not introduce `BigInt` in the tick
// loop. These base units are a one-way door per plan §12 — changing SUBTILE after a
// world exists invalidates every save and every golden fixture.

declare const brandTag: unique symbol;

type Brand<T extends string> = { readonly [brandTag]: T };

/** Money, in cents. Never dollars. */
export type Cents = number & Brand<'Cents'>;

/** Fluid volume, in millilitres. */
export type Millilitres = number & Brand<'Millilitres'>;

/** Machine progress, in integer work-points. */
export type WorkPoints = number & Brand<'WorkPoints'>;

/** Position along an axis, in subtiles. `SUBTILE` subtiles make one tile. */
export type Subtiles = number & Brand<'Subtiles'>;

/**
 * Subtiles per tile. Belt positions, entity positions, and reach checks are all
 * measured in these. 256 is a power of two so tile/subtile splits stay exact.
 */
export const SUBTILE = 256;

/** The fixed simulation rate. The renderer runs at whatever the display does. */
export const TICKS_PER_SECOND = 20;

/** Wall-clock milliseconds one tick represents. Used by the host loop, not by the sim. */
export const TICK_MS = 50;

/**
 * An active hour, in ticks (plan §6). Money and the clock are the same substance: the
 * economy only advances while ticks accrue, and ticks only accrue while the player is
 * present. There is no offline progress, ever.
 */
export const TICKS_PER_ACTIVE_HOUR = 72_000;

/**
 * The Music Box grid (plan §14). 100 BPM at 20 Hz is exactly 12 ticks per beat. The beat
 * is derived from the tick counter and is therefore part of the deterministic world;
 * `AudioContext.currentTime` must never flow the other way.
 */
export const BEATS_PER_MINUTE = 100;
export const TICKS_PER_BEAT = 12;

/** Which beat of the global grid a tick falls on. */
export function beatIndex(tick: number): number {
  return divFloor(tick, TICKS_PER_BEAT);
}

/** True on the tick a beat starts. */
export function isBeatTick(tick: number): boolean {
  return tick % TICKS_PER_BEAT === 0;
}

// --- constructors -----------------------------------------------------------------
// These exist so that a raw `number` cannot drift into a branded slot unnoticed. They
// truncate rather than round, and truncation of an already-integer input is identity.

export function cents(n: number): Cents {
  return Math.trunc(n) as Cents;
}

export function millilitres(n: number): Millilitres {
  return Math.trunc(n) as Millilitres;
}

export function workPoints(n: number): WorkPoints {
  return Math.trunc(n) as WorkPoints;
}

export function subtiles(n: number): Subtiles {
  return Math.trunc(n) as Subtiles;
}

// --- conversions ------------------------------------------------------------------

export function tilesToSubtiles(tiles: number): Subtiles {
  return (tiles * SUBTILE) as Subtiles;
}

/** The tile a subtile coordinate falls in. Floors, so it is correct left of the origin. */
export function subtilesToTile(s: number): number {
  return divFloor(s, SUBTILE);
}

/** The centre of a tile, in subtiles — where hand-verb reach is measured from. */
export function tileCentreSubtiles(tile: number): Subtiles {
  return (tile * SUBTILE + SUBTILE / 2) as Subtiles;
}

export function litresToMillilitres(litres: number): Millilitres {
  return (litres * 1000) as Millilitres;
}

export function ticksToMilliseconds(ticks: number): number {
  return ticks * TICK_MS;
}

/** Active hours in hundredths, so the caller never sees a fraction. */
export function centiActiveHours(ticks: number): number {
  return divFloor(ticks * 100, TICKS_PER_ACTIVE_HOUR);
}

// --- integer arithmetic helpers ---------------------------------------------------
// All sim magnitudes sit far below 2^53, where IEEE division is exact enough that these
// agree with true integer arithmetic. Even at the limit they would be wrong *identically*
// on every machine, so determinism does not depend on that claim — only readability does.

export function divFloor(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Round-half-up division, used for prices and rates so value is never quietly lost. */
export function divRound(a: number, b: number): number {
  return Math.floor((a + divFloor(b, 2)) / b);
}

export function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Permille of a whole, for progress bars and condition readouts. Integers throughout. */
export function permille(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return clampInt(divFloor(part * 1000, whole), 0, 1000);
}

/**
 * Squared distance in subtiles. Squared, because comparing against a squared radius keeps
 * reach checks in exact integer arithmetic — `Math.sqrt` is bit-exact under IEEE-754 but
 * there is no reason to spend it.
 */
export function distanceSquaredSubtiles(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
