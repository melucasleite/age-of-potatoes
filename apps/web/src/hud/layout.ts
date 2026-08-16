// The one number the HUD and the canvas agree on: how wide the docked sidebar is.
//
// LEAF MODULE, LIKE `cadence.ts` — `GameCanvas` imports this to offset the canvas
// container, and importing the `@/hud` barrel from the game chunk would drag the whole
// React tree along to obtain one integer.
//
// WHY 440, MEASURED RATHER THAN GUESSED ([[069]]). The number was sized around the bag's
// 6-column grid (390px + padding + scrollbar) when the bag was a dock section. Item 089
// floated the bag out of the dock, but the width DOES NOT move with it: the canvas is
// `calc(100vw - this)` and the renderer's pixel-snap discipline ([[026]]) depends on the
// width never breathing — resizing the dock because a panel left it would resize the whole
// stage. Everything still in the dock reflows comfortably below 440: the tech tree drops
// to two branch columns, the shop's rows wrap, the field card stretches to fit.
//
// CONSTANT, NEVER RESPONSIVE. The canvas is `calc(100vw - this)` and the renderer resizes
// exactly once per real layout change ([[026]]'s pixel-snap discipline survives because
// the width never breathes). A sidebar that resized itself would be a floating menu with
// extra steps — the item's words, and the point of the whole relayout.
export const SIDEBAR_WIDTH_PX = 440;
