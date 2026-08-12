# Saves

A world, written as plain JSON, readable by a build that has not been written yet.

Plan §12 names **the first save format a real world uses** as one of the four one-way doors.
Once Lucas plays a world he cares about, every future version of this game either reads that
file or throws it away, and there is no third option. That is why this directory is more
careful than its size suggests.

## The envelope

```jsonc
{
  "formatVersion": 1, // envelope/payload shape; drives the migration chain
  "simVersion": "0.1.0+3babbcd4", // sim code version + balance data hash
  "worldSeed": 20260812, // the RNG seed the world was born with
  "tick": 32096, // the active-hour clock
  "payload": {/* WorldState, minus the trace */},
}
```

`worldSeed` and `tick` are duplicated out of the payload so a save list, a bug report, or a
sync layer can read them without parsing a world. `deserialize` reads them from the payload,
so the payload stays authoritative and the copies cannot drift into being the truth.

## Plain JSON, and explicitly not more

No typed arrays, no binary packing, no compression, no schema compiler. The research proposed
a typed-array grid field and its own roadmap then said not to build it yet; §12 rules it out
until saves genuinely exceed ~5 MB. A v0.1 world is about **11 KB**, so that is roughly a
450× margin.

The reason is worth stating plainly: for a solo multi-year build, being able to open a corrupt
save in a text editor and _see_ what went wrong is worth more than the bytes are. When saves
do cross 5 MB, that is a two-way door and a different work item.

## The two disciplines

**A released migration is never edited. Not once. Not to fix it.** A migration that gets
corrected after release produces two different worlds from the same file depending on which
deploy the player happened to load — and both worlds are plausible, so nothing catches it. If
a released migration is wrong, the repair is a _new_ step on the end of the chain.

**One real save fixture is kept per released version, forever.** See
[`../../test/fixtures/saves/README.md`](../../test/fixtures/saves/README.md). They accumulate;
that is the point.

For v0.1 the chain has length zero. The mechanism is built anyway: it costs an hour now and a
rewrite later.

## Balance data is save-compatibility surface

`SIM_VERSION` is `SIM_CODE_VERSION` fused with `BALANCE_HASH`, which `data.ts` computes over
the canonical serialization of every balance number **at module load** — not in a build step,
because a build step can be forgotten and module load cannot.

A save is only meaningful against the rules that produced it. Change the Chip Kitchen's
work-point cost and an old save's in-progress machine states describe a world that no longer
exists, exactly as if the code had changed. Treating balance as data outside the version key
is how a game quietly desyncs its own saves.

## What happens on mismatch

| Condition                 | Behaviour                                                        |
| ------------------------- | ---------------------------------------------------------------- |
| `simVersion` differs      | **Load it.** Report the mismatch; the host logs and displays it. |
| `formatVersion` < current | Migrate, then load.                                              |
| `formatVersion` > current | **Refuse, and write nothing.** `SaveFormatTooNewError`.          |
| Payload unreadable        | `SaveCorruptError` naming the first bad field.                   |

A `simVersion` mismatch does not invalidate a saved world; what it invalidates is replay
determinism and leaderboard comparability. A `formatVersion` from the future is different in
kind: it means a stale deploy met a newer save, and the only safe move is to leave the file
alone. Overwriting a future save with a past one is unrecoverable, and it is the single
outcome this module exists to prevent.

## Where the code lives, and why it splits

`packages/sim` has a DOM-free tsconfig with `"lib": ["ES2022"]`, so `indexedDB`, `navigator`,
and `localStorage` do not type-check here. Envelope types, canonical form, and migrations are
pure data transforms and live in the sim; the storage driver lives in
`apps/web/src/storage`. That is the boundary working as designed.

It also means **nothing in this directory logs** — the sim has no `console` either. Load
diagnostics come back as data (`RestoredWorld.simVersion`, `MigrationOutcome.steps`) and the
host decides what to do with them.

## The trace is not in the payload

`WorldState.trace` grows without bound over a persistent world, it is not save-compatibility
surface, and rewriting the whole log on every autosave would make each save progressively more
expensive for no benefit. It lives in its own IndexedDB object store in `apps/web`. It is also
not hashed, so leaving it out costs the round trip nothing.

## API

| Export                          | What it does                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| `serialize(state)`              | `WorldState` → `SaveEnvelope`. Deep-copies; safe to call mid-tick.  |
| `parseEnvelope(value)`          | Validate an untrusted stored value as an envelope.                  |
| `migrate(envelope)`             | Walk a save up to `CURRENT_FORMAT_VERSION`.                         |
| `deserialize(envelope, trace?)` | Migrated envelope → `WorldState`.                                   |
| `restoreWorld(value, trace?)`   | All three, in one call. What the storage layer uses.                |
| `checkSimVersion(saved)`        | Informational comparison. Never throws, never blocks.               |
| `toPayload` / `fromPayload`     | The canonical form on its own, for anything that wants it directly. |
