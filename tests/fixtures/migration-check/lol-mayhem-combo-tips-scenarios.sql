do $$
declare
  member uuid := '00000000-0000-4000-8000-0000000000c1';
begin
  if has_table_privilege('anon', 'public.lol_mayhem_combo_tips', 'SELECT')
    or has_table_privilege('authenticated', 'public.lol_mayhem_combo_tips', 'INSERT') then
    raise exception 'combo tips must stay server-only';
  end if;
  insert into auth.users (id) values (member) on conflict do nothing;
  -- 공용 조합(챔피언 없음)과 아이템 없는 제보를 허용한다.
  insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, summary) values (member, '16.22', array[1,2], '공용 조합');
  begin
    insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, summary) values (member, '16.22', '{}', '빈 증강');
    raise exception 'empty augments accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, item_ids, summary) values (member, '16.22', array[1], array[1,2,3,4,5,6,7], '아이템 초과');
    raise exception 'too many items accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_mayhem_combo_tips (user_id, client_patch, augment_ids, summary) values (member, '16.22', array[1], ' ');
    raise exception 'blank summary accepted';
  exception when check_violation then null;
  end;
  delete from public.lol_mayhem_combo_tips where user_id = member;
end
$$;
