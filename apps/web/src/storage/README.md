# Storage

IndexedDB is where the world lives. Not localStorage — it is synchronous, capped around 5 MB,
and evicted more aggressively. Not the network — plan §11 says the game must work with the
network off, and Supabase sync (work item 016) is a mirror on top of this, never the source of
truth.

The envelope format, the migration chain, and the canonical payload live in
[`packages/sim/src/save`](../../../../packages/sim/src/save/README.md). `packages/sim` has a
DOM-free tsconfig, so `indexedDB` and `navigator` do not type-check there. This directory is
the half of the split that touches the browser.

## Boot

```ts
import { bootWorld, startAutosave } from '@/storage';

const boot = await bootWorld();

if (boot.state === null) {
  // A save exists that this build must not touch. Show boot.outcome.message and STOP —
  // do not create a world and do not start autosaving over it.
  return;
}

const autosave = startAutosave(() => stateRef.current, { sinceTick: boot.state.tick });
```

`bootWorld()` requests persistent storage, then loads the save or creates a fresh world. It
never throws. `state === null` happens for exactly two reasons, and both mean _leave the disk
alone_:

| `outcome.reason` | What happened                                | What to do                                         |
| ---------------- | -------------------------------------------- | -------------------------------------------------- |
| `format-too-new` | A stale tab met a save from a newer deploy   | Tell the player to reload                          |
| `unreadable`     | The save and its backup both failed to parse | Offer to export it before starting over            |
| `unavailable`    | No IndexedDB (SSR, private mode, blocked)    | **Plays anyway**, with a fresh world and no saving |

## Autosave is counted in ticks

`AUTOSAVE_INTERVAL_TICKS` is 1,200 — 60 seconds of **active** play. §6 says ticks accrue only
while the player is present, so an AFK or paused world stops advancing and therefore stops
saving. A world that is not accruing money should not be accruing saves.

The `setInterval` inside is only a _poll_. It reads `state.tick` once a second and does nothing
unless the tick has moved far enough.

The flush on `visibilitychange` → hidden is **best-effort and nothing more**. An async
IndexedDB write is not reliable during page teardown and no amount of `beforeunload` cleverness
makes it so. The cadence is the real guarantee; worst case the player loses under a minute.

## Persistence, and the failure that presents as heartbreak

`requestPersistentStorage()` runs on every boot. Without it, **Safari evicts IndexedDB after
extended non-use** — which does not present to the player as a storage-policy nuance. It
presents as _"my factory vanished."_ The call is one line, it may be granted silently based on
engagement, and the result is logged either way.

## Two records, not two slots

The `saves` store holds `current` and `previous` under fixed out-of-line keys. §6 locks one
persistent world per player; `previous` is **not** a save slot and must never be surfaced as
one. Every write copies `current` into `previous` inside the same transaction before
overwriting. One extra `put` buys a survivable corrupt write.

The stored value _is_ the envelope, with no wrapper object — legible in DevTools →
Application → IndexedDB, and an upload rather than a redesign when cloud sync lands.

## The trace has its own store

`state.trace` is an append-only log of every command that applied. Seed + trace is a bug report
that reproduces exactly, which is why it exists (plan §12) — it is **not** anti-cheat code and
must not be deleted as such.

It is not in the save payload: it grows without bound, it is not save-compatibility surface,
and rewriting the whole log on every autosave would make each save progressively more
expensive. `drainTrace()` writes only the tail appended since the last save, in batches.
`exportTrace()` flattens every batch in application order.

## A failed load never writes

Not a repair, not a reset, not a tidy-up of the bad record. This is the rule the whole
directory is arranged around: a save from a newer build means the player's world is fine and
the tab is stale, and overwriting a future save with a past one is unrecoverable.

## Files

| File          | What lives there                                            |
| ------------- | ----------------------------------------------------------- |
| `db.ts`       | The connection, the schema, the two store names             |
| `saves.ts`    | `loadWorld`, `saveWorld`, `clearSavedWorld`, `readRawSaves` |
| `trace.ts`    | Draining, reading, and exporting the input trace            |
| `persist.ts`  | `navigator.storage.persist()` and the quota estimate        |
| `autosave.ts` | The tick-driven cadence and the best-effort flush           |
| `index.ts`    | The public surface, plus `bootWorld()`                      |
