do $$
declare
  author uuid := '00000000-0000-4000-8000-0000000000c1';
  voter uuid := '00000000-0000-4000-8000-0000000000c2';
  tip bigint;
  counts record;
begin
  if has_table_privilege('anon', 'public.lol_mayhem_combo_tips', 'SELECT')
    or has_table_privilege('authenticated', 'public.lol_mayhem_combo_tips', 'INSERT')
    or has_table_privilege('authenticated', 'public.lol_mayhem_combo_tip_votes', 'INSERT')
    or has_function_privilege('authenticated', 'public.vote_lol_mayhem_combo_tip(bigint, uuid, smallint)', 'EXECUTE') then
    raise exception 'combo tips must stay server-only';
  end if;
  insert into auth.users (id) values (author), (voter) on conflict do nothing;
  -- 공용 조합(챔피언 없음)과 아이템 없는 제보를 허용한다.
  insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, summary) values (author, '16.22', array[1,2], '공용 조합') returning id into tip;
  begin
    insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, summary) values (author, '16.22', '{}', '빈 증강');
    raise exception 'empty augments accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, item_ids, summary) values (author, '16.22', array[1], array[1,2,3,4,5,6,7], '아이템 초과');
    raise exception 'too many items accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, summary) values (author, '16.22', array[1], ' ');
    raise exception 'blank summary accepted';
  exception when check_violation then null;
  end;

  -- 추천, 비추천으로 바꾸기, 취소가 수를 다시 센다.
  select * into counts from public.vote_lol_mayhem_combo_tip(tip, voter, 1::smallint);
  if counts.up_count <> 1 or counts.down_count <> 0 then raise exception 'up vote count wrong'; end if;
  select * into counts from public.vote_lol_mayhem_combo_tip(tip, voter, -1::smallint);
  if counts.up_count <> 0 or counts.down_count <> 1 then raise exception 'changed vote count wrong'; end if;
  if (select score from public.lol_mayhem_combo_tips where id = tip) <> -1 then raise exception 'score wrong'; end if;
  select * into counts from public.vote_lol_mayhem_combo_tip(tip, voter, 0::smallint);
  if counts.up_count <> 0 or counts.down_count <> 0 then raise exception 'vote cancel wrong'; end if;
  begin
    perform public.vote_lol_mayhem_combo_tip(tip, author, 1::smallint);
    raise exception 'own vote accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.vote_lol_mayhem_combo_tip(-1, voter, 1::smallint);
    raise exception 'missing tip vote accepted';
  exception when no_data_found then null;
  end;

  -- 제보를 지우면 표도 함께 지워진다.
  perform public.vote_lol_mayhem_combo_tip(tip, voter, 1::smallint);
  delete from public.lol_mayhem_combo_tips where id = tip;
  if exists (select 1 from public.lol_mayhem_combo_tip_votes where tip_id = tip) then raise exception 'votes survived tip delete'; end if;
  delete from public.lol_mayhem_combo_tips where user_id = author;
end
$$;
