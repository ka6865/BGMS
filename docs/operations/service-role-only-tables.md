# service role 전용 테이블

RLS를 켜고 정책을 두지 않은 `public` 테이블은 anon·authenticated 요청에서 행을 읽거나 쓸 수 없다. 아래 54개 테이블은 이 상태가 의도된 설계이며, 서버(API route, `lib/` 서버 모듈, 운영 스크립트·워크플로)가 service role로만 접근한다. Supabase security advisor의 `rls_enabled_no_policy` 경고는 이 목록에 있는 테이블이면 조치 대상이 아니다.

확인 기준: 2026-10-15 운영 DB 읽기 전용 조회(`pg_class.relrowsecurity`가 켜져 있고 `pg_policies`에 정책이 없는 `public` 테이블). advisor는 같은 날 55개로 집계했으며, 아래 조회 결과와 차이가 생기면 조회 결과를 기준으로 이 문서를 갱신한다.

## 목록

| 영역 | 테이블 |
| --- | --- |
| 관리자 에이전트 | `agent_approvals`, `agent_memories`, `agent_runs`, `agent_steps` |
| AI 사용량·캐시·검수 | `ai_usage_logs`, `ai_coaching_review_cases`, `match_ai_coaching_cache`, `player_ai_summary_cache`, `squad_ai_coaching_cache` |
| 이용 지표 | `analytics_events`, `analytics_event_rate_limits`, `user_lifecycle_events`, `user_lifecycle_capture_meta` |
| 게시판 보조 | `board_comment_delete_credentials`, `board_post_delete_credentials`, `board_image_objects`, `board_image_reservation_rate_limits`, `board_post_image_refs`, `board_post_view_tracking`, `board_write_rate_limits` |
| 커뮤니티 비서·Discord | `community_agent_evidence`, `community_agent_policy`, `community_agent_runs`, `community_agent_sources`, `community_content_reviews`, `daily_ranker_stories`, `discord_room_rate_limits` |
| Overwolf | `overwolf_session_events`, `overwolf_session_quota` |
| PUBG API 상태 | `pubg_api_errors`, `pubg_api_status`, `pubg_api_alert_deliveries`, `pubg_response_cache`, `pubg_refresh_locks` |
| PUBG 수집·보관 | `pubg_player_match_discovery`, `pubg_linked_player_sync_state`, `pubg_archive_cleanup_cursor`, `telemetry_map_cache_entries` |
| PUBG 제재 추적 | `pubg_ban_status`, `pubg_ban_status_events`, `pubg_ban_watch_items` |
| PUBG 조우·성과 | `pubg_encounter_api_budget`, `pubg_encounter_cache`, `pubg_encounter_profiles`, `pubg_encounter_seasons`, `pubg_match_performance`, `pubg_performance_budget`, `pubg_performance_jobs` |
| 무기 메타·패치 | `weapon_meta_match_samples`, `weapon_meta_patches`, `weapon_meta_snapshots`, `weapon_patch_apply_log`, `weapon_patch_proposal_changes`, `weapon_patch_proposals` |

## 클라이언트 권한 회수 (2026-10-17)

`20261017050000_close_player_data_tables`가 위 목록 전체(RLS 켜짐·정책 없음)의 anon·authenticated 권한을 회수했다. 이전에는 13개 표에 `SELECT` 등 테이블 권한이 남아 RLS 하나만 방어선이었다.

같은 migration이 다음 플레이어 단위 데이터 표도 서버 전용으로 바꿨다. 이 표들은 예전 `SELECT ... using (true)` 정책이 남아 있지만 클라이언트 권한이 없어 공개되지 않는다. 앱은 service role로만 읽는다(`lib/server/serviceRoleSupabase.server.ts`).

`pubg_player_matches`, `pubg_player_cache`, `processed_match_telemetry`, `match_stats_raw`, `global_benchmarks`, `match_master_telemetry`, 뷰 `benchmark_stats_by_tier`, `benchmark_stats_by_tier_v2`

## 변경 규칙

- 이 목록의 테이블을 브라우저나 사용자 토큰으로 읽어야 하면 정책을 추가하는 migration을 만들고 이 문서에서 제외한다. 정책 없이 클라이언트에서 조회하면 오류 없이 빈 결과가 반환되므로 원인을 찾기 어렵다.
- 새 서버 전용 테이블은 RLS를 켜고 정책을 만들지 않으며, anon·authenticated 권한을 회수한 뒤 이 목록에 추가한다. 2026-10-17부터 public 스키마의 새 표에는 anon 쓰기 권한이 기본으로 붙지 않지만 `SELECT`는 붙는다.
- 목록 재확인 쿼리(읽기 전용):

```sql
select c.relname,
  has_table_privilege('anon', c.oid, 'select') as anon_select,
  has_table_privilege('authenticated', c.oid, 'select') as authenticated_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  )
order by 1;
```
