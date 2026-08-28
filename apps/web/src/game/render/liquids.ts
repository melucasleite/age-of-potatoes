// The liquid colour language.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  PLAN §5: "pipes auto-tint by liquid and render gray when empty".
//
//  That sentence is a whole diagnostic instrument, not a decoration. A mature base runs
//  four or more liquids on four or more networks — one pump and one liquid per network is
//  enforced — and the player is expected to read their entire fluid layout BY COLOUR, at
//  full zoom-out, without opening anything. Grey is the loudest colour in the set: a grey
//  run is a dead run, and finding it is the pipe equivalent of spotting a gap in a belt.
//
//  Which means the tints are a fixed vocabulary, not per-liquid taste. Two liquids that
//  read as "some kind of brown" at 2× zoom have cost the player the instrument.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Every colour below is lifted from `art/palette/master.json`, the hand-authored 40-colour
// master palette that every generated sprite is constrained to. A pipe tinted off-palette
// would be the one object on screen that could not have been drawn by the art pipeline.
//
// The table is keyed by SLUG, not by numeric id, because the sim owns the ids and this file
// must not race it for them. When `packages/sim` grows its liquid table, a liquid whose slug
// is listed here lights up with no edit here at all.

import * as sim from '@snack/sim';

/** A liquid's look: the tint a pipe carrying it takes, and what to call it in the ribbon. */
export interface LiquidLook {
  /** Multiply tint for the pipe body. Always a master-palette colour. */
  readonly tint: number;
  /** Name for the status ribbon. Lower case: it is read mid-sentence. */
  readonly name: string;
}

/**
 * Bare metal. What a pipe is when it carries nothing — and per §5, the state the player is
 * hunting for. Deliberately the most desaturated entry in the file so a dead line reads as
 * dead from across the lot rather than as "some liquid I do not recognise".
 */
export const EMPTY_PIPE_TINT = 0x868a99;

/**
 * The canonical liquids, by slug.
 *
 * Order is the chain order the soda line actually runs in — water and cane juice at the top
 * because they come out of the ground, soda syrup at the bottom because everything else
 * folds into it. Hues are spread so that no two adjacent steps in the chain share one:
 * juice is green, syrup is amber, carbonated water is pale cyan, flavoured syrup is red.
 * Standing at the Bottler you can see which of its two inlets is starved without leaning in.
 */
export const LIQUID_LOOKS: Readonly<Record<string, LiquidLook>> = {
  water: { tint: 0x4fa3d1, name: 'water' },
  // The Recirculator's murky graywater row sat here until [[145]] cut the machine.
  // The full green from the palette's grass ramp rather than the pale one above it. The pale
  // green sits close enough to simple syrup that the two converge at small sizes — caught by
  // `pipes.test.ts`, which is the whole reason that test measures distances instead of
  // trusting the eye of whoever picked the colours.
  'cane-juice': { tint: 0x74a340, name: 'cane juice' },
  juice: { tint: 0x74a340, name: 'juice' },
  'simple-syrup': { tint: 0xd9ab6e, name: 'simple syrup' },
  syrup: { tint: 0xd9ab6e, name: 'syrup' },
  'kola-syrup': { tint: 0x855428, name: 'kola syrup' },
  'soda-syrup': { tint: 0x9e2f27, name: 'soda syrup' },
  'carbonated-water': { tint: 0x9fdcef, name: 'carbonated water' },
} as const;

/**
 * The id order this renderer assumes until the sim ships its own table.
 *
 * This is the ONE place a numeric liquid id appears in the renderer, and it is a fallback:
 * the moment `packages/sim` exports `LIQUID_SPECS`, the ids come from there and this array
 * stops being consulted. It exists so that a pipe layer written before the liquid layer is
 * not a grey layer — and so the sim owner has a written-down order to agree or disagree with
 * rather than one to guess at.
 */
const ASSUMED_ID_ORDER = [
  'water',
  'cane-juice',
  'simple-syrup',
  'carbonated-water',
  'kola-syrup',
  'soda-syrup',
] as const;

/**
 * The sim's liquid table, if it has one yet.
 *
 * Read STRUCTURALLY rather than imported by name, because `packages/sim` belongs to another
 * agent this round: a hard import of a symbol added an hour from now is a build break rather
 * than a graceful degradation, and this file has to compile on both sides of that hour.
 *
 * `LiquidSpec.tintRgb` is authoritative when it exists — the sim owns the liquid table, and
 * a renderer that quietly overrode its colours would make the data a lie. What stays here is
 * the FALLBACK vocabulary for liquids the sim has not defined yet (today: all the soda ones)
 * and the friendlier names for the status ribbon.
 */
interface SimLiquidSpec {
  readonly id: number;
  readonly slug: string;
  readonly tintRgb?: number;
}

const SIM_LIQUID_SPECS: readonly SimLiquidSpec[] =
  (sim as { LIQUID_SPECS?: readonly SimLiquidSpec[] }).LIQUID_SPECS ?? [];

/** id → look, resolved once at module load. */
const BY_ID = new Map<number, LiquidLook>();
/** id → slug, for the status ribbon and for port matching. */
const SLUG_BY_ID = new Map<number, string>();

function register(id: number, slug: string, simTint?: number): void {
  if (id === 0) return;
  SLUG_BY_ID.set(id, slug);
  const known = LIQUID_LOOKS[slug];
  BY_ID.set(id, {
    tint: simTint ?? known?.tint ?? EMPTY_PIPE_TINT,
    name: known?.name ?? slug.split('-').join(' '),
  });
}

for (const spec of SIM_LIQUID_SPECS) register(spec.id, spec.slug, spec.tintRgb);

// Anything the sim has not defined yet keeps the assumed id. The soda liquids arrive on the
// sim side during this same release, and the two tables agreeing on `water = 1` is what makes
// that landing uneventful.
for (let i = 0; i < ASSUMED_ID_ORDER.length; i++) {
  const id = i + 1;
  if (!BY_ID.has(id)) register(id, ASSUMED_ID_ORDER[i]!);
}

/** True once the sim owns the liquid table — reported by the dev overlay, useful in review. */
export const LIQUIDS_FROM_SIM = SIM_LIQUID_SPECS.length > 0;

/** How many liquids are known, from whichever source won. */
export const LIQUID_COUNT = BY_ID.size;

/**
 * The tint for a pipe carrying `liquidId`.
 *
 * `0` — and any id nobody has heard of — is bare metal. Never a magenta "missing colour"
 * square: an unknown liquid should look like an empty pipe, which is a state the player
 * already knows how to debug, rather than like a rendering bug they cannot.
 */
export function liquidTint(liquidId: number): number {
  if (liquidId === 0) return EMPTY_PIPE_TINT;
  return BY_ID.get(liquidId)?.tint ?? EMPTY_PIPE_TINT;
}

/** The liquid's name for the status ribbon, or `null` for "nothing in there". */
export function liquidName(liquidId: number): string | null {
  if (liquidId === 0) return null;
  return BY_ID.get(liquidId)?.name ?? 'liquid';
}

/** The liquid's slug, for matching a machine's declared port against what is plugged in. */
export function liquidSlug(liquidId: number): string | null {
  if (liquidId === 0) return null;
  return SLUG_BY_ID.get(liquidId) ?? null;
}

/**
 * The tint for a machine's typed pipe port with nothing plugged into it: the liquid it
 * wants, dimmed hard.
 *
 * Not grey. Grey is reserved for "a pipe that is carrying nothing", and a port is not a
 * pipe. Dimmed-but-hued says "this is where the water goes and there is no water", which is
 * a different errand from "the water line is dead" and should not look like it.
 */
export function portHintTint(liquidId: number): number {
  return dim(liquidTint(liquidId), 0.45);
}

/**
 * Scale a colour toward black. Used for the unconnected port hint and for the shaded half
 * of a pipe, so both stay on the same hue as the liquid rather than drifting grey.
 */
export function dim(colour: number, factor: number): number {
  const r = Math.round(((colour >> 16) & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round((colour & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
