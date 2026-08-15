// The one number the HUD and the canvas agree on: how wide the docked sidebar is.
//
// LEAF MODULE, LIKE `cadence.ts` — `GameCanvas` imports this to offset the canvas
// container, and importing the `@/hud` barrel from the game chunk would drag the whole
// React tree along to obtain one integer.
//
// WHY 440, MEASURED RATHER THAN GUESSED ([[069]]). The widest thing that cannot reflow is
// the bag's grid: 6 columns × 60px cells + 5 × 6px gaps = 390px (`.invGrid`, and the
// column count is load-bearing — see `COLUMNS` in `Inventory.tsx`). Add the section's
// 12px padding each side (414) and room for a thin scrollbar, and 440 is the first tidy
// number with slack. Everything else reflows below it: the tech tree drops to two branch
// columns, the shop's rows wrap, the clipboard and field card stretch to fit.
//
// CONSTANT, NEVER RESPONSIVE. The canvas is `calc(100vw - this)` and the renderer resizes
// exactly once per real layout change ([[026]]'s pixel-snap discipline survives because
// the width never breathes). A sidebar that resized itself would be a floating menu with
// extra steps — the item's words, and the point of the whole relayout.
export const SIDEBAR_WIDTH_PX = 440;
