// Lets bare Node run the sim's TypeScript sources directly.
//
// The package compiles under `moduleResolution: "bundler"`, so its relative imports carry
// no file extension — `./units`, not `./units.ts`. Node's ESM resolver requires the
// extension, so this hook adds it back. Node 22.18+ strips the types itself; there is no
// transpiler and no bundler in the loop.
//
// Why bother: the golden test needs a genuinely separate process to prove a fixture replays
// the same way twice, and running that process under Vitest would compare two runs of the
// same loader rather than two runs of the sim. It also keeps the "headless, no renderer, no
// DOM, no build step" claim honest — if the sim ever picks up a dependency that only a
// bundler can resolve, this breaks loudly.
//
// Usage: node --import ./packages/sim/scripts/node-resolve-hook.mjs <script.ts>

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const HAS_EXTENSION = /\.(?:[cm]?ts|[cm]?js|json)$/;
const EXTENSIONS = ['.ts', '.js'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !HAS_EXTENSION.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL).href;
      for (const extension of EXTENSIONS) {
        if (existsSync(fileURLToPath(base + extension))) {
          return nextResolve(base + extension, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
