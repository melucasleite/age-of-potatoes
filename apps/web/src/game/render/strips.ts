// The strip-slicing arithmetic, as arithmetic.
//
// Kept OUT of `./textures` for one testability reason that file already discovered the hard
// way (see ceremony.test.ts's note): importing `./textures` drags the generated atlas
// manifest in through the `@/` alias, which vitest does not resolve, so anything living
// there is untestable. These two functions are the part of the slicing that can fail
// quietly, which is exactly the part that wants a test.

/**
 * How many square cells a strip holds — READ OFF THE PICTURE, not off the crop's stage
 * count.
 *
 * The two agreed by arithmetic while every strip was 64×16 and every crop had four growth
 * stages, and that coincidence is exactly the kind that breaks silently: a five-frame 80×16
 * strip sliced into four would stretch each cell 25% wider and shift every stage but the
 * first, which reads as "the art came back wrong" rather than as a slicing bug.
 *
 * Cells are square by construction — a strip is N frames of the same tile size in a row —
 * so width ÷ height IS the count. `Math.round` rather than a floor, so a packer that ever
 * shaves a pixel off the page cannot silently drop the last frame.
 */
export function stripCells(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.max(1, Math.round(width / height));
}

/**
 * Which half of a two-frame stride a character is on, from distance walked.
 *
 * THE CADENCE IS DISTANCE, NOT A CLOCK — the rule `render/bots.ts` established and the
 * player now shares. `(xSub + ySub) / strideSub` plants a foot every `strideSub` subtiles
 * and stops dead the moment the character does, with no state and nothing to reset when a
 * save is loaded mid-stride. A wall-clock cycle would keep marching on the spot.
 *
 * Returns 0 or 1 — the caller adds 1 to get the strip's 1-based cell.
 */
export function stridePhase(xSub: number, ySub: number, strideSub: number): number {
  if (strideSub <= 0) return 0;
  return Math.floor((xSub + ySub) / strideSub) & 1;
}

/**
 * The cell a character standing still shows — the NEUTRAL pose, not half a stride ([[134]]).
 *
 * ── WHY CELL 3 IS A FACT ABOUT THE ART, NOT A PREFERENCE ────────────────────────────────
 *
 * Every character sheet is a 4×4 grid of 48px cells and the manifest harvests three of each
 * row: columns 0 and 2 are the CONTACT poses (one foot forward, the other trailing) and
 * column 1 is the PASSING pose — legs together, both feet flat on the ground. The harvest
 * lists the passing cell LAST, so a walk strip is `contact, contact, standing` and the
 * neutral frame is cell 3.
 *
 * The old answer was cell 1, and cell 1 is a contact pose: measured across all 36 harvested
 * cells, a character parked on one has a foot hanging four source pixels off the ground.
 * That is the whole of the complaint this fixes — the farmer was not frozen mid-walk by
 * accident, he was pinned to a frame in which he is mid-step by construction.
 *
 * A STALE ATLAS DEGRADES RATHER THAN BREAKS: `fromStrip` clamps, so a two-cell strip asked
 * for cell 3 returns its last cell. Wrong picture, real texture, no magenta.
 */
export const STAND_CELL = 3;

/**
 * The 1-based strip cell a walking (or standing) character shows.
 *
 * Standing selects the strip's neutral cell rather than freezing on whichever foot the walk
 * stopped on: a pawn parked mid-stride reads as broken, which is a sentence this game's
 * visual grammar reserves for machines that actually are.
 *
 * THE SWITCH IS INSTANT, BY RULING. Snapping from stride to stand is what the genre does,
 * and the alternative — finishing the current step first — costs renderer-side state that
 * has to be reset on a load, a teleport and a facing change, to hide a transition that is
 * one frame long. The one measured artefact is a 1px rise: the passing pose stands a single
 * source pixel taller than the contact poses in every character and every direction, which
 * is 2 CSS px at default zoom, and is anatomically what standing up out of a step looks
 * like.
 */
export function walkStep(moving: boolean, xSub: number, ySub: number, strideSub: number): number {
  return moving ? stridePhase(xSub, ySub, strideSub) + 1 : STAND_CELL;
}
