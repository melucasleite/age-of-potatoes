# Permanent save fixtures

**One real save is kept per released format version, forever. Nothing here is ever edited,
regenerated, or deleted.**

A hand-written fixture tests the migration you imagined. A real save tests the one you
shipped. These files are small, they never change, and they are the only thing that will
catch a migration bug in 2029 — by which point nobody will remember what a format-1 payload
looked like, and the code that wrote it will be long gone.

| File            | Format | Recorded             | World                                                                                                                                                                                                                                                                 |
| --------------- | ------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format-1.json` | 1      | 2026-08-12, `v0.1.0` | Seed 20260812, tick 32096. A sell bin, a sprinkler mid-cooldown with 12 L in the barrel, and a Chip Kitchen caught part-way through a bag.                                                                                                                            |
| `format-2.json` | 2      | 2026-08-12, `v0.2.0` | Seed 70707, tick 29100. The first save with a factory in it: seven machines, two belt segments with six items riding them, five grabber arms — three of them mid-swing holding a washed potato or a plain chip — a painted Grow Zone, and nine researched tech nodes. |

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
