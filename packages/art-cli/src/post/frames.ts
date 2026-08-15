import type { RawImage } from './raw.js';
import type { AssetEntry } from '../manifest.js';

/**
 * The frame counts Retro Diffusion's animation styles will actually generate. The API calls
 * this `frames_duration`, which reads like a timing knob and is not one: it is the number of
 * frames in the animation. There is no way to ask for 5.
 */
export const ALLOWED_FRAME_COUNTS = [4, 6, 8, 10, 12, 16] as const;

/**
 * Frame pixel sizes are FIXED per animation style — the endpoint does not honour arbitrary
 * width/height the way the plain path does. Only styles in this table may be used with
 * `frames`; the size is what goes on the wire and what the returned sheet is sliced by.
 *
 * `check_cost` prices other sizes happily (it validates nothing, see PRICING.md), so this
 * table is the enforcement, the same way the 64px floor lives in code rather than in the API.
 */
export const ANIMATION_FRAME_SIZES: Readonly<Record<string, number>> = {
  rd_animation__small_sprites: 32,
  rd_animation__four_angle_walking: 48,
  rd_animation__any_animation: 64,
  rd_animation__big_animation: 128,
};

export interface AnimationPlan {
  /** Native cells the strip ships with — `entry.frames`. */
  frames: number;
  /** Frame count actually requested upstream: the smallest allowed count ≥ `frames`. */
  framesRequested: number;
  /** Pixel size of one frame on the wire, fixed by the style. */
  frameSize: number;
  /** Native cell size — `entry.height`; the strip is one row of square cells. */
  cell: number;
  /** Integer oversampling factor the cook stage undoes: `frameSize / cell`. */
  factor: number;
  /**
   * Which of the requested frames ship, in order, as strip cells — THE DISCARD RULE.
   *
   * When the request had to over-ask (5 wanted, 6 is the nearest count RD sells), the strip
   * keeps the first `frames - 1` frames and the LAST one, discarding the interior surplus.
   * The last frame is the animation's end state, and the final cell of a strip is defined by
   * its end state — a grow-then-wither crop strip's cell 4 must be the fully wilted plant,
   * not the halfway sag the model drew on its way there. Deterministic: same request, same
   * kept frames, forever.
   */
  keep: readonly number[];
}

/**
 * Validates a `frames` entry against what the animation endpoint can actually deliver, and
 * fixes every derived number the adapter and the cook stage must agree on. Both call this —
 * one function, so the request and the reassembly can never drift apart.
 */
export function planAnimation(entry: AssetEntry): AnimationPlan {
  const frames = entry.frames;
  if (frames === undefined) {
    throw new Error(`Asset "${entry.id}" has no "frames" — planAnimation is for strip entries.`);
  }
  const cell = entry.height;
  if (entry.width !== frames * cell) {
    throw new Error(
      `Asset "${entry.id}" declares frames: ${frames} but is ${entry.width}x${entry.height} — ` +
        `a strip is one row of square cells, so width must be ${frames * cell}.`,
    );
  }

  const style = entry.promptStyle;
  if (!style || !(style in ANIMATION_FRAME_SIZES)) {
    throw new Error(
      `Asset "${entry.id}" declares frames: ${frames} but promptStyle "${style ?? '(none)'}" is ` +
        `not an animation style. Use one of: ${Object.keys(ANIMATION_FRAME_SIZES).join(', ')}.`,
    );
  }
  const frameSize = ANIMATION_FRAME_SIZES[style] as number;
  if (frameSize % cell !== 0) {
    throw new Error(
      `Asset "${entry.id}": style ${style} generates ${frameSize}px frames, which is not an ` +
        `integer multiple of the ${cell}px cell — the decimation would not be exact.`,
    );
  }

  const framesRequested = ALLOWED_FRAME_COUNTS.find((n) => n >= frames);
  if (framesRequested === undefined) {
    throw new Error(
      `Asset "${entry.id}" wants ${frames} frames; Retro Diffusion tops out at ` +
        `${ALLOWED_FRAME_COUNTS[ALLOWED_FRAME_COUNTS.length - 1]}.`,
    );
  }

  const keep: number[] = [];
  if (framesRequested === frames) {
    for (let i = 0; i < frames; i++) keep.push(i);
  } else {
    for (let i = 0; i < frames - 1; i++) keep.push(i);
    keep.push(framesRequested - 1);
  }

  return { frames, framesRequested, frameSize, cell, factor: frameSize / cell, keep };
}

/**
 * Turns the provider's spritesheet — whatever grid it chose — into the horizontal strip the
 * pipeline expects, applying the plan's discard rule.
 *
 * The committed original stays the raw sheet (originals are always the provider's untouched
 * output); this runs in the cook stage on every pack, and in `gen` once, to gate the take.
 * The sheet's layout is not documented anywhere, so it is derived: both dimensions must be
 * exact multiples of the frame size, frames read row-major, and the cell count must EQUAL
 * the frames requested. Anything else fails loudly rather than guessing.
 *
 * Exact equality is a measured rule, not tidiness. `rd_animation__small_sprites` ignores
 * `frames_duration` entirely and always returns a 5x4 twenty-cell RPG character sheet —
 * walk cycles and a death pose, whatever the prompt says (measured 2026-08-14, two paid
 * takes: even "not a character, no face, no arms, it never walks" came back as a plant
 * person waving). A surplus-cell sheet therefore means the style substituted its own
 * format, and slicing the first six cells of it ships four walk frames and a wave. Reject
 * the take; the geometry gate cannot judge subject matter, but this it can catch.
 */
export function reassembleStrip(sheet: RawImage, plan: AnimationPlan, id: string): RawImage {
  const { frameSize, framesRequested, keep } = plan;
  if (sheet.width % frameSize !== 0 || sheet.height % frameSize !== 0) {
    throw new Error(
      `Asset "${id}": provider returned a ${sheet.width}x${sheet.height} sheet, not a multiple ` +
        `of the ${frameSize}px frame — likely a GIF or a plain image, not a spritesheet.`,
    );
  }
  const cols = sheet.width / frameSize;
  const rows = sheet.height / frameSize;
  if (cols * rows !== framesRequested) {
    throw new Error(
      `Asset "${id}": sheet has ${cols}x${rows} = ${cols * rows} cell(s) but exactly ` +
        `${framesRequested} frame(s) were requested — the style substituted its own animation ` +
        `format for the asked frame count. This take is not a strip; reject it.`,
    );
  }

  const out: RawImage = {
    data: Buffer.alloc(keep.length * frameSize * frameSize * 4),
    width: keep.length * frameSize,
    height: frameSize,
  };

  keep.forEach((frameIndex, cellIndex) => {
    const srcX = (frameIndex % cols) * frameSize;
    const srcY = Math.floor(frameIndex / cols) * frameSize;
    for (let y = 0; y < frameSize; y++) {
      const src = ((srcY + y) * sheet.width + srcX) * 4;
      const dst = (y * out.width + cellIndex * frameSize) * 4;
      sheet.data.copy(out.data, dst, src, src + frameSize * 4);
    }
  });

  return out;
}
