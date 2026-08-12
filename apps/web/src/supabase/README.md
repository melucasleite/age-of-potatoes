# Cloud sync

**There is no Supabase project provisioned for this repo.** Everything in this directory is
inert until someone sets two environment variables, and "inert" is meant literally: with no
keys configured the Supabase SDK is never even downloaded, because
[`bootstrap.ts`](./bootstrap.ts) checks the env synchronously and only then dynamically
imports the client.

That is the design, not a temporary state. Plan §11: _"Deliberately small. Nothing about the
game requires the server to be up."_ IndexedDB is the source of truth; this is a mirror.

## Why this exists at v0.1 when leaderboards arrive at v0.8

Plan §10.2: _"Retrofitting auth into a years-old persistent-world save format is the
expensive path; doing it first is cheap."_ This is not a leaderboard prerequisite built
early. It is an ownership column added to a save format while that format has exactly one
released version, and an anonymous user id minted before there are any worlds that would
need re-homing.

[`linkEmailToCurrentUser()`](./session.ts) is the payoff and the reason the item is worth
doing now: a player can attach an email to their **existing** anonymous user later, keeping
the same `user.id`, and therefore the same `saves` row, with no migration and without losing
a tick. It ships as a function with no UI — an account screen is not v0.1 scope, and
building the function now is what keeps the door open.

## Setup, when someone provisions a project

1. Create the project. Note its ref.
2. **Authentication → Sign In / Providers → enable Anonymous sign-ins.** It is off by
   default and it is a dashboard setting — no client code can turn it on. Without it,
   `signInAnonymously()` returns an `anonymous_provider_disabled` error, sync stays off, and
   the game plays exactly as it does now.
3. Apply [`supabase/migrations`](../../../../supabase/migrations) — see the README there.
4. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the URL and the
   **publishable** key (`sb_publishable_…`, under Project Settings → API Keys).

The legacy `anon` JWT key still works and is still accepted by [`env.ts`](./env.ts) as a
fallback, but Supabase has it scheduled for retirement at the end of 2026.

## The rules this directory follows

**Nothing on the critical path waits for a session.** The game renders, plays, and autosaves
whether or not `getSession()` ever settles. It is called from the boot path with `void` and
is never awaited. A player who meets a spinner before they meet a watering can fails work
item 017's ship gate.

**Every network error is swallowed, logged once at `console.debug`, and retried with capped
exponential backoff.** No toast, no modal, no banner, no error boundary. A player with the
network off must not be able to tell this exists. A paused project and a plane with no wifi
are normal operating conditions, not incidents.

**`packages/sim` knows nothing about any of this.** No import, no user id, no field that
varies with sync state. The state hash is identical online and offline, which is what keeps
the golden determinism test meaningful.

**Rows are validated, never trusted.** A row coming back off the network is reassembled into
an envelope and put through the sim's own `parseEnvelope()` — the same validator a save off
the disk goes through. A malformed row is ignored exactly like a corrupt local save.

## The conflict rule

**The envelope with the higher `tick` wins**, tie-broken by `updated_at`.

Ticks are the game's real clock (§6: an active hour is 72,000 ticks) and are monotonic
within one world's lineage, which makes them a better ordering key than wall-clock time on a
machine whose clock we do not control — a player whose laptop is set to 2019 still syncs
correctly. `updated_at` is written by a database trigger rather than the client, so even the
tie-break does not depend on that clock.

**The loser is never destroyed.** It goes under the `conflict` key in IndexedDB, next to
`current` and `previous`. See [`../storage/cloudHandoff.ts`](../storage/cloudHandoff.ts) —
that file is the only seam between this directory and the save database.

### The v0.1 narrowing, stated plainly

Adoption swaps the record on disk; it does not hot-swap the world running under the
renderer. So a cloud save that wins takes effect **on the next reload**, and the log says so.
If the player has already played this session, the cloud copy is parked under `conflict`
instead of being written and then immediately clobbered by the next autosave. Either way
both envelopes survive. Rebuilding a live world underneath Pixi is well outside this item's
scope and is not something a single-device v0.1 needs.

## Files

| File           | What lives there                                            |
| -------------- | ----------------------------------------------------------- |
| `env.ts`       | Which keys we have. Imports no SDK, so the gate is free     |
| `bootstrap.ts` | The gate: dynamically imports the rest only when configured |
| `client.ts`    | The one browser client, memoised, or `null`                 |
| `session.ts`   | Anonymous sign-in, and the identity-upgrade helper          |
| `cloudSync.ts` | Push, pull, the conflict rule, and the backoff policy       |
| `log.ts`       | Deliberately quiet logging, and `once()`                    |
