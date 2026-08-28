-- Postgres grants EXECUTE to PUBLIC on every new function, which put the leaderboard
-- mirror on the Data API's RPC surface for anyone holding the publishable key. Calling a
-- trigger-returning function over RPC fails anyway ("trigger functions can only be called
-- as triggers"), but the security advisor flags it and the grant buys nothing: trigger
-- firing does not require the invoking role to hold EXECUTE. So: nobody gets it.

revoke execute on function public.saves_mirror_to_leaderboard()
  from public, anon, authenticated;
