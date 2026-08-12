// Lint rules that enforce the determinism bans inside @snack/sim.
//
// Plan §12 says to write the rules in the README and enforce them in lint. This is the
// enforcement half. It is also why the toolchain pins TypeScript 6 rather than 7 —
// typescript-eslint cannot consume TS 7 yet, and these rules are the mechanism.
//
// Type-aware linting is deliberately off. Every ban below is a syntactic question, so the
// parser alone answers it, and the rules stay fast and indifferent to the TS version.

import tseslint from 'typescript-eslint';

const BANNED_MATH =
  '^(random|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)$';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Wall-clock time and the host environment. The DOM-free tsconfig already rejects
      // `window`, `document`, and `performance`; listing them here means the error names
      // the reason rather than just the missing type.
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'The sim has no wall clock. Time is `state.tick`, and nothing else.',
        },
        {
          name: 'performance',
          message: 'The sim has no wall clock. Time is `state.tick`, and nothing else.',
        },
        { name: 'window', message: 'No DOM in the sim. The renderer lives in apps/web.' },
        { name: 'document', message: 'No DOM in the sim. The renderer lives in apps/web.' },
        { name: 'navigator', message: 'No DOM in the sim. The renderer lives in apps/web.' },
        { name: 'localStorage', message: 'No storage in the sim. Saves live in apps/web.' },
        { name: 'fetch', message: 'The sim never talks to the network.' },
        {
          name: 'requestAnimationFrame',
          message: 'The sim runs on a fixed tick, not on the display refresh.',
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: `MemberExpression[object.name='Math'][property.name=/${BANNED_MATH}/]`,
          message:
            'IEEE-754 guarantees bit-exact + - * / and sqrt; transcendentals are implementation-defined and engines disagree in the last bits. Use an integer table or a lookup curve. Math.random belongs to the renderer.',
        },
        {
          selector: "BinaryExpression[operator='**']",
          message: '`**` is Math.pow. Use repeated multiplication or an integer table.',
        },
        {
          selector: "AssignmentExpression[operator='**=']",
          message: '`**=` is Math.pow. Use repeated multiplication or an integer table.',
        },
        {
          selector: 'ForInStatement',
          message:
            'Object key order mixes rules: integer-like keys sort ascending, string keys keep insertion order. Iterate a sorted array, a Map, or Object.keys().sort().',
        },
        {
          selector: 'FunctionDeclaration[async=true]',
          message: 'The sim is synchronous. A tick that can await is a tick that can interleave.',
        },
        {
          selector: 'FunctionExpression[async=true]',
          message: 'The sim is synchronous. A tick that can await is a tick that can interleave.',
        },
        {
          selector: 'ArrowFunctionExpression[async=true]',
          message: 'The sim is synchronous. A tick that can await is a tick that can interleave.',
        },
        {
          selector: 'AwaitExpression',
          message: 'The sim is synchronous. A tick that can await is a tick that can interleave.',
        },
        {
          selector: 'TSEnumDeclaration',
          message:
            "Node's native type stripping cannot execute enums. Use an `as const` object with a derived union type.",
        },
      ],

      eqeqeq: ['error', 'always'],
      'no-var': 'error',
    },
  },
];
