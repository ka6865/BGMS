# 보존 후보 조회 timeout 수정 (2026-10-21)

## 증상

- `PUBG Archive Backlog`가 10/12부터 거의 매 실행 실패했다(최근 40회 중 37회).
- 하위 `PUBG Detail Archive Retention`이 `retention-candidate-query-failed:57014`(쿼리 취소)로 중단됐다.
- `pubg_archive_cleanup_cursor`가 2026-09-23 17:26 UTC에서 10/15 이후 움직이지 않았다.
- 같은 기간 `Daily BGMS Maintenance`의 `Backup Core Tables`가 `pubg_player_matches` 읽기 중
  statement timeout으로 부분 백업이 되었고, 백업 성공을 조건으로 거는 정리 step이 함께 건너뛰어졌다.

## 원인

`list_retention_archive_candidates`는 `pubg_player_matches`를 커서 인덱스로 순서대로 읽으면서
"텔레메트리가 있는 경기인가"를 행마다 사후 필터로 확인했다. 커서와 기준일 사이에 텔레메트리 없는
참가자 행이 수십만 개(2026-10-21 기준 약 88만) 있고 텔레메트리가 있는 경기는 약 2.2만 개뿐이라,
후보 1000개를 채우려고 대부분을 훑다가 PostgREST의 8초 제한(authenticator `statement_timeout=8s`)을 넘었다.

## 변경

- `20261021010000_retention_candidates_telemetry_driven.sql`: 텔레메트리 레지스트리의 경기 키에서
  출발해 경기별 최초 `played_at`을 식별 인덱스(`idx_pubg_match_retention_identity`)로 찾은 뒤
  커서와 기준일 조건을 건다. 반환 계약(경기당 가장 이른 played_at의 player_id 최소 행, 정렬, 입력 검증, 권한)은 같다.
  - 운영 DB에서 읽기 전용으로 기존 쿼리와 비교한 결과, 커서가 가까운 구간에서 300행이 완전히 일치했다.
  - 현재 커서로 웜 상태 실행 시간은 약 0.3초였다(첫 실행은 캐시가 차가워 약 8초).
- `scripts/backup_core_tables.ts`: 페이지 읽기에서 statement timeout, 요청 중단, 네트워크 오류만
  1·3·9초 간격으로 최대 3회 다시 시도한다. 권한·스키마 오류는 즉시 실패한다.
- 핵심 테이블 백업 대상에서 `pubg_player_matches`를 제외했다. 유료 플랜의 Supabase 일일 백업(7일 보관, PITR은 사용 안 함)이
  전적을 보호한다. 작은 테이블(마커, 회원, 게시글, 삭제 비밀번호, 벤치마크, 무기 메타, 성과 요약)은 부분 복구가 쉬워 R2 JSON 백업을 유지한다.
  - 이 변경 전에 만든 백업 파일은 테이블 목록이 달라 `verify_core_backup`의 목록 검증을 통과하지 못한다. 새 백업부터 사용한다.
  - 전적을 다시 백업 대상에 넣으려면 `BACKUP_TABLES`와 `TABLE_KEYS`에 추가한다. 4구간 병렬 읽기와 복합키 빠른 경로는 쓰는 테이블이 없어 제거했다(이력은 git에서 찾는다).
  - 전적은 7일이 지난 삭제 사고를 되돌릴 수 없다. 보존 정리 코드를 바꿀 때는 dry-run 결과를 먼저 확인한다.
- `daily-tasks.yml`의 `failure-notify`: 가변 구간 상한을 줄이고, 최종 본문을 1900자로 자른다.
  변경 전에는 8개 단계가 실패하는 경우 본문이 2000자를 넘어(측정 2511자) 웹훅이 거절될 수 있었다.

## 운영 적용

migration은 자동 적용되지 않는다. `supabase db push`는 이력 불일치로 중단되므로
`docs/operations/2026-10-10-remaining-review-fixes.md`의 "준비 migration 적용 실적"대로 파일 하나만 적용한다.

적용 후 확인:

1. `select count(*) from public.list_retention_archive_candidates(1000, now() - interval '15 days',
   (select played_at from public.pubg_archive_cleanup_cursor where id=1),
   (select platform from public.pubg_archive_cleanup_cursor where id=1),
   (select match_id from public.pubg_archive_cleanup_cursor where id=1));`가 8초 안에 끝난다
   (service_role로 실행. 첫 실행은 캐시 때문에 느릴 수 있어 한 번 더 실행한다).
2. `PUBG Detail Archive Retention`을 `dry-run`으로 수동 실행해 후보 조회가 성공하는지 본다.
3. 다음 `PUBG Archive Backlog` 실행에서 `pubg_archive_cleanup_cursor.generation`이 증가하는지 본다.

## 남은 위험

- 후보 조회 비용은 텔레메트리가 있는 경기 수에 비례한다. 텔레메트리 레지스트리가 10배 이상 커지면 다시 점검한다.
- 전적 백업을 제외했으므로 백업은 수 분 안에 끝나야 한다. 다시 길어지면 다른 테이블이 커졌는지 본다.
