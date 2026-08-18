// Which picture a thing in the bag is, and where that picture sits on the atlas.
//
// The HUD is DOM, so an item sprite arrives as `background-image` + `background-position` on a
// span rather than as a Pixi sprite. All the arithmetic for that lives here, apart from React,
// because it is the half that can be wrong invisibly: a background offset that is one atlas
// repack out of date does not throw, does not warn, and draws the neighbouring frame.
//
// WHY THIS IS NOT `game/render/textures.ts`, which already knows every one of these names.
// That module's first line imports `pixi.js` and its job is to hand out `Texture`s from a
// loaded spritesheet — importing it from a React panel would drag the renderer, a GPU context
// and an async atlas load into a DOM component, and into every test that touches one. What is
// duplicated here instead is deliberately the SMALL half: the naming rule (a frame id is the
// sim's own slug with dashes swapped for underscores) and two alias entries. The geometry —
// every x, y, width and height — is read from the generated manifest at import time and never
// copied, which is the part that actually goes stale.
//
// THE MANIFEST IS READ, NEVER WRITTEN, AND NEVER QUOTED. `manifest.generated.ts` is emitted by
// `yarn art pack` and its URL is content-hashed ([[022]]): the atlas repacks to a new filename
// on every art build, so a copied string is a 404 waiting for the next generation run, and a
// copied x/y is a wrong picture. Both come from the import.
//
// FOUR RUNGS, AND THE LAST ONE IS BLANK ON PURPOSE. An item resolves to its own frame, or to an
// alias, or to a cell of its crop's growth strip, or to nothing at all — and "nothing at all"
// draws a neutral chip. It must never draw the renderer's magenta placeholder: that square is a
// debugging affordance for a build that is missing art it expects, and item 037's lesson is that
// a magenta square in front of a player reads as a broken game rather than as a missing asset.
// New items land in `data.ts` faster than art lands in the atlas, and the bag has to survive
// the gap between them without looking broken.

import { CROP_SPECS, itemSpec, machineKindForBoxedItem, machineSpec } from '@snack/sim';
import type { ItemId, MachineKind } from '@snack/sim';

// Relative rather than the `@/` alias, for the reason `derive-inventory.ts` and `format/money.ts`
// both state at length: `@/*` is a tsconfig path that Next resolves and vitest does not, and this
// module has a test.
import { ATLAS_FRAMES, ATLAS_IMAGE_URL, ATLAS_SIZE } from '../art/manifest.generated';
import type { AtlasFrame } from '../art/manifest.generated';

/**
 * The manifest, indexed by a name that may not be in it.
 *
 * `ATLAS_FRAMES` is a const object with one property per frame, so `ATLAS_FRAMES[name]` for a
 * computed name is a type error rather than an existence check. Widening it once, here, is what
 * makes "does this frame exist yet?" an ordinary question — and asking it is the whole guard.
 */
const FRAMES = ATLAS_FRAMES as Readonly<Record<string, AtlasFrame | undefined>>;

/** Frame ids are the sim's own slugs with dashes swapped for underscores. One vocabulary. */
function frameSlug(slug: string): string {
  return slug.split('-').join('_');
}

/**
 * Frames the art pipeline shipped under an older id.
 *
 * The renderer keeps the same two entries and for the same reason — a rename in `data.ts`
 * degrades to "old art, right slot" instead of a grey box. They are copied rather than shared
 * because the module holding them cannot be imported without Pixi (see the header). Two entries
 * of duplication, and the ladder below means a stale one costs a neutral chip, not a wrong
 * picture: an alias is consulted only after the correctly-named frame is found to be absent.
 */
const ITEM_ALIASES: Readonly<Record<string, string>> = {
  item_russet_potato: 'item_potato',
  item_bagged_chips: 'item_chip_bag',
};

/**
 * A boxed Belt Junction wears the junction tile itself.
 *
 * The one machine in the game whose sprite lives on the belt page rather than the machine page,
 * because it is a single tile of conveyor — see the note on `ART.beltJunction`. Without this a
 * boxed junction is the one crate in the bag with no picture, which is a strange thing for the
 * most common machine on a built-up lot.
 */
const MACHINE_ALIASES: Readonly<Record<string, string>> = {
  machine_belt_junction: 'belt_junction',
};

/** A rectangle of the atlas to draw. Not a frame name: a crop strip resolves to one CELL of one. */
export interface IconSource {
  /** The atlas frame this came out of. Carried for tests and for debugging, never for layout. */
  readonly frame: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function whole(name: string, frame: AtlasFrame): IconSource {
  return { frame: name, x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

/** The frame under this name, or under the name it used to have, or nothing. */
function lookup(name: string, aliases: Readonly<Record<string, string>>): IconSource | null {
  const direct = FRAMES[name];
  if (direct !== undefined) return whole(name, direct);

  const alias = aliases[name];
  if (alias === undefined) return null;
  const aliased = FRAMES[alias];
  return aliased === undefined ? null : whole(alias, aliased);
}

/**
 * How many square cells a growth strip holds — READ OFF THE PICTURE, not off the crop's
 * `stageCount`.
 *
 * The renderer makes the same point where it slices strips for the world: the two agreed by
 * arithmetic while every strip was 64×16 and every crop had four drawn stages, and a five-cell
 * strip sliced into four shifts every stage but the first. Cells are square by construction, so
 * width ÷ height IS the count.
 */
function stripCells(source: AtlasFrame): number {
  if (source.width <= 0 || source.height <= 0) return 0;
  return Math.max(1, Math.round(source.width / source.height));
}

/** The n-th square cell of a growth strip, clamped into it. */
function stripCell(name: string, source: AtlasFrame, cell: number): IconSource {
  const cells = stripCells(source);
  const index = cell < 0 ? 0 : cell >= cells ? cells - 1 : cell;
  return {
    frame: name,
    x: source.x + index * source.height,
    y: source.y,
    width: source.height,
    height: source.height,
  };
}

/**
 * The growth strip for a crop slug, hunting the vocabulary the art pipeline actually used.
 *
 * The pipeline names a strip after ONE word of the crop's slug and is not consistent about
 * which: `russet-potato` is `crop_potato_strip` (the last word) and `chili-pepper` is
 * `crop_chili_strip` (the first). Trying several is not sloppiness — it is the difference
 * between chili peppers having a picture and not, and the existence check means a wrong guess
 * costs nothing. Whichever the packer emits, the bag finds it.
 *
 * THE WHOLE SLUG IS TRIED FIRST, and that ordering is load-bearing rather than tidy. A Gold
 * Potato's last word is "potato": ask for the short name first and the premium crop quietly
 * borrows the russet's picture, which is the one failure on this rung that a player could act
 * on. The specific name wins, and the general one is only ever a fallback.
 */
function cropStrip(slug: string): { name: string; frame: AtlasFrame } | null {
  const full = frameSlug(slug);
  const words = full.split('_');
  const tries = [full, words[words.length - 1], words[0]];
  for (const word of tries) {
    if (word === undefined || word === '') continue;
    const name = `crop_${word}_strip`;
    const frame = FRAMES[name];
    if (frame !== undefined) return { name, frame };
  }
  return null;
}

/**
 * A seed or a harvest, drawn from its crop's growth strip.
 *
 * THIS RUNG IS THE REASON THE FEATURE WORKS ON DAY ONE. The atlas has fourteen item frames and
 * `ITEM_SPECS` has fifty-odd rows; seeds, corn, chili and cane have no sprite of their own and
 * are not going to get one soon. Without this the FIRST bag a player ever opens —
 * potato seeds and russets — is half neutral chips, which is precisely the "a list of text with
 * pictures missing" the work item exists to end.
 *
 * A seed takes the strip's first cell and a harvest its last, which is honest twice over: the
 * two are visibly different in the grid, and each one is a picture of the thing itself at the
 * moment the player holds it.
 *
 * The link is `CROP_SPECS`, never a table here: a crop added in `data.ts` brings its seed and
 * its yield with it, already pointing at the strip the artist will draw.
 */
function cropIcon(item: number): IconSource | null {
  for (const crop of CROP_SPECS) {
    const seed = (crop.seedItem as number) === item;
    const fruit = (crop.yieldItem as number) === item;
    if (!seed && !fruit) continue;

    const strip = cropStrip(crop.slug);
    if (strip === null) return null;
    return stripCell(strip.name, strip.frame, seed ? 0 : stripCells(strip.frame) - 1);
  }
  return null;
}

/** The sprite for a machine kind, or null when the atlas has not got one yet. */
export function resolveMachineIcon(kind: number): IconSource | null {
  const spec = machineSpec(kind as MachineKind);
  if (spec === null) return null;
  return lookup(`machine_${frameSlug(spec.slug)}`, MACHINE_ALIASES);
}

/**
 * An atlas frame by its own name, for the build menu's cells ([[071]]).
 *
 * The catalogue derives frame NAMES on the input side (`BuildEntry.frame` — the sim's slugs
 * under the pipeline's naming rule) and this is where they become rectangles, because the
 * manifest belongs to this module and to nobody across the seam. The machine aliases apply
 * for the same one machine they always cover: `machine_belt_junction` lives on the belt page
 * as `belt_junction`, and a menu cell should degrade exactly as the bag's crate does.
 *
 * `null` falls to the same neutral chip every other missing frame gets — never magenta
 * ([[037]]). Today that is the Drone Bay and the retired Parts Bench, which have no world sprite
 * either (`render/textures.ts` draws them procedurally); the mapping test in
 * `build-menu.test.ts` pins that list so a new frameless entry fails loudly.
 */
export function resolveFrameIcon(name: string): IconSource | null {
  if (name === '') return null;
  return lookup(name, MACHINE_ALIASES);
}

const CACHE = new Map<number, IconSource | null>();

/**
 * The sprite for anything that can sit in the bag, the pouch or the stand's board.
 *
 * A BOXED MACHINE IS ASKED ABOUT AS A MACHINE, FIRST. Its item slug is `boxed-fryer` and there
 * is no `item_boxed_fryer` frame nor ever will be — the crate in the bag is drawn as the Fryer
 * inside it, which is also what `item-copy.ts` decided about its name, and for the same reason:
 * the player thinks of it as the Fryer they picked up.
 *
 * Memoised because the answer is a fact about the build. The manifest is generated, the sim's
 * specs are constant, and the grid asks this question once per slot per render.
 */
export function resolveItemIcon(item: number): IconSource | null {
  const cached = CACHE.get(item);
  if (cached !== undefined) return cached;

  const found = resolveUncached(item);
  CACHE.set(item, found);
  return found;
}

function resolveUncached(item: number): IconSource | null {
  const kind = machineKindForBoxedItem(item as ItemId);
  if (kind !== null) return resolveMachineIcon(kind as number);

  const spec = itemSpec(item as ItemId);
  if (spec === null) return null;

  return lookup(`item_${frameSlug(spec.slug)}`, ITEM_ALIASES) ?? cropIcon(item);
}

/** The CSS that paints one atlas rectangle into a square box. Every number an integer. */
export interface IconPaint {
  /**
   * The magnification. A whole number when the frame fits, and otherwise an exact reciprocal
   * power of two — never 0, so a sprite is never scaled away to nothing.
   */
  readonly scale: number;
  /** Letterbox padding, in painted pixels. Negative when the frame is wider than its box. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly backgroundImage: string;
  readonly backgroundPosition: string;
  readonly backgroundSize: string;
}

/**
 * Fit an atlas rectangle into a `boxPx` square: integer scale, centred, never stretched.
 *
 * THE WHOLE JOB IS NOT STRETCHING. Item frames are 32×32 and machine frames are 64×64 — except
 * the Bottler, which is 96×64. A box that set `background-size: 100% 100%` would squash that
 * Bottler by a third on one axis, and squashed pixel art is the single loudest way to say the UI
 * was not built for the game it is sitting on. So the scale is `floor` of what fits on the
 * TIGHTER axis and the slack becomes padding on the other one.
 *
 * The consequence, stated plainly because it is visible: a 32px item in a 48px box is drawn 1×
 * and a 64px machine in the same box is drawn ½, so machines are physically smaller in the grid
 * and their pixels are finer. The alternative is fractional scaling, and a pixel game does not
 * get to have blurry inventory icons.
 *
 * A FRAME TOO BIG FOR ITS BOX HALVES UNTIL IT FITS. It used to keep 1× and centre-CROP, on the
 * stated grounds that an oversized frame "cannot happen at the sizes this HUD uses" — the
 * Bottler needed 48px and the smallest box was the pouch's 32. Doubling the art to 32px tiles is
 * exactly the event that falsified that: every machine frame is 64×64 now, the Bottler is 96×64,
 * and the boxes below it are CSS pixels that did not move and should not. Under the old rule
 * every machine crate in the bag, the shop and the build menu would have shown the middle
 * quarter of itself, which is a worse picture than a small one.
 *
 * HALVING IS THE ONE DOWNSCALE THAT IS NOT A BLUR. At ½ with `image-rendering: pixelated` the
 * browser takes every other source pixel — which is, near enough, the 16px frame this art was
 * baked from. Any other ratio re-samples and the grid goes soft, so the ladder is 1, ½, ¼ and
 * stops: a quarter fits the widest frame in the game into the smallest box in the HUD.
 *
 * The box sizes themselves are deliberately untouched. They are CSS pixels, the HUD is CSS
 * pixels, and the tile bump has no opinion about how big a bag slot should be.
 */
export function paintIcon(source: IconSource, boxPx: number): IconPaint {
  const scale = fitScale(source, boxPx);

  // `floor`, not a halved remainder rounded: a half-pixel offset re-samples the whole sprite and
  // undoes `image-rendering: pixelated` in one line.
  const offsetX = Math.floor((boxPx - source.width * scale) / 2);
  const offsetY = Math.floor((boxPx - source.height * scale) / 2);

  return {
    scale,
    offsetX,
    offsetY,
    backgroundImage: `url(${ATLAS_IMAGE_URL})`,
    // The page is scaled up whole and then slid so the wanted rectangle lands in the box. Both
    // halves must use the SAME scale or the sprite drifts by a few pixels per hundred — which
    // looks like slightly wrong art rather than like a bug, and is the reason this is tested.
    // `round` is a no-op at every whole scale and is only ever reached below 1×, where a frame
    // parked at an odd x on the page would otherwise slide the whole atlas by half a CSS pixel —
    // which re-samples the icon, which is the one thing this module exists to prevent.
    backgroundPosition: `${Math.round(offsetX - source.x * scale)}px ${Math.round(offsetY - source.y * scale)}px`,
    backgroundSize: `${ATLAS_SIZE.width * scale}px ${ATLAS_SIZE.height * scale}px`,
  };
}

/** Whole magnification while the frame fits, then halves — 1, ½, ¼ — and never 0. */
function fitScale(source: IconSource, boxPx: number): number {
  if (source.width <= 0 || source.height <= 0) return 1;

  const whole = Math.min(Math.floor(boxPx / source.width), Math.floor(boxPx / source.height));
  if (whole >= 1) return whole;

  let scale = 1;
  for (let step = 0; step < 2; step++) {
    scale /= 2;
    if (source.width * scale <= boxPx && source.height * scale <= boxPx) break;
  }
  return scale;
}
