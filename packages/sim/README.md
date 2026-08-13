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
that stops being hypothetical. It **scales with the map**: land deeds took the lot to 64 tiles
a side, where the longest honest walk is 21.9 seconds, so the ceiling went from 600 ticks to
1,200 to keep a margin rather than start cancelling errands that were merely long.

`state.trace` is an append-only log of every command that actually applied, in application
order. **It is not dead anti-cheat code and must not be deleted as such.** Leaderboards are
only lightly validated. The trace is here because seed + trace is a bug report that
reproduces exactly — the single most valuable debugging asset a solo dev can have — and it
costs an append-only array.

## The lot

The world is **64×64 tiles — a 4×4 grid of 16-tile parcels** — and the player owns one of them
to start with. Plan §8's roadmap is the only place the design names a map size ("64×64 map"),
and plan §5 is the only place it describes land: _"the starter lot is free; adjacent parcels
are purchasable land deeds at escalating prices"_. Everything else about it was decided here
and the arithmetic is written down in `data.ts`.

**`WORLD_TILES_WIDE/HIGH` are the MAXIMUM extent, not the lot.** How much of it is yours is
`WorldState.ownedParcels`, a sorted list of parcel indices — sorted for the reason `unlocked`
is, because two players who bought the same two parcels in the opposite order own the same
land and must hash the same. `isInsideWorld` and `isOwnedTile` are different questions and
every build path asks both: outside the world is nowhere, and unowned land is a real place
with a price standing on it.

**The grid grew outward from an origin that did not move.** Parcel 0 is the north-west 16×16,
which is exactly the map every pre-deed world was born on, so a save from before deeds loads
with its field at (4,4), its pond at (12,13), and every machine, belt and pipe where it was
left. The format 7 → 8 migration adds `ownedParcels: [0]` and translates one thing only —
**pipe network ids, which are row-major tile indices and therefore arithmetic on the map's
width**. Not a tile moves; a network is simply called 844 where it used to be called 220.

**Deeds are priced by how many you have bought, never by which parcel you are buying**
(`DEED_PRICE_CENTS_BY_PURCHASE`, doubling from $200), so two players who expanded in opposite
directions paid the same money and hash the same. `BuyDeed` carries no price in its payload
for the same reason `RotateGrabber` carries no direction: what land costs is the sim's rule.
It is refused unless the parcel is unowned, on the map, **orthogonally adjacent to land you
already hold** (plan §5's "adjacent", which is what stops a player owning two disconnected
islands), and affordable.

**Land is on the net-worth books at what it cost.** Plan §6 wants investing during a scoring
window to be neutral, and a deed that only subtracted cash would make expanding the one
purchase in the game that costs you a rung on the leaderboard.

**Building is gated on ownership; walking is not.** Plan §5 sells deeds as the answer to "is
space free?", which is a question about building — nothing in the design fences the farmer in,
and an invisible wall around unowned land would be the first collision geometry in the game,
put there to stop the player walking over to read the price of the thing they are meant to
buy. A footprint that straddles the fence is refused whole, and so is a belt run or a pipe run
that crosses it: `BuildRefusal.Unowned` is a separate code from `OutsideWorld` precisely
because the sentence the renderer prints for it is an offer rather than a wall.

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

**A belt is drawn as a double line and routed as a single lane, and plan §5 says both.** Two
adjacent paragraphs of the design call belts _"double-line"_ and _"single-lane"_, which is a real
contradiction and not a typo — a future agent will hit it, so here is the reading that fits
everything else. **Double-line is presentation**: items are drawn in two files side by side,
because that is what makes a belt look busy and legible at a glance. **Single-lane is routing**:
one input, one output, no per-side lane addressing, no lane-balancing puzzle, and one sorted item
list per segment. Lane balancing is a genre convention, not a thing this design ever asks for, and
the sim has no field in which to express a side. If a change starts wanting `BeltItem.lane`, this
is the paragraph it has to argue with.

**Belts.** A belt segment is a sorted list of `(distanceAlongBelt, itemTypeId)` — plan §13,
and load-bearing. Items are not entities: they have no ids and no renderer counterparts, and
the renderer derives particle positions from the list every frame. That is what makes
`ParticleContainer` (no interactivity, no children, no filters) survivable, because picking a
belt item is a sim-side lookup rather than a sprite hit-test. **Do not replace this with
per-item entities.** Segments are straight; corners are two segments meeting, and a head item
hands off to whatever belt starts where its own ends.

**Grabbers** are the only bridge between belts and machine buffers: an arm takes from the tile
behind it and puts into the tile ahead. A blocked arm stands there holding the item, which is
the readable version of "look downstream" — and it now also carries a **lamp** in the projection,
in plan §5's grammar, derived from the only two fields an arm has: mid-swing is green, standing
empty is amber (reached back, found nothing), standing full is red (reached forward, was refused).
Visible-if-you-know-what-to-look-for is not the same as a lamp, and from ten tiles up a starved arm
and a blocked one look identical. **The renderer does not draw it yet.** `RotateGrabber` turns a placed arm one step
clockwise, reach-gated like every other verb you perform with your hands — one press, one trace
entry, no target direction in the payload, because which way clockwise goes is the sim's rule
and not the client's. **Nothing else in the world rotates.** A machine's ports are typed by
LIQUID rather than by geometry, so no machine has a facing at all, and a belt's direction is the
direction it was dragged.

**The splitter and the merger are one object, and it has no facing.** Plan §5 names both;
built honestly they are the same tile. A **belt junction** takes one item per tick off a belt that
ends on it and puts it on a belt that leads away from it, choosing round-robin on each side from
two cursors stored on the machine. Two belts in and one out is a merger; one in and two out is a
splitter; the device does not know which it is, because the answer is the belts the player ran into
it and those are on screen. Shipping two kinds with identical code would have been two names for
one rule and a build menu asking the player to decide something already decided. A face that points
_into_ the junction is an input and can therefore never be chosen as an output, which is the single
rule that rules out ping-pong without a special case.

**The alternation is world state, never a roll and never the tick counter** — that is item 024's
criterion (_"the same seed and command list produce the same hash across runs"_) stated as bytes:
the cursors are in the digest and in the save, so a reloaded splitter carries on dealing where it
left off. A junction holds **nothing**: an item crosses inside one tick or it is still on the belt
behind, which keeps a jam visible on the belt where the player can see it, keeps net worth with
nothing extra to count, and makes picking the junction back up incapable of eating anything. It has
no work cycle, so it never wears, never jams, and takes no dial. A grabber cannot feed one — a
junction has no recipe, so the arm stalls holding its item, the same "look downstream" stall a full
hopper gives. Feed junctions with belt.

**Boxing is the rearranging verb; scrapping is the selling one.** `DeconstructMachine` takes a
machine off the lot and puts it in the bag as one of twenty boxed-machine items — one per
buildable kind — carrying its dials, its condition and its invoice, and `PlaceMachine` opens a
box in preference to buying new, for free. It pays nothing, because moving a machine is free
forever (plan §4) and the machine was already bought; a deconstruct that handed back cash would
make demolishing a factory a business model. `SellBoxedMachine` is the one that pays, at **40%
of `investedCents`, floored** — which is where plan §3's scrap rate and item 037's dangling
criterion finally live somewhere they can be checked. The sell bin refuses boxes for the same
one-column reason it refuses seeds: `ItemSpec.sellable` is data, and a box has no list price.

A machine refuses to box while it is **jammed** or **actually running**. Running means it would
advance work this tick — it has the ingredients and it has the room — rather than `progress > 0`,
which is the resting state of every machine with a Speed dial on it and would have banned boxing
exactly the machines the feature is for. Everything countable comes back to the player's hands.
Liquid does not and cannot: there is no item id for a millilitre of anything, and net worth has
never counted water.

Boxes inside a slot are kept **sorted, least invested first**, so two players who boxed the same
bare Fryer and the same maxed one in opposite orders hash identically — the same argument that
keeps `unlocked` sorted and network ids geometric. That order also settles which box comes out
next, for both verbs at once: you put down the plainest machine you own and you scrap the
plainest machine you own, so the one you spent money on is the last one you can lose by accident.

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

## The farm

Plan §3's ladder runs manual → assisted → automated for every system in the game, and the farm was
the column where only the bottom rung existed. What arrives here is the rest of it, plus the clock
that makes any of it matter.

**The roster is eight and five of them are `CropId`s.** §5 names Russet Potato, Gold Potato, Chili
Pepper, Corn, Sugar Cane, and the three 2×2 trees — and **the trees are `MachineKind`s**. A
`CropTile` is one tile with one crop on it, so a 2×2 tree expressed as a crop is four tiles each
claiming a quarter of a plant, with nothing in the shape to say they are the same plant; every
question the feature asks (which quarter do you harvest, what happens when you plant over a corner,
where does the cooldown live) is then new. A `Machine` already answers all of them. The count still
comes to eight: five sown, three planted. **`MachineRole.Orchard` is not `Converter` with an empty
recipe**, though that would have compiled and run — a converter advancing work ticks
`untouchedTicks`, and the Corporate Charter's whole claim is that a machine cannot advance work for
96,000 ticks unless something is _feeding_ it. A tree needs nothing feeding it.

**Soil scales the target once, at sowing.** `GROWTH_PER_WATERED_TICK` is 1 and there is no integer
between 0 and 1, so sand's 1150‰ is a target 13% lower rather than growth 15% faster — divided once
at planting it is exact, visible in the save, and cannot drift, and loam divides to exactly what the
line computed before soil existed. Moisture goes the other way, through `CropTile.moistureAccum`:
clay at 700‰ under a Russet's drain of 1 floors to **zero**, so a clay tile would never dry out at
all without the accumulator. Fertility decay is **a counter, never a roll** — five harvests a star,
floored at 1, so exhausted ground still feeds you while you go and fetch fertilizer.

**Goods age in the player's hands and nowhere else.** That one sentence is how §4's _"timers freeze
inside machine hoppers"_ is implemented: a machine buffer is `inputCounts: number[]`, a bare count
per recipe line, and counts have no timer — so freeze is **structural** rather than a rule somebody
could forget. The alternative was giving every buffer in the game per-stack spoil ticks and then
advancing them with the world while held, which turns one integer into a list of pairs on every
machine, in the hash, in the save, in the migration, in the loader, in `advanceConverter`, in
`consumeRecipe` and in every grabber hand-off — to model a clock whose only legal value is
_stopped_. Goods handed back OUT of a machine are stamped fresh from that tick, and that is not a
laundering exploit worth closing: it costs two hand-verbs and a walk to gain what running the
machine for one operation would have gained anyway, and §4's thesis for the whole section is that
**processing is preservation**.

**A crate is an item, not a building, and that only becomes obvious when you try it the other way.**
Since nothing inside any machine has a clock, a placeable Crate would freeze its contents exactly as
a Root Cellar does and the two would be one object with two prices — the same "two names for one
rule" the belt junction ruling refuses. The distinction §4 actually draws is between goods **loose**
and goods **crated**, and both of those are in your arms. So the Crate is a consumable you pack a
stack into, refused rather than eaten when it would not help, and the Root Cellar is a hundred slots
where the clock stops.

**The armful gates the verb, not the container.** `addItem` is deliberately still unbounded, because
half the things that put goods in the bag are involuntary — a belt taken up with forty slices on it,
a machine boxed with a full hopper, a cancelled contract, a refund — and a cap enforced inside
`addItem` would have to either destroy those goods or refuse the verb that returns them. Both are
fines for misplacement, which §4 rules out flat. So the cap is asked at the voluntary door instead:
harvest, buy, unload, take-from-storage, pick up compost. **A full player cannot harvest and the
crop stays in the ground**, which is the anti-softlock answer as well as the criterion — a tile you
could not pick is a tile that is still there when you come back with room. Boxed machines are
exempt: a box is not a good, the bin refuses one, and demolishing a factory must not fill your hands
with turnips.

**The Barrel Sprinkler is `MachineKind.Sprinkler` and has been since v0.1.** Item 023 asks for a
distinct, cheaper Barrel on the grounds that item 011 disclaimed the $150 sprinkler as "the
automated feel" — and re-reading the machine that actually shipped, the disclaimer is what is wrong.
It has a real tank, it is filled by can through `RefillHopper`, it counts a `hopperRefill` touch, it
shows the blue utility lamp when dry, and it stops when the barrel is empty. That is the assisted
rung in full, down to the lamp; the automated rung is the piped head at $250 and the Hub at $900,
which need no filling at all. The debt was a **label**, and shipping a second machine with identical
behaviour would have been a build menu asking the player to decide something already decided.

**One swing is one touch.** Plan §6's taxonomy counts _hands on the world_, and a scythe swing is
one motion of one pair of arms. Counting three would make the assisted rung score **worse** on
Hands-Free than doing the same work by hand, which inverts the whole ladder — the way to win a board
about not touching things would be to refuse the tool that touches them less.

## The Agri-Bots, and the one mover

**There is exactly one mover in this simulation and that is the point of `movement.ts`.** Item 039
requires its repair drones to reuse the Agri-Bot movement code _verbatim_, which is a promise you
can only keep about code that lives in one place — so rather than writing a bot mover beside the
player's errand walk and keeping them in step by remembering to, the walk that already existed was
**generalised**. `advanceErrand` had carried the whole thing since v0.1: accrue speed into a
hundredths accumulator, spend whole subtiles, aim straight, clamp to the world, face the dominant
axis. None of that was ever about the player. It moved to `stepToward`, the errand calls it, the
bots call it, and the arithmetic did not change in the move — a replay of a pre-bot world walks the
farmer over exactly the same subtiles.

**The route is dumb on purpose.** A bot scans its zone's tiles in field-index order from a cursor
stored in `WorldState`, takes the first that wants work, and walks at it in a straight line: no A\*,
no float distances, no `Math.sqrt` heuristics, no dynamic avoidance, and a tile it cannot service is
skipped rather than queued. Nothing in this world is solid enough to walk into, so a path around an
obstacle would be a path around nothing — and pathing is where determinism usually dies. The cursor
is world state rather than a module variable for the reason the Irrigation Hub's is.

**The zone is the bot's only instruction set.** Item 018 already built a surface that says what
should be growing where; a dock carrying its own crop and its own tile list would be a second answer
to the same question, and the two would disagree the first time somebody repainted a rectangle.
`Machine.boundZone` is an id rather than a copy of the tiles, so repainting re-aims the bot with no
command at all.

**Upkeep is per completed operation and never per tick** — §4 names this case by name. A docked idle
bot wears exactly nothing, forever, because time-based upkeep would charge a player for leaving the
tab open, which contradicts §6's clock outright.

**Hand-fed costs a touch and belt-fed costs nothing, and the Hands-Free board rests on it.** §6's
taxonomy makes _"hand-refilling any hopper (seeds, kits, consumables)"_ a disqualifier, so the two
paths are different functions rather than one function with a flag: `RefillHopper` in `tick.ts` is
the hand's and counts, `dockAcceptSeed` in `bots.ts` is the belt's and does not. A genuinely
hands-free farm therefore has to feed its planter by belt, which is the design turning that board
into a logistics problem rather than a purchase.

**What the golden set cannot reach, said plainly.** The dock is gated on the Corporate Charter,
whose milestone is 96,000 consecutive ticks of untouched work, so a fixture that reached
`SetDockZone` honestly would be a six-figure-tick recording of a belt loop built to satisfy a
checklist. `SetDockZone` is therefore the one entry in `GOLDEN_COVERAGE_EXEMPT`, and `test/bots.test.ts`
pins what a fixture would have: two worlds built the same way and stepped the same way hash
identically, a bot clears its zone with no player input, and an idle bot wears nothing over ten
thousand ticks.

## Selling above the roadside stand

Plan §3's ladder runs manual → assisted → automated for every system in the game, and selling
was the one column that stopped at the first rung. The bin is still a gift the world starts
with and it never rots (§1); what arrives above it is a **delivery cart** you load and dispatch
by hand, and a **truck depot** that takes goods off a belt and ships them under **standing
contracts** while you are three screens away.

**A contract is a logistics object and never a price.** Locked decision 3 fixes prices as stable
and posted and §8 cuts fluctuating markets forever, so a route chooses _what_ to ship and _how
much per run_ — and there is nowhere in `Contract` to put a value. Every payout, on every route,
is `listPriceCents(item) × count`: the same arithmetic the bin does, and identical money at the
bin, on a cart, and on a truck. `commerce.test.ts` asserts the shape rather than the convention.

**A cart load counts a `handCarry` touch and a depot sale counts nothing, and the Hands-Free
board is unadjudicable if that ever leaks.** Plan §6's taxonomy lists "hand-carry/load/unload",
and the cart is _fewer_ hands rather than none. Signing a route is paperwork — no touch, no
reach check, the same shape as `ResearchTech` — because the whole point of the automated rung is
that you never go and stand next to it again. `test/fixtures/depot-run.json` ends with **5,000
commandless ticks** in which the money goes up and every touch counter stays exactly where it
was; that fixture is what makes the board a thing a test can decide.

**What is still not possible, said plainly:** nothing in this game harvests a crop for you, so
"seed-to-sold with zero manual touches" is not reachable today and the fixture does not claim
it. The kitchen's hopper is filled by hand immediately before the window opens. What is proven
is the last link — production to money — which is the link this feature was asked for.

**Goods in transit are on the books** (plan §6). A cart's cargo and a route's `stocked` and
`inTransit` are all counted at list by `computeNetWorthCents`, and a dispatch moves goods from
one of those columns to another at one price inside one tick — so net worth does not move when a
truck leaves, and Peak Flow records no trough that never happened. Payment is on **arrival**,
which is what makes that accounting load-bearing rather than decorative.

**A run is an integer number of ticks and the journey happens off the map.** There is no path,
no route, and no pathfinding: a truck leaves the lot for a town that is not simulated, so
nothing about the drive crosses anybody's land. What ownership gates is the tile the vehicle
_stands_ on, which `PlaceMachine` already refuses. Distance is one subtraction against
`ROAD_EDGE_TILE_X` — the lot's west edge, where the design put the road and where `createWorld`
stood the stand — at ten ticks a tile. On a 16-wide lot that was not a decision anybody could
make; at 64 wide, a depot on the far parcel nearly doubles its own round trip, so _build near
the road_ is a real layout question the progress bar answers without a tutorial.

**Cancelling is free and hands everything back** — the floor and the lorry both, into the bag.
Paying out the in-flight truck instead was the obvious alternative and it is an exploit: it
deletes the run time, so sign-load-cancel-resign is the same money with the journey removed, and
the rung whose entire selling point is never touching it again becomes the most click-intensive
verb in the game.

**The first truck honks twice** (§3's Hall of Hands, by name). `CeremonyId.FirstTruck` is marked
on the tick a truck leaves the dock — not when the route is signed and not when it returns —
which is why the depot has a five-second loading beat at all: a ceremony needs the truck to
still be there when the horn sounds. A cart deliberately does not mark it. **The renderer's COPY
table for that id is the render lane's to add.**

**A depot has no recipe, so a grabber reaches it through one door.** `depotAccept` is the only
way goods enter, and it refuses anything no route on that depot names — the arm then stalls
holding the item, which is the same "look downstream" stall a full hopper gives. One route per
product per depot, refused at `CreateContract`, so there is never a question of which route an
item lands in.

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

**The third Charter measures an absence, and that needed a counter that did not exist.** Plan §3's
Corporate Charter is _"money + one line untouched for 10 in-game days"_, and an in-game day is 8
real minutes (plan §2), so ten of them is 96,000 ticks. `stats.longestHandsFreeTicks` was the
obvious candidate and is the wrong one: it counts ticks since the player touched **anything**, and
nothing in this game harvests a crop for you, so a farmer who is still farming could never pass it.
Instead every machine keeps `untouchedTicks` — **consecutive ticks on which it advanced work with
nobody's hands on it** — and the milestone reads the lot's high-water mark. It counts work rather
than time, which is what makes it a _production_ line: a machine idle in a corner earns nothing,
and a machine that advanced work for 96,000 straight ticks must have had something feeding it and
something emptying it, so what the counter certifies **is** a line. No definition of where a line
starts and stops is needed, which is the whole reason this shape was chosen. It is a high-water
mark rather than a live maximum because demonstrated is demonstrated — a gate that closed again
because you refilled a hopper on the walk to the tech panel reads as a bug.

**Two of plan §3's three named joints are real; the third is waiting on a machine.** Sprinklers
need pipes, and bottling needs fluids **and** belts (`SodaMixing` requires `SodaPress` and `Belts`
— a Bottler has two pipe inlets and a solid inlet, so a player who has never run a belt cannot feed
the third). _Drones need diagnostics and trucking_ has no nodes to join: trucking exists and is
standing ready, but there is no drone and no diagnostics verb, and a capstone unlocking a machine
nobody built is exactly the lie the Hydraulics branch was once left empty to avoid. Item 039 builds
both; the joint is made in that commit.

**Node ids are strings and are staying strings.** Item 036 asks for integers; sorted-and-hashed is
what that criterion actually protects, and the string buys a save you can read and an identity that
reordering a table cannot silently change. See the ruling at the top of `tech.ts`.

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
- ~~**Kola as a crop.**~~ **Built** — as a 2×2 tree, which is what §5 listed all along. The cap of
  eight was never in danger: §5's roster is five sown crops and three trees, and the ninth _sown_
  crop is the thing §7 ruling 8 closes the door on. A kola nut off your own tree and one off the
  roadside stand are the same `ItemId`, deliberately: the Grinder does not care where its nut came
  from, and §4's consumable ladder is exactly a bought rung with a crafted rung under it.

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
migrates, and deserializes one. The chain is at **format 11** — the farm: every perishable stack in
the bag carries the tick it turns, every field tile carries its soil, its moisture remainder and its
fertility counter, every machine carries the zone a dock is bound to, the player carries the cart
they are towing, and the world carries a sorted list of Agri-Bots. Four items landed in one release
and therefore in one migration step; the chain's rule is one migration per _released_ version, and
11 is not released until this ships. Almost all of 10 → 11 is empty and zero because no format-10
save can name a bot, a cart or a dock — the two exceptions are soil, which becomes **loam** rather
than being rolled (a half-grown crop's `growthTarget` was computed at loam rates, so calling its
tile clay afterwards would leave a crop whose target agrees with no soil at all), and freshness,
which is computed **generously** so a returning player opens their bag to fresh potatoes rather
than to a compost heap. Format 10 was the third Charter and the belt
junction, so every machine carries the untouched-work clock the Corporate Charter's milestone is
read off and the two round-robin cursors a junction alternates on, and the stats block carries the
lot's high-water mark. A format-9 world had no junctions and had never been asked how long a line
had run untouched, so all three start at zero: that is the only value they could have had rather
than a default. Format 9 was selling above the stand, so a
world carries its standing contracts as a sorted list of their own and every machine carries the
three delivery-cart fields. Format 8 was land deeds, so a world records the parcels it owns and
its pipe network ids are re-expressed on the wider map. Format 7 was
deconstruct-to-inventory: a machine can come off the lot as a boxed item, so an inventory slot
carries the boxed machines in it beside its count. Format 6 was the soda line, which made a
recipe a list, so a machine holds one count per recipe line instead of a single `inputCount`
and a converter carries typed liquid ports. `SIM_VERSION` is the code version fused with `BALANCE_HASH`,
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
| `movement.ts` | **The one mover.** Straight-line travel in integer subtiles                |
| `bots.ts`     | Agri-Bots: the dock, the route, and what a bot does when it arrives        |
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
