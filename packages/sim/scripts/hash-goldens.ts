// Replays every golden fixture and prints `name -> hash` as one line of JSON.
//
// This is the *other* process in the golden test's cross-process check. It runs under bare
// Node with no Vitest, no Vite, and no bundler, so a hash that only holds inside one
// long-lived test process — module-level cache, shared buffer, a value that happened to
// survive from an earlier fixture — shows up as a mismatch here.
//
// Run it yourself when a hash is in dispute:
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//        ./packages/sim/scripts/hash-goldens.ts
//
// The result is prefixed so that any warning Node decides to print cannot be mistaken for
// the payload.

import { HASH_LINE_PREFIX, replayAllHashes } from '../test/goldens';

console.log(HASH_LINE_PREFIX + JSON.stringify(replayAllHashes()));
