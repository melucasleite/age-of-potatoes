# @snack/sim

The deterministic simulation core of Snack Mogul.

Given the same seed and the same command sequence, N ticks produce the same `hashState()`
on every machine, every run, forever. Everything else in this repo is arranged around
keeping that true.

This package imports nothing, renders nothing, and knows nothing about time of day, the
browser, or the player's monitor.

## The rules

These are not style preferences. Each exists because breaking it causes a failure that is
silent, delayed, and expensive — a replay that diverges in 2029 with no way left to find
out when it started.

**No wall clock.** `Date` and `performance` are banned. Time is `state.tick`.

**No DOM.** `window`, `document`, `navigator`. The tsconfig has no `"DOM"` lib, so these
fail to typecheck here; that is the gate, and it must never be loosened to make something
compile.

**No `Math.random`.** Randomness comes from a seeded stream via `streamFor(state, systemId)`.
Cosmetic randomness — particle jitter, idle animation offsets, lamp flicker — lives in the
renderer and uses `Math.random` freely. A visual effect must never touch a sim stream.

**No transcendentals: `Math.sin/cos/tan/exp/log/pow`, and no `**`.** IEEE-754 guarantees
bit-exact `+ - * /` and `sqrt`; transcendentals are explicitly implementation-defined and
engines disagree in the last bits. If a system seems to need one, redesign it with an
integer table or a lookup curve.

**No `async`/`await`.** A tick that can await is a tick that can interleave.

**No `for...in`, and no reliance on object key order.** Integer-like keys sort ascending
while string keys keep insertion order, and that mixed rule will eventually reorder entity
iteration. Iterate sorted arrays, a `Map`, or `Object.keys().sort()`.

**No `enum`.** Node's native type stripping cannot execute them. Use an `as const` object
with a derived union type.

**Zero runtime dependencies, permanently.** The RNG is vendored into `src/rng.ts` precisely
so it cannot be upgraded out from under existing worlds — an "improved" generator arriving
by `yarn upgrade` would invalidate every seeded world. Do not replace it with a package,
and do not improve the algorithm now that worlds exist.

**Integer units only.** No floats in `WorldState`, in any hashed field, or in any command
payload. Money is cents. Positions are subtiles (`SUBTILE = 256`). Fluids are millilitres.
Machine progress is work-points. The argument is not paranoia about compilers: float
determinism holds only if the exact operation _sequence_ survives, so a routine cleanup
that reorders `(a * b) + c` silently breaks every stored replay. Integers make refactoring
safe, which is the actual requirement over a multi-year project.

Enforcement is `eslint.config.js` (`yarn workspace @snack/sim lint`) plus the DOM-free
`tsconfig.json`. The toolchain pins TypeScript 6 rather than 7 because typescript-eslint
cannot consume 7 yet and these rules are the enforcement mechanism.

## Using it

```ts
import { createWorld, createWorldView, hashState, step, view } from '@snack/sim';

const state = createWorld(seed);
const buffer = createWorldView(); // allocate once, reuse forever

// …inside the host's fixed-step loop:
step(state, { tick: state.tick, commands: drainCommands() });
render(view(state, buffer), alpha);
```

`step()` mutates `state` in place and returns nothing. Nothing outside this package may
mutate `WorldState` directly — send a `Command`.

`view()` returns **plain serializable data written into reused buffers, not references
into live state**. The result is valid only until the next `view()` call on that buffer; a
consumer that wants to keep a snapshot must copy it. Interpolated render positions are
write-only: they exist in the renderer, are never read back into the sim, never persisted,
and never hashed.

## Commands and the trace

Every state mutation enters through a `Command` applied at a specific tick. No debug
buttons, no direct setters, no out-of-band mutation.

Camera pan, camera zoom, hover, selection, and menu state are **not** commands and must
never become commands. Player movement is a **held direction**, never a position delta —
otherwise input frequency leaks into world state and a 144 Hz monitor walks faster.

**The walk-to errand is ONE command, and that is the whole reason it lives in here.** Clicking
a tile out of `HAND_REACH_SUBTILES` records a single `WalkAndAct`; the sim then walks the
farmer over the next hundred-odd ticks and fires the verb on arrival, appending nothing more.
The obvious shortcut — the input layer emitting `SetMoveDirection` until the player is close
enough, then the verb — was rejected twice over. It writes a direction change into the trace
every few ticks for every click, forever, and it makes how far the farmer walks depend on how
fast the browser happened to be running, which is the exact leak the held-direction rule above
exists to plug. Modelled as world state, where the farmer ends up is a function of
`seed + trace` like everything else.

**One errand at a time; a new click replaces it rather than queueing behind it.** Click three
tiles and do all three is a different feature with its own interface problems — what is the
order, how do you cancel the second one, what does the marker show — and none of them are
solved by letting `PlayerState.intent` become an array. Manual control always wins: touching a
movement key clears the errand on the same tick, including the release to `Direction.None`,
because a convenience feature that argues with a grabbed steering wheel is the thing that
makes this infuriating in other games.

**`WALK_ERRAND_TIMEOUT_TICKS` is a deadlock breaker, not a balance number.** Nothing in this
world is solid enough to walk into, so today the errand always arrives long before the ceiling
and no fixture can honestly reach it. It is there because an errand that can never complete is
a farmer who can never move again, and the day something finally blocks a footstep is the day
that stops being hypothetical.

`state.trace` is an append-only log of every command that actually applied, in application
order. **It is not dead anti-cheat code and must not be deleted as such.** Leaderboards are
only lightly validated. The trace is here because seed + trace is a bug report that
reproduces exactly — the single most valuable debugging asset a solo dev can have — and it
costs an append-only array.

## The factory

**The production line.** `Washer → Slicer → Fryer → Seasoner → Bagger`, each a machine with
its own input and output buffers, integer work-points, and per-operation wear. The canonical
ratio is **1:1:2:1:1** and the Fryer's doubled cycle time is deliberate — an under-fed line
leaves a Slicer visibly idle, and "build a second Fryer" is meant to be every player's first
ratio lesson, taught by a bored machine rather than by a compost pile. `test/factory.test.ts`
pins that ratio; do not "optimise" it.

The monolithic **Chip Kitchen** from v0.1 is still buildable, still needs no research, and
still turns a potato straight into a bag. It is strictly slower than the line, which is what
makes it the honest early-game answer rather than a legacy wart.

Machines are dispatched on `MachineSpec.role`, not on kind, so adding a converter is a data
change rather than an edit to `tick.ts`.

**There is one recipe executor, and a recipe is a list.** `MachineSpec.inputs` is a list of
`(item, count)` lines and `MachineSpec.ports` is a list of typed liquid ports; `advanceConverter`
reads both and knows nothing about which machine it is running. The chip line's rows are
one-line recipes, the six-pack's is one line with a count of six, and the Snack Combo's is two
lines. **Consumption is atomic** — every line or none — so there is no state in which a Bottler
has swallowed the bottle and is waiting for the syrup, and no half-consumed operation to
describe in a save. `machine.inputCounts` is parallel to `spec.inputs`, sized when the machine
is built and re-sized on load; the single `inputItem` field it replaced is gone rather than
kept beside it, because a general path with a legacy path beside it is two paths.

**The sell bin does not buy seeds.** `ItemSpec.sellable` is data, not a check on `purchasable`
— they are different facts and one item may eventually be both — and it exists because plan §4's
anti-softlock floor is that a harvested potato always hands a seed back. A bin that bought seeds
at list, from a stand that sells them at the same price, would turn a misclick into a world that
can no longer plant. The reducer refuses, and `InventoryView.sellable` carries the same fact
outward so the HUD greys the affordance rather than swallowing the click.

**Overcooking is a layout condition.** A Fryer that fills its output buffer stops dead — that
is demand-pull, the same stop that leaves a Slicer idle — but the basket it has already fried
is still in the oil. Every `OVERCOOK_BLOCKED_TICKS` of _continuous_ blockage one more chip
turns into **Rustic Style**, priced at exactly 70% of seasoned chips by arithmetic on the real
price rather than by a second literal that could drift. Burnt chips come out of the buffer
first, because they were at the bottom of the basket, and any pull resets the clock. There is
no roll anywhere in it: the cause is no belt off the Fryer, a grabber aimed elsewhere, or
nobody coming back — all things a player can see standing in front of the machine. One chip
per interval rather than the whole basket, so neglect is a slope you can watch rather than a
cliff you fall off.

**Maintenance wears per operation and never per second** (plan §4, stated as absolute).
Nothing degrades while idle, and a closed tab degrades nothing at all, because `step()` is the
only thing that moves any of it — `test/fixtures/idle-wear.json` pins exactly that. Below
`CONDITION_EFFECT_THRESHOLD` a machine halves its work rate, jams every Nth operation, and
spoils an input on a **cadence** whose period shortens as condition falls. Plan §4 calls that
last one a "waste chance"; plan §7 ruling 5 bans rolls, and a cadence is the only reading that
satisfies both. `effectiveWastePeriod()` in `upgrades.ts` is where that period is decided, and
it is the seam the Efficiency dial's waste half hooks into. At zero condition the machine
halts: it costs nothing, keeps its buffers, and never explodes. Hand repair is free forever;
a **repair kit** buys the walk rather than the repair, servicing every machine in
`REPAIR_KIT_RADIUS_TILES` in one use, and is refused rather than consumed when nothing in
range wants it.

**Belts.** A belt segment is a sorted list of `(distanceAlongBelt, itemTypeId)` — plan §13,
and load-bearing. Items are not entities: they have no ids and no renderer counterparts, and
the renderer derives particle positions from the list every frame. That is what makes
`ParticleContainer` (no interactivity, no children, no filters) survivable, because picking a
belt item is a sim-side lookup rather than a sprite hit-test. **Do not replace this with
per-item entities.** Segments are straight; corners are two segments meeting, and a head item
hands off to whatever belt starts where its own ends.

**Grabbers** are the only bridge between belts and machine buffers: an arm takes from the tile
behind it and puts into the tile ahead. A blocked arm stands there holding the item, which is
the readable version of "look downstream".

**Zones** are painted plans, not machines. Membership lives on the tile (`CropTile.zone`), so
a tile belongs to at most one zone and painting over a neighbour reassigns rather than
overlaps. **A drag is ONE command** — `CreateZone` and `PaintZone` carry a rect, so a
sixty-tile paint is one trace entry instead of sixty, which is what keeps replays small and an
eventual undo one step per player action. The auto-replant toggle is rejected by the reducer
until the seed hopper is researched: locked in the simulation, not just in the UI.

**Withering.** A matured tile accrues `readyAge`, one per tick, inside `step()` — so freshness
counts active factory minutes and nothing else, and a closed tab ages no crop because time
does not pass. Grace is ~30 active minutes, then a five-minute telegraphed droop, then the
crop turns and harvests as a **Day-Old** good at `floor(list / 2)`. Left longer it collapses
into **Compost** on the tile, which the player can still pick up. There is no path out of a
crop tile that pays zero, and there is no roll anywhere in it — a crop that wilted on a die
roll would teach nothing.

## The liquid layer

The physical grammar is exactly `RESERVOIR → (Pump) → pipes → [Tank] → machines`, and the
rules that keep it comprehensible matter as much as the feature does.

**Flow, not pressure** (plan §5). No pressure field, no per-segment fill level, no flow
solver anywhere. Each connected pipe network is **one ledger**: supply is the pump's rate
capped by what the source holds, demand is the sum of its consumers' draws, and the tick
divides one by the other. Demand ≤ supply and everyone runs; demand > supply and every
consumer is throttled **round-robin** and flagged amber. That is why routing a pipe is a
_puzzle_ — where does the pump go, how do I split the supply — rather than a _chore_ — why
is segment 41 empty. **If a change here starts wanting a solver, the model has been misread.**

**One pump and one liquid per network, enforced at placement.** Not warned about, not
resolved afterwards: `pipePathRefusal()` refuses the run that would create the situation and
returns a `BuildRefusal` code the renderer prints on the object. That single rule kills most
fluid-sim confusion. It is also why the **Recirculator feeds a Tank rather than the pipes** —
a second source injecting into a network would break the rule, and a tank is the sanctioned
way to add supply.

**Network ids are geometric, not sequential.** A network's id is the lowest row-major world
tile index among its pipes, so two worlds that built the same plumbing in a different order
hash identically and a pipe laid across the map cannot renumber anything. Membership is
recomputed **on edit only** by `rebuildNetworks()` — a full recompute, because a wrong
incremental update is a determinism bug that hides for weeks.

**Reservoirs are finite but never permanently dry.** ~20,000 L recharging 40 L/min, both
derived from `HAND_POUR_ML` in `data.ts` with the arithmetic written out. Draw it down and
the level falls and the shoreline recedes; leave it and it recovers. Pumps run at full rate
above 25%, **half below 25%**, and at empty they **sip at the recharge rate** — which falls
out of the tick order (recharge runs before the ledger) rather than needing a special case.

**`takeWater()` in `water.ts` is the one place water leaves a source and the one place
`stats.waterDrawnMl` moves.** Every draw goes through it: the can, a hand refill, a pump, and
anything added later. If two code paths could take water, plan §6's Dry County board would
already be wrong and nobody would notice for months. Its `WaterDraw.Shore` mode exists for
exactly one caller — **the watering can always fills at any shore at any level** (plan §4),
including an empty pond and a world with no pond at all. That and "reservoirs always recover"
are anti-softlock guarantees in plan §1's tradition, not balance numbers; `test/water.test.ts`
pins both and they must not be tuned away for tension.

**The watering ladder's top rung.** A piped sprinkler head is the barrel sprinkler with
plumbing — same pour, same period, same radius, it simply never needs filling. The
**Irrigation Hub** waters only tiles below `MOISTURE_DRY_THRESHOLD`, **the same threshold the
renderer draws cracked earth with**; there is exactly one definition of dry. Its scan is a
fixed slice of its coverage per tick from a cursor stored on the machine, so its cost never
scales with the field — and the cursor is world state rather than a module variable, because
module state is invisible to the hash and to saves.

**The tree and the dials.** `tech.ts` unlocks **verbs** (crops, machines, belt tiers, the
auto-replant toggle) and carries no numeric field anywhere in `TechNode`. `upgrades.ts` scales
**numbers** (Speed, Efficiency, Capacity) and unlocks nothing. That split is plan §3's
anti-double-dip rule, and it is enforced by the shapes themselves rather than by convention —
adding a "+20% fryer speed" node would require changing the `TechNode` interface, which is
exactly the friction the rule wants. `test/factory.test.ts` asserts the key set.

Gates are money-only except the three Charters, which add a _visible_ milestone read off a
counter the HUD already shows. There are no hidden behavioural gates.

**The Efficiency dial cuts wear and waste, and it is the expensive track.** Plan §3 specifies it
as reducing "both input waste and wear"; the wear half is `effectiveWear`, and the waste half is
`effectiveWastePeriod`, which **stretches the cadence** rather than lowering a chance — there is
no chance in it to lower. A machine just below the threshold spoils one input in seven, and one
in twelve with the dial maxed; at death's door, one in two becomes one in three. It never
reaches "never", for the same reason wear never reaches zero. Because it is now plainly the
strongest dial on a hard-run machine, `UPGRADE_COST_PERCENT_BY_DIAL` charges 150% of the shared
1x/2.5x/6x ladder for it — 5.7x the machine's price to max, against 3.8x for the other two.

## The soda line

Plan §5: the chip line is a **belt cathedral** and the soda line is a **pipe organ**. Same
machine code, same roles, same demand-pull, same wear — what is different is that the ingredients
arrive through pipes and a recipe may name several of them.

```
1 Sugar Cane       → Juicer     → 1000 ml cane juice
1000 ml cane juice → Kettle     →  250 ml simple syrup     (a reduction — hence the boil)
1 Kola Nut         → Grinder    → 1 Kola Powder
125 ml simple syrup + 125 ml water + 1 Kola Powder
                   → SyrupMixer →  250 ml soda syrup
750 ml water       → Carbonator →  750 ml carbonated water
250 ml soda syrup + 750 ml carbonated water + 1 Bottle
                   → Bottler    → 1 Soda ($16)
```

**A typed port is the whole enforcement mechanism.** `MachineSpec.ports` declares which liquid
each inlet accepts and which each outlet makes, and `pipePathRefusal()` refuses a run that would
present any other liquid to a machine that has ports at all — the same function, the same
`BuildRefusal` grammar, and the same "refused before it happens" as a two-pump network.
`liquidPlacementRefusal()` refuses the identical mistake made in the other order, dropping a
Carbonator onto a syrup main. Machines with no ports are invisible to the rule, so a water main
may still run past a Fryer.

**A liquid producer is a tank that fills itself, and it is not a pump.** An outlet port joins its
network exactly as a `Tank` does: it covers the shortfall of whatever draws on the other end, and
it never accepts surplus. That is how the whole line runs on the existing one-ledger model with
no second source anywhere — **a juice network has no pump on it at all**, so plan §5's "one pump
per network" is not stretched here, it is unspent. The Recirculator set the precedent a release
early: a producer pours into a tank, never into the pipes.

**Demand-pull is one rule, not two.** A Juicer whose outlet is full stops dead and eats nothing
more, exactly as a Fryer with a full basket does. An unplumbed press that quietly destroyed cane
would be a compost pile, which plan §4 rules out.

**The 1:1:1 is a volume, not a count.** One Syrup Mixer operation makes exactly the soda syrup
one Bottler operation drinks; one Carbonator operation makes exactly its carbonated water; all
three take the same time. So the three run in lockstep, and a player who builds a second Bottler
sees the pipes go amber rather than a machine go idle. Upstream the ratio is 1:1:2 (juicer :
kettle : mixer), which falls out of one cane making two bottles' worth of syrup rather than being
tuned in. `test/factory.test.ts` pins both, the same way it pins the chip line's 1:1:2:1:1.

**Four liquids means four networks, and that constraint _is_ the puzzle.** One liquid per network
is untouched; the soda line is simply the first thing in the game that makes the rule cost
something.

**The bundles answer the release gate.** Plan §8 asks whether players run both lines or one
dominates into decoration. A Snack Combo is one bagged chip plus one soda at 125% of the two
sold separately, and a six-pack is six sodas at 110% — both derived from the real prices rather
than typed as literals. Running both districts therefore beats running either one twice, which
is the mechanism rather than an opinion.

### Vertical Integration: stubbed, and listed here rather than half-built

Plan §4's consumable ladder is _"oil, seasoning, bags, bottles start store-bought at fixed
prices; mid-game Vertical Integration lets you grow/craft them."_ The bought rungs exist — a
**Bottle** is 120¢ and a **Kola Nut** is 150¢ at the stand, both posted and stable, because §8's
cut-forever list opens with fluctuating market prices. The crafted rungs are **not built**, and
naming them here is the point (§8: "fake the far side of every interface, stubs listed
explicitly"):

- **The oil press** — corn → corn oil. Corn is already a crop and `LiquidId` has room; nothing
  consumes oil yet, and a liquid whose machines do not exist is a liquid that lies.
- **The Evaporator** — water → salt, for seasoning.
- **The chili grinder** — chili → chili powder. The Grinder that ships takes kola nuts only.
- **Corn syrup** — a second sweetener route into the Syrup Mixer's syrup inlet.
- **Kola as a crop.** There is none and there will not be one: §5 caps the roster at eight and
  §7 ruling 8 closes it, which is exactly why kola arrives as a bought nut.

`LiquidId` reserves **5 for kola syrup**, which the renderer already has a colour for. Skipping a
number now is cheaper than renumbering a shipped save later.

## One-way doors

Per plan §12, these were settled in v0.1 and cannot be revisited once worlds exist:

- `SUBTILE = 256` and the other base units.
- Per-system RNG stream derivation, keyed by the system id's **string**, so adding a
  consumer never perturbs an existing stream.
- Leaderboard stat accumulators living **inside** `WorldState` and **inside** the hash.
- The first save format a real world uses.
- Fluids as **flow, not pressure**: one ledger per network, one pump and one liquid per
  network. A pressure model could not be retrofitted without invalidating every stored world,
  and it is the decision the entire soda line will stand on.

Everything else is a two-way door.

## Hashing

`hashState(state)` is FNV-1a over a canonical serialization: fixed field order, field tiles
by index, machines by id, inventory by item id, RNG streams by sorted key, and no floats.
It returns eight lowercase hex characters; `hashStateUint32` returns the same value as a
number.

The **trace is not hashed** — it is the input log, not the world. Two worlds that reached
identical state by different routes must agree, and hashing an append-only array on every
call would make the digest cost grow with the session rather than the world.

`findNonIntegerFields(state)` returns every hashed field that has gone fractional. A
non-empty result is a bug in units, not in the hash.

## Saves

`serialize(state)` produces a plain-JSON `SaveEnvelope`; `restoreWorld(value)` parses,
migrates, and deserializes one. The chain is at **format 6** — the soda line made a recipe a
list, so a machine holds one count per recipe line instead of a single `inputCount`, and a
converter carries typed liquid ports. `SIM_VERSION` is the code version fused with `BALANCE_HASH`,
because balance data is save-compatibility surface exactly as much as code is. The rules —
released migrations are never edited, one real fixture is kept per released version forever —
are in [`src/save/README.md`](src/save/README.md). The IndexedDB driver lives in
`apps/web/src/storage`, because `indexedDB` does not type-check in this package.

## Layout

| File          | What lives there                                                           |
| ------------- | -------------------------------------------------------------------------- |
| `units.ts`    | Base units, conversions, integer arithmetic helpers, the beat grid         |
| `rng.ts`      | Vendored xoshiro128\*\*, splitmix32, per-system stream derivation          |
| `data.ts`     | Balance data — crops, items, machines, belts, prices — plus `BALANCE_HASH` |
| `tech.ts`     | The tech tree. Unlocks verbs; carries no numbers                           |
| `upgrades.ts` | The three per-machine dials. Scales numbers; unlocks nothing               |
| `state.ts`    | `WorldState`, `createWorld`, and the accessors over it                     |
| `belts.ts`    | Belt movement, hand-off, and grabber arms                                  |
| `zones.ts`    | Zone painting, readouts, and the seed hopper                               |
| `water.ts`    | Reservoirs, the throttle curve, and `takeWater()` — the one draw path      |
| `pipes.ts`    | Pipe networks, placement refusals, and the one-ledger flow tick            |
| `commands.ts` | The `Command` union and the append-only trace                              |
| `tick.ts`     | `step()` and the fixed system order                                        |
| `stats.ts`    | Leaderboard accumulators                                                   |
| `hash.ts`     | FNV-1a and the canonical serialization                                     |
| `view.ts`     | The render projection                                                      |
| `save/`       | The save envelope, canonical payload, migrations, and `SIM_VERSION`        |
| `index.ts`    | The public surface                                                         |

Balance data lives in this package on purpose: it is save-compatibility surface exactly as
much as code is, so it is versioned with the sim and folded into `BALANCE_HASH`.
