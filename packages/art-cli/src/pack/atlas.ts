/** 1px gutter between frames. Cheap insurance against edge bleed at any zoom. */
const PADDING = 1;

export interface PackInput {
  id: string;
  group: string;
  width: number;
  height: number;
}

export interface PackedFrame extends PackInput {
  x: number;
  y: number;
}

export interface GroupBlock {
  group: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface AtlasLayout {
  width: number;
  height: number;
  frames: PackedFrame[];
  groups: GroupBlock[];
}

/**
 * Thrown when a group cannot fit one page. Plan §13 makes this a build-time contract rather
 * than a warning: belt items render through a ParticleContainer, every particle must share
 * one TextureSource, and a silent spill to page two breaks the batch *silently*. Failing the
 * build is the only version of this that a human ever finds out about.
 */
export class AtlasSpillError extends Error {
  constructor(
    readonly group: string,
    readonly offenders: string[],
    message: string,
  ) {
    super(message);
    this.name = 'AtlasSpillError';
  }
}

function nextPowerOfTwo(value: number): number {
  let n = 1;
  while (n < value) n *= 2;
  return n;
}

/** Shelf packer: sprites sorted tall-first, laid left to right, wrapping at maxWidth. */
function shelfPack(
  inputs: PackInput[],
  maxWidth: number,
): { frames: PackedFrame[]; width: number; height: number } {
  const sorted = [...inputs].sort((a, b) => b.height - a.height || a.id.localeCompare(b.id));
  const frames: PackedFrame[] = [];
  let cursorX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  let usedWidth = 0;

  for (const input of sorted) {
    const advance = input.width + PADDING;
    if (cursorX + input.width > maxWidth && cursorX > 0) {
      shelfY += shelfHeight + PADDING;
      cursorX = 0;
      shelfHeight = 0;
    }
    frames.push({ ...input, x: cursorX, y: shelfY });
    cursorX += advance;
    usedWidth = Math.max(usedWidth, cursorX - PADDING);
    shelfHeight = Math.max(shelfHeight, input.height);
  }

  return { frames, width: usedWidth, height: shelfY + shelfHeight };
}

/**
 * Packs every group into one page, each group occupying a contiguous horizontal band.
 * One page for the whole atlas means one TextureSource, which satisfies the
 * ParticleContainer constraint for every group at once.
 */
export function packAtlas(inputs: PackInput[], maxPage: number): AtlasLayout {
  const byGroup = new Map<string, PackInput[]>();
  for (const input of inputs) {
    if (input.width > maxPage || input.height > maxPage) {
      throw new AtlasSpillError(
        input.group,
        [input.id],
        `Sprite "${input.id}" is ${input.width}x${input.height}, larger than the ${maxPage}px page limit.`,
      );
    }
    const list = byGroup.get(input.group);
    if (list) list.push(input);
    else byGroup.set(input.group, [input]);
  }

  const frames: PackedFrame[] = [];
  const groups: GroupBlock[] = [];
  let pageWidth = 0;
  let cursorY = 0;

  for (const group of [...byGroup.keys()].sort()) {
    const members = byGroup.get(group) ?? [];
    const block = shelfPack(members, maxPage);

    if (block.height > maxPage) {
      throw new AtlasSpillError(
        group,
        members.map((m) => m.id),
        `Atlas group "${group}" needs ${block.width}x${block.height} and cannot fit a single ` +
          `${maxPage}x${maxPage} page. Sprites in this group: ${members.map((m) => m.id).join(', ')}.`,
      );
    }
    if (cursorY + block.height > maxPage) {
      const offenders = members.map((m) => m.id);
      throw new AtlasSpillError(
        group,
        offenders,
        `Atlas spilled to a second page when adding group "${group}": it needs ${block.height}px ` +
          `but only ${Math.max(0, maxPage - cursorY)}px remain on the page. Sprites that pushed it over: ` +
          `${offenders.join(', ')}. Every group must share one page — a ParticleContainer ` +
          `batch breaks silently otherwise (plan §13).`,
      );
    }

    for (const frame of block.frames) frames.push({ ...frame, y: frame.y + cursorY });
    groups.push({
      group,
      x: 0,
      y: cursorY,
      width: block.width,
      height: block.height,
      count: members.length,
    });
    pageWidth = Math.max(pageWidth, block.width);
    cursorY += block.height + PADDING;
  }

  const usedHeight = Math.max(0, cursorY - PADDING);
  return {
    width: nextPowerOfTwo(Math.max(1, pageWidth)),
    height: nextPowerOfTwo(Math.max(1, usedHeight)),
    frames: frames.sort((a, b) => a.id.localeCompare(b.id)),
    groups,
  };
}
