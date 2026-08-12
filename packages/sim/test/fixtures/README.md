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

| Fixture             | Seed     |  Ticks | Guards                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-world.json`  | 20260812 |  1,000 | World generation and everything that advances with no player at all: moisture drain, the net-worth sampler, the clock.                                                                                                                                                                                                                                                                                                                   |
| `canary-1000.json`  | 1234     |  1,000 | Plan §17's canary — a fixed seed and fixed command list. The same script `sim.test.ts` pins inline, so they must agree.                                                                                                                                                                                                                                                                                                                  |
| `rng-streams.json`  | 424242   |  4,327 | Two plots in different corners, so `field-init`, `crop-growth`, and `harvest` have each advanced by a different amount. A change to stream derivation surfaces here instead of as quietly different crop rolls.                                                                                                                                                                                                                          |
| `all-verbs.json`    | 8123     | 22,967 | The original eleven `Command` variants, over a long session: hand-farming, a Chip Kitchen, a sprinkler, repairs, and a jam worn in over 130 operations and then whacked out.                                                                                                                                                                                                                                                             |
| `factory-line.json` | 70707    | 33,389 | A full era-1-to-era-2 run: hand-farms for cash, researches the fabrication branch and the Workshop Charter, builds `Washer → belt → belt → Slicer → Fryer → Seasoner → Bagger` with five grabber arms, paints and renames a Grow Zone, buys a Speed dial, and runs twenty potatoes all the way to twenty bags. Guards the whole factory: belt movement and hand-off, grabber swings, tech gating, upgrade arithmetic, and zone painting. |
| `withering.json`    | 31337    | 60,212 | Six potatoes planted and abandoned. Ticks past the 30-active-minute grace, past the wilting window, through a Day-Old harvest, and on to the compost collapse. Guards the entire withering timeline and the rule that no path out of a crop tile pays zero.                                                                                                                                                                              |

`golden.test.ts` asserts that the set as a whole covers every `Command` variant, and
`REQUIRED_COMMAND_COVERAGE` in `test/goldens.ts` is typed so that adding one more variant to
the union fails `yarn typecheck` until a fixture exercises it. That is deliberately annoying:
a verb no fixture applies is a verb the determinism gate does not guard.

The two factory fixtures were authored by scripting a bot against `step()` and dumping the
world's own `state.trace` — so every command in them is one that actually applied, not one
that was attempted and silently rejected.

## What is deliberately not here

- **No cross-runtime job.** Plan §12 skips running the sim under a second runtime: it
  validated a server-side replay validator that is no longer being built (§10.9 makes
  leaderboards fun and lightly validated). Do not add a Deno leg to CI.
- **No performance gate.** The 5,000-item trip-wire in plan §13 is a manual check at minor
  versions. It needs a real GPU and a real screen; a headless runner would only produce a
  number nobody can trust.
- **No coverage thresholds, no mutation testing, no browser tests.** The gate is typecheck,
  lint, build, and these fixtures. That is the whole thing.
