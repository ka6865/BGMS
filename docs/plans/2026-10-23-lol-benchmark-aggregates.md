# LoL 익명 벤치마크 집계와 관리자 수집

## 목적과 적용 범위

향후 경기 기여 점수의 포지션별 백분위 기준을 준비한다. 지금부터 저장되는 경기의 10명 지표를 누적하며 이번 변경에서 자체 점수를 계산하거나 사용자 화면에 노출하지 않는다.
원문이 삭제된 과거 경기는 복원할 수 없으므로 migration 당시 남아 있는 `lol_matches.request_json`만 백필한다. 운영 적용과 실제 수집은 별도 담당자가 진행한다. 운영 반영은 migration을 먼저 적용한 뒤 새 API·패널 코드를 배포한다.

## 저장·익명성 계약

- `lol_benchmark_processed_matches`: `match_id`, `patch`, `queue_id`, `processed_at`, `skipped_reason`만 저장한다.
- `lol_benchmark_aggregates`: `patch`, `queue_id`, `team_position`, `champion_id`, `metric`, `sample_count`, `sum`, `sum_sq`, `histogram`, `wins`, `updated_at`만 저장한다.
- PUUID, Riot ID, 이름, 로그인 회원 ID, 참가자 ID, 원문, 개인별 지표 행을 두 테이블에 저장하지 않는다. SQL fixture에서 컬럼 전체 목록을 고정해 검증한다.
- `match_id`는 경기 식별자이며 개인 식별자가 아니다. 다른 저장소의 경기 원문에는 신원이 남아 있으므로 두 집계 테이블의 비식별 계약과 기존 원문 보존 정책을 구분한다.
- 패치는 `gameVersion`의 major.minor다. 포지션은 TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY/미분류이며 `champion_id=0`에 같은 포지션 전체 챔피언을 함께 누적한다.
- `games`에만 승리 표본 수를 저장한다. 나머지 metric의 `wins`는 0이다. 표본 수는 경기 수가 아니라 유효 참가자 수이므로 전체 챔피언 행과 개별 챔피언 행을 더하지 않는다.
- 집계 기록은 원문 만료·계정 삭제와 독립적으로 보존한다. 개인별 행을 갖지 않아 특정 계정의 기여분을 사후 제거할 수 없다.

두 테이블은 RLS를 켜고 PUBLIC/anon/authenticated 권한을 회수한다. 함수는 `security invoker`, 빈 `search_path`를 사용하며 service_role만 호출한다.

## 계산 규칙

비중은 퍼센트가 아닌 0~1 비율이다. 모든 분당 지표는 `gameDuration` 초를 분으로 환산한다. 원문 수치만 쓰며 challenges의 사전 계산 비율은 사용하지 않는다.
`lib/lol/summary.ts`처럼 remake와 300초 미만 경기를 제외하고 승패가 결측인 참가자는 제외한다. 수치가 없거나 JSON 숫자가 아니거나 음수이면 해당 metric을 제외한다.
수치 입력은 안전한 원문 범위인 0~10^12로 한정한다. 팀 분모는 같은 팀 5명 전원의 해당 필드가 유효할 때만 계산하며 0이면 비중 표본을 제외한다.
킬 관여율의 분모는 팀 참가자의 kills 합계다. 피해량 비중은 해당 팀 참가자 5명의 같은 피해 필드 합계다. 한 metric 결측이 다른 metric 표본을 제거하지 않는다.

| metric | 경기당 참가자 값 | 히스토그램 경계 |
| --- | --- | --- |
| kill_participation | (kills+assists)/팀 kills | 비중 공통 |
| damage_share | totalDamageDealtToChampions/팀 합 | 비중 공통 |
| death_share | deaths/팀 deaths | 비중 공통 |
| cs_per_min | (totalMinionsKilled+neutralMinionsKilled)×60/gameDuration; 두 필드 필수 | 2, 4, 6, 8, 10, 12 |
| gold_per_min | goldEarned×60/gameDuration | 200, 300, 400, 500, 600, 800 |
| vision_per_min | visionScore×60/gameDuration | 0.5, 1, 1.5, 2, 3, 4 |
| control_wards | detectorWardsPlaced | 1, 2, 3, 5, 8, 12 |
| wards_killed_per_min | wardsKilled×60/gameDuration | 0.1, 0.2, 0.3, 0.5, 1, 2 |
| objective_damage_share | damageDealtToObjectives/팀 합 | 비중 공통 |
| turret_damage_share | damageDealtToTurrets/팀 합 | 비중 공통 |
| damage_taken_share | totalDamageTaken/팀 합 | 비중 공통 |
| kda | (kills+assists)/max(deaths,1); K/D/A 모두 필수 | 1, 2, 3, 4, 5, 8, 12, 20 |
| games | 승패가 유효한 참가자당 1, 승리 시 wins에 1 | 1 |

비중 공통 경계는 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1이다. SQL 상수 `lol_benchmark_bounds`가 유일한 실행 정의다.
버킷은 `[0,첫 경계)`, `[첫 경계,다음 경계)`, …, `[마지막 경계,∞)`다. 경계와 같은 값은 오른쪽 버킷에 포함한다. 경계 N개면 배열은 N+1칸이다.
KDA는 기존 여러 경기의 합산 KDA와 달리 경기별 분포를 위한 값이다. 데스 0도 분모 1로 포함하며 다른 경기와 K/A/D를 합산한 뒤 나누지 않는다.

조회 RPC `get_lol_benchmark_summary(p_patch,p_queue_id,p_team_position,p_champion_id)`는 metric별 표본 수, 평균, 모집단 표준편차, 히스토그램, 경계, 승리 수를 반환한다.
표준편차는 `sqrt(max(0,sum_sq/n-(sum/n)^2))`이며 n=1이면 0이다. 부동소수점 오차로 음수가 된 분산을 0으로 보정한다.

## 제외·멱등성·원문 경로

queue 0 또는 CUSTOM_GAME은 `custom`, 300초 미만은 `short`, duration 결측은 `missing_duration`으로 기록한다.
유효 patch가 없으면 `invalid_patch`, 10명/양 팀 5명 구조가 아니면 `invalid_participants`로 기록한다.
참가자의 `gameEndedInEarlySurrender` 또는 `teamEarlySurrendered`가 true이면 경기 전체를 `remake`로 제외한다. 정상 조기 항복 필드만으로 remake를 판정하지 않는다.
제외 경기도 processed 행을 남기며 집계는 만들지 않는다. 유효 경기의 참가자 championId가 결측·0이면 해당 참가자는 제외한다.

`aggregate_lol_match_benchmarks`는 processed의 고유 키를 먼저 확보해 동시 호출도 한 번만 누적한다. 집계 upsert와 processed 기록은 같은 트랜잭션이다.
원문 저장 함수 `persist_lol_search_snapshot`, `persist_lol_match_details`는 직전 migration 본문에 집계 호출 한 줄만 추가했다. 기존 원문·lease·개인 요약·랭크 이력 계약을 유지한다.
이미 처리한 경기는 원문이 삭제되어도 no-op이다. 원문을 다시 수집해도 같은 match_id는 중복 누적하지 않는다.

## 관리자 수집 API와 패널

`POST /api/admin/lol/collect`: `{ riotId, count?: 1..100, startOffset?: 0 이상 정수, confirm: true }`.
관리자 가드·동일 출처·영속 저장 활성화·2 KiB 본문 상한을 검사한다. 기본 목표는 20이다. 기존 DB 계정 또는 Riot 계정 조회로 계정을 확보한다.
계정별 기존 검색 lease와 PUUID 기준 수집 lease를 함께 사용한다. 모든 Riot 요청은 기존 공유 동시 2건·1.5초 간격·429 쿨다운을 경유한다.
경기 ID는 start/count로 요청하되 요청당 최대 20개다. 원문이 아직 저장되어 있으면 TTL 만료 여부와 무관하게 재사용한다. 삭제된 원문만 Riot 상세를 호출한다.
짧은 경기와 커스텀 원문도 저장 경로를 거쳐 skipped로 기록한다. 수집 전용 캐시 키·버전을 써서 사용자 상세 캐시와 섞지 않는다.
50초를 넘으면 다음 경기 전 경계를 끊는다. 상세는 최대 20개이며 개별 네트워크·저장 요청의 시간까지 포함하면 전체 응답은 50초를 초과할 수 있다.

응답 필드:

- `requested`: 이번 요청 목표 수, `processed`: 성공·제외·일반 실패를 포함해 소비한 ID 수.
- `fetched`: 실제 Riot HTTP 호출 수. 계정·ID 목록·상세 호출을 모두 포함하며 DB·Data Dragon 호출은 포함하지 않는다.
- `reused`: 저장 원문 재사용 수. ID 페이지도 프로세스 캐시에 남은 같은 요청을 반복하면 Riot 호출은 0이다. 새 ID 페이지는 Riot 조회 1회가 필요하다.
- `failed`: 개별 일반 실패 경기 수, `aggregated`: 이번 경로에서 신규 집계한 경기 수, `skipped`: 제외 사유가 있는 경기 수.
- `nextOffset`, `hasMore`: 다음 반복 위치와 계속 조회 가능 여부. 정확한 마지막 페이지 판정에는 빈 다음 페이지 조회가 필요할 수 있다.
- `durationMs`: 요청 경과 시간. 429는 HTTP 429, `stopped=rate_limited`, `retryAfter`와 Retry-After 헤더 및 부분 진행 결과를 반환한다.

429·동시 수집 충돌·키 오류는 현재 ID를 소비하지 않고 중단한다. 호출자는 같은 nextOffset을 나중에 재시도한다.
패널은 목표까지 count를 줄이고 nextOffset을 넘겨 반복한다. 중지는 현재 요청의 원자적 저장을 기다린 뒤 다음 요청부터 보내지 않는다. 자동 429 재시도는 하지 않는다.
중단 후 시작 버튼을 누르면 offset 0부터 새 실행한다. 저장 원문과 processed 멱등성이 중복 Riot 상세 호출·누적을 방지한다.
운영 상태에 두 테이블과 processed/skipped 경기 수가 표시된다. 개인별 점수 화면·공개 벤치마크 API·예약 수집은 범위에서 제외했다.

## 표본 편향과 향후 수집

소수 계정으로 시작하면 특정 티어·챔피언·포지션·시간대·함께 플레이한 사람에게 표본이 치우친다. 이 표본의 백분위를 전체 이용자의 실력으로 해석하거나 공개 점수로 사용하면 안 된다.
한 경기의 10명은 독립 표본이 아니며, champion_id=0도 역할·패치·큐별 분포를 보존한다. 최소 표본 기준과 불확실성 표시는 실제 점수 설계 단계에서 정한다.
Production 키 확보 이후에는 래더의 티어·지역·시간대 층화 표본을 사용하고 경기 ID 중복을 제거해 수집한다. 시드 계정 수와 수집 기간, 층별 경기 수를 운영 지표로 함께 점검한다.
현재 집계에는 티어 축이 없으므로 필요해지면 별도 버전의 집계 계약과 이후 수집분으로 확장한다. 이미 삭제한 원문으로 과거 티어를 복원할 수 없다.

## 로컬 검증

```sh
BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations
bash scripts/verify_lol_persistence_local.sh
npm run verify:core
npm run verify:lol
RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts
```

운영 DB·원격 Supabase·실제 Riot에 연결하지 않는다. 통합 스크립트도 새 migration을 적용하며 명시된 로컬 PostgREST 환경에서 fixture Riot 응답만 사용한다.
브라우저는 자체 fixture 서버와 격리 브라우저를 사용하고 localhost:3000 개발 서버를 재시작하지 않는다. 375×667, 390×844, 430×932, 데스크톱에서 진행·중지·넘침을 확인한다.
SQL 시나리오는 지표 값·경계·결측·팀 0 분모·중복·두 저장 경로·제외·컬럼 목록·RLS·anon/authenticated 접근 거부를 검사한다.

## 롤백 SQL

먼저 수집 호출을 중지하고 API·패널 코드를 이전 버전으로 배포한다. 함수 세 개를 이전 migration의 정의로 되돌린 뒤 집계 객체를 제거한다.
다음 psql 스크립트는 해당 세 함수의 이전 정의만 추출해 실행하며 이전 migration 전체를 재실행하지 않는다.

```sh
python3 - <<'PY' > /tmp/lol-benchmark-rollback.sql
from pathlib import Path
source = Path('supabase/migrations/20261023040000_lol_player_summaries.sql').read_text()
print('begin;')
for name in ['persist_lol_search_snapshot', 'persist_lol_match_details', 'get_lol_ops_status']:
    start = source.index('create or replace function public.' + name + '(')
    end = source.index('$$;', source.index('as $$', start)) + 3
    print(source[start:end])
print('drop function public.get_lol_benchmark_match_source(text,text,text);')
print('drop function public.get_lol_benchmark_summary(text,integer,text,integer);')
print('drop function public.aggregate_lol_match_benchmarks(text);')
print('drop table public.lol_benchmark_aggregates;')
print('drop table public.lol_benchmark_processed_matches;')
print('drop function public.lol_benchmark_number(jsonb);')
print('drop function public.lol_benchmark_bounds(text);')
print('commit;')
PY
# 승인된 대상 DB에만 별도 실행한다.
psql -X -v ON_ERROR_STOP=1 -f /tmp/lol-benchmark-rollback.sql
```

롤백은 익명 누적과 중복 처리 이력을 삭제한다. 원문이 이미 만료됐다면 같은 집계를 복구할 수 없으므로 보존 필요 시 두 집계 테이블을 먼저 승인된 백업 경로로 보관한다.

## 구현 결과와 검증 기록

교체한 기존 함수는 `persist_lol_search_snapshot`, `persist_lol_match_details`, `get_lol_ops_status`다.
앞의 두 함수는 직전 migration 정의와 집계 호출 한 줄만 다르며 자동 비교 테스트로 고정했다. 기존 migration과 PUBG 코드는 수정하지 않았다.

새 migration SHA256:

```text
96df231529e7652cb767d9d16d4890ae90f25e65e289a54405cd544577edfa29
```

로컬 PostgreSQL 17 migration·저장 검증을 통과했다. 모든 metric의 0·각 버킷 경계, 결측과 팀 0 분모, 재처리, 만료 원문 재사용, 원문 삭제 뒤 멱등성을 검사한다.
LoL 단위 검증은 235개 통과이며 기본 실행에서 브라우저 29개와 환경별 통합 4개는 별도 실행 대상으로 skip된다.
브라우저는 별도 활성화 실행으로 29개 모두 통과했고 수집 진행·중지·반복은 375×667, 390×844, 430×932, 1440×900에서 확인했다.
화면 증거는 `tmp/lol-detail-alignment/collect-<width>x<height>.png`에 있다. 모바일 뷰포트 검사이며 실제 모바일 기기·네이티브 앱 검증은 수행하지 않았다.

원문이 삭제된 뒤 재수집할 때는 처리 이력을 별도 확인하여 응답의 신규 집계 수에도 중복을 포함하지 않는다.
변경 LoL 파일과 package.json의 변경 script 줄에서 300자 초과 줄은 0개다. package.json의 기존 다른 긴 script는 유지했다.
`.agents/rules/project_rules.md`와 `docs-private/.project_context.md`는 이 작업 폴더에 없어 기존 구현·추적 문서·테스트를 기준으로 작업했다.
운영 DB·원격 Supabase·실제 Riot 요청·개발 서버 재시작·커밋·staging은 수행하지 않았다.

최종 `verify:core`는 종료 코드 0, 오류 0개·기존 경고 47개다. 로컬 PostgREST 16.5 통합도 populate/cache-hit/flag-off/db-error 네 모드 모두 통과했다.
실제 REST에서 anon/authenticated의 두 테이블·집계 RPC 거부, service_role 원문 재사용·처리 이력 조회와 Riot 호출 0회를 확인했다.

## 운영 적용·시드 수집 실적 (2026-10-23)

- 02:25 UTC에 `20261023050000_lol_benchmark_aggregates.sql`(SHA256 96df2315…)을 운영에 단독 적용했다. 적용 후 RLS가 켜져 있고 anon/authenticated는 조회할 수 없음을 확인했다.
- 시드 수집: 계정마다 20경기씩 5배치를 수집했다(솔로·자유 랭크).

| 계정 | Riot 호출 | 원문 재사용 | 집계 | 제외 |
| --- | --- | --- | --- | --- |
| 계정 A | 92 | 13 | 85 | 3 |
| 계정 B | 33 | 72 | 28 | 3 |
| 계정 C | 101 | 5 | 89 | 6 |

  - 계정 C는 브라우저 렌더러가 멈춰, 같은 `collectLolMatches`를 로컬 스크립트에서 직접 실행했다. 관리자 API와 같은 가드·메트릭 경로를 쓴다.
- 수집 후 총계: 고유 경기 223개, 플레이어 표본 2,140개, 패치 11개. `lol_matches`는 약 11 MB이고 7일 뒤 정리 대상이다.
- 소수 계정과 같이 한 경기 비중이 커서 표본이 치우쳐 있다. 점수 계산에 쓰기 전에 표본을 넓혀야 한다.
