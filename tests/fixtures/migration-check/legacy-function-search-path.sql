-- Runs only in the verifier's disposable PostgreSQL database.
do $$
declare
  target record;
begin
  for target in
    select * from (values
      -- 20261014110000 부터 서버(service role) 전용이다.
      ('public.suggest_similar_players(text,text,integer)', true),
      ('public.get_db_size()', true),
      ('public.handle_new_user()', true),
      ('public.delete_orphaned_stats()', true),
      ('public.delete_orphaned_stats_limited(integer)', true),
      ('public.get_orphaned_match_ids()', true),
      ('public.increment_player_search_count(text,text,text)', true)
    ) as t(signature, service_only)
  loop
    if not exists(
      select from pg_proc
      where oid = target.signature::regprocedure
        and array_position(proconfig, 'search_path=public') is not null
    ) then
      raise exception '% must pin search_path to public', target.signature;
    end if;
    if not has_function_privilege('service_role', target.signature, 'EXECUTE') then
      raise exception '% must stay executable by service_role', target.signature;
    end if;
    if target.service_only and (
      has_function_privilege('anon', target.signature, 'EXECUTE')
      or has_function_privilege('authenticated', target.signature, 'EXECUTE')
    ) then
      raise exception '% must not be executable by anon or authenticated', target.signature;
    end if;
    if not target.service_only and not has_function_privilege('anon', target.signature, 'EXECUTE') then
      raise exception '% is called by the stats SSR client and must stay executable by anon', target.signature;
    end if;
  end loop;
end;
$$;
