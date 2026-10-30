\set ON_ERROR_STOP on
begin;
create policy augment_icon_test_open_objects on storage.objects for all to anon,authenticated using (true) with check (true);
create policy augment_icon_test_open_buckets on storage.buckets for all to anon,authenticated using (true) with check (true);
insert into storage.objects(bucket_id,name) values ('lol-augment-icons','16.21/assets/ux/kiwi/augments/icons/test.png');
do $$
declare
  role_name text;
  changed integer;
begin
  if not exists (select 1 from storage.buckets where id='lol-augment-icons' and public=false and file_size_limit=2097152
    and allowed_mime_types=array['image/png']::text[]) then
    raise exception '증강 아이콘 버킷 설정이 다릅니다';
  end if;
  foreach role_name in array array['anon','authenticated'] loop
    execute format('set local role %I', role_name);
    if (select count(*) from storage.objects where bucket_id='lol-augment-icons') <> 0 then raise exception '% 객체 조회 허용', role_name; end if;
    if (select count(*) from storage.buckets where id='lol-augment-icons') <> 0 then raise exception '% 버킷 조회 허용', role_name; end if;
    delete from storage.objects where bucket_id='lol-augment-icons';
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception '% 객체 삭제 허용', role_name; end if;
    begin
      insert into storage.objects(bucket_id,name) values ('lol-augment-icons','denied.png');
      raise exception '% 객체 추가 허용', role_name;
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
  set local role service_role;
  insert into storage.objects(bucket_id,name) values ('lol-augment-icons','16.21/assets/ux/kiwi/augments/icons/service.png');
  if (select count(*) from storage.objects where bucket_id='lol-augment-icons') <> 2 then raise exception '서비스 역할 조회 실패'; end if;
  reset role;
end $$;
rollback;
