# 플레이어 데이터 표 서버 전용화와 클라이언트 쓰기 권한 정리 (2026-10-17)

`2026-10-17-public-column-privacy.md`의 후속이다. 같은 점검에서 나온 3번(전적·분석 데이터 통째 공개)과 4번(쓰지 않는 쓰기 권한)을 처리했다.

## 3. 플레이어 단위 데이터 표

- 대상: `pubg_player_matches`, `pubg_player_cache`, `processed_match_telemetry`, `match_stats_raw`, `global_benchmarks`, `match_master_telemetry`, 뷰 `benchmark_stats_by_tier(_v2)`.
- 문제: 공개 키로 직접 읽을 수 있어 비공개 요청 플레이어 차단(앱 서버에서만 수행)을 우회하거나 표 전체를 내려받을 수 있었다. 2026-10-17 기준 비공개 플레이어 행은 0건이라 실제 노출은 없었다.
- 앱 변경: 공개 키·사용자 세션으로 읽던 네 경로를 service role로 바꿨다(`createServiceRoleSupabase`).
  - `app/api/pubg/player/route.ts`: 플레이어 캐시·`match_master_telemetry`
  - `app/api/pubg/suggest/route.ts`: 닉네임 추천
  - `app/stats/[platform]/[nickname]/weapons/page.tsx`: 무기 숙련도
  - `lib/pubg-analysis/squadAnalysis.ts`: 스쿼드 분석 상세 결과
- 근거: 코드 추적과 24시간 API 로그가 일치했다. 브라우저에서 이 표를 직접 읽는 곳은 없다.
- 공개 유지: `hotdrop_heatmap`, `pubg_team_benchmarks`(집계값), 게임 정보 표(무기·차량 등).
- 정책 없는 서버 전용 표(`service-role-only-tables.md`)의 남은 클라이언트 권한도 같은 migration에서 회수했다.

## 4. 쓰지 않는 쓰기 권한

`20261017060000_revoke_unused_client_write_grants`:

- anon: public 스키마 모든 표·뷰의 INSERT·UPDATE·DELETE·TRUNCATE·REFERENCES·TRIGGER 회수. 모든 쓰기 정책이 `auth.uid()`·관리자·service role을 요구해 anon은 원래 통과할 수 없었다. 비회원 글·댓글은 서버 API가 service role로 쓴다.
- authenticated: 해당 명령(또는 ALL)에 authenticated/public 대상 정책이 있는 표만 남긴다. service role 전용·`false` 정책은 제외한다. TRUNCATE·REFERENCES·TRIGGER는 회수.
  - 남는 쓰기(2026-10-17 운영 기준): 관리자 게임 데이터(`ammo`, `attachments`, `consumables`, `craftable_items`, `throwables`, `vehicles`, `weapons`, `categories`, `map_settings`, `map_markers`, `ip_blacklist`), 게시판 삭제(`posts`, `comments`), `post_likes` 추가, `notifications` 읽음·삭제, `reports` 처리, `user_knowledge_notes`·`user_memory_facts`, `profiles` 본인 칸 수정.
- 기본 권한: `postgres`가 public에 새로 만드는 표는 anon 쓰기 권한이 붙지 않는다.
- 확인: 24시간 API 로그에서 클라이언트 직접 쓰기는 `profiles` 접속 시각 갱신(PATCH)뿐이었다. 쓰기 대상 표의 트리거 함수는 모두 SECURITY DEFINER다.

## 배포 순서

1. 앱 배포(service role 조회 전환).
2. `20261017050000` 적용 → 플레이어 조회·추천·무기·스쿼드 화면 확인.
3. `20261017060000` 적용 → 게시판 삭제·좋아요·알림·프로필 저장 확인.

## 주의

- 새 기능이 위 표를 공개 키나 사용자 세션으로 읽으면 권한 오류(`42501`)가 난다. 서버에서 `createServiceRoleSupabase()`로 읽고 비공개 플레이어 차단을 직접 거친다.
- 정책을 추가해도 권한이 없으면 동작하지 않는다. 클라이언트 쓰기를 새로 열 때는 정책과 권한을 같은 migration에서 준다.

## 검증

`npm run verify:migrations`(`client-grant-hardening-checks.sql`, 기대값을 바꾼 `board-public-write-boundaries.sql`·`scenarios.sql` 시나리오 11), `npm run test:unit`, `npm run verify:core`.
