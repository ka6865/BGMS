-- 증강 아이콘 저장소: 수집기가 패치별로 올리고 /api/lol/augment-icons가 서버에서 읽어 CDN으로 내보낸다.
-- 브라우저가 Storage에 직접 오지 않도록 비공개로 두고, 공개 역할은 기존 증강 버킷과 같이 차단한다.
begin;
set local lock_timeout = '2s';

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('lol-augment-icons','lol-augment-icons',false,2097152,array['image/png']::text[])
on conflict (id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create policy lol_augment_icons_objects_service_only on storage.objects as restrictive for all to anon,authenticated
  using (bucket_id <> 'lol-augment-icons') with check (bucket_id <> 'lol-augment-icons');
create policy lol_augment_icons_buckets_service_only on storage.buckets as restrictive for all to anon,authenticated
  using (id <> 'lol-augment-icons') with check (id <> 'lol-augment-icons');
create policy lol_augment_icons_objects_service_all on storage.objects for all to service_role
  using (bucket_id = 'lol-augment-icons') with check (bucket_id = 'lol-augment-icons');
create policy lol_augment_icons_buckets_service_all on storage.buckets for all to service_role
  using (id = 'lol-augment-icons') with check (id = 'lol-augment-icons');
commit;
