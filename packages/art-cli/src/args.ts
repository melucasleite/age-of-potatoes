export interface Args {
  flags: Set<string>;
  options: Map<string, string>;
}

/** Parses `--flag` and `--key=value`. Positional arguments are not used by any command. */
export function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else options.set(body.slice(0, eq), body.slice(eq + 1));
  }
  return { flags, options };
}

export function numberOption(args: Args, key: string, fallback: number): number {
  const raw = args.options.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number, got "${raw}"`);
  return value;
}

export function usd(amount: number): string {
  return `$${amount.toFixed(3)}`;
}
