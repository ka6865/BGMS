do $$
begin
  if not has_column_privilege('service_role', 'public.daily_ranker_stories', 'story', 'UPDATE') then
    raise exception 'service_role must update daily story display fields';
  end if;
  if has_column_privilege('service_role', 'public.daily_ranker_stories', 'match_id', 'UPDATE') then
    raise exception 'service_role must not rewrite daily story identity';
  end if;
  if has_table_privilege('anon', 'public.daily_ranker_stories', 'SELECT')
    or has_table_privilege('authenticated', 'public.daily_ranker_stories', 'SELECT') then
    raise exception 'daily stories must stay server-only';
  end if;
end
$$;
