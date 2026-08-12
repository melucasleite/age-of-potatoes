// Rewrites `expectedHash` in every golden fixture. The only sanctioned way to do it.
//
//   yarn goldens:regen
//
// THIS IS NOT A REPAIR TOOL. A red golden test has exactly two causes: you changed the
// simulation on purpose, or you broke it by accident. Running this without deciding which
// converts the second case into the first, silently, and the test stops being worth its
// runtime. See `test/fixtures/README.md`.
//
// Regeneration is deliberately never a side effect of running the tests, and this script is
// deliberately never invoked by CI. It rewrites one line per fixture — the hash and nothing
// else — so the resulting diff is small enough that a reviewer can see it happened and ask
// why the commit message does not mention it.

import { readFileSync, writeFileSync } from 'node:fs';

import { FIXTURE_NAMES, fixturePath, loadFixture, replayHash } from '../test/goldens';

const EXPECTED_HASH_LINE = /("expectedHash"\s*:\s*")[0-9a-f]{8}(")/;

let changed = 0;

for (let i = 0; i < FIXTURE_NAMES.length; i++) {
  const name = FIXTURE_NAMES[i]!;
  const path = fixturePath(name);
  const fixture = loadFixture(name);
  const actual = replayHash(fixture);

  if (actual === fixture.expectedHash) {
    console.log(`  unchanged  ${name}  ${actual}`);
    continue;
  }

  const source = readFileSync(path, 'utf8');
  if (!EXPECTED_HASH_LINE.test(source)) {
    throw new Error(
      `${name}: could not find an 8-hex-digit "expectedHash" to rewrite. ` +
        `Fix the fixture by hand rather than letting a script guess.`,
    );
  }

  writeFileSync(path, source.replace(EXPECTED_HASH_LINE, `$1${actual}$2`));
  console.log(`  REWROTE    ${name}  ${fixture.expectedHash} -> ${actual}`);
  changed += 1;
}

if (changed === 0) {
  console.log('\nEvery fixture already matched. Nothing was written.');
} else {
  console.log(
    `\n${changed} fixture hash(es) rewritten.\n` +
      'Say so in the commit message, and say which simulation change caused it.',
  );
}
