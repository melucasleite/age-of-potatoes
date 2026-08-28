# Accounts and cloud saves

**Accounts are required** (work item 143, 2026-08-27). Every player signs in — GitHub,
Google, or an email magic link — before anything else renders, and every world's save
mirrors to the live Supabase project (`snack-mogul`, ref `fikglrbievvcutrsgrcp`,
configured through `apps/web/.env.local`). A build with no Supabase env does not play
local-only; it shows a plain "cloud is not configured" screen instead of the game.

This reverses the v0.1 anonymous-first design on Lucas's direct instruction: _"I don't
want anonymous login or anonymous gameplay. Every user should have an account and all
saves should be persistent to the cloud."_ What did NOT reverse: **IndexedDB is still the
read path the game boots from.** The cloud is a required mirror, not a required
dependency mid-session — a network outage during play is still invisible, and every
network error is still swallowed, logged once at debug level, and retried with backoff.

## The door flow

1. `/play` mounts `app/play/play-client.tsx`, whose sign-in gate
   (`supabase/authGate.ts`, pure and tested) runs before the lot picker, the game, and
   every query-param bypass (`?artsheet` included).
2. No env → the "cloud is not configured" screen. Env but no session → the sign-in door
   (`hud/SignInDoor.tsx`): GitHub, Google, magic link. No guest path.
3. OAuth and magic links use the **PKCE flow** with `detectSessionInUrl: true`
   (`client.ts`): the return leg lands on `/play` carrying a `?code=`, the client
   exchanges it during initialisation, and the gate's `onAuthChange` subscription
   (`session.ts`) dismisses the door. The same subscription re-arms it on sign-out.
4. Signed in → the lot picker, which also reconciles every lot with the cloud
   (`worldsSync.ts`, below).

`getSession()` (`session.ts`) resolves a real persisted session or null — it never mints
anything. `signInAnonymously` is gone from the codebase.

## Sync: one row per world

The `saves` table's key is `(user_id, slot)`, and **`slot` is the local world id** — no
schema change was needed; the pre-143 code simply always wrote the one slot `'default'`.

- **The running world** mirrors through `cloudSync.ts`: one pull at start, then a 10s
  poll that pushes whenever the committed local save's tick moved. `bootstrap.ts` retains
  the handle now, and the ordered exit (`storage/exit.ts`) **flushes a final push after
  the exit save verifies, before teardown** (bounded at 5s — a dead network delays an
  exit, never traps one).
- **Every other world** is reconciled at the lot picker (`worldsSync.ts`, called by
  `FrontDoor.tsx`): lots the cloud has never seen are pushed, lots another device carried
  further are adopted, and the pre-143 `'default'` row is **moved** under the world it
  mirrors (matched by `world_seed`; see `worldsSyncPlan.ts` for the pure decisions). No
  envelope is destroyed anywhere in that flow — losers park under the world's local
  `conflict` key, and the `'default'` row is deleted only after its envelope verifiably
  lives somewhere else.

### The conflict rule (unchanged since 016)

**The envelope with the higher `tick` wins**, tie-broken by `updated_at` (which is
database-written, so no client clock is ever trusted). The loser is never destroyed: it
goes under the world's `conflict` key in IndexedDB. `../storage/cloudHandoff.ts` is still
the only seam between this directory and the save database. Adoption still takes effect
on the next boot of that world; a world being actively played parks the cloud copy
instead of swapping under the renderer.

## Dashboard switches this code depends on

These live in the dashboard and no client code can flip them — the full checklist with
URLs is in [`supabase/README.md`](../../../../supabase/README.md):

1. **Anonymous sign-ins: OFF** — the code no longer calls it, and leaving it on invites
   rows no account can ever reach again.
2. **GitHub and Google providers: ON**, each with its own OAuth app credentials.
3. **Manual linking: ON** — `linkIdentity()` (the panel's "add a sign-in method") errors
   without it.
4. **URL Configuration** — Site URL plus a redirect allow-list covering production and
   localhost, or the `redirectTo` this code sends is ignored.

## The rules this directory follows

**Boot never awaits the network.** The sign-in door awaits auth — that is its job — but
once a session exists, `bootWorld` still `void`s `startCloudSyncIfConfigured` and the
frame loop never waits on anything here.

**Every network error is swallowed, logged once at `console.debug`, and retried with
capped exponential backoff.** No toast, no modal, no error boundary mid-session.

**`packages/sim` knows nothing about any of this.** No import, no user id, no field that
varies with sync state. The state hash is identical online and offline.

**Rows are validated, never trusted.** A row coming back off the network is reassembled
into an envelope and put through the sim's own `parseEnvelope()` — the same validator a
save off the disk goes through. A malformed row is ignored exactly like a corrupt local
save.

## Files

| File                | What lives there                                                |
| ------------------- | --------------------------------------------------------------- |
| `env.ts`            | Which keys we have. Imports no SDK, so the gate is free         |
| `authGate.ts`       | The sign-in gate's states, pure and import-free                 |
| `bootstrap.ts`      | The dynamic-import gate, and the retained sync handle           |
| `client.ts`         | The one browser client, memoised, or `null`                     |
| `session.ts`        | Session reads, sign-in flows, linking, sign-out, `onAuthChange` |
| `profile.ts`        | The leaderboard display name, and the account status read       |
| `cloudSync.ts`      | The running world's loop: push, pull, conflict rule, backoff    |
| `worldsSync.ts`     | The lot picker reconciliation, and legacy-row adoption          |
| `worldsSyncPlan.ts` | That reconciliation's decisions, pure and import-free           |
| `log.ts`            | Deliberately quiet logging, and `once()`                        |
