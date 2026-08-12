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

**The tree and the dials.** `tech.ts` unlocks **verbs** (crops, machines, belt tiers, the
auto-replant toggle) and carries no numeric field anywhere in `TechNode`. `upgrades.ts` scales
**numbers** (Speed, Efficiency, Capacity) and unlocks nothing. That split is plan §3's
anti-double-dip rule, and it is enforced by the shapes themselves rather than by convention —
adding a "+20% fryer speed" node would require changing the `TechNode` interface, which is
exactly the friction the rule wants. `test/factory.test.ts` asserts the key set.

Gates are money-only except the three Charters, which add a _visible_ milestone read off a
counter the HUD already shows. There are no hidden behavioural gates.

## One-way doors

Per plan §12, these were settled in v0.1 and cannot be revisited once worlds exist:

- `SUBTILE = 256` and the other base units.
- Per-system RNG stream derivation, keyed by the system id's **string**, so adding a
  consumer never perturbs an existing stream.
- Leaderboard stat accumulators living **inside** `WorldState` and **inside** the hash.
- The first save format a real world uses.

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
migrates, and deserializes one. `SIM_VERSION` is the code version fused with `BALANCE_HASH`,
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
| `commands.ts` | The `Command` union and the append-only trace                              |
| `tick.ts`     | `step()` and the fixed system order                                        |
| `stats.ts`    | Leaderboard accumulators                                                   |
| `hash.ts`     | FNV-1a and the canonical serialization                                     |
| `view.ts`     | The render projection                                                      |
| `save/`       | The save envelope, canonical payload, migrations, and `SIM_VERSION`        |
| `index.ts`    | The public surface                                                         |

Balance data lives in this package on purpose: it is save-compatibility surface exactly as
much as code is, so it is versioned with the sim and folded into `BALANCE_HASH`.
