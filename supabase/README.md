# Supabase

Three migrations. That is the whole backend.

**A live project exists as of 2026-08-24**: `snack-mogul`, ref `fikglrbievvcutrsgrcp`, in the
"Lucas' Crafts" org (us-east-1, $10/month). All three migrations below are applied to it, and
`apps/web/.env.local` (gitignored) holds its URL and publishable key. The game still does not
need any of it to be playable — local-first is unchanged.

## What is in the database

- **`public.saves`** (`20260824144637_saves_table.sql`) — one row per player per slot, keyed
  `(user_id, slot)`. Envelope header in real columns (`format_version`, `sim_version`,
  `world_seed`, `tick`), world in `payload jsonb`. RLS on, all four policies scoped to
  `(select auth.uid()) = user_id`. `updated_at` is trigger-written; the conflict tie-break
  never trusts a client clock.
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

## Dashboard settings that SQL cannot express

Under Authentication → Sign In / Providers, the project needs, by hand:

1. **Anonymous sign-ins: ON** — the whole session model rests on it; off by default.
2. **Manual linking: ON** — `linkIdentity()` (anonymous → GitHub/Google upgrade) fails
   without it.
3. **GitHub provider** — needs a GitHub OAuth app's client id + secret. Callback URL:
   `https://fikglrbievvcutrsgrcp.supabase.co/auth/v1/callback`
4. **Google provider** — needs a Google Cloud OAuth client id + secret, same callback URL.
5. **URL Configuration** — Site URL `https://ageofpotatoes.com` (the production origin as of
   2026-08-24, on Vercel project `age-of-potatoes`), with `http://localhost:3000` and
   `http://localhost:3210` on the redirect allow-list so OAuth and magic links still land
   back in a dev session.

Email magic links ride the built-in email provider (on by default). The built-in SMTP is
rate-limited to a couple of messages an hour — fine for a hobby project, but custom SMTP is
the fix on the day it is not.

## Applying migrations

Applied to the live project via the Supabase MCP server; filenames carry the versions the
remote migration history assigned (`supabase migration list` agrees with `ls` here).
For a fresh project: `supabase link --project-ref <ref> && supabase db push`.

Naming: `<utc-timestamp>_<description>.sql`, applied in filename order, **append-only**.
Never edit a migration that has been applied to a real database — add another one. Same rule
as `packages/sim/src/save/migrations.ts`, for the same reason.
