# Permanent save fixtures

**One real save is kept per released format version, forever. Nothing here is ever edited,
regenerated, or deleted.**

A hand-written fixture tests the migration you imagined. A real save tests the one you
shipped. These files are small, they never change, and they are the only thing that will
catch a migration bug in 2029 — by which point nobody will remember what a format-1 payload
looked like, and the code that wrote it will be long gone.

| File            | Format | Recorded             | World                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format-1.json` | 1      | 2026-08-12, `v0.1.0` | Seed 20260812, tick 32096. A sell bin, a sprinkler mid-cooldown with 12 L in the barrel, and a Chip Kitchen caught part-way through a bag.                                                                                                                                                                                                                                                                                          |
| `format-2.json` | 2      | 2026-08-12, `v0.2.0` | Seed 70707, tick 29100. The first save with a factory in it: seven machines, two belt segments with six items riding them, five grabber arms — three of them mid-swing holding a washed potato or a plain chip — a painted Grow Zone, and nine researched tech nodes.                                                                                                                                                               |
| `format-3.json` | 3      | 2026-08-12, `v0.4.0` | Seed 51015, tick 21306. The first save with plumbing in it: a drawn-down pond, a Pump on its bank, a seventeen-tile pipe run, and a Tank, two piped heads and an Irrigation Hub caught **mid-throttle** — demand 1,600 ml against a supply of 500, every consumer amber, the round-robin offset at 40, the Hub's scan cursor at 62, and both first-activation ceremonies already recorded.                                          |
| `format-4.json` | 4      | 2026-08-12, `v0.3.0` | Seed 90210, tick 3300. The first save with an errand in it, caught **mid-walk**: the farmer is 27 ticks into a harvest errand aimed at tile 11,11, four potatoes and five seeds in the bag, three plots still in the ground, and `moveAccum` stopped at 40 hundredths of a subtile.                                                                                                                                                 |
| `format-5.json` | 5      | 2026-08-12, `v0.6.0` | Seed 50505, tick 41837. The first save with maintenance and overcooking in it, caught deliberately **mid-brown**: a hand-built `Washer → Slicer → Fryer` line whose Fryer stands on a full basket of twenty chips, three of them already gone Rustic Style and the clock 250 ticks into a fourth, plus a Chip Kitchen run past the effect threshold and back to full by a single $8 repair kit, three inputs spoiled along the way. |
| `format-6.json` | 6      | 2026-08-12, `v0.4.0` | Seed 60606, tick 42400. The first save with the soda line in it, caught deliberately **mid-pour**: five single-liquid networks all part-full, every machine part-way through an operation, a Syrup Mixer holding kola powder with liquid in both inlets, and the Bottler's soda-syrup inlet flagged amber while its carbonated-water inlet runs fine.                                                                               |

`format-1.json` was produced by driving `step()` through a scripted play session — plant,
water, harvest, walk, sell, buy the sprinkler, feed the kitchen — and calling `serialize()`
on the result. It is a save the real code path wrote, not a payload someone typed. It stops
mid-everything on purpose: four crops still growing, a machine at 82 of 120 work-points, a
sprinkler 31 ticks from its next pour. A save taken at a tidy moment tests nothing.

`format-2.json` was recorded by replaying the `factory-line` golden fixture to tick 29,100 —
part-way through the run that feeds twenty potatoes through the line — and calling
`serialize()`. It stops mid-everything for the same reason format-1 does: goods in transit on
a belt and in an arm's hand are part of the world, and a save taken when the line is empty
would not prove they come back.

`format-3.json` was recorded by replaying the `water-works` golden fixture to forty ticks
after its last command and calling `serialize()`. That moment was chosen deliberately: every
buffer is still filling, so the ledger is genuinely over-demanded and all three consumers are
flagged amber. A pipe network at rest has a supply accumulator of zero, an idle rotation, and
full tanks — it would round-trip perfectly while proving almost nothing. The interesting
fields are the ones that only exist mid-flight: `supplyAccum`, `rrOffset`, `throttled`, and
the Hub's `scanCursor`.

`format-4.json` was recorded by replaying the `walk-errands` golden fixture to tick 3,300 and
calling `serialize()`. The moment is the whole point of the file: a pending `PlayerIntent` is
the only thing a format-4 payload has that a format-3 one does not, and it exists **only in
flight**. A save taken between errands would carry `intent: null`, round-trip perfectly, and
prove nothing at all — so this one is caught 27 ticks into a harvest walk, with part of the
crop already picked and the rest still standing, and `moveAccum` mid-fraction so a reload that
rounded the farmer's position would show up as drift rather than as nothing.

`format-5.json` was recorded by driving `step()` through a long scripted session — hand-farm,
buy the monolith, run it into the worn regime, research the fabrication branch, build and
hand-feed the three-machine line — and calling `serialize()` at a moment chosen for one reason:
`blockedTicks` and `overcookedCount` **exist only in flight**. They are non-zero exactly when a
machine is stopped with nowhere to put its output, which is a layout condition rather than a
timer, so a save taken with an empty Fryer would carry two zeroes, round-trip perfectly, and
prove nothing about the feature it was added for. This one is caught with the basket browning
and the clock mid-count — neither at zero nor at the interval, because a clock that reloaded to
either end would hand the player a free reset or charge them a chip for closing the tab.

## When the test fails

`test/save.test.ts` loads this file, migrates it, deserializes it, and asserts the resulting
state hash. If that assertion fails, exactly one of two things happened:

1. **The save format changed and a migration is missing.** Write the migration, append it to
   the chain in `src/save/migrations.ts`, bump `CURRENT_FORMAT_VERSION`, and add a new
   fixture for the new version. This file keeps its old expectation — after migration it must
   still produce a world, and the hash it produces now is whatever the migration makes of it.
2. **Determinism broke.** Something in the sim stopped being reproducible. Find it.

**Fixing the expectation to match the new output is not on that list.** Doing so converts a
caught bug into a silent one, which is the exact failure this directory exists to prevent.

`format-6.json` was recorded by replaying the `soda-line` golden fixture to tick 42,400 and
calling `serialize()`. The moment is chosen for one field in particular: **a single throttled
port on a machine whose other port is fine**. A machine-level `throttled` flag cannot express
that, which is exactly why ports carry their own — and a save taken with the line at rest would
round-trip perfectly while proving nothing about typed ports at all. Every machine is also
mid-operation, so a `progress` that came back at zero would show up here rather than as a free
restart nobody notices.
