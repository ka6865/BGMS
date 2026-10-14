-- 자기장 통계(scripts/extract_bluezone.ts)는 app-data/bluezone_data_v2.json 에 올리고 /api/bluezone 이 읽는다.
-- 운영에 버킷이 없어 새 경기가 생긴 2026-10-04 부터 업로드가 실패했다(bluezone-storage-upload-failed).
-- 그동안 API 는 저장소의 public/bluezone_data_v2.json 으로 대신 응답했다. 서버만 읽고 쓰므로 비공개로 만든다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('app-data', 'app-data', false, 20971520, array['application/json']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = array['application/json']::text[];
