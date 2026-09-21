-- The private player registry now contains stable account IDs and must never be
-- readable through the public system_settings policy.
drop policy if exists "Allow public read system_settings" on public.system_settings;

create policy "Allow public read non-private system_settings"
  on public.system_settings for select
  using (key <> 'private_players_list');

-- Serialize private-player writes at the row level. The old read/modify/upsert
-- sequence could lose one of two concurrent privacy decisions.
create or replace function public.add_private_player(
  p_platform text,
  p_nickname text,
  p_account_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform text := lower(trim(p_platform));
  v_nickname text := trim(p_nickname);
  v_lower_nickname text := lower(trim(p_nickname));
  v_value text;
  v_rows jsonb := '[]'::jsonb;
  v_item jsonb;
  v_matched boolean := false;
  v_item_platform text;
  v_item_lower text;
  v_item_account_id text;
begin
  if v_platform = '' or v_nickname = '' then
    raise exception 'private_player_invalid_input' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private_players_list', 47116));
  select value into v_value
  from public.system_settings
  where key = 'private_players_list'
  for update;

  for v_item in select value from jsonb_array_elements(
    case when coalesce(v_value, '') = '' then '[]'::jsonb else v_value::jsonb end
  ) loop
    v_item_platform := lower(trim(coalesce(v_item->>'platform', '')));
    v_item_lower := lower(trim(coalesce(v_item->>'lower_nickname', v_item->>'nickname', '')));
    v_item_account_id := nullif(trim(v_item->>'account_id'), '');
    if not v_matched
      and (v_item_platform = v_platform or v_item_platform = 'all')
      and (
        (nullif(trim(p_account_id), '') is not null and v_item_account_id = trim(p_account_id))
        or (nullif(trim(p_account_id), '') is null and v_item_account_id is null and v_item_lower = v_lower_nickname)
      ) then
      v_matched := true;
      if v_item_platform = v_platform then
        v_item := v_item || jsonb_build_object('nickname', v_nickname, 'lower_nickname', v_lower_nickname);
      end if;
      if nullif(trim(p_account_id), '') is not null then
        v_item := v_item || jsonb_build_object('account_id', trim(p_account_id));
      end if;
    end if;
    v_rows := v_rows || jsonb_build_array(v_item);
  end loop;

  if not v_matched then
    v_rows := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'platform', v_platform,
      'nickname', v_nickname,
      'lower_nickname', v_lower_nickname,
      'account_id', nullif(trim(p_account_id), ''),
      'created_at', now()
    ))) || v_rows;
  end if;

  insert into public.system_settings (key, value, description, updated_at)
  values ('private_players_list', v_rows::text, '전적 비공개 처리된 배틀그라운드 플레이어 목록', now())
  on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = excluded.updated_at;
  return v_rows;
end;
$$;

revoke all on function public.add_private_player(text, text, text) from public, anon, authenticated;
grant execute on function public.add_private_player(text, text, text) to service_role;

create or replace function public.remove_private_player(
  p_platform text,
  p_nickname text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform text := lower(trim(p_platform));
  v_lower_nickname text := lower(trim(p_nickname));
  v_value text;
  v_rows jsonb := '[]'::jsonb;
  v_item jsonb;
begin
  if v_platform = '' or v_lower_nickname = '' then
    raise exception 'private_player_invalid_input' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private_players_list', 47116));
  select value into v_value
  from public.system_settings
  where key = 'private_players_list'
  for update;
  for v_item in select value from jsonb_array_elements(
    case when coalesce(v_value, '') = '' then '[]'::jsonb else v_value::jsonb end
  ) loop
    if lower(trim(coalesce(v_item->>'platform', ''))) <> v_platform
      or lower(trim(coalesce(v_item->>'lower_nickname', v_item->>'nickname', ''))) <> v_lower_nickname then
      v_rows := v_rows || jsonb_build_array(v_item);
    end if;
  end loop;
  insert into public.system_settings (key, value, description, updated_at)
  values ('private_players_list', v_rows::text, '전적 비공개 처리된 배틀그라운드 플레이어 목록', now())
  on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = excluded.updated_at;
  return v_rows;
end;
$$;

revoke all on function public.remove_private_player(text, text) from public, anon, authenticated;
grant execute on function public.remove_private_player(text, text) to service_role;

-- Storage's internal schema is not necessarily exposed through PostgREST. Keep
-- completion metadata validation in a service-role RPC that can read the
-- internal storage.objects table and update the reservation under one lock.
create or replace function public.complete_support_attachment(
  p_attachment_id uuid,
  p_owner_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attachment public.support_attachments%rowtype;
  v_mime_type text;
  v_size bigint;
begin
  select attachment.* into v_attachment
  from public.support_attachments as attachment
  where attachment.id = p_attachment_id
    and attachment.uploader_id = p_owner_user_id
    and attachment.status = 'pending'
  for update;
  if not found then
    select attachment.* into v_attachment
    from public.support_attachments as attachment
    where attachment.id = p_attachment_id
      and attachment.uploader_id = p_owner_user_id;
    if found and v_attachment.status = 'ready' then return 'ready'; end if;
    return 'not_found';
  end if;

  select object_row.metadata ->> 'mimetype',
    case when object_row.metadata ->> 'size' ~ '^[0-9]+$' then (object_row.metadata ->> 'size')::bigint else null end
  into v_mime_type, v_size
  from storage.objects as object_row
  where object_row.bucket_id = v_attachment.bucket_id
    and object_row.name = v_attachment.storage_key;
  if not found then
    return 'upload_missing';
  end if;
  if v_mime_type is null or v_size is null then
    return 'upload_metadata_invalid';
  end if;
  if lower(v_mime_type) is distinct from lower(v_attachment.mime_type)
    or v_size is distinct from v_attachment.byte_size then
    return 'upload_metadata_mismatch';
  end if;

  update public.support_attachments
  set status = 'ready'
  where id = v_attachment.id;
  return 'ready';
end;
$$;

revoke all on function public.complete_support_attachment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_support_attachment(uuid, uuid) to service_role;

create or replace function public.claim_support_attachment_cleanup(
  p_attachment_id uuid,
  p_now timestamptz default now()
)
returns table(id uuid, ticket_id uuid, storage_key text, previous_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attachment public.support_attachments%rowtype;
  v_ticket_status text;
  v_resolved_at timestamptz;
begin
  select attachment.* into v_attachment
  from public.support_attachments as attachment
  where attachment.id = p_attachment_id
    and attachment.status in ('pending', 'ready', 'deleting')
  for update;
  if not found then return; end if;

  if v_attachment.ticket_id is null then
    if v_attachment.expires_at is null or v_attachment.expires_at > p_now then return; end if;
  else
    select ticket.status, ticket.resolved_at
    into v_ticket_status, v_resolved_at
    from public.support_tickets as ticket
    where ticket.id = v_attachment.ticket_id
    for update;
    if v_ticket_status not in ('resolved', 'rejected')
      or v_resolved_at is null
      or v_resolved_at > p_now - interval '30 days' then
      return;
    end if;
  end if;

  update public.support_attachments
  set status = 'deleting'
  where support_attachments.id = v_attachment.id;
  return query select v_attachment.id, v_attachment.ticket_id, v_attachment.storage_key, v_attachment.status;
end;
$$;

revoke all on function public.claim_support_attachment_cleanup(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_support_attachment_cleanup(uuid, timestamptz) to service_role;

create or replace function public.reserve_support_attachment(
  p_owner_user_id uuid,
  p_mime_type text,
  p_byte_size integer,
  p_original_name text
)
returns table(id uuid, bucket_id text, storage_key text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_total bigint;
  v_id uuid := gen_random_uuid();
begin
  if p_owner_user_id is null
    or lower(trim(p_mime_type)) not in ('image/png', 'image/jpeg', 'image/webp')
    or p_byte_size is null or p_byte_size <= 0 or p_byte_size > 3145728
    or nullif(trim(p_original_name), '') is null then
    raise exception 'support_attachment_invalid_input' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_user_id::text, 47115));
  select count(*)::integer, coalesce(sum(byte_size), 0)::bigint
  into v_count, v_total
  from public.support_attachments
  where uploader_id = p_owner_user_id
    and ticket_id is null
    and status in ('pending', 'ready');
  if v_count >= 3 or v_total + p_byte_size > 9437184 then
    raise exception 'support_attachment_quota' using errcode = 'P0001';
  end if;

  return query
  insert into public.support_attachments (
    id, ticket_id, uploader_id, bucket_id, storage_key, original_name,
    mime_type, byte_size, status, expires_at
  ) values (
    v_id, null, p_owner_user_id, 'support-evidence', 'attachments/' || v_id::text,
    left(trim(p_original_name), 255), lower(trim(p_mime_type)), p_byte_size, 'pending',
    now() + interval '24 hours'
  )
  returning support_attachments.id, support_attachments.bucket_id, support_attachments.storage_key;
end;
$$;

revoke all on function public.reserve_support_attachment(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_support_attachment(uuid, text, integer, text) to service_role;

create or replace function public.append_support_message(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_sender_type text,
  p_body text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_message public.support_messages%rowtype;
  v_next_status text;
  v_now timestamptz := now();
begin
  if p_ticket_id is null or p_actor_id is null or p_sender_type not in ('user', 'admin')
    or nullif(trim(p_body), '') is null or char_length(trim(p_body)) > 5000 then
    return jsonb_build_object('code', 'invalid_input');
  end if;

  select ticket.* into v_ticket
  from public.support_tickets as ticket
  where ticket.id = p_ticket_id
  for update;
  if not found then return jsonb_build_object('code', 'not_found'); end if;
  if (p_sender_type = 'user' and v_ticket.requester_id is distinct from p_actor_id)
    or (p_sender_type = 'admin' and not exists (
      select 1 from public.profiles as profile where profile.id = p_actor_id and profile.role = 'admin'
    )) then
    return jsonb_build_object('code', 'forbidden');
  end if;

  if nullif(trim(p_idempotency_key), '') is not null then
    select message.* into v_message
    from public.support_messages as message
    where message.ticket_id = p_ticket_id
      and message.sender_type = p_sender_type
      and message.idempotency_key = trim(p_idempotency_key)
    for update;
    if found then
      if v_message.body is distinct from trim(p_body) then
        return jsonb_build_object('code', 'idempotency_conflict');
      end if;
      return to_jsonb(v_message);
    end if;
  end if;

  v_next_status := case
    when p_sender_type = 'user' and v_ticket.status in ('awaiting_user', 'answered', 'resolved', 'rejected') then 'in_progress'
    when p_sender_type = 'admin' and v_ticket.status in ('new', 'in_progress', 'awaiting_user') then 'answered'
    else v_ticket.status
  end;

  insert into public.support_messages (ticket_id, sender_id, sender_type, idempotency_key, body)
  values (p_ticket_id, p_actor_id, p_sender_type, nullif(trim(p_idempotency_key), ''), trim(p_body))
  returning * into v_message;

  update public.support_tickets
  set status = v_next_status,
      last_message_at = v_now,
      last_message_sender = p_sender_type,
      user_last_read_at = case when p_sender_type = 'user' then v_now else user_last_read_at end,
      admin_last_read_at = case when p_sender_type = 'admin' then v_now else admin_last_read_at end,
      resolved_at = case
        when v_next_status in ('resolved', 'rejected')
          and v_ticket.status not in ('resolved', 'rejected') then v_now
        when v_next_status not in ('resolved', 'rejected')
          and v_ticket.status in ('resolved', 'rejected') then null
        else resolved_at
      end
  where id = p_ticket_id;

  if v_next_status is distinct from v_ticket.status then
    insert into public.support_ticket_events (
      ticket_id, actor_id, event_type, from_status, to_status, metadata
    ) values (
      p_ticket_id, p_actor_id, 'status_changed', v_ticket.status, v_next_status,
      jsonb_build_object('reason', p_sender_type || '_message', 'message_id', v_message.id)
    );
  end if;
  if p_sender_type = 'admin' and v_ticket.requester_id is not null then
    insert into public.notifications (
      user_id, sender_id, sender_name, type, post_id, support_ticket_id, support_message_id, preview_text
    ) values (
      v_ticket.requester_id, p_actor_id, '관리자', 'support_reply', null, p_ticket_id, v_message.id,
      left(
        trim(regexp_replace(
          regexp_replace(p_body, 'https?://[^[:space:]]+', '', 'gi'),
          '[[:space:]]+', ' ', 'g'
        )),
        200
      )
    ) on conflict (support_message_id) do nothing;
  end if;
  return to_jsonb(v_message);
exception
  when unique_violation then
    select message.* into v_message
    from public.support_messages as message
    where message.ticket_id = p_ticket_id
      and message.sender_type = p_sender_type
      and message.idempotency_key = nullif(trim(p_idempotency_key), '');
    if found then return to_jsonb(v_message); end if;
    raise;
end;
$$;

revoke all on function public.append_support_message(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.append_support_message(uuid, uuid, text, text, text) to service_role;

-- Complete a verified privacy request in one transaction. This keeps the
-- verification check, account-ID registry update, audit event, and terminal
-- ticket transition together even when two admins click at the same time.
create or replace function public.apply_support_privacy_action(
  p_ticket_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_existing_event text;
  v_value text;
  v_rows jsonb := '[]'::jsonb;
  v_item jsonb;
  v_platform text;
  v_nickname text;
  v_lower_nickname text;
  v_account_id text;
  v_item_platform text;
  v_item_account_id text;
  v_item_lower_nickname text;
  v_matched boolean := false;
  v_outcome text := 'registered';
begin
  if p_ticket_id is null or p_actor_id is null then
    return jsonb_build_object('code', 'invalid_input');
  end if;
  if not exists (
    select 1 from public.profiles as profile
    where profile.id = p_actor_id and profile.role = 'admin'
  ) then
    return jsonb_build_object('code', 'forbidden');
  end if;

  select ticket.* into v_ticket
  from public.support_tickets as ticket
  where ticket.id = p_ticket_id
  for update;
  if not found then return jsonb_build_object('code', 'not_found'); end if;
  if v_ticket.category <> 'privacy' or v_ticket.verification_status <> 'verified' then
    return jsonb_build_object('code', 'not_verified');
  end if;
  if nullif(trim(v_ticket.target_platform), '') is null
    or nullif(trim(v_ticket.target_account_id), '') is null
    or trim(v_ticket.target_account_id) !~ '^account\.[A-Za-z0-9_-]+$'
    or nullif(trim(coalesce(v_ticket.target_resolved_nickname, v_ticket.target_nickname)), '') is null then
    return jsonb_build_object('code', 'invalid_target');
  end if;
  if v_ticket.status = 'rejected' then
    return jsonb_build_object('code', 'invalid_status');
  end if;

  select event.event_type into v_existing_event
  from public.support_ticket_events as event
  where event.ticket_id = p_ticket_id
    and event.event_type in ('privacy_player_registered', 'privacy_player_already_registered')
  order by event.created_at desc
  limit 1;
  if v_existing_event is not null then
    v_outcome := case when v_existing_event = 'privacy_player_already_registered'
      then 'already_registered' else 'registered' end;
  end if;

  if v_existing_event is null then
    v_platform := lower(trim(v_ticket.target_platform));
    v_nickname := trim(coalesce(v_ticket.target_resolved_nickname, v_ticket.target_nickname));
    v_lower_nickname := lower(v_nickname);
    v_account_id := trim(v_ticket.target_account_id);

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private_players_list', 47116));
    select value into v_value
    from public.system_settings
    where key = 'private_players_list'
    for update;

    for v_item in select value from jsonb_array_elements(
      case when coalesce(v_value, '') = '' then '[]'::jsonb else v_value::jsonb end
    ) loop
      v_item_platform := lower(trim(coalesce(v_item->>'platform', '')));
      v_item_account_id := nullif(trim(v_item->>'account_id'), '');
      v_item_lower_nickname := lower(trim(coalesce(v_item->>'lower_nickname', v_item->>'nickname', '')));
      if not v_matched
        and (v_item_platform = v_platform or v_item_platform = 'all')
        and v_item_account_id = v_account_id then
        v_matched := true;
        v_outcome := 'already_registered';
        if v_item_platform = v_platform then
          v_item := v_item || jsonb_build_object(
            'nickname', v_nickname,
            'lower_nickname', v_lower_nickname,
            'account_id', v_account_id
          );
        end if;
      end if;
      v_rows := v_rows || jsonb_build_array(v_item);
    end loop;

    if not v_matched then
      v_rows := jsonb_build_array(jsonb_build_object(
        'platform', v_platform,
        'nickname', v_nickname,
        'lower_nickname', v_lower_nickname,
        'account_id', v_account_id,
        'created_at', now()
      )) || v_rows;
    end if;

    insert into public.system_settings (key, value, description, updated_at)
    values ('private_players_list', v_rows::text, '전적 비공개 처리된 배틀그라운드 플레이어 목록', now())
    on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = excluded.updated_at;

    insert into public.support_ticket_events (
      ticket_id, actor_id, event_type, metadata
    ) values (
      p_ticket_id, p_actor_id,
      case when v_outcome = 'already_registered' then 'privacy_player_already_registered' else 'privacy_player_registered' end,
      jsonb_build_object('account_id', v_account_id, 'outcome', v_outcome)
    );
  end if;

  if v_ticket.status <> 'resolved' then
    update public.support_tickets
    set status = 'resolved', resolved_at = coalesce(v_ticket.resolved_at, now())
    where id = p_ticket_id;
    insert into public.support_ticket_events (
      ticket_id, actor_id, event_type, from_status, to_status, metadata
    ) values (
      p_ticket_id, p_actor_id, 'status_changed', v_ticket.status, 'resolved',
      jsonb_build_object('reason', 'privacy_action', 'outcome', v_outcome)
    );
  end if;
  return jsonb_build_object('outcome', v_outcome);
end;
$$;

revoke all on function public.apply_support_privacy_action(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_support_privacy_action(uuid, uuid) to service_role;

create unique index if not exists support_retention_event_once_idx
  on public.support_ticket_events(ticket_id, ((metadata ->> 'attachment_id')))
  where event_type = 'retention_deleted' and metadata ? 'attachment_id';

-- Admin state transitions must lock the ticket and append audit events in the
-- same transaction. The API still validates the user-facing transition before
-- calling this RPC, while the locked check protects concurrent admin actions.
create or replace function public.update_support_ticket_state(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_expected_status text,
  p_expected_verification_status text,
  p_status text default null,
  p_verification_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_status_changed boolean := false;
  v_verification_changed boolean := false;
  v_resolved_at timestamptz;
begin
  if p_ticket_id is null or p_actor_id is null
    or (p_status is null and p_verification_status is null) then
    return jsonb_build_object('code', 'invalid_input');
  end if;
  if not exists (
    select 1 from public.profiles as profile
    where profile.id = p_actor_id and profile.role = 'admin'
  ) then
    return jsonb_build_object('code', 'forbidden');
  end if;
  if p_status is not null and p_status not in ('new', 'in_progress', 'awaiting_user', 'answered', 'resolved', 'rejected') then
    return jsonb_build_object('code', 'invalid_status');
  end if;
  if p_verification_status is not null and p_verification_status not in ('not_required', 'pending', 'verified', 'additional_info', 'rejected') then
    return jsonb_build_object('code', 'invalid_verification_status');
  end if;

  select ticket.* into v_ticket
  from public.support_tickets as ticket
  where ticket.id = p_ticket_id
  for update;
  if not found then return jsonb_build_object('code', 'not_found'); end if;
  if v_ticket.status is distinct from p_expected_status
    or v_ticket.verification_status is distinct from p_expected_verification_status then
    return jsonb_build_object('code', 'stale');
  end if;
  if p_verification_status is not null then
    if (v_ticket.category <> 'privacy' and p_verification_status <> 'not_required')
      or (v_ticket.category = 'privacy' and p_verification_status = 'not_required') then
      return jsonb_build_object('code', 'invalid_verification_status');
    end if;
  end if;
  if p_status = 'resolved'
    and v_ticket.category = 'privacy'
    and coalesce(p_verification_status, v_ticket.verification_status) <> 'verified' then
    return jsonb_build_object('code', 'privacy_not_verified');
  end if;
  if p_status = 'resolved'
    and v_ticket.category = 'privacy'
    and not exists (
      select 1 from public.support_ticket_events as event
      where event.ticket_id = p_ticket_id
        and event.event_type in ('privacy_player_registered', 'privacy_player_already_registered')
    ) then
    return jsonb_build_object('code', 'privacy_action_required');
  end if;

  v_status_changed := p_status is not null and p_status is distinct from v_ticket.status;
  v_verification_changed := p_verification_status is not null
    and p_verification_status is distinct from v_ticket.verification_status;
  if p_status is not null and v_status_changed and not (
    (v_ticket.status = 'new' and p_status in ('in_progress', 'rejected'))
    or (v_ticket.status = 'in_progress' and p_status in ('awaiting_user', 'answered', 'resolved', 'rejected'))
    or (v_ticket.status = 'awaiting_user' and p_status in ('in_progress', 'rejected'))
    or (v_ticket.status = 'answered' and p_status in ('in_progress', 'resolved'))
    or (v_ticket.status = 'resolved' and p_status = 'in_progress')
    or (v_ticket.status = 'rejected' and p_status = 'in_progress')
  ) then
    return jsonb_build_object('code', 'invalid_transition');
  end if;

  v_resolved_at := v_ticket.resolved_at;
  if v_status_changed and p_status in ('resolved', 'rejected') then
    v_resolved_at := now();
  elsif v_status_changed and p_status not in ('resolved', 'rejected')
    and v_ticket.status in ('resolved', 'rejected') then
    v_resolved_at := null;
  end if;

  update public.support_tickets
  set status = coalesce(p_status, status),
      verification_status = coalesce(p_verification_status, verification_status),
      resolved_at = v_resolved_at
  where id = p_ticket_id;

  if v_status_changed then
    insert into public.support_ticket_events (
      ticket_id, actor_id, event_type, from_status, to_status, metadata
    ) values (
      p_ticket_id, p_actor_id, 'status_changed', v_ticket.status, p_status,
      jsonb_build_object('reason', 'admin_patch')
    );
  end if;
  if v_verification_changed then
    insert into public.support_ticket_events (
      ticket_id, actor_id, event_type, metadata
    ) values (
      p_ticket_id, p_actor_id, 'verification_changed',
      jsonb_build_object('from', v_ticket.verification_status, 'to', p_verification_status)
    );
  end if;

  select ticket.* into v_ticket
  from public.support_tickets as ticket
  where ticket.id = p_ticket_id;
  return to_jsonb(v_ticket);
end;
$$;

revoke all on function public.update_support_ticket_state(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.update_support_ticket_state(uuid, uuid, text, text, text, text)
  to service_role;

create or replace function public.prevent_support_reopen_during_attachment_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('resolved', 'rejected')
    and new.status not in ('resolved', 'rejected')
    and exists (
      select 1 from public.support_attachments as attachment
      where attachment.ticket_id = old.id and attachment.status = 'deleting'
    ) then
    raise exception 'support_attachment_cleanup_in_progress' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists support_ticket_reopen_cleanup_guard on public.support_tickets;
create trigger support_ticket_reopen_cleanup_guard
before update of status on public.support_tickets
for each row execute function public.prevent_support_reopen_during_attachment_cleanup();

revoke all on function public.prevent_support_reopen_during_attachment_cleanup() from public, anon, authenticated;
grant execute on function public.prevent_support_reopen_during_attachment_cleanup() to service_role;
