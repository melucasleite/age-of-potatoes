# Snack Mogul

Build a chips-and-soda empire from a weedy roadside lot.

A browser factory/farming/tycoon game: hand-water potatoes in your first hour, watch robot
arms do it in your tenth. RimWorld-style zone plantations, Stardew-style farming that
graduates into Factorio-style belts, inserter arms, pumps, and pipes.

> Rent's paid through the month. Make chips.

## The idea

The loop never changes — **Tend → Convert → Sell → Improve**. What changes over the life of
a save is _who owns each verb_: your hands, your tools, then your machines. Every system
has a manual tier, an assisted tier, and an automated tier, and each automation unlock
retires a tool with a small ceremony. Your first watering can ends up bronzed on a plaque
with the number of tiles you personally watered.

Money is both the resource and the score. Prices are stable and posted — the pressure
comes from upkeep: machines wear with use, raw crops spoil while processed goods keep
forever, and reservoirs run down if you overdraw them. A sloppy factory bleeds margin. A
well-run one prints money and, because every machine's work-cycle sound is quantized to a
shared beat grid, literally grooves.

## Status

**v0.1 — the vertical slice.** One field, potatoes, a monolithic Chip Kitchen, a sell bin,
and one purchasable sprinkler. It ships when a fresh-eyes player grins at the moment the
sprinkler waters for them and immediately wants a second one. Everything else is
downstream of that reaction.

## Getting started

```bash
yarn install
yarn build
```

Then run your dev server and open `/play`.

## Layout

| Path               | What lives there                                                          |
| ------------------ | ------------------------------------------------------------------------- |
| `packages/sim`     | The deterministic simulation. Pure TypeScript, zero dependencies, no DOM. |
| `packages/art-cli` | Asset pipeline: AI generation → post-processing → atlas packing.          |
| `apps/web`         | Next.js shell, PixiJS renderer, input, HUD, audio.                        |
| `art/`             | Master palette, manifest, and committed generated originals.              |

## Contributing

Read [AGENTS.md](AGENTS.md) first — it documents the rules that are load-bearing rather
than stylistic, and each one is there because breaking it fails silently.
