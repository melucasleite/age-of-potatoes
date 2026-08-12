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

## Layout

| File          | What lives there                                                    |
| ------------- | ------------------------------------------------------------------- |
| `units.ts`    | Base units, conversions, integer arithmetic helpers, the beat grid  |
| `rng.ts`      | Vendored xoshiro128\*\*, splitmix32, per-system stream derivation   |
| `data.ts`     | Balance data — crops, items, machines, prices — plus `BALANCE_HASH` |
| `state.ts`    | `WorldState`, `createWorld`, and the accessors over it              |
| `commands.ts` | The `Command` union and the append-only trace                       |
| `tick.ts`     | `step()` and the fixed system order                                 |
| `stats.ts`    | Leaderboard accumulators                                            |
| `hash.ts`     | FNV-1a and the canonical serialization                              |
| `view.ts`     | The render projection                                               |
| `index.ts`    | The public surface                                                  |

Balance data lives in this package on purpose: it is save-compatibility surface exactly as
much as code is, so it is versioned with the sim and folded into `BALANCE_HASH`.
