# Supabase

Three migrations. That is the whole backend.

**A live project exists as of 2026-08-24**: `snack-mogul`, ref `fikglrbievvcutrsgrcp`, in the
"Lucas' Crafts" org (us-east-1, $10/month). All three migrations below are applied to it, and
`apps/web/.env.local` (gitignored) holds its URL and publishable key.

**The game requires it now** (work item 143, 2026-08-27): every player signs in — by email
magic link only, since the GitHub and Google doors were removed on 2026-09-02; no anonymous
path — and every world syncs to its own `saves` row
(`slot` = the local world id; the old single `'default'` slot is adopted by the client on
first contact). An unconfigured build shows a "cloud is not configured" screen instead of
the game. The read path is still local-first — IndexedDB boots the game and a mid-session
outage is invisible — but "playable with zero Supabase" is retired.

## What is in the database

- **`public.saves`** (`20260824144637_saves_table.sql`) — one row per player per slot, keyed
  `(user_id, slot)`. Envelope header in real columns (`format_version`, `sim_version`,
  `world_seed`, `tick`), world in `payload jsonb`. RLS on, all four policies scoped to
  `(select auth.uid()) = user_id`. `updated_at` is trigger-written; the conflict tie-break
  never trusts a client clock. Since work item 143 the slot is the LOCAL WORLD ID — one row
  per world — and the migration's "always `'default'`" comment describes the retired
  pre-143 behaviour (the client adopts any surviving `'default'` row into the world it
  mirrors; no schema change was needed, which is what putting `slot` in the key bought).
- **`public.profiles`** (`20260824144722_profiles_and_leaderboard.sql`) — one display name
  per player, 1–32 chars. Publicly readable (the leaderboard shows it); written only by its
  owner from the browser. No trigger on `auth.users` — Supabase restricted DDL there in
  2025, and a client-side upsert is sufficient.
- **`public.leaderboard_entries`** (same migration) — a few integers per `(user_id, slot)`,
  mirrored out of `payload -> stats` by an `after insert or update` trigger on `saves`
  (`lifetimeEarnedCents`, `ticksElapsed`, `cheatsUsed`). **No client writes, no write
  grants**: the only way to post a score is to sync a save that earns it. The trigger
  function is `security definer` with an empty `search_path`, and
  `20260824144909_revoke_mirror_execute.sql` revokes its `execute` from everyone so it is
  not even nominally on the RPC surface.
- **`public.leaderboard`** (view, `security_invoker`) — the public face, readable by `anon`
  and `authenticated`. Cheat-free rows only (`cheats_used = 0` — a save that ever ran a
  cheat code keeps syncing but stops appearing). `cents_per_active_hour` is computed with
  the exact `centsPerActiveHour` arithmetic from `apps/web/src/reports/rate.ts` — round(gain
  × 72,000 ÷ ticks) — and is NULL under six active minutes (`MIN_RATE_SPAN_TICKS`), the same
  floor for the same credibility reason. "Total" orders by `lifetime_earned_cents`; "per
  hour" orders by `cents_per_active_hour`.

The 2026-08-12 freeze ("no leaderboard tables until v0.5") was retired by Lucas's direct
request on 2026-08-24. Still absent, still deliberately (§10.9): seasons, cohorts, rollup
jobs, `pg_cron`, percentile materialization, the replay validator, any service-role bypass,
and any admin view. The leaderboard is fun and lightly validated; a determined cheater will
succeed, and lying to it requires lying to your own save file first.

## Dashboard checklist (work item 143) — settings SQL cannot express

The 143 flip (accounts required, no anonymous play) needs these confirmed by hand. Each is
a dashboard setting no client code can change:

1. **Anonymous sign-ins: OFF** (Authentication → Sign In / Providers). The code no longer
   calls `signInAnonymously()`, and leaving the switch on invites rows no account can ever
   reach. **Flipping it off strands the rows already owned by anonymous users** — those
   user ids can never sign in again, so their `saves`/`profiles` rows are dead weight.
   The local copies of those worlds are unaffected and re-push under whatever account
   signs in on that browser. Prune the orphans whenever convenient (Authentication →
   Users → filter Anonymous → delete; `on delete cascade` removes their rows).
2. **GitHub and Google providers: OFF** (Authentication → Sign In / Providers). The
   client no longer calls `signInWithOAuth()` or `linkIdentity()` — the sign-in door and
   the account panel offer the magic link only — so a provider left on is a door the game
   never draws. Their OAuth apps can be deleted; nothing references the callback URL.
3. **URL Configuration** — Site URL `https://ageofpotatoes.com` (the production origin as
   of 2026-08-24, on Vercel project `age-of-potatoes`), with `http://localhost:3000` and
   `http://localhost:3210` on the redirect allow-list. This list must cover EVERY origin
   the game is served from, production and dev both, or the `redirectTo` the sign-in door
   sends is ignored and magic links land on the Site URL instead of back in `/play`.

Email magic links ride the built-in email provider (on by default). The built-in SMTP is
rate-limited to a couple of messages an hour — that limit now gates SIGN-IN, not just
account linking, so custom SMTP is worth setting up sooner rather than later.

## Applying migrations

Applied to the live project via the Supabase MCP server; filenames carry the versions the
remote migration history assigned (`supabase migration list` agrees with `ls` here).
For a fresh project: `supabase link --project-ref <ref> && supabase db push`.

Naming: `<utc-timestamp>_<description>.sql`, applied in filename order, **append-only**.
Never edit a migration that has been applied to a real database — add another one. Same rule
as `packages/sim/src/save/migrations.ts`, for the same reason.
