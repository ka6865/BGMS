-- Match the notifications partial unique index when saving an admin support reply.
-- Without the predicate, PostgreSQL rejects ON CONFLICT and rolls back the reply.

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
    ) on conflict (support_message_id) where support_message_id is not null do nothing;
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
