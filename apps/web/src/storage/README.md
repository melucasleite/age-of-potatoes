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

`bootWorld()` requests persistent storage, then loads **the active world's** save or starts that
world from its recorded seed. It never throws. `state === null` happens for exactly three
reasons, and the first two mean _leave the disk alone_:

| `outcome.reason` | What happened                                | What to do                                          |
| ---------------- | -------------------------------------------- | --------------------------------------------------- |
| `format-too-new` | A stale tab met a save from a newer deploy   | Tell the player to reload                           |
| `unreadable`     | The save and its backup both failed to parse | Show the message; both records are quarantined      |
| `no-world`       | No lot is selected                           | Send them to the front door — do **not** invent one |
| `unavailable`    | No IndexedDB (SSR, private mode, blocked)    | **Plays anyway**, with a fresh world and no saving  |

## Worlds are plural

`worlds.ts` holds the registry: one record per lot with its id, name, seed, timestamps and a
summary for the front door's card, plus which one is active. **Which world is never an argument
to `bootWorld`, `saveWorld` or `loadWorld`** — they resolve the active id themselves, which is
how this landed without `GameCanvas`, `GameHost` or cloud sync learning that worlds became
plural. The front door (`hud/FrontDoor.tsx`) sets the active id and then navigates.

Records are keyed `w:<id>:current` / `:previous` / `:older` / `:milestone` / `:conflict`.
None of the backups is a save slot the player picks from, per world or otherwise.

**The pre-registry player is adopted, once.** The first read of the registry on a database that
predates it finds the bare `current`/`previous`/`conflict` records, mints a world called
"Lot #1", and re-keys them **inside one transaction** along with the registry write. If it
aborts, nothing moved. `planLegacyAdoption` is a pure function so the whole decision is covered
by `worlds.test.ts` without a browser — it is the one operation here that can lose a returning
player's factory, and it runs exactly once, unattended.

**Deleting is a tombstone.** `deleteWorld` sets `deletedAt` and touches no envelope. The records
are dropped only by `sweepTombstones()` on a later boot, once the tombstone is older than
`WORLD_TOMBSTONE_MS` — **fourteen days**. Until then `restoreDeletedWorld` brings it back whole.
The sweep runs on boot rather than on a timer, so a browser nobody reopens deletes nothing,
which is the right behaviour for a window whose purpose is second thoughts.

**Cloud sync is the active world only.** There is one row per player per slot on the server, and
mirroring several worlds into one row is a merge problem with no right answer. The front door
says so on the cards. Per-world cloud slots are a follow-up; the seam is `activeConflictKey` in
`cloudHandoff.ts` plus a slot name.

**New Game never reuses a seed.** `freshSeed()` draws from `crypto`. Before the registry every
new world was `createWorld(20260812)` — the same lot, weed for weed, for everyone.

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

## Four records per world, not four slots

The `saves` store holds, **for each world**: `current`, two rolling backups (`previous` and
`older`), and a `milestone`, under out-of-line keys built by `currentKeyFor` and friends in
`worlds.ts`. None of them is a save slot the player picks from and none must ever be surfaced
as one. Every write pushes the rolling records down one — `previous` into `older`, `current`
into `previous`, deepest first, inside the same transaction — before overwriting `current`.
Two extra `put`s buy a corrupt write that has to happen **three times in a row** before it
costs a world.

The `milestone` is on its own cadence — rewritten at most every `MILESTONE_INTERVAL_TICKS`
(ten minutes of active play) — because the rolling records are written a minute apart and are
therefore three photographs of the same sixty seconds. The milestone is the copy from a
usefully different moment; recovering from it costs up to ten minutes, and the notice says so.

Every record's stamp is the envelope's own `tick`, so loading picks the **newest record by
tick that parses, migrates and restores cleanly** — tick order, not key order, because a
freshly written milestone is newer than `older`.

The quota ladder drops only the **active** world's backups, oldest first (`older`, then
`milestone`, then `previous` — the parachute for the very next torn write goes last). A player
whose second lot is running out of room has not consented to their first lot losing its
parachute.

The stored value _is_ the envelope, with no wrapper object — legible in DevTools →
Application → IndexedDB, and an upload rather than a redesign when cloud sync lands.

`quarantine` is its own store rather than another record, and it is not a slot either: it is
where records that failed to load are kept, and nothing ever loads from it. `worlds` is another,
holding the registry — names, timestamps and card summaries, every field of which §12 bans from
`WorldState` outright, and all of it still readable when a world's own envelope will not parse.
`meta` is another again, holding host-side facts about the player's visits and never world
state — see below.

## A save is loaded before it is written

Rotation only buys a survivable corrupt write if what replaces `current` is loadable. Hand the
layer two unloadable saves a minute apart and it faithfully destroys the good record with the
first and the evidence with the second. That is not hypothetical — it is the **frankensave**, on
the item-041 log: an HMR window stamped a save with the new format version using a reloaded
migrations module while a stale canonical module wrote the payload, so it claimed the current
format and was missing a field that format requires.

The lesson is narrow and worth stating exactly: **every check that reads a save's own claim about
itself is defeated by a save that lies about itself.** A version gate cannot catch a bad version
stamp. So `verify.ts` does not check the save — it _loads_ it, through `restoreWorld`, the same
call on the same kind of value that boot makes, then compares `hashState` in and out to catch the
save that loads into a subtly different world. Do not replace this with a cheaper structural
check; the cheaper check is precisely the one that already failed.

The order is serialize → verify → **write**, not write → verify. Verifying afterwards is too
late: the rotation has already pushed the last good save down a slot. A save that fails is never
written at all, so `current` and `previous` are exactly as they were, the bytes are filed under a
`rejected-write` label in `quarantine` (the only copy — nothing reached disk), and the player is
told. `saveWorld` then rejects with `SaveRejectedError`.

It runs on **every** save, with no sampling. Measured at ~1.1 ms for a 214 KB, 556-machine lot
against a 60-second cadence (`verify-cost.test.ts` asserts a 25 ms ceiling), and roughly half of
that was already being paid to stringify the world for `bytes`. Sampling would save nothing worth
having and would leave gaps in the one guarantee the check exists to make.

Because a rejected save means the live world still produces unloadable bytes, `autosave.ts` backs
off — `rejectBackoff`, doubling 1→2→4→8→16 intervals, capped so a long session keeps trying — and
says the new interval in the same notice. Retrying on the ordinary cadence would deep-copy,
stringify, parse and rebuild the world on the main thread every minute, forever, for a condition
that usually survives until a reload. An explicit `flush()` ignores the backoff: a player who
pressed save is owed an attempt and an answer.

## The trace has its own store

`state.trace` is an append-only log of every command that applied. Seed + trace is a bug report
that reproduces exactly, which is why it exists (plan §12) — it is **not** anti-cheat code and
must not be deleted as such.

It is not in the save payload: it grows without bound, it is not save-compatibility surface,
and rewriting the whole log on every autosave would make each save progressively more
expensive. `drainTrace()` writes only the tail appended since the last save, in batches.
`exportTrace(worldSeed)` flattens that world's batches in application order — **pass the seed**
for anything that claims to be a replay, because the store now holds several worlds' batches
interleaved by insertion order and a "replay" built from all of them is a replay of nothing.
`clearTraceForWorld(seed)` drops one world's; plain `clearTrace()` drops every world's and has
exactly one caller, the quota ladder, for which that is correct — being out of disk is not a
per-world condition.

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

## The one wall clock, and why it is over here

`session.ts` records **when the player was last actually present**, in its own `meta` object
store, keyed `last-played:<worldId>` — one visit per lot, since [[055]]. The Welcome Back card
([[040]]) is its only consumer, and it needed no changes: it still calls `readLastSession()` with
no arguments and still gets the right answer, because which world is meant was never the
caller's to know. A player who plays Lot #2 daily must still be greeted on Lot #1 after a month,
and must not be greeted on Lot #2 the next morning because the other lot moved a global clock.

It lives in this directory because it cannot live in the other one. §6 says the sim has no wall
clock and §12 bans `Date` from `packages/sim` outright — a timestamp inside `WorldState` would
change the state hash on every save and take every replay and every leaderboard with it. Its
own object store, rather than a field on the save, so there is no code path that reads it and
hands the result to the sim.

**Presence is gated on ticks, not on the page being open.** This is the same insight autosave
runs on, applied to a different question: the clock only writes when `state.tick` has _moved_
since the last write. A tab left open overnight is not a player playing overnight, and if the
timestamp kept advancing while nothing moved, a genuine week-long absence would be measured
from the wrong end. Wall clock answers _how long ago_; ticks answer _were they here_.

**Read before you write.** `startPresenceClock` overwrites the record, so anything that wants
the previous visit must call `readLastSession()` first. The HUD's `use-welcome.ts` memoises
that read at module scope specifically so a StrictMode double-mount cannot read back its own
heartbeat and conclude the player never left.

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
| `worlds.ts`     | The world registry, the record keys, and the delete window  |
| `saves.ts`      | `loadWorld`, `saveWorld`, `clearSavedWorld`, `readRawSaves` |
| `verify.ts`     | Loading a save back before agreeing to write it             |
| `trace.ts`      | Draining, reading, and exporting the input trace            |
| `persist.ts`    | `navigator.storage.persist()` and the quota estimate        |
| `autosave.ts`   | The tick-driven cadence and the best-effort flush           |
| `quota.ts`      | `isQuotaError`, the single retry, and the full-disk wording |
| `quarantine.ts` | Filing a record that would not load, and reading them back  |
| `notices.ts`    | The plain-language channel to the player                    |
| `session.ts`    | The last-played timestamp and the presence clock            |
| `index.ts`      | The public surface, plus `bootWorld()`                      |
