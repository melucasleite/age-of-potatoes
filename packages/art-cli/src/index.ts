import { parseArgs } from './args.js';
import { gen } from './commands/gen.js';
import { pack } from './commands/pack.js';
import { review } from './commands/review.js';

const USAGE = `snack-mogul art pipeline

  yarn art gen [--dry-run] [--force] [--reroll] [--confirm] [--max-spend=<usd>]
               [--retries=<n>] [--only=<id>]
      Manifest -> provider -> art/originals/. --dry-run prices the run for free.
      --force re-buys the SAME image (generation is deterministic on seed);
      --reroll re-buys a DIFFERENT one by rolling a new seed. --retries=<n> sets
      extra transport attempts after a timeout (default 1, same seed each time).

  yarn art pack [--max-page=<px>]
      Post-process originals -> one atlas page + atlas.<hash>.png/.json + typed TS
      manifest carrying their URLs. Stale atlases are removed. Fails the build if
      any atlas group spills to a second page.

  yarn art review
      Emit art/review/index.html — a self-contained contact sheet.
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'gen':
      return gen(args);
    case 'pack':
      return pack(args);
    case 'review':
      return review();
    default:
      console.log(USAGE);
      return command === undefined || command === '--help' ? 0 : 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
