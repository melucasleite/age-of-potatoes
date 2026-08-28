-- Snack Mogul — profiles and the leaderboard. The v0.5 leaderboard work item, arrived early
-- by Lucas's direct request (2026-08-24), which retires the "nothing until v0.5" freeze the
-- saves migration wrote down. Still within §10.9's ruling: fun, lightly validated, no replay
-- validator, no seasons, no cohorts. A determined cheater will succeed; a casual one is
-- filtered by the flag the sim already ratchets for us.
--
-- TWO TABLES AND A VIEW, and the leaderboard table is written by NOBODY. Not the client,
-- not a service role — only the trigger below, which mirrors a handful of integers out of
-- every save payload as it lands in `public.saves`. The client cannot write a score it did
-- not also write into its save, which is exactly the "lightly validated" bar: lying to the
-- leaderboard requires lying to your own save file first.

-- Profiles ------------------------------------------------------------------------------
--
-- The leaderboard needs a name to show, and `auth.users` is not readable by clients (nor
-- should it be — it holds emails). One row per player, created and edited by the player
-- from the browser. No trigger on `auth.users`: Supabase restricted DDL on the `auth`
-- schema in 2025, and a client-side upsert is both allowed and sufficient here.

create table if not exists public.profiles (
  user_id uuid not null primary key references auth.users (id) on delete cascade,

  -- Bounded because this string is rendered into every other player's browser. Length is
  -- the only validation; profanity is the sandbox's problem, not the schema's.
  display_name text not null
    check (char_length(display_name) between 1 and 32),

  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One display name per player, shown on the public leaderboard. Written only by its owner.';

-- Reuses the generic updated-at trigger function the saves migration created.
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.saves_set_updated_at();

alter table public.profiles enable row level security;

-- Readable by EVERYONE, including the keyless `anon` role: the leaderboard on the landing
-- page must render before (and whether) a session exists.
create policy "Display names are public"
  on public.profiles for select
  to anon, authenticated
  using (true);

create policy "Players insert only their own profile"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Players update only their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select on table public.profiles to anon;
grant select, insert, update on table public.profiles to authenticated;

-- Leaderboard entries -------------------------------------------------------------------
--
-- A few integers per (player, slot), mirrored out of the save payload by trigger. The
-- foreign key cascades from `saves`, so deleting a save (or the user above it) removes the
-- score with it — no orphan rows outliving the world they brag about.

create table if not exists public.leaderboard_entries (
  user_id uuid not null,
  slot text not null,

  -- Straight out of `stats` in the payload, same names, same units: integer cents and
  -- 20 Hz ticks. The database does not invent numbers; it copies the sim's.
  ticks_elapsed bigint not null check (ticks_elapsed >= 0),
  lifetime_earned_cents bigint not null check (lifetime_earned_cents >= 0),

  -- The honesty flag. `stats.cheatsUsed` lives inside the sim's hashed state precisely so
  -- that (per its own comment) "a personal best or a future leaderboard can annotate rather
  -- than adjudicate." This is that future leaderboard. Nonzero means the save keeps syncing
  -- and the world keeps playing — it just stops appearing in the view below.
  cheats_used int not null default 0 check (cheats_used >= 0),

  updated_at timestamptz not null default now(),

  primary key (user_id, slot),
  foreign key (user_id, slot) references public.saves (user_id, slot) on delete cascade
);

comment on table public.leaderboard_entries is
  'Score columns mirrored from public.saves by trigger. No client writes here, ever — '
  'the only way to post a score is to sync a save that earns it.';

alter table public.leaderboard_entries enable row level security;

create policy "Scores are public"
  on public.leaderboard_entries for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policies and no write grants ON PURPOSE. Writes arrive only via
-- the trigger below, whose function is SECURITY DEFINER. A plain `security invoker` trigger
-- would need write grants for `authenticated` on this table — which would also open the
-- Data API to hand-crafted scores, defeating the mirror.
grant select on table public.leaderboard_entries to anon, authenticated;

-- The mirror --------------------------------------------------------------------------
--
-- SECURITY DEFINER is safe in this one narrow shape: a trigger function cannot be invoked
-- directly (Postgres refuses to call trigger-returning functions outside a trigger), it
-- reads nothing but NEW — a row RLS on `saves` has already pinned to `auth.uid()` — and
-- `search_path` is pinned empty.
--
-- MALFORMED STATS NEVER BLOCK A SAVE. The save table is load-bearing for sync; the
-- leaderboard is decoration. If a payload's stats block is missing or unreadable, the save
-- lands and the score is simply skipped.

create or replace function public.saves_mirror_to_leaderboard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  earned bigint;
  ticks bigint;
  cheats int;
begin
  begin
    earned := (new.payload #>> '{stats,lifetimeEarnedCents}')::bigint;
    ticks := (new.payload #>> '{stats,ticksElapsed}')::bigint;
    cheats := (new.payload #>> '{stats,cheatsUsed}')::int;
  exception when others then
    return new;
  end;

  if earned is null or ticks is null or cheats is null then
    return new;
  end if;
  if earned < 0 or ticks < 0 or cheats < 0 then
    return new;
  end if;

  insert into public.leaderboard_entries
      (user_id, slot, ticks_elapsed, lifetime_earned_cents, cheats_used)
    values (new.user_id, new.slot, ticks, earned, cheats)
    on conflict (user_id, slot) do update set
      ticks_elapsed = excluded.ticks_elapsed,
      lifetime_earned_cents = excluded.lifetime_earned_cents,
      -- Taken from the payload, not ratcheted here: `cheatsUsed` is already monotonic
      -- within one world's lineage (it lives in hashed state), and a genuinely new world
      -- in the same slot deserves a clean flag.
      cheats_used = excluded.cheats_used,
      updated_at = now();

  return new;
end;
$$;

drop trigger if exists saves_mirror_to_leaderboard on public.saves;
create trigger saves_mirror_to_leaderboard
  after insert or update on public.saves
  for each row
  execute function public.saves_mirror_to_leaderboard();

-- The public face -----------------------------------------------------------------------
--
-- One view, both boards. "Total" orders by `lifetime_earned_cents`; "per hour" orders by
-- `cents_per_active_hour`. The rate column goes NULL below six active minutes — the same
-- MIN_RATE_SPAN_TICKS floor `apps/web/src/reports/rate.ts` draws, for the same reason: one
-- lucky harvest over twenty seconds extrapolates to a five-figure hourly rate, and a board
-- that opens with that number has spent its credibility. The arithmetic is
-- `centsPerActiveHour` verbatim: round(gain × 72,000 ÷ ticks), integer cents out.
--
-- `security_invoker` so the view runs as the caller and the tables' own RLS applies —
-- a plain view would run as its owner and quietly bypass every policy above.

create or replace view public.leaderboard
with (security_invoker = true) as
select
  le.user_id,
  le.slot,
  coalesce(p.display_name, 'Anonymous Mogul') as display_name,
  le.lifetime_earned_cents,
  le.ticks_elapsed,
  case
    when le.ticks_elapsed >= 7200 -- MIN_RATE_SPAN_TICKS: TICKS_PER_ACTIVE_HOUR / 10
      then round((le.lifetime_earned_cents * 72000)::numeric / le.ticks_elapsed)::bigint
    else null
  end as cents_per_active_hour,
  le.updated_at
from public.leaderboard_entries le
left join public.profiles p using (user_id)
where le.cheats_used = 0;

comment on view public.leaderboard is
  'Cheat-free scores with display names. Rate is NULL under six active minutes of play; '
  'a save with cheats_used > 0 does not appear at all.';

grant select on public.leaderboard to anon, authenticated;
