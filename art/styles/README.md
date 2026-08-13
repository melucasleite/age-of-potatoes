# Styles

**`snack_mogul_v1` was NOT minted. This directory is deliberately empty of style records.**

Work item 005 planned to generate a golden set, hand-pick it, and feed it to Retro Diffusion's
`create_user_style` to mint `snack_mogul_v1`, then pass that style on every later call. That
step was cut on cost, and the number is not close.

## Why

Custom user styles are built on **RD Pro's** reference-image template, and Pro prices at
roughly **$0.18 per image** against the `rd_fast__default` floor of **$0.017** this project
actually generates at — about 10x. The account held **$0.466** on 2026-08-12. Minting the
style and then generating through it buys **two sprites and a bankrupt account**; generating
on `rd_fast__default` bought the entire v0.1 set for $0.174 with change for rerolls.

So the choice was never "style or no style". It was "a style, or any art at all".

## What holds consistency instead

The other half of §15's strategy, which is the half that was always doing the real work:

- **`art/palette/master.json`** — 40 hand-authored colours, sent as `input_palette` on every
  call, and now impossible to omit: the RD adapter throws rather than generate without one.
- **The palette gate** (`yarn art:verify`) — an off-palette pixel fails the build.
- **Committed originals + provenance sidecars** — every asset records its seed, exact prompt,
  model and requested size, so any sprite can be deliberately regenerated.

§15's framing was that style drift becomes "a random walk anchored at the origin instead of a
free one". The palette is that anchor. The user style would have shortened the step size.

## Minting it later

Do not backfill `v1` onto art generated without it — that would make the record a lie. When
the balance supports it, mint from the then-current golden set, record the returned id, date,
contributing asset ids and reference image paths in `snack_mogul_v1.json`, set it as the
manifest's default `promptStyle`, and regenerate deliberately from there. Version, never
mutate: if the look moves again, `v2` gets a new file and `v1` stays reproducible.

A full v1.0 pass on Pro is the number Lucas needs before committing: at ~$0.18/image with the
generous rerolls §15 assumes, that is the $150-$400 range the plan already predicted.

## The UI font — licence and provenance

**`snack` is authored in this repository and carries this repository's licence. No third-party
typeface was used, referenced, or traced.**

The letterforms live in `art/tools/make-ui-font.mjs` as literal pixel masks and are the only
"style record" the font has — a 6x10 monospaced cell, a 5x7 body with two descender rows, 104
glyphs (printable ASCII plus the nine non-ASCII characters the renderer's format strings
actually print). Regenerating it is `node art/tools/make-ui-font.mjs`, which rewrites
`art/local/ui_font.png` and `apps/web/src/art/ui-font.generated.ts` together.

**Why authored rather than vendored.** §15 rules out asking an image model for letterforms —
a diffusion model cannot be asked for the same stroke weight a hundred times, which is the
entire content of a font. That leaves adopting an open-licensed pixel font or drawing one. An
adopted font arrives with a licence to track, a file to vendor, metrics to trust, and a
character set somebody else chose; at 5x7, drawing one is an afternoon and the result is
unambiguously ours. The same argument the belts and pipes make for `provider: "local"`, one
step further.

**Why it is not a style record.** Nothing in `art/manifest.json` generates through it and no
provider ever sees it. It is listed here because a font is the one asset in a repository that
people are right to ask the licence of, and the answer should be in the file where licences
live rather than in a commit message.
