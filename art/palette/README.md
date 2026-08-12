# Palettes

`placeholder.json` is exactly what it says: eight colours that exist so the pipeline had
something to run against while it was being built. It is not the game's palette.

**Work item 005 authors `master.json` here** — 32–48 colours, by hand, before any real
generation — and repoints `palette` in `art/manifest.json` at it. Plan §15 is emphatic that
this comes first and never mutates afterwards: the palette is passed as `input_palette` on
every call forever, so changing it retroactively invalidates every asset generated under it.
Version a palette (`master_v2.json`) rather than editing one.

Format is either a bare array of `#rrggbb` strings or `{ "colors": [...] }`. Anything else
is rejected at load, because a palette that silently half-loads is worse than no palette.
