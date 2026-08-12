# @snack/art-cli

The asset pipeline. Three commands, no more. It is a script, not a product — small enough
to read in one sitting, and **never imported by the game**.

```
yarn art gen [--dry-run] [--force] [--confirm] [--max-spend=<usd>] [--only=<id>]
yarn art pack [--max-page=<px>]
yarn art review
```

`gen` turns `art/manifest.json` into committed originals. `pack` post-processes those into
one atlas page plus a typed TypeScript manifest. `review` writes a self-contained contact
sheet. Nothing else belongs here: no ledger, no cache, no approval flow, no watch mode, no
budget machinery. Plan §15 cut all of it by name, and adding it back is scope, not rigour.

## The rules that are easy to break by accident

**Originals are committed, and a build never regenerates them.** `art/originals/` is in git
permanently. They are not a cache — they are the source of truth the day the vendor dies,
and a model that has been decommissioned cannot be re-run at any price. No CI step calls
`gen`, and `yarn build` makes no network call.

**Never request 512², and never add git-lfs.** Declare native sizes — 16, 32, 48. A 512²
request exceeds every provider's cap, costs 3–10× more (pricing is by pixel area), and turns
a ~1 KB original into a ~300 KB one. The phantom 450 MB estimate that produced the git-lfs
recommendation came entirely from that mistake. Real numbers from this repo: a generated
original is **0.9 KB**, the hand-authored one is **145 bytes**.

**Never run `pngquant`, and never use `sharp`'s `png({ palette: true })` for palette
mapping.** That option runs libimagequant, which picks its _own_ palette and offers no API
to supply a fixed one. It will silently re-quantise pixels the pipeline just mapped and
produce near-miss colours that look fine and fail the palette gate. All colour work is
hand-rolled on raw RGBA buffers, and every encode passes `palette: false` explicitly.

**`sharp` stays out of `apps/web`.** That is why this is a third package despite plan §12
counselling against extraction — the reason is inverted here: nothing must _ever_ import
this one. `sharp` has an open `ERR_DLOPEN_FAILED` libvips bug under Turbopack on Vercel with
Next 16, which is why atlases are committed to `public/art/` rather than built. A separate
workspace makes that structural instead of remembered.

## Cost safety

The Retro Diffusion account is small. `check_cost: true` is free, so `gen` **always** prices
the whole run before spending anything, whether or not you passed `--dry-run`. A projected
total above `--max-spend` (default $0.10) stops the run until you pass `--confirm`, and a
projection above the reported balance stops it unconditionally. `balance_cost` and
`remaining_balance` are printed after every run.

## Five things the live API taught us that no document had right

**1. Retro Diffusion has a generation floor of 64px, and `check_cost` does not enforce it.**

Verified against the live API on 2026-08-12. `check_cost` prices 16, 24, 32 and 48px
requests happily and identically — $0.017, flat all the way to 64px — but a real inference at
any of those sizes returns `400 inference_failed`. Only 64px and up actually generate.

Treat `check_cost` as a price quote and never as a request validator. It also priced a 512²
request without complaint, which is why the 512 refusal lives in our code rather than
depending on the API to object.

This does not weaken the plan's cost argument: pricing is flat below 64px, so 64 sits at
exactly the same floor 16 would have. What changes is the mechanism. The adapter requests
the **smallest exact integer multiple** of the declared native size that clears the floor —
16→64 (4×), 32→64 (2×), 48→96 (2×) — and the cook stage decimates by that factor. An integer
multiple is the point: every target pixel maps to one aligned block, so the reduction is
arithmetic rather than the grid _detection_ a non-pixel-art provider forces.

**Committed originals stay at the provider's full output**, not the decimation. Improving the
downsampler later must not require re-buying the art.

**2. RD's 64px output is real 64px detail, not an upscaled 16px grid.** Measured on the first
generated asset: 4 distinct colours, but only 65% of 4×4 blocks uniform. So the modal-vote
downsample earns its keep on the RD path too — it is not dormant after all, and the reduction
is lossy in the way any honest reduction is.

**3. `input_palette` is a strong guide, not a guarantee — and the miss is invisible.**

Measured on the first real generation run (work item 005, 2026-08-12): 1312 off-palette
pixels across ten assets, and every one of them was **exactly −1 in the red channel**. RD
lands within 1/255 of the master palette and stops there. That is close enough to look
perfectly correct on screen and far enough to fail an exact-match gate on every asset.

This is the same class of hazard as the pngquant rule above — near-miss colours that look
fine and fail the gate — arriving from the provider instead of from a local encoder, which
does not make it acceptable. So `quantizeToPalette` now runs whenever a palette is
configured, whatever the provider claims. On the RD path it moves pixels by one level and is
visually a no-op; it is what makes the palette gate binary instead of advisory.

Keep sending `input_palette` regardless. It is the difference between a one-level snap and
the remap inventing a colour scheme.

**4. Multi-frame strips must set `trim: false`.** `trimAndPad` trims to the whole image's
opaque bounds and re-anchors, which is right for one sprite and silently wrong for a strip —
a 4-stage crop strip slides off its 16px cells, producing exactly the incoherence that
generating the whole progression in one call was meant to prevent.

**5. Prompt for the size that ships, not the size requested.** Everything is generated at an
integer multiple ≥64px and decimated, and fine detail does not survive 4×. Four sprinkler
takes all read beautifully at 64px; only the one prompted for "large solid areas of flat
colour, no thin lines, no small details" still read at 16px.

## How the seam works

Post-processing stages branch on **capability flags**, never on a provider's name. That is
the whole point of the adapter:

| Capability             | `true` →                                          | `false` →                           |
| ---------------------- | ------------------------------------------------- | ----------------------------------- |
| `nativePixelOutput`    | assert an exact integer grid                      | modal-vote downsample from any size |
| `supportsPaletteInput` | send `input_palette` upstream to guide generation | do not send it                      |

`retro-diffusion` sets both `true`; `local` sets `supportsPaletteInput: false`.

**`supportsPaletteInput` no longer decides whether the local remap runs — the remap always
runs when a palette is configured.** It was originally a branch (`true` → measure drift only,
`false` → Oklab remap first) on the theory that RD applying the palette server-side made the
output exact. Work item 005 disproved that on the first real run; see finding 3 above. The
`false` branch is still what the OpenAI fallback adapter needs on the day RD is deprecated —
**do not delete it as dead code.** `OPENAI_API_TOKEN` is already in `.env`, under that
non-default name, because the OpenAI SDK looks for `OPENAI_API_KEY` and will not find it.

`provider: "local"` is first-class, not an escape hatch: it flows through the identical
post-processing, packing and typed-manifest path.

## The atlas is a build-time contract

`pack` writes **one page**. If any group needs a second, it exits non-zero and names the
group and the sprites that pushed it over. This is not tidiness — belt items render through a
`ParticleContainer`, every particle must share one `TextureSource`, and a silent spill breaks
the batch _silently_ (plan §13). Prove it still works with `yarn art pack --max-page=16`.

Status lamps must not share a page with machine sprites unless that page is pinned too. The
plan's answer is better anyway: one tiny sprite, tinted in code.

**No text in sprites, ever.** Bitmap fonts render text at runtime.

## Outputs

| Path                                     | Committed? | What                                 |
| ---------------------------------------- | ---------- | ------------------------------------ |
| `art/originals/<id>.png` + `.json`       | yes        | provider output + provenance sidecar |
| `art/local/<id>.png`                     | yes        | hand-authored sources                |
| `art/cooked/`                            | no         | post-processed intermediates         |
| `art/review/index.html`                  | no         | contact sheet                        |
| `apps/web/public/art/atlas.{png,json}`   | yes        | what the game loads                  |
| `apps/web/src/art/manifest.generated.ts` | yes        | typed manifest the game imports      |

The sidecar records provider, model, seed, exact prompt and style, declared native size,
the size actually requested upstream, palette, cost and an ISO timestamp — enough to
regenerate deliberately rather than by coin flip.

The palette lives in `art/palette/`. Work item 005 authors `master.json` there and wires the
CI gate that turns a non-empty drift report into a failed build. This package only
**measures** drift; building the gate here too would mean two gates disagreeing.
