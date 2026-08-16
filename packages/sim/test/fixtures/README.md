# Golden fixtures

Each JSON file named in `FIXTURE_NAMES` (`test/goldens.ts`) is one pinned world: a seed, a
list of commands with the tick each was applied on, a tick count, and the state hash that
combination must produce. `golden.test.ts` replays them on every `yarn test` and on every
push and pull request.

## The rule

**A failing golden test has exactly two possible causes, and you must decide which one it is
before you touch anything.**

1. **You changed the simulation on purpose.** Regenerate, and **say so in the commit
   message** — which change, and why the new numbers are the right ones.

   ```bash
   yarn goldens:regen
   ```

2. **You changed it by accident.** You have just found the bug this test exists to find.
   Fix the simulation. Do not regenerate.

Never regenerate to turn a red build green without answering that question first. A golden
test that rewrites its own expectations is strictly worse than no test at all: it costs
runtime on every push and guarantees nothing.

`yarn goldens:regen` rewrites one line per fixture — the hash and nothing else — so a
regeneration is a small, obvious diff that a reviewer can spot and ask about. Running the
tests never rewrites a fixture, and CI never runs the regeneration script.

## The command lists are frozen

Only `expectedHash` is ever regenerated. The `commands` arrays are frozen input, recorded
once from a played session and committed. Do not rewrite them to make a fixture pass — a
command that the simulation now rejects is itself the finding, and it will show up as a
changed hash.

Adding a **new** fixture is fine and encouraged when a new system lands. Add its file, add
its name to `FIXTURE_NAMES` in `test/goldens.ts`, and generate its hash once.

## What each fixture is for

| Fixture               | Seed     |   Ticks | Guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-world.json`    | 20260812 |   1,000 | World generation and everything that advances with no player at all: moisture drain, the net-worth sampler, the clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `canary-1000.json`    | 1234     |   1,000 | Plan §17's canary — a fixed seed and fixed command list. The same script `sim.test.ts` pins inline, so they must agree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `rng-streams.json`    | 424242   |   4,479 | Two plots in different corners, so `field-init`, `crop-growth`, and `harvest` have each advanced by a different amount. A change to stream derivation surfaces here instead of as quietly different crop rolls.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `all-verbs.json`      | 8123     |  30,070 | The original eleven `Command` variants, over a long session: hand-farming, a Chip Kitchen, a sprinkler, repairs, and a jam worn in over 130 operations and then whacked out.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `factory-line.json`   | 70707    |  43,795 | A full era-1-to-era-2 run: hand-farms for cash, researches the fabrication branch and the Workshop Charter, builds `Washer → belt → belt → Slicer → Fryer → Seasoner → Bagger` with five grabber arms, paints and renames a Grow Zone, buys a Speed dial, and runs twenty potatoes all the way to twenty bags. Guards the whole factory: belt movement and hand-off, grabber swings, tech gating, upgrade arithmetic, and zone painting.                                                                                                                                                                        |
| `withering.json`      | 31337    |  60,212 | Six potatoes planted and abandoned. Ticks past the 30-active-minute grace, past the wilting window, through a Day-Old harvest, and on to the compost collapse. Guards the entire withering timeline and the rule that no path out of a crop tile pays zero.                                                                                                                                                                                                                                                                                                                                                     |
| `water-works.json`    | 51015    |  36,425 | The liquid layer end to end: a Pump on the pond bank, a seventeen-tile pipe run drag-routed around the field and a second one torn straight back up, then a Tank, two piped heads and an Irrigation Hub hung off the survivor — deliberately more demand than one pump can meet. Guards the one-ledger flow model, the round-robin throttle, and the geometric network ids.                                                                                                                                                                                                                                     |
| `idle-wear.json`      | 606060   |  19,004 | Plan §4's absolute rule, as a pinned world: wear is per operation and **never** per second. Hand-farms two rows of potatoes, buys a Chip Kitchen, and then never touches it again for ten thousand ticks. The kitchen completes no operations, so it must end at full condition — a machine that aged on the clock shows up here as a changed hash, and `factory.test.ts` reads this fixture back and says so in words.                                                                                                                                                                                         |
| `maintenance.json`    | 404040   | 100,090 | The worn regime, end to end. Feeds a Chip Kitchen batch after batch until wear drops it below the effect threshold, at which point it runs at half speed, jams every tenth operation (four whacked out), and spoils an input on a cadence (eight wasted) — every one a consequence of work done rather than a roll. Ends with one $8 repair kit bought at the bin and spent standing by the kitchen, restoring the cell to full in a single use. Re-recorded 2026-08-14 and again 2026-08-15 by `scripts/record-maintenance.ts`; `factory.test.ts` replays it watching, so the story cannot silently die again. |
| `soda-line.json`      | 60606    |  54,577 | The soda line end to end, and the first fixture with a second product in it: a potato economy is farmed up to $100 with two Chip Kitchens and a repair kit a cycle, the fabrication and hydraulics branches are researched through the Workshop Charter, and then a Juicer, Kettle, Syrup Mixer, Carbonator and 3x2 Bottler are built along the north strip across **five single-liquid networks**. Cane and kola go in one end, twenty bottles come out the other and sell at $16. Guards the multi-input recipe executor, typed liquid ports, outlet demand-pull, and the 1:1:1 finishing ratio.              |
| `walk-errands.json`   | 90210    |   4,018 | Four corner plots planted, watered and harvested entirely by clicking out of reach, then sold at the bin the same way. Guards all four endings an errand has: arrival fires the verb through the ordinary reducer, a second click replaces a pending errand rather than queueing, a held direction abandons one mid-stride, and moving the sell bin out from under a repair errand strands it.                                                                                                                                                                                                                  |
| `rotate-and-box.json` | 24680    |  57,562 | Rotation and boxing. A grabber placed facing north and turned three times round the compass; a Chip Kitchen given two Speed levels and a Capacity level, worn until it jams, whacked, repaired, then **boxed by errand** with forty bags and six potatoes still in it and put straight back down elsewhere for nothing — same dials, same invoice, money untouched. A second, plain kitchen is boxed **at the machine** and scrapped for exactly 40% of its $100 invoice. Ends holding two boxes of one kind at two different invoices, beside a Washer left mid-operation.                                     |

| `land-deeds.json` | 480480 | 13,131 | The lot growing. Two full hand-farmed cycles pay for the deed to parcel 1 at $200, and then a Chip Kitchen and a Sprinkler go down east of tile 16 — ground that did not exist to build on a release ago. Guards `BuyDeed`, the ownership gate every placement verb shares, the sorted parcel list in the hash, and land on the net-worth books. |
| `depot-run.json` | 320320 | 382,391 | Selling without you. Farms a potato economy up from $50 through the Workshop Charter, the Belts node and Trucking, then builds `Chip Kitchen → grabber → Truck Depot`, signs a standing route for bagged chips, tears a second one up, hand-loads a delivery cart and sends it. **Ends with 5,000 commandless ticks** — no player input of any kind — in which four truck runs and one cart arrive, the money goes up by $560, and every manual touch counter stays exactly where it was. That last window is the whole fixture; `test/commerce.test.ts` replays to its boundary and asserts the counters are frozen across it. |
| `the-farm.json` | 90210 | 67,284 | The farm release end to end: soil under the crops, a push-scythe cutting three tiles a swing, a crate bought and packed, a hand cart hitched, dragged and parked, a bag of goods left to spoil into Compost, and that Compost composted into Fertilizer and worked back into the ground. Pins the whole spoilage loop — nothing in it ends at zero value — and the assisted tier that softens it. |
| `worn-to-zero.json` | 515151 | 24,024 | Item 034's third wear fixture: a Chip Kitchen driven from full condition to zero by honest work — jams whacked out on the way down, never repaired — until it halts and sits dead losing nothing further, then is restored to full by free hand repair alone (plan §1: "manual never rots"). `factory.test.ts` replays it watching and asserts the floor, the halt, the kit-free restoration. |
| `junction-loop.json` | 626262 | 39,230 | Item 024 instruction 11: the economy ground honestly up to the Splitters node, then a closed belt circuit through two junctions — one splitting one feed across two branches, one merging them back — with the bags circulating forever and both round-robin cursors advancing in the hash. `factory.test.ts` replays it watching and asserts the alternation and that goods reach every belt in the loop. |
| `the-till.json` | 660660 | 2,203 | The till tool (item 066): a strip of grass broken in one drag, farmed through a potato cycle, un-tilled, and re-tilled — coming back with identical soil and fertility, because the roll-once ledger remembers every position ever broken. Recorded by `scripts/record-the-till.ts`. |
| `mid-field.json` | 670670 | 5,779 | Machines on farm tiles (item 067): the gardener loop earns the $150 honestly, the farmer crosses the field on a no-op walk errand (item 070's `IntentAction.Walk`, absorbed here), a barrel sprinkler stands ON a hand-watered farm tile, and **three hauls from the pond — ten pours, ten, then four** — water all 24 farm neighbours and never its own feet, the second and third cycles walking past the ground the first one wet. Deconstruction hands the tile back untouched and the freed ground takes a seed again. Recorded by `scripts/record-mid-field.ts`, which asserts every beat — and the refusals (crop tile, non-flagged machine) — before writing; re-recorded 2026-08-16 for item 086's ten-charge sensing barrel. |

`depot-run` carries a field no other fixture has: **`handsOffFromTick`**, the tick after which it
issues nothing. It is not derivable from `commands` — the last command's tick is where the player
stopped _issuing_, not where the world went quiet — and it is what lets a test say "and then
nobody touched anything for five thousand ticks" rather than merely comment it. What the fixture
deliberately does **not** claim is seed-to-sold: nothing in this game harvests a crop for you, so
the kitchen's hopper is filled by hand immediately before the window opens. The link it proves is
production to money, which is the link work item 032 was asked for.

`golden.test.ts` asserts that the set as a whole covers every `Command` variant, and
`REQUIRED_COMMAND_COVERAGE` in `test/goldens.ts` is typed so that adding one more variant to
the union fails `yarn typecheck` until a fixture exercises it. That is deliberately annoying:
a verb no fixture applies is a verb the determinism gate does not guard.

The two factory fixtures, `soda-line`, `walk-errands`, `idle-wear`, `maintenance`,
`rotate-and-box`, `land-deeds`, `worn-to-zero`, and `junction-loop` were authored by scripting
a bot against `step()` and dumping the world's own `state.trace` — so every command in them is
one that actually applied, not one that was attempted and silently rejected. `maintenance` is
the one whose recorder is committed (`scripts/record-maintenance.ts`), because it had to be
authored twice — see the 2026-08-14 note below.

`land-deeds` is the shortest of the bot-authored fixtures because the thing it pins is cheap to
reach: 391 commands and two farming cycles buy the first deed on plan §4's curve, which is the
point — the first parcel is meant to be an hour of early income, not a milestone. What it
cannot show is the refusals, because a refused command appends nothing to the trace; those live
in `test/parcels.test.ts`, which is also where the fit arithmetic for item 053's acceptance
criterion is.

`soda-line` is the longest thing here that is not a waiting game, and most of its 54,577 ticks
are the _economy_, not the soda: the tech chain up to `hydraulics-soda-mixing` costs $5,005 and
a Charter that wants 200 items sold, so the bot has to farm its way there before it can place a
Juicer. That ramp is not padding — a fixture that could not afford what it builds would have to
reach into `WorldState` to build it, and then it would no longer be replaying a game.

`idle-wear` is the only fixture whose point is what **fails** to happen, which makes it the one
most easily broken by accident: its last ten thousand ticks are deliberately commandless, and a
future fixture-tidying pass that "helpfully" gave the kitchen something to do would delete the
entire test while leaving it green.

`rotate-and-box` spends its first 35,000 ticks earning the right to exist, and that is not
padding either: a grabber needs the Belts node and a dial needs the Upgrade Bench, both of which
sit behind the Workshop Charter's 200 items sold and about $1,800 of research. The bot farms two
Chip Kitchens up to it. What happens afterwards is the whole point, and one detail of it was
found rather than written — the kitchen it upgrades wears itself into a **jam** on the way, and
the deconstruct refused it, which is the refusal working before anybody wrote a test for it. The
final moment is chosen the way every other save-worthy moment here is: two boxes of ONE item id
at two different invoices, which is the one thing a flat `{item, count}` slot cannot say.

`walk-errands` is deliberately short. Its job is branch coverage rather than endurance: the
long fixtures already prove the sim survives sixty thousand ticks, and what this one proves is
that an errand can end four different ways. **The timeout is not among them, and cannot be.**
`WALK_ERRAND_TIMEOUT_TICKS` is 1,200 ticks, which buys about 240 tiles of walking against a
64×64 lot whose longest honest crossing is 88 — it is a deadlock breaker for a future in which
something can block a footstep, not a number any honest fixture can reach today. A fixture
contorted into triggering it would be testing the contortion.

## What is deliberately not here

- **No cross-runtime job.** Plan §12 skips running the sim under a second runtime: it
  validated a server-side replay validator that is no longer being built (§10.9 makes
  leaderboards fun and lightly validated). Do not add a Deno leg to CI.
- **No performance gate.** The 5,000-item trip-wire in plan §13 is a manual check at minor
  versions. It needs a real GPU and a real screen; a headless runner would only produce a
  number nobody can trust.
- **No coverage thresholds, no mutation testing, no browser tests.** The gate is typecheck,
  lint, build, and these fixtures. That is the whole thing.

## 2026-08-13: re-timed for the eight-pour can

Item 009's ruling restored the 8-pour watering can, and every session recorded under the
infinite can ran dry on its ninth pour — which would have collapsed the recordings' economies
and turned fixtures that guard belts, contracts and the soda line into fixtures that guard a
farmer clicking refusals. Following `c8f877d`'s precedent (**re-timed, not replaced**), the
fixture sessions were re-timed by `scripts/amend-goldens-for-can.ts`: the same verbs at the
same targets in the same order, plus the shore trips the new rule demands, with every
recorded wait preserved or lengthened and never shortened. `depot-run` additionally earns its
Truck Depot honestly — the amended session farms on past the recording's end until the
deferred purchases are affordable — and its hands-off window still contains a departure, the
road, and the payout. `empty-world`, `canary-1000` and `withering` water eight times or fewer
and are byte-identical to their recordings; only their hashes moved (the can counter, the
ledgers and the format bump are all inside the digest).

## 2026-08-14: `maintenance` re-recorded — a hash cannot pin a story

The re-timing above had one casualty the hashes could not show. `maintenance`'s slower
amended economy could not afford the Chip Kitchen at its recorded moment, so the amender
deferred the `PlaceMachine` and — never affordable in a session whose tail merely waits —
appended it at the second-to-last tick as a recorded refusal. The fixture stayed hash-stable
and green while every feed, jam-whack, and kit use in it replayed against a machine that did
not exist yet: a zombie that guarded nothing item 034 asked it to guard.

The repair is a **new recorded session**, `scripts/record-maintenance.ts` (same seed, same
story, committed as provenance), which refuses to write the file unless the story provably
happened — threshold crossed, inputs wasted, jams whacked, kit consumed, condition restored.
And because "the hash matches" and "the story happened" are different claims, the wear and
junction fixtures now also have watching replays in `factory.test.ts` ("fixture stories")
that assert the latter directly.

## 2026-08-15: re-timed for the removed armful cap

Item 068's owner ruling removed `ARMFUL_CAP_ITEMS` outright, and every session recorded
under the twelve-item armful had the cap's rhythm baked in: harvest errands that were
refused with full hands now succeed on the spot, the crop timeline shifts under the recorded
watering, and the early economies run differently. Eleven fixture hashes were regenerated
for that one cause (`empty-world`, `canary-1000`, `withering`, `idle-wear`, `the-farm`,
`worn-to-zero`, `the-till`, and `mid-field` replay identically and did not move — their
sessions never leaned on the cap). Two needed more than a re-pin:

- **`maintenance`** re-timed past its recorded feeds; re-run `scripts/record-maintenance.ts`
  (same seed, same story, story asserted before writing).
- **`depot-run`** reached its Chip Kitchen purchase short of money, which shifted every
  later machine id out from under the trace and silenced the hands-off window. Re-timed by
  `scripts/amend-depot-for-armful.ts` on the can amender's precedent: arc-critical commands
  deferred in recorded order until the same economy catches up, and — because idle ticks
  mint no money — a drain phase that sells the un-capped session's surplus and runs ordinary
  gardener passes until the deferred Trucking research and Truck Depot are affordable. Its
  hands-off window still contains the runs, the money, and the frozen touch counters, and
  the amender asserts all three before writing.

The barrel sprinkler's tank also grew from 30,000 to 36,000 ml in the same wave (item 067:
a mid-field 5×5 is 24 pours, and a 20-pour barrel would water the same first twenty tiles
forever) — measured against the fixture set, that change alone moved **no** hashes: no
recorded session refills a barrel sprinkler.

## 2026-08-15 (wave 11): the solid pond, the polite refusal, the deep can, and the counted cheat

Four sim changes landed in one wave, and every fixture hash moved for at least one of them:

- **Item 073** — `CAN_CHARGES_MAX` 8 → 20 (owner ruling). Every fresh world's hashed
  `player.canCharges` starts at 20, so ALL nineteen hashes move for this alone. Recorded
  refills top up a fuller can and draw honestly less; a recorded `RefillCan` on a can the
  wider cap left full refuses harmlessly (`worn-to-zero` carries three such beats).
- **Item 075** — the `Cheat` command and the hashed `WorldStats.cheatsUsed` counter (save
  format 14). The digest gained a field, which moves every hash again. No fixture applies
  the command — see `GOLDEN_COVERAGE_EXEMPT` in `test/goldens.ts` for why, and what pins it
  instead.
- **Item 081** — a fully saturated tile now refuses the hand pour: no charge, no pour
  signal, no trace entry. Recorded pours that land on a tile at exactly `MOISTURE_MAX`
  replay as deterministic refusals, spending nothing.
- **Item 080** — nobody walks on water. A divergence detector replayed all nineteen
  fixtures and found six whose sessions held a movement key through the pond's corner
  (`soda-line`, `rotate-and-box`, `depot-run`, `the-farm`, `worn-to-zero`,
  `junction-loop`). The farmer now stops at the bank, ends those runs displaced, and every
  errand walked from the displaced spot takes a different number of ticks.

What each diverger needed, on the re-timed-not-replaced precedent:

- **`the-farm`**, **`worn-to-zero`** — nothing but a re-pin: they replay green with their
  command lists frozen (zero refused beats; worn-to-zero's three full-can refill refusals
  are item 073's relaxation, kept as recorded refusals).
- **`depot-run`** — re-timed by re-running the committed `amend-depot-for-armful.ts`
  machinery against today's sim: the displaced timeline reached its purchases short of
  money, exactly the armful disease. The hands-off window still contains the runs, the
  money, and the frozen touch counters, asserted before writing.
- **`soda-line`**, **`rotate-and-box`**, **`junction-loop`** — re-timed by
  `scripts/amend-goldens-for-water.ts`, the can amender adapted for water: the same
  drift-shifted replay, proactive reach walks and refill trips, with every corrective walk
  SKIRTING the pond (the amender's own dead-reckoning obeys item 080), and deferred arc
  purchases retried PER-TYPE FIFO so a pipe waiting on a tech node cannot stall the
  research that legalises it. `soda-line`'s seven pipe beats — dead in the file since the
  can re-timing recorded them ahead of their deferred research — finally land, and its
  soda quartet builds again; the amender also buys `logistics-belts`, the prerequisite
  `hydraulics-soda-mixing` gained in a rebalance after the session was recorded.
  `rotate-and-box` keeps one unresolved `PlaceMachine` beat as a recorded refusal (its
  target tile is occupied in the re-timed session); every rotation, upgrade, boxing, and
  scrap beat the fixture exists to pin landed, and `factory.test.ts`'s watching replay
  agrees.

## 2026-08-16 (wave 12): the ten-charge sensing barrel

**Item 086** — owner ruling, 2026-08-15: _"the sprinklers should have charges, ten charges,
and they only should go watering if the tile needs it."_ Two sim changes in one:
`tankCapacityMl` on the barrel drops from 36,000 ml to `10 × SPRINKLER_POUR_ML` = 15,000, and
`moistureSensing` turns on for it, so a barrel cycle now skips any tile at or above
`MOISTURE_DRY_THRESHOLD` — spending nothing, marking no pour signal (item 081's rule), and
counting the skip the Hub's way. The Irrigation Hub and the piped heads are untouched: the
piped head keeps `moistureSensing: false` on purpose, because its indifference is what the Hub
is sold against.

**And a third change, added the same day after the owner played the first two.** Ten charges
do not cover twenty-four thirsty neighbours, so a barrel that restarted its top-left scan
every cycle watered the near rows and starved the far ones — reported from play as _"they
should be watering 5 by 5 around them, but it looks like it's only watering in front of
them."_ The barrel now resumes its sweep from `machine.scanCursor`, the field the Irrigation
Hub already owned: hashed, saved, and migrated since the Hub landed, so the fix costs no state
and no format bump. The piped head keeps the old fresh-start scan (`resumeScan: false`), which
is why nothing on a pipe moved.

**One hash moved out of nineteen, and it is the only fixture that ever refilled a barrel.**

| Fixture     | Old hash   | New hash   | Cause                                                                   |
| ----------- | ---------- | ---------- | ----------------------------------------------------------------------- |
| `mid-field` | `f042ed59` | `78041d16` | Re-recorded: one 24-pour cycle became three hauls of ten, ten and four. |

The other eighteen replay byte-identically with their command lists frozen. That is not luck
and it is the same fact the 2026-08-15 note recorded from the other direction — **no recorded
session outside `mid-field` refills a barrel sprinkler**, so a smaller barrel has nothing to
change: `all-verbs` and `land-deeds` both build one and neither ever hauls water to it.

`mid-field` was re-recorded rather than re-timed, because what item 086 broke was its
_story_, not its schedule. The fixture existed to watch a single cycle cross a full mid-field
5×5, and a ten-charge barrel cannot: the scan reaches ten tiles and stops, which is the exact
problem the 36,000 ml barrel was sized to paper over and which the resuming cursor above is
the real answer to. **Sensing alone was not**, and the first cut of item 086 claimed it was:
sensing skips WET tiles, and a patch that has dried out uniformly has none to skip, so the
head went back to the near rows every time. So the recorder now hauls three barrels and
asserts the split
(10, 10, 4), the head still never watering its own feet, and the skips on the books. The new
fixture is 5,779 ticks and 152 commands, up from 5,578 and 150 — two more `RefillHopper`
errands, which is precisely what the ruling costs the player.

## 2026-08-16 (wave 12, continued): the sell bin's belt door, and the seed that comes home

Two more sim changes landed in the same wave. One moved nothing at all; the other moved
everything, and the difference between them is the whole of what a format bump means.

### Item 087 — a grabber can feed the sell bin: **zero hashes moved**

`grabberPlace` gained a sell-bin door, so an arm pointed from a belt into the bin sells one unit
on arrival at list, through `sellAtBin` — the same money-and-ledger the hand's `SellItem` walks
through, extracted so a bin sale is booked in exactly one place however it arrived.

All nineteen fixtures replayed green with their command lists frozen BEFORE the seed work below
landed, which is the enumeration: **no recorded session has ever pointed an arm at the sell bin**,
so a new door on the bin has nothing to change in any of them. That was the item's own prediction
and it is confirmed by replay rather than by inspection. The behaviour is pinned instead by a
hands-free story test in `test/commerce.test.ts` (`a grabber pointed into the sell bin`): a Chip
Kitchen feeding a belt feeding an arm feeding the bin, stepped three thousand ticks with an empty
command list, money climbing and every touch counter frozen at zero.

### Item 088 — the auto-harvester brings back the seed: **all nineteen moved, and none of them behaved differently**

Save format 15 → 16. Every bot gained a seed pocket (`seedItem`/`seedCount`) and every machine
gained the harvester dock's seed shelf (`seedShelfItem`/`seedShelfCount`); all four are in the
digest, so every world in the repository hashes differently from the one before.

| Fixture          | Old        | New        |
| ---------------- | ---------- | ---------- |
| `empty-world`    | `2289b823` | `3966bd25` |
| `canary-1000`    | `ea1510a9` | `f34ea50f` |
| `rng-streams`    | `9e44ef68` | `c8a8029e` |
| `all-verbs`      | `e8df7724` | `1b07a880` |
| `factory-line`   | `ef3297b5` | `55f97d5d` |
| `withering`      | `f713bca7` | `30c1bbfd` |
| `water-works`    | `5033666b` | `e747d0a7` |
| `walk-errands`   | `82bf0b9c` | `d31b5b26` |
| `idle-wear`      | `9acfbcb8` | `4c9bb89c` |
| `maintenance`    | `4db7581f` | `7cb209cf` |
| `soda-line`      | `fa330702` | `7ff2ebce` |
| `rotate-and-box` | `b9b89c7e` | `f38c63c8` |
| `land-deeds`     | `aa334446` | `41e24bb8` |
| `depot-run`      | `f312adf4` | `710ac94a` |
| `the-farm`       | `60c29baf` | `f09b7451` |
| `worn-to-zero`   | `492ab7db` | `2e533b7b` |
| `junction-loop`  | `9734e50f` | `3606bfc7` |
| `the-till`       | `2b44adc3` | `03f8a035` |
| `mid-field`      | `78041d16` | `00db6dee` |

**Cause, for all nineteen: the digest, and nothing else.** Not one fixture in this set builds a
bot dock of any kind — checked, not assumed — so no recorded session owns a robot, no robot
pockets a seed, and not a single command in any of these files behaves differently than it did
yesterday. Nineteen worlds moved by four zeroes each. Every command list stayed frozen and every
fixture replayed green on the first try after `yarn goldens:regen`.

`mid-field`'s "old" hash above is item 086's re-recording from earlier in this same wave, not the
`f042ed59` it carried into the day — see the previous section for that half.

Two inline goldens outside this directory moved for the same reason and carry the same note in
their own comments: `sim.test.ts`'s scripted canary (`ea1510a9` → `f34ea50f`, agreeing with
`canary-1000` as it must) and `maintenance-automation.test.ts`'s drone story (`ff316263` →
`b26e8c41` — that world DOES own a robot, but a repair drone harvests nothing and can pocket
nothing, so its four fields are zero too).

### The save fixtures

`format-16.json` is new, recorded by `scripts/record-format-16.ts`: format 15's session played one
beat further, until the dock holds a named harvest on the produce shelf AND named seeds on the
seed shelf — the one state no earlier format can express. Every older format fixture's migrated
hash moved with the digest and its `steps` array gained the 15 → 16 step; the files themselves
were not touched, which is the rule that makes them worth keeping.
