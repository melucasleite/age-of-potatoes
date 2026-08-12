# Working on Snack Mogul

A browser factory/farming/tycoon game — Factorio × Stardew Valley × RimWorld, where you
build a chips-and-soda empire from a weedy roadside lot.

The full design and technology plan lives at
`~/.claude/plans/i-want-to-create-snuggly-pillow.md` (the filename is an unrelated
auto-generated slug; the content is this game's design document). Work items live in the
Obsidian vault at `~/obsidian-vault/Work/age-of-potatoes/`, filed by status.

## The rules that are load-bearing

These are not style preferences. Each one exists because breaking it causes a failure that
is silent, delayed, or expensive to reverse.

**`.env` holds live API tokens and is gitignored.** Never commit it, never print its
values, never paste a key into a file or a PR. `.env.example` documents the variable names.

**The simulation is pure and deterministic.** `packages/sim` has no DOM lib in its
tsconfig, so `window`, `document`, and `performance` fail to type-check there — that is
deliberate. Also banned inside the package: `Date`, `Math.random`, `async`, `for...in`,
and `Math.sin/cos/tan/exp/log/pow` and `**`. IEEE-754 guarantees bit-exact `+ - * /` and
`sqrt`; transcendentals are explicitly implementation-defined and JS engines disagree in
the last bits, which desyncs replays.

**Integer units everywhere in the sim.** `SUBTILE = 256` per tile, money in **cents**,
machine progress in integer work-points, fluids in millilitres. No floats in sim state.
The reason is not paranoia about compilers — it is that float determinism holds only if
the exact operation _sequence_ survives, and a routine refactor that reorders `(a*b)+c`
silently invalidates every stored replay. Integers make refactoring safe.

**Cosmetic randomness lives in the renderer.** Particle jitter, idle animation offsets,
and lamp flicker use `Math.random` freely — in `apps/web`, never in `packages/sim`. A
visual effect must never touch a sim RNG stream.

**Render positions are write-only.** Interpolated positions exist in the renderer, are
never read back into the sim, never persisted, never hashed.

**Audio follows the sim, never the reverse.** The Music Box beat grid is an integer number
of ticks, owned by `WorldState`. `AudioContext.currentTime` must never influence
simulation state — putting a drifting sample clock inside the deterministic loop is not
recoverable by refactoring.

**One atlas page for belt items.** Every sprite that can ride a belt must live on a single
texture page, because `ParticleContainer` requires one shared `TextureSource`. The art CLI
fails the build if that atlas spills to a second page. Status lamps must not share an
atlas with machine sprites unless that atlas is also pinned to one page.

**Every state mutation goes through a `Command` applied at a specific tick.** No debug
buttons, no cheats, no out-of-band mutation. Camera pan, hover, and menu state are _not_
commands and never enter the sim.

## Toolchain

- **yarn 1.22 (classic)** — always yarn, never npm.
- **TypeScript 6.0.3**, not 7. TS 7 shipped without a stable programmatic API until 7.1
  and typescript-eslint cannot consume it — but lint rules are what enforce sim purity.
- Next.js 16.3 (App Router, Turbopack), React 19.2, PixiJS 8.19 as a _library_ with no
  game framework, vitest 4.
- Node's native TS stripping cannot run `enum` — use `as const` objects instead.

## Commands

```bash
yarn install         # workspace install
yarn build           # next build (apps/web)
yarn typecheck       # tsc --build across the workspace
yarn test            # vitest, including the sim's golden determinism test
yarn format          # prettier — run this after any change
yarn art gen         # asset pipeline: generate (use --dry-run first, it is free)
yarn art pack        # post-process + atlas pack
```

**Do not start a dev server.** Lucas runs his own on `:3000`.

## Verification expectations

Deliberately light, by Lucas's explicit instruction: "if it works, it works — don't spend
too much time doing verification, just test it and see if it works." Keep the cheap
structural gates that catch silent breakage — `typecheck`, `build`, and the sim's golden
hash test — and skip elaborate proof harnesses.

The one exception worth its cost is the **golden determinism test**: fixed seed plus a
fixed command list must produce a known state hash, run headless. It is what catches
accidental non-determinism on the day it is introduced rather than years later.

## The design gate that outranks everything

v0.1 ships when a fresh-eyes player **grins the moment the sprinkler waters for them, and
then immediately wants a second one**. Every technical decision in this repo is in service
of that one reaction. If a change makes the manual farming less pleasant, it is a
regression no matter what it optimizes.
