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
 * Whether a strip genuinely carries a wilted frame, or only clamps politely.
 *
 * A crop's growth frames are `stageCount - 1` cells (stage 5 is "ready", drawn with the
 * last growth frame plus the ready mark), so a strip with `stageCount` cells has one frame
 * PAST the growth run — the withered plant, generated in the same call as the living one
 * (item 021, §15's one-strip rule). A four-cell strip asked for that frame would clamp to
 * its last growth cell and return the mature plant — a real texture, the wrong picture —
 * which is why the caller must ask this question rather than just requesting the frame.
 */
export function stripHasWiltCell(cells: number, stageCount: number): boolean {
  if (stageCount <= 0) return false;
  return cells >= stageCount;
}
