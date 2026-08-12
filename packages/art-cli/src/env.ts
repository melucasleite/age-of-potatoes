import { readFileSync, existsSync } from 'node:fs';
import { ENV_PATH } from './paths.js';

let cache: Record<string, string> | null = null;

/**
 * Minimal .env reader. Deliberately not `dotenv`: this is the only consumer, and a
 * dependency that can reach process.env is a dependency that can leak it.
 *
 * Values from this file are secrets. Never log a value — only report presence.
 */
function loadEnvFile(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      out[key] = value;
    }
  }
  cache = out;
  return out;
}

/** Reads a secret from the repo-root .env, falling back to the real environment. */
export function readSecret(name: string): string | undefined {
  return loadEnvFile()[name] ?? process.env[name];
}

/** Reads a required secret, failing with a message that names the variable but never its value. */
export function requireSecret(name: string): string {
  const value = readSecret(name);
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to ${ENV_PATH} (which is gitignored) before running this command. ` +
        `Refusing to send an unauthenticated request.`,
    );
  }
  return value;
}
