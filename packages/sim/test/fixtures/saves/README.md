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
| `format-7.json` | 7      | 2026-08-12, `v0.4.0` | Seed 24680, tick 48792. The first save with boxed machines in it, caught holding **two boxes of one item id at two different invoices**: a bare Chip Kitchen and a Speed-2/Capacity-1 one worn to 853 condition, in one slot, in canonical least-invested-first order. A Washer stands beside them part-way through an operation and a grabber faces west, three presses round from where it was placed.                            |
| `format-8.json` | 8      | 2026-08-13, `v0.4.0` | Seed 480480, tick 6721. The first save with **bought land** in it: two parcels owned, and a Chip Kitchen mid-operation plus a Sprinkler standing east of tile 16 — ground that did not exist to build on in format 7. Caught with two potatoes in the kitchen's hopper and six bags in its buffer.                                                                                                                                  |

| `format-9.json` | 9 | 2026-08-13, `v0.4.0` | Seed 320480, tick 17,949. The first save with **vehicles** in it, caught at a moment that exists for about two hundred ticks in the world's whole history: a delivery cart 212 ticks from home with eight bags aboard, a truck that left the depot moments ago with five more, one bag already on the depot floor for the next run — and **not a penny of it paid yet**. |

| `format-11.json` | 11 | 2026-08-13, `v0.4.0` | Seed 90210, tick 66,516. The first save with a **clock on the goods** and a **robot on the lot**: an Agri-Bot between the row and its dock with eight potatoes in its arms and 32 hundredths of a subtile banked in its walk, two heaps of potatoes on two different deadlines beside a heap of slices on a third, a hand cart in tow, and three soils under the field. |

| `format-10.json` | 10 | 2026-08-13, `v0.4.0` | Seed 320320, tick 22,929. The first save with a **belt junction** in it, caught mid-rotation: one bag already sent north and one sent east, four more riding the feed belt, and a Chip Kitchen 381 ticks into a run nobody has touched. |

| `format-13.json` | 13 | 2026-08-14, `v0.4.0` | Seed 660660, tick 1,980. The first save with **player-made farmland** in it, recorded by replaying the `the-till` golden to the gap between its un-till and its re-till. A 67-tile NON-RECTANGULAR field — three tilled tiles still standing north of the legacy rect, one already farmed bare with its fertility wear counted — and a 68-entry roll-once soil ledger holding one position **with no tile on it**: ground the world remembers but the map no longer shows, which is the one state no earlier format can express. |

`format-10.json` was recorded by replaying the `depot-run` golden fixture, then driving `step()`
through eight more commands — research the splitter node, move the depot out of the way, lay the
feed belt, drop a junction on the end of it, give it a branch on each of two faces, and hand-load
the kitchen with the seven potatoes the player happened to be carrying — and calling `serialize()`
380 ticks later. The moment is the point, as always: **a junction's cursors and a machine's
untouched clock are both mid-flight quantities.** A junction at rest has its cursors wherever they
last stopped and a machine with an empty hopper has a frozen clock, so a save taken with the line
idle would round-trip perfectly while proving nothing about the format it was written for. This one
is caught with `junctionOutCursor` at 2 — part-way round, having dealt north and then east — and
the kitchen still counting.

The 9 → 10 migration adds three machine fields and one stats field and translates nothing, for the
same reason 8 → 9 did: `MachineKind.BeltJunction` did not exist, so no format-9 save can name one,
and the untouched clock was never kept, so no format-9 world knows the answer. Zero is the fact
rather than the default, and `save.test.ts` asserts it on the real format-9 file rather than
claiming it in a comment.

`format-9.json` was recorded by replaying the `depot-run` golden fixture to tick 17,949 and
calling `serialize()`. The moment is the entire point of the file: `cargoCount`,
`runTicksRemaining`, `Contract.inTransit` and `Contract.phase` are all zero whenever nothing is
moving, so a save taken with the yard at rest would round-trip perfectly and prove nothing at all
about the format it was written for. `automatedGrossCents` is still 0 at this instant, which is
what makes the net-worth assertion beside it mean something: fourteen bags are somewhere between
a shed and a town, none of them are cash, and the books have to be carrying all fourteen.

It also caught a real bug on its first run. `MACHINE_KINDS` in `canonical.ts` is a hand-written
allowlist rather than a map over `MACHINE_SPECS` — deliberately, because an id space is permanent
save surface and deriving the guard from today's table would mean a kind retired in 2029 silently
stops loading. The cost of writing it down is that it can go out of date, and it had: the loader
refused every save with a delivery cart in it. There is now a test for exactly that.

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

`format-7.json` was recorded by replaying the `rotate-and-box` golden fixture to its last tick
and calling `serialize()`. The moment is chosen for the one fact a format-6 payload cannot
express: an inventory slot is no longer `{item, count}`, because a bare Chip Kitchen and a
maxed one are the **same item id and different machines**, and the dials, condition and invoice
that tell them apart live on the slot. A save holding one box would round-trip perfectly while
proving nothing about the list; a save holding two identical boxes would prove nothing about the
order they are kept in, which is what makes two worlds that boxed the same pair in opposite
sequences hash the same. So this one holds two boxes that differ on all five numbers.

It also carries the condition a machine was boxed at — 853, not 1000 — because that is the field
that keeps net worth from jumping when a worn machine goes in a box, and a fixture recorded at
full condition would not notice if it were quietly dropped.

`format-8.json` was recorded by replaying the `land-deeds` golden fixture to its last tick and
calling `serialize()`. The fact it exists to pin is that **ownership is a property of the world
rather than of the tiles it covers**: the payload carries `ownedParcels: [0, 1]` and nothing
else in the file says which land is whose, so a save that dropped or reordered that list would
restore a world with two machines standing on somebody else's grass — and every other
assertion in `save.test.ts` would still pass. The format 7 → 8 migration does not touch this
file at all — it was born on the 64-wide map — which is exactly why `format-3.json` is the one
that proves the network-id widening: it has seventeen pipes on it, laid when a row was sixteen
tiles long.

`format-11.json` was recorded by replaying the `the-farm` golden fixture — a genuinely played
world, with soil under its crops, freshness stacks in the bag, a hand cart in the yard and a
Composter that has run — and then putting on the lot the one thing no fixture can reach by
command: an **Agri-Bot**. The dock is gated on the Corporate Charter, whose milestone is 96,000
consecutive ticks of untouched work, so the dock, its zone and its bot were spawned directly and
the world stepped until the robot was genuinely between two places. That mixture is deliberate and
it is stated here rather than hidden: the played half is what makes the soil, the stacks and the
cart real, and the spawned half is the only way this format's newest entity gets into a permanent
file at all.

The moment is the point, as always. **A bot's position, its walk accumulator and a stack's
deadline are all mid-flight quantities.** A parked bot has a zero accumulator, a freshly filled bag
has exactly one stack, and a farm at rest would round-trip perfectly while proving nothing about
the format it was written for. This one is caught mid-stride with eight potatoes in its arms, two
potato heaps on two deadlines, and the player towing a cart while it happens.

The 10 → 11 migration is the widest in the chain — four items landed in one release — and almost
all of it is empty and zero for the usual reason: no format-10 save can name a bot, a hand cart or
a dock, because none of those existed. The two that are NOT defaults are worth knowing. Soil
becomes **loam** on every migrated tile rather than being rolled, because `growthTarget` is
computed from the soil at sowing and a half-grown crop's target was calculated at loam rates —
calling that tile clay afterwards would leave a crop whose target agrees with no soil at all. And
freshness is **computed to be generous**: every perishable stack comes back with its full window
ahead of it, measured from the tick the save was written, because the world that was saved had no
clock at all and time does not pass when nobody is playing.

| `format-12.json` | 12 | 2026-08-13, `v0.5.0` | Seed 812812, tick 11,000. The first save with the **eight-pour can** and the **receipt ledgers** in it, caught mid-morning of its second day: the can run EMPTY (the refusal state is the one worth pinning), a fresh crop watered and growing, one `salesByItem` row with its day snapshots taken at the first dawn, the short birth hour already closed in `hours`, and the open hour's mark counting from tick 8,400. |

The 11 → 12 migration adds the can's charge counter to the player and the sales/hour ledgers
to the stats, and translates almost nothing: the can arrives **full** (an infinite can and a
full one are indistinguishable at the moment of loading), and the ledgers arrive **empty** —
the world sold things and worked hours that were never recorded, and a migration must not
invent history. The one computed value is `dawnsSeen`, derived from the saved tick with
frozen calendar constants so that loading is never mistaken for a dawn. The open hour's mark
is taken at the load tick with the saved lifetime accumulators as its starting line, so the
first bucket a migrated world closes contains only what happened after the load.
