# Supabase

One table. That is the whole backend.

**No project is provisioned for this repo yet**, and nothing here has been applied to a live
database. The migration is written and reviewed but unrun — see the agent log on work item 016. The game does not need any of it to be playable.

## Applying it

```bash
# Once, against a project you created in the dashboard:
supabase link --project-ref <ref>
supabase db push
```

Or paste [`migrations/20260812120000_saves_table.sql`](./migrations/20260812120000_saves_table.sql)
into the dashboard's SQL editor. It is idempotent enough to re-run: the table is
`create table if not exists` and the trigger is dropped before it is created. The four
policies are not — drop them first if you are re-applying by hand.

**Also required, and not expressible in SQL:** enable **Anonymous sign-ins** under
Authentication → Sign In / Providers. It is off by default on new projects and there is no
client-side way to turn it on.

## What is in `public.saves`

One row per player per slot, keyed `(user_id, slot)`. The envelope header lives in real
columns (`format_version`, `sim_version`, `world_seed`, `tick`) and the world itself lives in
`payload jsonb`. RLS is on, with four policies all scoped to `(select auth.uid()) = user_id`.

`sim_version` is a column rather than a field inside the blob on purpose: plan §12 makes
balance data save-compatibility surface fused into that string, which makes it the field
that says which code could safely load a given row. That question should be answerable
without parsing a megabyte of JSON.

## What is deliberately not here

Leaderboards, seasons, cohort tables, rollup jobs, `pg_cron` schedules, percentile
materialization, and the server-side replay validator. Lucas cut every one of them (plan
§10.9) when he chose a "fun, lightly validated" leaderboard and accepted that determined
cheaters will succeed. **One** leaderboard table arrives at v0.5, in its own work item. Not
even a commented-out sketch belongs here before then.

There is also no service-role bypass and no admin view. Nothing in v0.1 reads this table
from a server; every call is made by the signed-in browser.

## Migration naming

`<utc-timestamp>_<description>.sql`, applied in filename order, **append-only**. Never edit
a migration that has been applied to a real database — add another one. This is the same
rule the save-format migration chain follows in `packages/sim/src/save/migrations.ts`, for
the same reason.
