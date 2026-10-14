-- Runs only in the verifier's disposable PostgreSQL database.
do $$ begin
  if not exists(select 1 from storage.buckets where id='app-data' and not public
      and file_size_limit=20971520 and allowed_mime_types=array['application/json']::text[]) then
    raise exception 'FAIL: app-data bucket for bluezone statistics';
  end if;
  raise notice 'PASS: bluezone app-data bucket';
end $$;
