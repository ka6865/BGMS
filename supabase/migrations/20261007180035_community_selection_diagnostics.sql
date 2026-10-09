-- 기존 승인·권한·lease 계약을 유지하며 주제 선별 진단만 보존한다.
create or replace function public.finish_community_stage(
  p_run_id uuid, p_stage text, p_lease uuid, p_result jsonb
)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_stage_state jsonb;
  v_payload jsonb;
  v_safe_result jsonb;
  v_evidence_ids jsonb;
  v_state text;
  v_reason text;
  v_fetched_count integer;
  v_retained_count integer;
  v_channel_id text;
  v_uploads_id text;
  v_kind text;
  v_title text;
  v_topic_key text;
  v_official_update boolean;
  v_question text;
  v_paragraph jsonb;
  v_paragraphs jsonb := '[]'::jsonb;
  v_paragraph_count integer := 0;
  v_text text;
  v_claim_kind text;
  v_recent_window text;
  v_validation jsonb;
  v_reasons jsonb;
  v_passed boolean;
  v_html text;
  v_category text;
  v_hash text;
  v_usage jsonb;
  v_terminal jsonb;
  v_terminal_status text;
  v_selection jsonb;
  v_selection_payload jsonb;
  v_selection_key text;
  v_selection_count numeric;
  v_candidate jsonb;
  v_candidates jsonb := '[]'::jsonb;
begin
  if p_stage not in ('dc', 'naver', 'youtube', 'select', 'draft', 'verify')
    or jsonb_typeof(p_result) is distinct from 'object' then
    raise exception 'community_invalid_stage_result';
  end if;
  select * into strict v_policy from public.community_agent_policy where singleton for update;
  if not v_policy.enabled then raise exception 'community_agent_disabled'; end if;
  select * into strict v_run from public.community_agent_runs where run_id = p_run_id for update;
  v_stage_state := v_run.stages -> p_stage;
  if v_stage_state ->> 'status' is distinct from 'running'
    or v_stage_state ->> 'lease' is distinct from p_lease::text then
    raise exception 'community_stage_lease_mismatch';
  end if;

  -- 진단은 선별 단계의 읽기 전용 메타데이터이며 기존 lease/policy 검증 뒤에만 저장한다.
  if p_result ? 'selection' then
    v_selection_payload := p_result -> 'selection';
    if p_stage <> 'select' or jsonb_typeof(v_selection_payload) is distinct from 'object' then
      raise exception 'community_invalid_selection_diagnostics';
    end if;
    v_selection := '{}'::jsonb;
    foreach v_selection_key in array array['storedCount', 'usableCount', 'inputCount', 'emptyCount', 'rejectedCount', 'supplementalCount'] loop
      if jsonb_typeof(v_selection_payload -> v_selection_key) is distinct from 'number' then
        raise exception 'community_invalid_selection_diagnostics';
      end if;
      v_selection_count := (v_selection_payload ->> v_selection_key)::numeric;
      if v_selection_count < 0 or v_selection_count > 200 or trunc(v_selection_count) <> v_selection_count then
        raise exception 'community_invalid_selection_diagnostics';
      end if;
      v_selection := v_selection || jsonb_build_object(v_selection_key, v_selection_count::integer);
    end loop;
    if not (v_selection_payload ? 'detail')
      or jsonb_typeof(v_selection_payload -> 'detail') not in ('string', 'null')
      or char_length(v_selection_payload ->> 'detail') > 500
      or jsonb_typeof(v_selection_payload -> 'candidates') is distinct from 'array' then
      raise exception 'community_invalid_selection_diagnostics';
    end if;
    if jsonb_array_length(v_selection_payload -> 'candidates') > 5 then
      raise exception 'community_invalid_selection_diagnostics';
    end if;
    for v_candidate in select value from jsonb_array_elements(v_selection_payload -> 'candidates') loop
      if jsonb_typeof(v_candidate) is distinct from 'object'
        or jsonb_typeof(v_candidate -> 'title') is distinct from 'string'
        or char_length(v_candidate ->> 'title') not between 1 and 120
        or jsonb_typeof(v_candidate -> 'reason') is distinct from 'string'
        or char_length(v_candidate ->> 'reason') not between 1 and 300 then
        raise exception 'community_invalid_selection_diagnostics';
      end if;
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'title', v_candidate ->> 'title', 'reason', v_candidate ->> 'reason'
      ));
    end loop;
    v_selection := v_selection || jsonb_build_object(
      'detail', v_selection_payload -> 'detail', 'candidates', v_candidates
    );
  end if;

  v_usage := public.community_stage_usage(p_result);
  v_terminal := p_result -> 'terminal';
  if v_terminal is not null then
    if jsonb_typeof(v_terminal) is distinct from 'object'
      or v_terminal - 'status' - 'reason' <> '{}'::jsonb then
      raise exception 'community_invalid_terminal_result';
    end if;
    v_terminal_status := v_terminal ->> 'status';
    v_reason := v_terminal ->> 'reason';
    if v_terminal_status not in ('deferred', 'failed')
      or v_reason is null or v_reason !~ '^[a-z][a-z0-9_]{0,99}$' then
      raise exception 'community_invalid_terminal_result';
    end if;
    v_safe_result := jsonb_build_object('terminal', jsonb_build_object(
      'status', v_terminal_status, 'reason', v_reason
    )) || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end
      || case when v_selection is null then '{}'::jsonb else jsonb_build_object('selection', v_selection) end;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object(
          'status', 'failed', 'lease', p_lease::text, 'result', v_safe_result
        ), true),
        status = v_terminal_status,
        reason = v_reason
    where run_id = v_run.run_id returning * into v_run;
    update public.agent_runs
    set status = case when v_terminal_status = 'failed' then 'failed' else 'completed' end,
        error = case when v_terminal_status = 'failed' then v_reason else null end,
        completed_at = clock_timestamp()
    where id = v_run.run_id and status = 'running';
    return public.community_run_payload(v_run);
  end if;

  if p_stage in ('dc', 'naver', 'youtube') then
    v_payload := coalesce(p_result -> 'report', p_result);
    v_evidence_ids := public.community_evidence_ids(coalesce(v_payload -> 'evidenceIds', '[]'::jsonb), 100);
    v_state := coalesce(v_payload ->> 'state', 'failed');
    if v_state not in ('ok', 'partial', 'empty', 'needs_setup', 'blocked', 'failed', 'disabled') then
      raise exception 'community_invalid_source_state';
    end if;
    v_reason := nullif(left(coalesce(v_payload ->> 'reason', ''), 300), '');
    v_fetched_count := case when jsonb_typeof(v_payload -> 'fetchedCount') = 'number'
      then greatest(0, least((v_payload ->> 'fetchedCount')::integer, 1000)) else 0 end;
    v_retained_count := case when jsonb_typeof(v_payload -> 'retainedCount') = 'number'
      then greatest(0, least((v_payload ->> 'retainedCount')::integer, v_fetched_count)) else 0 end;
    if jsonb_typeof(v_payload -> 'channel') = 'object' then
      v_channel_id := nullif(left(coalesce(v_payload -> 'channel' ->> 'id', ''), 200), '');
      v_uploads_id := nullif(left(coalesce(v_payload -> 'channel' ->> 'uploads', ''), 200), '');
    end if;
    if p_stage <> 'youtube' and (v_channel_id is not null or v_uploads_id is not null) then
      raise exception 'community_channel_only_for_youtube';
    end if;
    v_safe_result := jsonb_build_object(
      'evidenceIds', v_evidence_ids, 'state', v_state,
      'reason', v_reason, 'fetchedCount', v_fetched_count, 'retainedCount', v_retained_count
    );
    if v_channel_id is not null and v_uploads_id is not null then
      v_safe_result := v_safe_result || jsonb_build_object('channel', jsonb_build_object('id', v_channel_id, 'uploads', v_uploads_id));
    end if;
    update public.community_agent_sources
    set resolved_channel_id = case when p_stage = 'youtube' and v_channel_id is not null then v_channel_id else resolved_channel_id end,
        uploads_playlist_id = case when p_stage = 'youtube' and v_uploads_id is not null then v_uploads_id else uploads_playlist_id end,
        state = v_state, reason = v_reason,
        last_success_at = case when v_state in ('ok', 'partial', 'empty') then clock_timestamp() else last_success_at end,
        updated_at = clock_timestamp()
    where id = p_stage;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        reports = reports || jsonb_build_array(v_safe_result || jsonb_build_object('source', p_stage))
    where run_id = v_run.run_id returning * into v_run;

  elsif p_stage = 'select' then
    v_payload := coalesce(p_result -> 'topic', p_result);
    v_kind := v_payload ->> 'kind';
    v_title := v_payload ->> 'title';
    v_topic_key := v_payload ->> 'topicKey';
    v_evidence_ids := public.community_evidence_ids(coalesce(v_payload -> 'evidenceIds', '[]'::jsonb), 10);
    v_reason := nullif(left(coalesce(v_payload ->> 'reason', ''), 500), '');
    v_official_update := coalesce((v_payload ->> 'officialUpdate')::boolean, false);
    if v_kind not in ('news', 'tip', 'question') or v_title is null or char_length(v_title) not between 1 and 120
      or v_topic_key is null or char_length(v_topic_key) not between 1 and 200
      or v_reason is null or jsonb_array_length(v_evidence_ids) = 0 then
      raise exception 'community_invalid_topic';
    end if;
    v_safe_result := jsonb_build_object('kind', v_kind, 'title', v_title, 'topicKey', v_topic_key,
      'evidenceIds', v_evidence_ids, 'reason', v_reason, 'officialUpdate', v_official_update)
      || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end
      || case when v_selection is null then '{}'::jsonb else jsonb_build_object('selection', v_selection) end;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        topic = v_safe_result - 'selection', status = 'selected'
    where run_id = v_run.run_id returning * into v_run;

  elsif p_stage = 'draft' then
    v_payload := coalesce(p_result -> 'draft', p_result);
    v_title := v_payload ->> 'title';
    v_question := v_payload ->> 'question';
    if v_title is null or char_length(v_title) not between 1 and 120 or v_question is null or char_length(v_question) > 200
      or jsonb_typeof(v_payload -> 'paragraphs') is distinct from 'array' then
      raise exception 'community_invalid_draft';
    end if;
    for v_paragraph in select value from jsonb_array_elements(v_payload -> 'paragraphs') loop
      v_paragraph_count := v_paragraph_count + 1;
      if v_paragraph_count > 8 or jsonb_typeof(v_paragraph) is distinct from 'object' then raise exception 'community_invalid_draft'; end if;
      v_text := v_paragraph ->> 'text';
      v_claim_kind := v_paragraph ->> 'kind';
      v_recent_window := v_paragraph ->> 'recentWindow';
      if v_text is null or char_length(v_text) not between 1 and 500
        or v_claim_kind not in ('official_fact', 'observed_opinion', 'suggestion')
        or (v_recent_window is not null and v_recent_window not in ('24h', '7d')) then
        raise exception 'community_invalid_draft';
      end if;
      v_paragraphs := v_paragraphs || jsonb_build_array(jsonb_build_object(
        'text', v_text, 'kind', v_claim_kind,
        'evidenceIds', public.community_evidence_ids(coalesce(v_paragraph -> 'evidenceIds', '[]'::jsonb), 10),
        'recentWindow', v_recent_window
      ));
    end loop;
    if v_paragraph_count = 0 then raise exception 'community_invalid_draft'; end if;
    v_safe_result := jsonb_build_object('title', v_title, 'paragraphs', v_paragraphs, 'question', v_question)
      || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        draft = v_safe_result, validation = null, approved_title = null, approved_html = null,
        approved_category = null, approved_hash = null, status = 'drafted'
    where run_id = v_run.run_id returning * into v_run;

  else
    v_validation := coalesce(p_result -> 'validation', p_result);
    v_passed := v_validation ->> 'passed' = 'true';
    v_reasons := public.community_short_text_array(coalesce(v_validation -> 'reasons', '[]'::jsonb), 20, 300);
    v_hash := coalesce(v_validation ->> 'contentHash', p_result ->> 'contentHash', p_result ->> 'hash');
    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then raise exception 'community_invalid_validation'; end if;
    v_safe_result := jsonb_build_object('passed', v_passed, 'reasons', v_reasons, 'contentHash', v_hash)
      || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end;
    v_title := coalesce(p_result ->> 'title', p_result -> 'rendered' ->> 'title');
    v_html := coalesce(p_result ->> 'html', p_result -> 'rendered' ->> 'html');
    v_category := coalesce(p_result ->> 'category', p_result -> 'rendered' ->> 'category');
    if v_passed and (v_title is null or char_length(v_title) not between 1 and 120
      or v_html is null or char_length(v_html) not between 1 and 20000
      or v_category not in ('배그 소식', '자유')) then
      raise exception 'community_invalid_approved_draft';
    end if;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        validation = v_safe_result,
        approved_title = case when v_passed then v_title else null end,
        approved_html = case when v_passed then v_html else null end,
        approved_category = case when v_passed then v_category else null end,
        approved_hash = case when v_passed then v_hash else null end,
        status = case when v_passed then 'ready' else 'deferred' end,
        reason = case when v_passed then null else 'validation_failed' end
    where run_id = v_run.run_id returning * into v_run;
    if v_run.status in ('ready', 'deferred') then
      update public.agent_runs set status = 'completed', completed_at = clock_timestamp()
      where id = v_run.run_id and status = 'running';
    end if;
  end if;
  return public.community_run_payload(v_run);
end;
$$;
