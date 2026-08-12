-- Snack Mogul — cloud save sync. Work item 016.
--
-- ONE TABLE. THAT IS THE WHOLE BACKEND. Plan §16.9: "Supabase: anonymous auth and save-blob
-- sync. Nothing else — no leaderboard tables until v0.5." §11 from the other direction:
-- "Deliberately small. Nothing about the game requires the server to be up."
--
-- DELIBERATELY ABSENT, and please do not add them here when the time comes — they belong to
-- their own work items: leaderboards, seasons, cohort tables, rollup jobs, pg_cron
-- schedules, percentile materialization, and the server-side replay validator. Lucas cut
-- every one of those (§10.9) when he chose a "fun, lightly validated" leaderboard and
-- accepted that determined cheaters will succeed. Not even a commented-out sketch.
--
-- ONE ROW PER PLAYER PER SLOT, enforced by the primary key. No append-only save history:
-- that is a storage bill and a schema decision nobody has made.

create table if not exists public.saves (
  -- `on delete cascade` so that deleting an auth user actually removes their world, rather
  -- than leaving an orphan row that no policy can ever match again.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- §6 locks one persistent world per player, so today there is exactly one slot and it is
  -- always 'default'. It is in the key anyway because adding a column to a primary key
  -- later is a genuinely painful migration, and adding a constant now costs nothing.
  slot text not null default 'default',

  -- The envelope header, lifted out of the blob into real columns. §12 makes balance data
  -- save-compatibility surface fused into `sim_version`, which makes `sim_version` the
  -- field that tells a future reader which code could safely load this row — so it has to
  -- be queryable without parsing a megabyte of JSON.
  format_version int not null check (format_version > 0),
  sim_version text not null,

  -- TEXT, NOT AN INTEGER TYPE, ON PURPOSE. Seeds are uint32 today. A text column never
  -- needs a migration on the day one of them is not.
  world_seed text not null,

  -- The game's actual clock (§6: an active hour is 72,000 ticks), and the ordering key the
  -- conflict rule uses. bigint because at 20 Hz an int4 overflows after about three and a
  -- half years of *active* play, which is a bug that would arrive with no warning.
  tick bigint not null check (tick >= 0),

  payload jsonb not null,

  -- WRITTEN BY THE DATABASE, NEVER BY THE CLIENT — see the trigger below. It is the
  -- conflict rule's tie-break, and a tie-break that trusts a clock we do not control is not
  -- a tie-break.
  updated_at timestamptz not null default now(),

  primary key (user_id, slot)
);

comment on table public.saves is
  'One Snack Mogul world per player per slot. A mirror of the local IndexedDB save, never '
  'the read path the game boots from — the client is local-first and plays fine with this '
  'table unreachable.';

-- `now()` is a column default, and a default does not re-fire on UPDATE. Without this the
-- tie-break timestamp would freeze at the moment the row was first inserted.
create or replace function public.saves_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists saves_set_updated_at on public.saves;
create trigger saves_set_updated_at
  before update on public.saves
  for each row
  execute function public.saves_set_updated_at();

-- Row Level Security -------------------------------------------------------------------
--
-- A NOTE ON ROLES THAT IS EASY TO GET BACKWARDS: a player who signed in with
-- `signInAnonymously()` is NOT the `anon` Postgres role. They hold a real JWT with
-- `role: authenticated` and a stable `sub`, plus an `is_anonymous: true` claim. The `anon`
-- role is for requests carrying no session at all, and it gets nothing here.
--
-- `(select auth.uid())` rather than a bare `auth.uid()`: wrapping it in a subselect lets
-- Postgres evaluate it once as an InitPlan instead of once per row.

alter table public.saves enable row level security;

create policy "Players read only their own save"
  on public.saves for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Players insert only their own save"
  on public.saves for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Both clauses are required on UPDATE: `using` decides which rows are visible to update,
-- `with check` stops a player from rewriting `user_id` and handing their row to somebody
-- else. Omitting the second one is the classic way an "obviously correct" policy leaks.
create policy "Players update only their own save"
  on public.saves for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Players delete only their own save"
  on public.saves for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Grants -------------------------------------------------------------------------------
--
-- RLS filters rows; grants decide who may attempt the statement at all. Both are needed.
-- No service-role bypass and no admin view: work item 016 forbids them, and nothing in
-- v0.1 reads this table from a server.

revoke all on table public.saves from anon;
grant select, insert, update, delete on table public.saves to authenticated;
