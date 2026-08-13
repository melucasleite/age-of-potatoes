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

| Fixture               | Seed     |  Ticks | Guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-world.json`    | 20260812 |  1,000 | World generation and everything that advances with no player at all: moisture drain, the net-worth sampler, the clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `canary-1000.json`    | 1234     |  1,000 | Plan §17's canary — a fixed seed and fixed command list. The same script `sim.test.ts` pins inline, so they must agree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `rng-streams.json`    | 424242   |  4,327 | Two plots in different corners, so `field-init`, `crop-growth`, and `harvest` have each advanced by a different amount. A change to stream derivation surfaces here instead of as quietly different crop rolls.                                                                                                                                                                                                                                                                                                                                                                                    |
| `all-verbs.json`      | 8123     | 22,967 | The original eleven `Command` variants, over a long session: hand-farming, a Chip Kitchen, a sprinkler, repairs, and a jam worn in over 130 operations and then whacked out.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-line.json`   | 70707    | 33,389 | A full era-1-to-era-2 run: hand-farms for cash, researches the fabrication branch and the Workshop Charter, builds `Washer → belt → belt → Slicer → Fryer → Seasoner → Bagger` with five grabber arms, paints and renames a Grow Zone, buys a Speed dial, and runs twenty potatoes all the way to twenty bags. Guards the whole factory: belt movement and hand-off, grabber swings, tech gating, upgrade arithmetic, and zone painting.                                                                                                                                                           |
| `withering.json`      | 31337    | 60,212 | Six potatoes planted and abandoned. Ticks past the 30-active-minute grace, past the wilting window, through a Day-Old harvest, and on to the compost collapse. Guards the entire withering timeline and the rule that no path out of a crop tile pays zero.                                                                                                                                                                                                                                                                                                                                        |
| `water-works.json`    | 51015    | 25,267 | The liquid layer end to end: a Pump on the pond bank, a seventeen-tile pipe run drag-routed around the field and a second one torn straight back up, then a Tank, two piped heads and an Irrigation Hub hung off the survivor — deliberately more demand than one pump can meet. Guards the one-ledger flow model, the round-robin throttle, and the geometric network ids.                                                                                                                                                                                                                        |
| `idle-wear.json`      | 606060   | 14,465 | Plan §4's absolute rule, as a pinned world: wear is per operation and **never** per second. Hand-farms two rows of potatoes, buys a Chip Kitchen, and then never touches it again for ten thousand ticks. The kitchen completes no operations, so it must end at full condition — a machine that aged on the clock shows up here as a changed hash, and `factory.test.ts` reads this fixture back and says so in words.                                                                                                                                                                            |
| `maintenance.json`    | 404040   | 40,294 | The worn regime, end to end. Feeds a Chip Kitchen batch after batch until wear drops it below the effect threshold, at which point it runs at half speed, jams every tenth operation, and spoils an input on a cadence — ten spoiled potatoes and five jams whacked out, every one of them a consequence of work done rather than a roll. Ends with one $8 repair kit bought at the bin and spent on the cell, restoring it to full in a single use.                                                                                                                                               |
| `soda-line.json`      | 60606    | 43,838 | The soda line end to end, and the first fixture with a second product in it: a potato economy is farmed up to $100 with two Chip Kitchens and a repair kit a cycle, the fabrication and hydraulics branches are researched through the Workshop Charter, and then a Juicer, Kettle, Syrup Mixer, Carbonator and 3x2 Bottler are built along the north strip across **five single-liquid networks**. Cane and kola go in one end, twenty bottles come out the other and sell at $16. Guards the multi-input recipe executor, typed liquid ports, outlet demand-pull, and the 1:1:1 finishing ratio. |
| `walk-errands.json`   | 90210    |  3,923 | Four corner plots planted, watered and harvested entirely by clicking out of reach, then sold at the bin the same way. Guards all four endings an errand has: arrival fires the verb through the ordinary reducer, a second click replaces a pending errand rather than queueing, a held direction abandons one mid-stride, and moving the sell bin out from under a repair errand strands it.                                                                                                                                                                                                     |
| `rotate-and-box.json` | 24680    | 48,792 | Rotation and boxing. A grabber placed facing north and turned three times round the compass; a Chip Kitchen given two Speed levels and a Capacity level, worn until it jams, whacked, repaired, then **boxed by errand** with forty bags and six potatoes still in it and put straight back down elsewhere for nothing — same dials, same invoice, money untouched. A second, plain kitchen is boxed **at the machine** and scrapped for exactly 40% of its $100 invoice. Ends holding two boxes of one kind at two different invoices, beside a Washer left mid-operation.                        |

`golden.test.ts` asserts that the set as a whole covers every `Command` variant, and
`REQUIRED_COMMAND_COVERAGE` in `test/goldens.ts` is typed so that adding one more variant to
the union fails `yarn typecheck` until a fixture exercises it. That is deliberately annoying:
a verb no fixture applies is a verb the determinism gate does not guard.

The two factory fixtures, `soda-line`, `walk-errands`, `idle-wear`, `maintenance`, and
`rotate-and-box` were authored by scripting a bot against `step()` and dumping the world's own
`state.trace` — so every command in them is one that actually applied, not one that was
attempted and silently rejected.

`soda-line` is the longest thing here that is not a waiting game, and most of its 43,838 ticks
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
`WALK_ERRAND_TIMEOUT_TICKS` is 600 ticks, which buys about 120 tiles of walking in a 16×16
world — it is a deadlock breaker for a future in which something can block a footstep, not a
number any honest fixture can reach today. A fixture contorted into triggering it would be
testing the contortion.

## What is deliberately not here

- **No cross-runtime job.** Plan §12 skips running the sim under a second runtime: it
  validated a server-side replay validator that is no longer being built (§10.9 makes
  leaderboards fun and lightly validated). Do not add a Deno leg to CI.
- **No performance gate.** The 5,000-item trip-wire in plan §13 is a manual check at minor
  versions. It needs a real GPU and a real screen; a headless runner would only produce a
  number nobody can trust.
- **No coverage thresholds, no mutation testing, no browser tests.** The gate is typecheck,
  lint, build, and these fixtures. That is the whole thing.
