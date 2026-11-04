insert into public.official_game_catalog (category, source_url, items) values ('weapons', 'https://pubg.com/ko/game-info/weapons/etc', '[{"name":"RPD"}]');
set role anon;
do $$ begin
  if (select count(*) from public.official_game_catalog) <> 1 then raise exception 'public read failed'; end if;
  begin
    update public.official_game_catalog set items = '[]';
    raise exception 'anonymous update unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set role authenticated;
do $$ begin
  if (select count(*) from public.official_game_catalog) <> 1 then raise exception 'authenticated read failed'; end if;
  begin
    delete from public.official_game_catalog;
    raise exception 'authenticated delete unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set role service_role;
update public.official_game_catalog set items = '[{"name":"RPD", "updated":"2026-11-04"}]' where category = 'weapons';
reset role;
