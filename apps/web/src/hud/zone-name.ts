// What a typed zone name MEANS — the one place that decides it ([[108]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS IS A MODULE AND NOT THREE LINES INSIDE `NameField`. The bug was never the
//  arithmetic of a name; it was that the arithmetic had FIVE CALLERS and only one of them
//  ever ran. A zone name commits on Enter, on a real blur, on the pointer going down
//  anywhere else, on the panel closing, and on the player selecting a different zone — and
//  the shipped field committed on exactly one of those, because the other four never reached
//  the handler at all (see `NameField`'s note for the focus mechanism).
//
//  So the fix has two halves and they belong in different files. THIS half is "given what is
//  in the box and what the world says, what should be sent" — a question with one answer that
//  can be pinned without a DOM. The OTHER half is which gestures ask it, which is React
//  wiring and was verified in a browser with real mouse events.
// ────────────────────────────────────────────────────────────────────────────────────
//
// THE DRAFT IS THE WHOLE STATE MODEL, and it has exactly two values worth naming:
//
//   `null`  — the player is not editing. The box shows the world's name, character for
//             character, because it renders `zone.name` itself rather than a copy of it.
//   a string — the player has typed something and has not left yet.
//
// A commit ALWAYS returns the draft to `null`, whether it sent a command or not. That single
// rule is what makes the panel's second bug structurally impossible: the box can differ from
// the list row only while somebody is actively typing into it, never after they walk away.
// The shipped version kept a discarded draft on screen forever, so the panel showed `South
// Field` in the box and `North Field` on the row for the same rectangle.

import { clipZoneName } from '@snack/sim';

/**
 * What the name box shows.
 *
 * ONE SOURCE, AND THE FALLBACK IS THE SOURCE ITSELF. Not a copy taken at mount time — that is
 * what `defaultValue` was, and an uncontrolled field seeded once cannot notice the world
 * renaming a zone underneath it. When there is no draft this returns the very string the list
 * row prints, so "the box and the row disagree" is not a bug that can be introduced by getting
 * a later edit wrong; it is a state with no representation.
 */
export function zoneNameShown(draft: string | null, current: string): string {
  return draft ?? current;
}

/**
 * The name to send, or `null` for "send nothing".
 *
 * **EMPTY AND WHITESPACE KEEP THE OLD NAME.** The decision, and the reasons in order:
 *
 *   1. `applyRenameZone` refuses a zero-length name outright (`tick.ts`), so a blank commit was
 *      never going to reach the world. Inventing a generated default here would mean the panel
 *      and the reducer disagreeing about what a blank name means — the HUD would show `Zone 3`
 *      restored while believing it had set it.
 *   2. Blanking the box is what a player does when they mean to retype, and the most common way
 *      to leave it blank is to select-all, hit delete, and then get distracted. Deleting a name
 *      should be a thing you ask for, not a thing you time out into.
 *   3. There is no such thing as a nameless zone. `state.ts` mints `Zone {id}` at paint time and
 *      the swatch, the dock's picker and this panel's list all print the name; an empty one would
 *      be a blank button in three places.
 *
 * The old name is restored on screen by the caller returning the draft to `null`, which puts the
 * box back on `zone.name`. Nothing is sent and nothing enters the trace.
 *
 * TRIMMED THEN CLIPPED, in that order, and `clipZoneName` is the sim's own clipper imported
 * rather than reimplemented — so the field and the reducer agree about the 24th character, and a
 * name that is only spaces is `''` before anything else looks at it.
 */
export function zoneNameToCommit(draft: string | null, current: string): string | null {
  if (draft === null) return null;
  const name = clipZoneName(draft.trim());
  // An unchanged name is refused by `applyRenameZone` anyway; not sending it keeps a no-op out
  // of the trace, which is the same rule every other control in this panel follows.
  if (name === '' || name === current) return null;
  return name;
}
