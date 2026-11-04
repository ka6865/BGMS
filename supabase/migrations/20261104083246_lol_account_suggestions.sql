begin;
set local lock_timeout='2s';

create index lol_accounts_suggest_prefix on public.lol_accounts (lower(game_name) text_pattern_ops,lower(tag_line) text_pattern_ops)
where platform_id='kr' and regional_route='asia';

create or replace function public.suggest_lol_accounts(p_query text)
returns table(game_name text,tag_line text)
language sql stable security invoker set search_path='' as $$
  with input as (
    select lower(btrim(split_part(btrim(p_query),'#',1))) as name,
      lower(btrim(split_part(btrim(p_query),'#',2))) as tag,
      position('#' in p_query)>0 as has_tag
    where length(btrim(p_query)) between 2 and 81
      and p_query !~ '[[:cntrl:]]' and length(p_query)-length(replace(p_query,'#',''))<=1
  )
  select distinct a.game_name,a.tag_line
  from public.lol_accounts a cross join input q
  where a.platform_id='kr' and a.regional_route='asia' and q.name<>''
    and lower(a.game_name) like replace(replace(replace(q.name,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%'
    and (not q.has_tag or lower(a.tag_line) like replace(replace(replace(q.tag,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%')
  order by a.game_name,a.tag_line limit 8;
$$;
revoke all on function public.suggest_lol_accounts(text) from public,anon,authenticated;
grant execute on function public.suggest_lol_accounts(text) to service_role;
commit;
