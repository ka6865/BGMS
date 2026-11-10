do $$
begin
  if has_table_privilege('anon', 'public.lol_mayhem_offer_rules', 'SELECT') or has_table_privilege('authenticated', 'public.lol_mayhem_offer_rules', 'INSERT') then
    raise exception 'offer rules must stay server-only';
  end if;
  if (select count(*) from public.lol_mayhem_offer_rules where status = 'active') <> 10 then raise exception 'seed rules missing'; end if;
  -- 대상 증강이 없는 패치노트 문장은 후보로만 쌓이고, 같은 문장은 한 번만 들어간다.
  insert into public.lol_mayhem_offer_rules (kind, status, source_quote) values ('condition', 'candidate', '전환: 프리즘에서 더 이상 등장하지 않습니다.')
    on conflict (source_quote) do nothing;
  insert into public.lol_mayhem_offer_rules (kind, status, source_quote) values ('condition', 'candidate', '전환: 프리즘에서 더 이상 등장하지 않습니다.')
    on conflict (source_quote) do nothing;
  if (select count(*) from public.lol_mayhem_offer_rules where status = 'candidate') <> 1 then raise exception 'candidate dedupe failed'; end if;
  begin
    update public.lol_mayhem_offer_rules set status = 'active' where status = 'candidate';
    raise exception 'active rule without augment accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_mayhem_offer_rules (augment_id, kind, patch) values (1134, 'random_excluded', '26.22');
    raise exception 'duplicate random exclusion accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.lol_mayhem_offer_rules (augment_id, kind, text) values (1134, 'condition', ' ');
    raise exception 'blank active condition accepted';
  exception when check_violation then null;
  end;
  delete from public.lol_mayhem_offer_rules where status = 'candidate';
end
$$;
