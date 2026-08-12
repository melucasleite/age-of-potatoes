# Palettes

`placeholder.json` is exactly what it says: eight colours that exist so the pipeline had
something to run against while it was being built. It is not the game's palette.

`master.json` is the real one — **40 colours, hand-authored on 2026-08-12 before a single
image was generated**, and `art/manifest.json` points at it. Plan §15 is emphatic that this
comes first and never mutates afterwards: the palette is passed as `input_palette` on every
call forever, so changing it retroactively invalidates every asset generated under it.
Version a palette (`master_v2.json`) rather than editing one.

`master.png` renders it as swatches and is generated, never drawn:

```bash
node art/tools/palette-png.mjs   # rewrite master.png from master.json
yarn art:verify                  # the gate — see below
```

## The gate

`yarn art:verify` (`art/tools/verify-palette.mjs`) fails the build if `master.json` is
malformed, if the manifest stops pointing at it, if `master.png` has drifted out of sync, or
if any opaque pixel in `art/cooked/` is off-palette. Run it after `yarn art pack`, which is
what writes `art/cooked/`.

**RD's `input_palette` is a strong guide, not a guarantee.** Measured on the first real run:
every drifted pixel was exactly -1 in the red channel — 1312 of them across ten assets, close
enough to look right and far enough to fail an exact-match gate. The cook stage therefore
snaps every asset to the palette locally, on every provider, before measuring. Sending the
palette upstream still matters: it means the snap moves pixels by one level instead of
inventing a colour scheme.

Format is either a bare array of `#rrggbb` strings or `{ "colors": [...] }`. Anything else
is rejected at load, because a palette that silently half-loads is worse than no palette.
