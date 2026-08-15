import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { numberOption, usd } from '../args.js';
import { loadManifest, resolveArtPath } from '../manifest.js';
import { planAnimation, reassembleStrip } from '../post/frames.js';
import { checkStripGeometry } from '../post/geometry.js';
import { loadPaletteContext } from '../post/palette.js';
import { decode } from '../post/raw.js';
import { getAdapter } from '../providers/index.js';
import { DEFAULT_ATTEMPTS, GenerationLostError } from '../providers/retro-diffusion.js';
import { ORIGINALS_DIR, REVIEW_DIR } from '../paths.js';
import type { Args } from '../args.js';
import type { AssetEntry } from '../manifest.js';
import type { StripGeometryReport } from '../post/geometry.js';

/**
 * Spend above this, in USD, requires --confirm. The RD account is small and a surprise
 * here stops art production entirely; `check_cost` dry runs are free, so there is never a
 * reason to find out the price by paying it.
 */
const DEFAULT_MAX_SPEND = 0.1;

/**
 * Per-entry ceiling on what a `frames` strip may burn chasing a take that passes the
 * geometry gate, in USD. Another take is bought only while the entry's spend so far plus
 * that take would stay at or under this — at $0.07 an animation, that means two takes and
 * out. The number is item 063's, set against wave 8's counter-example: 26 takes of grinding
 * proved the plain endpoint wrong at ~$0.68, and the lesson was to abort and report, not
 * persist. A capped failure is a finding; an uncapped one is a bill.
 */
const STRIP_RETRY_SPEND_CAP = 0.15;

function sidecarPath(id: string): string {
  return resolve(ORIGINALS_DIR, `${id}.json`);
}

function originalPath(id: string): string {
  return resolve(ORIGINALS_DIR, `${id}.png`);
}

export async function gen(args: Args): Promise<number> {
  const dryRun = args.flags.has('dry-run');
  // A reroll is a regeneration by definition, so it implies --force rather than needing it.
  const reroll = args.flags.has('reroll');
  const force = args.flags.has('force') || reroll;
  const confirmed = args.flags.has('confirm');
  const maxSpend = numberOption(args, 'max-spend', DEFAULT_MAX_SPEND);
  const attempts = Math.max(1, numberOption(args, 'retries', DEFAULT_ATTEMPTS - 1) + 1);
  const concurrency = Math.max(1, Math.floor(numberOption(args, 'concurrency', 1)));
  const only = args.options.get('only');

  const manifest = loadManifest();
  const palettes = loadPaletteContext(manifest.palette ? resolveArtPath(manifest.palette) : null);
  // The subset an asset declares is what goes upstream as `input_palette`. Steering
  // generation toward the colours the asset is allowed to keep is free, and strictly
  // better than generating unconstrained and snapping to them afterwards.
  const paletteFor = (entry: AssetEntry): readonly string[] | null =>
    palettes.subsetFor(entry) ?? palettes.colors;
  mkdirSync(ORIGINALS_DIR, { recursive: true });

  let pending: AssetEntry[] = manifest.assets;
  if (only) {
    // A comma-separated list, because rerolling is never a one-asset activity: a review pass
    // rejects a handful at once, and eight sequential `--only` runs is eight times 2-5
    // minutes of waiting for no reason. Unknown ids are named rather than silently dropped.
    const wanted = new Set(
      only
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    );
    const known = new Set(pending.map((entry) => entry.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    if (missing.length > 0) {
      console.error(`\nNo such asset in art/manifest.json: ${missing.join(', ')}`);
      return 1;
    }
    pending = pending.filter((entry) => wanted.has(entry.id));
  }
  const skipped = pending.filter((entry) => !force && existsSync(originalPath(entry.id)));
  pending = pending.filter((entry) => force || !existsSync(originalPath(entry.id)));

  // Rerolled seeds are chosen here, once, and used for BOTH the free quote and the paid
  // call. Generation is deterministic on seed within a session (work item 048), so
  // `--force` alone is liable to buy the identical PNG at full price — a reroll is only a
  // reroll if the seed moves.
  //
  // That determinism does NOT hold across hours: re-requesting a take from earlier the same
  // day, with the same prompt, style, size and recorded seed, came back visibly different
  // (factory art round). The seed is provenance, not a restore point, so a take worth
  // keeping must be copied off disk before the next roll overwrites it.
  const seeds = new Map<string, number>();
  if (reroll) {
    for (const entry of pending) seeds.set(entry.id, Math.floor(Math.random() * 2 ** 31));
  }
  const seedFor = (id: string): number | undefined => seeds.get(id);

  for (const entry of skipped) {
    console.log(
      `  skip  ${entry.id.padEnd(24)} original already committed (--force to regenerate)`,
    );
  }
  if (pending.length === 0) {
    console.log('\nNothing to generate. Originals are committed and never regenerated by a build.');
    return 0;
  }

  // Phase 1 — price everything. Free, and the only honest way to know what a run costs.
  console.log(`\nPricing ${pending.length} asset(s) via check_cost (free)...\n`);
  let projected = 0;
  let balance: number | null = null;

  for (const entry of pending) {
    const adapter = getAdapter(entry.provider);
    const result = await adapter.generate({
      entry,
      palette: paletteFor(entry),
      dryRun: true,
      seed: seedFor(entry.id),
      attempts,
    });
    projected += result.cost;
    if (result.remainingBalance !== null) balance = result.remainingBalance;
    console.log(
      `  quote ${entry.id.padEnd(24)} ${String(entry.width).padStart(3)}x${String(entry.height).padEnd(3)} ` +
        `${adapter.name.padEnd(16)} ${usd(result.cost)}`,
    );
  }

  console.log(`\n  projected total: ${usd(projected)}`);
  if (balance !== null)
    console.log(`  remaining balance: ${usd(balance)} (unchanged — nothing was spent)`);

  if (dryRun) {
    console.log('\nDry run. No images were generated and no money was spent.');
    return 0;
  }

  if (projected > maxSpend && !confirmed) {
    console.error(
      `\nRefusing to spend ${usd(projected)}: above the ${usd(maxSpend)} threshold.\n` +
        `Re-run with --confirm to proceed, or raise the bar with --max-spend=<usd>.`,
    );
    return 1;
  }
  if (balance !== null && projected > balance) {
    console.error(
      `\nRefusing to start: projected ${usd(projected)} exceeds the ${usd(balance)} balance. ` +
        `Top up the account or narrow the run with --only=<id>.`,
    );
    return 1;
  }

  // Phase 2 — spend.
  console.log(
    `\nGenerating ${pending.length} asset(s)` +
      `${concurrency > 1 ? `, ${concurrency} at a time` : ''}...\n`,
  );
  let spent = 0;
  const failures: { id: string; message: string; billed: boolean }[] = [];

  // A worker pool over a shared cursor. Pricing stays sequential above — it is free and
  // fast — but generation is 134-309 SECONDS per image (measured, work item 048), so a
  // fifteen-asset run is an hour of a machine waiting on a socket. Nothing here is ordered
  // or shared except the cursor and the tallies, and Node is single-threaded, so the
  // accumulations below cannot interleave mid-statement.
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const entry = pending[cursor++];
      if (entry === undefined) return;
      await generateOne(entry);
    }
  }

  async function generateOne(entry: AssetEntry): Promise<void> {
    const adapter = getAdapter(entry.provider);
    const animation = entry.frames !== undefined ? planAnimation(entry) : null;
    let entrySpent = 0;
    let takeSeed = seedFor(entry.id);

    for (let take = 1; ; take++) {
      let result;
      try {
        result = await adapter.generate({
          entry,
          palette: paletteFor(entry),
          dryRun: false,
          seed: takeSeed,
          attempts,
        });
      } catch (error) {
        // One bad asset must not abandon the run. On a forty-asset batch, throwing here
        // would discard every remaining generation AND the printed record of what the ones
        // already bought had cost — which is the number the operator most needs when a run
        // goes wrong. Collect, report at the end, exit non-zero.
        const billed = error instanceof GenerationLostError && error.billed;
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ id: entry.id, message, billed });
        console.error(`  FAIL  ${entry.id.padEnd(24)} ${message.split('\n')[0]}`);
        return;
      }
      const image = result.images[0];
      if (!image) throw new Error(`Provider returned no image for "${entry.id}".`);

      entrySpent += result.cost;
      spent += result.cost;
      if (result.remainingBalance !== null) balance = result.remainingBalance;

      // The geometry gate, for strips only: reject a take whose cells are wrong BEFORE
      // paying for more. Transport retries above reuse the seed (same picture, already
      // billed); a geometry reject rolls a FRESH seed, because the picture itself is the
      // problem and same-session determinism would buy the identical failure again.
      let geometry: StripGeometryReport | null = null;
      if (animation && entry.sheetCells !== undefined) {
        // Sheet-harvest mode: the style substitutes its own character-sheet format by
        // design, so the take gate only asks "is this a real sheet on the style's frame
        // grid?". Which cells ship is a cook-time selection from the committed original —
        // inspect the sheet, name the cells, re-cook. A wrong index costs an edit, not a
        // re-buy; the full cell-geometry gate still runs in `cook` on every pack.
        const sheet = await decode(image);
        const { frameSize } = animation;
        if (sheet.width % frameSize !== 0 || sheet.height % frameSize !== 0) {
          geometry = {
            ok: false,
            clusters: [],
            message:
              `provider returned ${sheet.width}x${sheet.height}, not a multiple of the ` +
              `${frameSize}px frame — likely a GIF or a plain image, not a spritesheet`,
          };
        } else {
          const cols = sheet.width / frameSize;
          const rows = sheet.height / frameSize;
          geometry = {
            ok: true,
            clusters: [],
            message: `sheet accepted: ${cols}x${rows} cells of ${frameSize}px, cell choice deferred to cook`,
          };
        }
      } else if (animation) {
        try {
          geometry = checkStripGeometry(
            reassembleStrip(await decode(image), animation, entry.id),
            animation.frames,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          geometry = { ok: false, clusters: [], message };
        }
      }

      if (geometry !== null && !geometry.ok) {
        // The take was paid for either way — keep the receipt where a human can look.
        const rejectedDir = resolve(REVIEW_DIR, 'rejected');
        mkdirSync(rejectedDir, { recursive: true });
        const receipt = `${entry.id}.take${take}.seed${result.seed ?? 'none'}`;
        writeFileSync(resolve(rejectedDir, `${receipt}.png`), image);
        console.warn(
          `  gate  ${entry.id.padEnd(24)} take ${take} rejected: ${geometry.message}\n` +
            `        receipt in art/review/rejected/${receipt}.png`,
        );

        if (entrySpent + result.cost > STRIP_RETRY_SPEND_CAP) {
          failures.push({
            id: entry.id,
            message:
              `geometry gate rejected ${take} take(s) for ${usd(entrySpent)}; another take ` +
              `would pass the ${usd(STRIP_RETRY_SPEND_CAP)} per-strip cap. Aborted — see ` +
              `art/review/rejected/ for the paid takes. Last: ${geometry.message}`,
            billed: false,
          });
          return;
        }
        takeSeed = Math.floor(Math.random() * 2 ** 31);
        continue;
      }

      writeFileSync(originalPath(entry.id), image);
      writeFileSync(
        sidecarPath(entry.id),
        `${JSON.stringify(
          {
            id: entry.id,
            provider: adapter.name,
            model: result.model,
            seed: result.seed,
            prompt: result.prompt,
            promptStyle: result.promptStyle,
            native: { width: entry.width, height: entry.height },
            requested: result.requested,
            ...(animation
              ? {
                  animation: {
                    frames: animation.frames,
                    framesRequested: animation.framesRequested,
                    frameSize: animation.frameSize,
                    keptFrames: [...(animation.cells ?? animation.keep)],
                    discardRule: animation.cells
                      ? 'sheetCells at time of purchase — the live selection is art/manifest.json'
                      : 'first frames-1 requested frames, plus the last',
                    takes: take,
                    geometry: geometry?.message ?? null,
                  },
                }
              : {}),
            removeBg: entry.removeBg ?? true,
            tileX: entry.tileX ?? false,
            tileY: entry.tileY ?? false,
            palette: manifest.palette ?? null,
            anchor: entry.anchor,
            atlasGroup: entry.atlasGroup,
            costUsd: entrySpent,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      console.log(
        `  wrote ${entry.id.padEnd(24)} ${(image.length / 1024).toFixed(1).padStart(6)} KB  ` +
          `seed ${String(result.seed ?? '-').padEnd(12)} ${usd(entrySpent)}` +
          (take > 1 ? ` over ${take} takes` : ''),
      );
      return;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));

  console.log(`\n  spent this run: ${usd(spent)}`);
  if (balance !== null) console.log(`  remaining balance: ${usd(balance)}`);

  if (failures.length > 0) {
    const billed = failures.filter((failure) => failure.billed);
    console.error(`\n${failures.length} asset(s) failed:\n`);
    for (const failure of failures) console.error(`  ${failure.id}\n    ${failure.message}\n`);
    if (billed.length > 0) {
      console.error(
        `  ${billed.length} of those reached the provider and were very likely BILLED without ` +
          `returning an image.\n  The reported balance above already reflects them; the spend ` +
          `total does not, because no cost was ever returned to count.`,
      );
    }
    return 1;
  }

  console.log('\nOriginals and sidecars are committed to git. They are the source of truth.');
  return 0;
}
