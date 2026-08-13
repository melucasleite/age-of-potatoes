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
| `unreadable`     | The save and its backup both failed to parse | Show the message; both records are quarantined     |
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

`quarantine` is a fourth store rather than a third record, and it is not a slot either: it is
where records that failed to load are kept, and nothing ever loads from it.

## The trace has its own store

`state.trace` is an append-only log of every command that applied. Seed + trace is a bug report
that reproduces exactly, which is why it exists (plan §12) — it is **not** anti-cheat code and
must not be deleted as such.

It is not in the save payload: it grows without bound, it is not save-compatibility surface,
and rewriting the whole log on every autosave would make each save progressively more
expensive. `drainTrace()` writes only the tail appended since the last save, in batches.
`exportTrace()` flattens every batch in application order.

## A failed load never writes _over the save_

Not a repair, not a reset, not a tidy-up of the bad record. This is the rule the whole
directory is arranged around: a save from a newer build means the player's world is fine and
the tab is stale, and overwriting a future save with a past one is unrecoverable.

The quarantine copy below is the one write a failed load does make, and it is additive — a
different object store, `current` and `previous` untouched. That distinction is the rule, not
an exception to it.

## Quarantine, not cleanup

A record that will not load is copied into the `quarantine` store with its error, its slot, and
the wall-clock time it failed, and **the original stays exactly where it is**. Two reasons, and
the second is the one that is easy to miss:

1. It may be the only copy of a real world, and it is certainly the only copy of the evidence.
2. If the corruption is a _read_-side bug — a migration with a hole in it, a field this build
   does not understand yet — then the record under `current` is a perfectly good world that a
   later build will load fine. Deleting it would turn a bug into a loss.

Quarantine is a copy rather than a move for exactly that reason. Records are deduplicated by a
cheap fingerprint (slot + error name + format + tick + size), because a player whose save is
broken reloads the page several times before they believe it, and each reload would otherwise
file another copy of an 11 KB world into a database that may already be full. Nothing is ever
deleted from this store automatically. Read it with `readQuarantine()`.

## Running out of room

`QuotaExceededError` is the failure that looks most like success. The write rejects, the game
keeps running, and from the far side of the screen a world that stopped saving an hour ago is
indistinguishable from one that is saving fine.

So a quota rejection walks a ladder, **cheapest loss first**, and retries **exactly once**:

1. **The stored input trace.** A debugging asset, and the thing that actually grows without
   bound. A bug report is worth a lot; it is not worth the world it is a report about. Dropping
   it deliberately does _not_ reset the drain cursor — resetting it would make the next save
   rewrite the whole trace and refill the space just freed. The honest consequence: after this
   fires, the stored trace is no longer a complete replay.
2. **The backup copy.** Trading a hypothetical future crash for a certain present save is the
   right trade when the alternative is not saving at all — but only once the trace is gone.

`conflict` is **not on the ladder and must never be**. It holds a world from another device,
and `cloudHandoff.ts` has exactly one invariant: no envelope is ever destroyed.

One rung per call, so a world that is genuinely too big walks down the ladder one autosave at a
time rather than dropping everything the first time it meets a limit that might be transient.
If the retry still fails, `saveWorld` rejects with a `StorageFullError` whose message is the
sentence the player is already reading on screen.

## Nothing fails quietly

`log.ts` writes to a console nobody has open. `notices.ts` is the channel to the **player**:
storage publishes, the HUD (`hud/SaveNotices.tsx`) subscribes, and neither imports the other's
internals. It is React-free and SSR-safe because `saves.ts` publishes during boot, before any
component exists.

| Notice          | Fires when                                                     |
| --------------- | -------------------------------------------------------------- |
| `Recovered`     | The backup was loaded because the main save was missing or bad |
| `QuotaFreed`    | The save landed, but something was dropped to fit it in        |
| `QuotaFull`     | The save did not land, even after making room                  |
| `WriteFailed`   | A save failed for some reason other than space                 |
| `NotPersistent` | The browser has not promised to keep this origin's storage     |

Two rules about the wording, and they are enforced by a test: **no jargon** (the player is
being told what happened to their factory, not what happened to a transaction) and **say what
is safe first**, because every one of these fires at a moment when the honest question is "have
I lost everything?".

`NotPersistent` is published only when a **saved world actually came back**. Chrome commonly
declines `persist()` until a site has earned some engagement, so a brand-new player would
otherwise be handed a warning about losing a factory they have not built yet, during the exact
first minute AGENTS.md says the whole project is in service of.

## Files

| File            | What lives there                                            |
| --------------- | ----------------------------------------------------------- |
| `db.ts`         | The connection, the schema, the store names                 |
| `saves.ts`      | `loadWorld`, `saveWorld`, `clearSavedWorld`, `readRawSaves` |
| `trace.ts`      | Draining, reading, and exporting the input trace            |
| `persist.ts`    | `navigator.storage.persist()` and the quota estimate        |
| `autosave.ts`   | The tick-driven cadence and the best-effort flush           |
| `quota.ts`      | `isQuotaError`, the single retry, and the full-disk wording |
| `quarantine.ts` | Filing a record that would not load, and reading them back  |
| `notices.ts`    | The plain-language channel to the player                    |
| `index.ts`      | The public surface, plus `bootWorld()`                      |
