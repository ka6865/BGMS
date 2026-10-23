# LoL 최근 30일 티어 그래프·챕터 4 운영 안정화

## 범위와 적용 상태

- 대상은 `/admin/lol`과 `/api/admin/lol/*`, `public.lol_*` 테이블이다.
- 운영 DB, Supabase 원격, 실제 Riot API에 연결하지 않았다. 개발 서버를 재시작하지 않았다.
- 운영 적용은 메인 담당자가 수행한다. 이 문서는 적용 명령 실행 기록이 아니다.
- 기존 PUBG 코드·migration·자동 스케줄을 변경하지 않는다.

## 최근 30일 일별 티어 계약

`20261023020000_lol_ranked_daily.sql`은 `get_lol_ranked_history(text,integer)`만 교체한다.
시그니처는 유지하며 `p_limit`은 최대 30일인 날짜 창의 길이다. 호출부는 30을 전달한다.
오늘을 포함한 KST 30일 범위에서 큐·날짜별 마지막 기록을 선택한다.
동일 시각이면 `id`가 큰 기록을 선택하며 다음 날 자정 이후 기록은 제외한다.

`points`는 `date`, `recordedAt`, `tier`, `rank`, `lp`, `wins`, `losses`, `isBaseline`을 포함한다.
범위 시작 이전 마지막 기록이 있으면 원래 날짜를 유지하여 `isBaseline=true`로 한 건 포함한다.
`highest`와 `trackingSince`는 기존 전체 기록 기준을 유지한다.

`persist_lol_search_snapshot`은 기존 본문을 그대로 유지한다.
기존 `jsonb_set(p_cache_payload,'{rankedHistory}',public.get_lol_ranked_history(v_puuid,30))`가
교체된 RPC를 호출하므로, 검색 저장·랭크 이력·캐시의 원자성과 lease 검증을 변경하지 않고 새 형식을 저장한다.
검색 DTO 캐시 키는 `search:v8`이며 메모리 캐시·추가 경기 조회도 동일 버전을 사용한다.

그래프는 30일 날짜 간격을 유지하고 기록일에만 점을 표시한다.
30일 이전 기록은 창의 왼쪽 경계에 빈 점으로 구분하고 title에는 실제 기록 날짜를 표시한다.
일반 랭크 위치는 티어 순서 × 4 + 디비전 위치 + 디비전 내부 LP/100이다.
마스터 이상은 마스터 시작 위치 + LP/100으로 연결한다.
이 위치는 공식 티어 순서를 그리기 위한 값이며 별도 사용자 점수가 아니다.
세로축은 티어·디비전 또는 마스터 이상 LP, 점 title은 날짜·티어·LP를 표시한다.
기록이 한 건이면 점 한 개와 기록 시작 안내를 제공한다.

## 일별 메트릭

`20261023030000_lol_ops_metrics.sql`은 `lol_ops_daily(day,metric,value)`와 RPC 네 개를 추가한다.
새 테이블은 RLS를 활성화하며 public/anon/authenticated 권한을 회수하고 service_role에만 DML을 부여한다.
모든 새 RPC는 `security invoker`, 빈 `search_path`, service_role 전용 EXECUTE를 사용한다.
`increment_lol_ops_metric(p_metric,p_by)`는 아래 allowlist와 1~1000 정수 증가만 허용한다.
날짜는 KST이며 `(day,metric)` 충돌 시 기존 값에 원자적으로 더한다.

| 메트릭 | 의미 |
| --- | --- |
| `riot_success` | Riot HTTP 성공 응답 |
| `riot_429` | Riot 실제 429 응답; 로컬 쿨다운 거절은 추가 집계하지 않음 |
| `riot_5xx` | Riot 5xx 응답 |
| `riot_network` | fetch 또는 응답 본문 읽기 네트워크 실패 |
| `riot_timeout` | fetch 또는 응답 본문 읽기 시간 초과 |
| `riot_key_error` | Riot 401/403 응답 |
| `riot_4xx` | 기타 Riot 비성공 응답 |
| `search_cache_hit`, `search_cache_miss` | 검색 DTO DB 캐시 조회 결과 |
| `detail_cache_hit`, `detail_cache_miss` | 상세 DTO DB 캐시 조회 결과 |
| `raw_reuse` | 범위와 TTL을 만족한 저장 원문 반환 횟수 |
| `db_error`, `db_timeout` | 영속 저장소 작업 실패 사유; operation은 안전 로그에서 구분 |

메트릭에 PUUID·Riot ID·키·회원 식별자를 넣지 않는다.
검색·상세 캐시 지표는 영속 저장이 활성화된 경우 DB 캐시 조회를 센다.
메트릭은 `next/server`의 `after`로 응답 후 기록하며 각 RPC에 1초 제한을 적용한다.
요청 컨텍스트가 없는 로컬 실행에서는 비동기로 실행한다.
실패는 `[lol-ops] metric_failed`와 허용된 metric·reasonCode만 기록하고 재시도·재귀하지 않는다.
일반 요청은 메트릭 저장 완료를 기다리지 않는다. best-effort이므로 장애·프로세스 종료 시 일부 집계가 유실될 수 있다.

## 관리자 운영 상태 패널

기존 `/api/admin/lol/status`는 인증 확인 용도로 보존한다.
새 `/api/admin/lol/operations` GET은 요청마다 기존 관리자 가드를 실행한 뒤 집계만 반환한다.
페이지에서 검색 결과와 분리된 기본 접힘 패널을 열 때 조회하고 수동 새로고침을 제공한다.

- 최근 7일 KST 메트릭과 오늘 Riot 호출 결과 합계.
- `lol_rate_limit_state`의 global/asia/kr별 `used_count`, `budget_day`, `blocked_until`.
- 현재 차단 시각을 기준으로 한 429 쿨다운 여부.
- LoL 10개 테이블의 정확한 행 수와 `pg_total_relation_size` 기반 총 바이트.
- 만료 대기 캐시·경기·lease 수. 계정 자동 삭제 수는 호환 필드 `account_rows=0`으로 유지한다.
- 키가 없거나 오늘 `riot_key_error`가 한 번 이상 관측되면 `키 확인 필요`.

기존 `used_count`는 UTC 날짜의 호출 예약 수다. KST 메트릭의 실제 응답 결과 합계와 의미·날짜 경계가 다르다.
키 교체 뒤에도 같은 날 키 오류 관측 경고는 유지된다. 경고만으로 현재 키 유효성을 단정하지 않는다.
영속 저장 비활성화 시 DB를 읽지 않고 비활성 상태를 표시한다.
상태 응답은 고정된 집계 필드만 구성하며 키·PUUID·회원 정보는 반환하지 않는다.

## 만료 정리 절차

1. 대상 환경을 확인하고 관리자 상태에서 용량·행 수·만료 대기 수를 기록한다.
2. `정리 미리보기`는 POST `{ "action": "preview" }`로 `preview_lol_expired_data()`만 호출한다.
3. 대상 수와 cascade 범위를 검토한 뒤 삭제 확인 체크를 선택한다.
4. `정리 실행(배치 1회)`는 POST `{ "action": "cleanup", "confirm": true, "limit": 100 }`를 보낸다.
5. `cleanup_lol_expired_batch(p_limit)` 결과의 `deleted`와 `remaining`을 비교한다.
6. 필요 시 다시 미리보고 별도 확인한 다음 한 배치씩 반복한다.

API와 DB 모두 배치 크기 1~1000 정수만 허용한다.
실행은 관리자 인증·동일 출처·`confirm=true`를 모두 요구한다. GET은 삭제하지 않는다.
캐시·경기·lease를 각각 최대 N행 삭제하며 잠긴 행은 `SKIP LOCKED`로 건너뛴다.
반환한 삭제 수는 부모 행 수다. 경기 참가자 cascade는 이 상한에 포함되지 않는다. 계정·랭크 이력·본인 경기 요약은 정리하지 않는다.
미리보기와 실행 사이 새 만료·갱신·잠금이 생기면 실제 삭제 수가 달라질 수 있다.
경계가 움직이지 않는 로컬 fixture에서는 dry-run 수와 실제 삭제 수가 일치함을 검증한다.

현재 보존 규칙은 다음과 같다.

| 테이블 | 삭제 대상 |
| --- | --- |
| `lol_api_cache` | `expires_at <= 현재 시각` |
| `lol_matches` | `expires_at <= 현재 시각`; 참가자 cascade |
| `lol_accounts` | 자동 삭제 없음; 명시적인 삭제 요청만 처리 |
| `lol_collection_leases` | `lease_until <= 현재 시각` |
| `lol_ranked_history`, `lol_player_match_summaries` | 영구 보관; 명시적 계정 삭제 cascade |
| `lol_ops_daily` | 이 변경에서 TTL·자동 삭제 없음 |

`20261023040000`에서 기존 `cleanup_lol_expired_data()`의 계정 자동 삭제를 중단한다. 반환 시그니처와 호출부는 유지한다.
운영 패널은 새 배치 RPC만 호출한다.

## 스케줄 제안: 미적용

GitHub Actions·Vercel Cron은 생성하거나 활성화하지 않았다.
초기 제안은 1시간마다 100행 배치 1회다. 각 회차 부모 행 상한은 3테이블 합계 300행이다.
참가자는 경기당 최대 10행 수준일 수 있다. 계정별 장기 이력·요약은 정리 대상이 아니며 저장량은 누적된다.
실제 예상 삭제 수는 각 실행 직전 `preview` 결과에서 `min(대기 수,100)`을 테이블별로 합산해 산정한다.
하루 적체 증가량과 배치 소요 시간·공유 DB 대기 시간을 측정한 후 주기·배치 크기를 조절한다.
운영 관리자 승인과 실행 자격·동일 출처 정책을 먼저 별도로 설계해야 자동화를 적용할 수 있다.
롤백은 예약을 먼저 비활성화하고 진행 중 실행을 확인하는 방식이며 삭제된 데이터는 별도 백업 없이는 되돌릴 수 없다.

## 장애 대응표

| 원인 | 사용자 HTTP·문구 | 안전 로그 | 메트릭·대응 |
| --- | --- | --- | --- |
| Riot 401/403 | 403 · Riot API 키 또는 API 권한을 확인해 주세요 | `http_401`/`http_403` | `riot_key_error`; 키 확인 필요 |
| 키 미설정 | 503 · Riot API 키가 설정되지 않았습니다 | `missing_api_key` | 패널에서 키 확인 필요 |
| Riot 429 | 429 · Riot API 요청 한도에 도달했습니다; Retry-After | `http_429` | `riot_429`; 쿨다운 종료 후 재시도 |
| Riot 5xx | 502 · Riot API에 일시적인 문제가 있습니다 | HTTP 상태별 사유 | `riot_5xx`; 외부 상태 확인 |
| Riot fetch 또는 응답 본문 읽기 시간 초과 | 504 · Riot API 응답 시간이 초과되었습니다 | `timeout`, fetch/body 단계 | `riot_timeout`; 이후 재시도 |
| Riot 네트워크 | 502 · Riot API에 일시적인 문제가 있습니다 | 허용된 전송 오류 코드 | `riot_network`; 네트워크 확인 |
| DB 연결·저장 실패 | 503 · LoL 저장소를 사용할 수 없습니다 | operation + `db_error` | `db_error`; DB 연결·권한 확인 |
| DB 시간 초과 | 503 · LoL 저장소를 사용할 수 없습니다 | operation + `timeout` | `db_timeout`; 쿼리·연결 대기 확인 |
| 운영 API DB 실패 | 503 · LoL 운영 저장소를 사용할 수 없습니다 | operation + 안전 사유 | 상태 조회·정리 재시도 전 DB 확인 |
| 메트릭 기록 실패 | 검색 응답 유지 | `metric_failed` | 메트릭 재기록 없음; 로그 확인 |

Riot 응답 본문·전송 예외 원문·키·식별자를 로그에 남기지 않는다.
401/403/429 오류 본문 취소가 실패하더라도 원래 오류 상태를 유지한다.

## 롤백 SQL 초안

실행하지 않은 초안이다. 애플리케이션도 일치하는 이전 DTO 계약으로 되돌려야 한다.
운영 롤백 전 메트릭 보존 여부와 진행 중 수집·정리 요청을 확인한다.

### `20261023030000_lol_ops_metrics.sql`

운영 패널·메트릭 호출 코드를 먼저 되돌린 뒤 아래를 실행한다.
기존 무제한 정리 RPC와 LoL 전적 테이블은 유지된다.

```sql
begin;
set local lock_timeout = '2s';
drop function public.get_lol_ops_status();
drop function public.cleanup_lol_expired_batch(integer);
drop function public.preview_lol_expired_data();
drop function public.increment_lol_ops_metric(text,integer);
drop table public.lol_ops_daily;
commit;
```

### `20261023020000_lol_ranked_daily.sql`

아래는 직전 migration의 조회 함수 정의를 복원한다.
`persist_lol_search_snapshot`은 변경하지 않았으므로 별도 복원이 필요 없다.
애플리케이션을 이전 DTO·캐시 키 버전으로 되돌린 후 검색 캐시를 무효화한다.

```sql
begin;
set local lock_timeout = '2s';
create or replace function public.get_lol_ranked_history(p_puuid text, p_limit integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with queues(queue_type) as (values ('RANKED_SOLO_5x5'),('RANKED_FLEX_SR'))
  select jsonb_object_agg(queues.queue_type,jsonb_build_object(
    'points',coalesce((
      select jsonb_agg(jsonb_build_object('recordedAt',recent.recorded_at,'tier',recent.tier,'rank',recent.rank,'lp',recent.league_points)
        order by recent.recorded_at,recent.id)
      from (
        select id,recorded_at,tier,rank,league_points from public.lol_ranked_history
        where puuid=p_puuid and queue_type=queues.queue_type
        order by recorded_at desc,id desc limit greatest(1,least(coalesce(p_limit,30),30))
      ) recent
    ),'[]'::jsonb),
    'highest',(
      select jsonb_build_object('recordedAt',recorded_at,'tier',tier,'rank',rank,'lp',league_points)
      from public.lol_ranked_history where puuid=p_puuid and queue_type=queues.queue_type
      order by coalesce(array_position(array['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND','MASTER','GRANDMASTER','CHALLENGER'],tier),0) desc,
        coalesce(array_position(array['IV','III','II','I'],rank),0) desc,league_points desc,recorded_at,id
      limit 1
    ),
    'trackingSince',(
      select min(recorded_at) from public.lol_ranked_history where puuid=p_puuid and queue_type=queues.queue_type
    )
  )) from queues;
$$;
revoke all on function public.get_lol_ranked_history(text,integer) from public, anon, authenticated;
grant execute on function public.get_lol_ranked_history(text,integer) to service_role;

delete from public.lol_api_cache where kind='search';
commit;
```

## PUBG 영향 측정 방법

- 상태 RPC는 명시한 `lol_*` 10개 테이블만 읽는다. PUBG 테이블·조회·저장 계약은 변경하지 않는다.
- LoL 관계별 `pg_total_relation_size` 합계와 일별 증가량을 기록해 게임별 관계 용량을 구분한다.
- 테이블은 분리돼 있지만 동일 PostgreSQL 인스턴스의 CPU·I/O·연결·디스크 한도는 공유한다.
- 상태 패널의 정확한 count는 참가자 테이블이 커질수록 비용이 증가하므로 요청 빈도와 실행 시간을 측정한다.
- 승인된 운영 측정에서 LoL 검색 전후 PUBG 대표 쿼리의 실행 시간·호출 수·DB 연결 대기와 전체 저장 용량을 비교한다.
- 로컬 측정은 일회용 fixture DB에서만 수행하며 운영 성능 수치를 추정한 값으로 보고하지 않는다.

## 검증과 미확인 사항

기본 검증 명령:

```sh
BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations
bash scripts/verify_lol_persistence_local.sh
npm run verify:core
npm run verify:lol
RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts --testTimeout=30000 --hookTimeout=90000
```

로컬 SQL fixture는 일별 최종값·KST 경계·이전 시작점·증가 RPC·allowlist·권한·dry-run/실제 삭제 일치·배치 상한을 검증한다.
브라우저 fixture는 외부 Riot·운영 DB 연결을 막고 모바일 375×667, 390×844, 430×932 및 데스크톱을 확인한다.
실제 관리자 로그인·로그아웃·권한 회수는 메인 담당자의 Chrome 확인 예정이며 이 작업에서 확인하지 않았다.
실제 Riot 키·운영 DB 적용·운영 용량·실기기 iOS/Android 동작은 미확인이다.
브라우저 뷰포트 검사는 실제 모바일 앱·실기기 검증을 대체하지 않는다.

## 로컬 검증 결과 (2026-10-23)

- 공통 migration 검증: `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations` 통과.
- 전용 일회용 PostgreSQL 17 검증: `bash scripts/verify_lol_persistence_local.sh` 통과.
- `npm run verify:lol`: 8개 파일, 191개 테스트 통과.
- `npm run verify:admin`: 20개 파일, 423개 테스트 통과.
- 브라우저 fixture: 25개 테스트 통과. 그래프 날짜 라벨 경계, 운영 패널 미리보기·확인·배치와 모바일 3종·데스크톱 넘침을 확인했다.
- PostgreSQL 17 + PostgREST 16.5 통합: populate/cache-hit/flag-off/db-error 네 모드 통과, 격리 포트 종료 확인.
  기존 로컬 바이너리에 `POSTGREST_BIN`, `POSTGREST_LIBRARY_PATH`를 지정했으며 설치·외부 API 접속은 없었다.
- `npm run verify:core`: ESLint·TypeScript 오류 0개, 기존 파일 경고 47개.
- LoL 제품 코드·테스트·새 migration·운영 문서 등 43개 파일에서 300자 초과 줄 0개, 제품 금지 식별자 0개.
- `git diff --check`와 검증 스크립트 3개의 `bash -n` 통과.

새 migration SHA-256:

| 파일 | SHA-256 | 교체하는 기존 함수 |
| --- | --- | --- |
| `20261023020000_lol_ranked_daily.sql` | `493cd7b8d2ed0704abdeb8aa912ba7b45f21ae1732c7cfcb097cf59d299beb44` | `get_lol_ranked_history(text,integer)` |
| `20261023030000_lol_ops_metrics.sql` | `465dfcb131a34d885f7c1b7ecb0584e99608aa0c807ade44e40932c8363bdb9c` | 없음; 테이블 1개·RPC 4개 신설 |

새 RPC는 `increment_lol_ops_metric(text,integer)`, `preview_lol_expired_data()`,
`cleanup_lol_expired_batch(integer)`, `get_lol_ops_status()`이다.
`20261023020000`·`20261023030000` 단계에서는 기존 `persist_lol_search_snapshot` 및 `cleanup_lol_expired_data()` 본문을 변경하지 않았다.
아래 `20261023040000` 보관 정책 단계에서 요약 저장과 계정 자동 삭제 중단을 추가한다.
로컬 보조 지침 `.agents/rules/project_rules.md`는 없어 현재 저장소·스킬·검증 결과를 기준으로 작업했다.

## 운영 적용 (2026-10-23 00:28 UTC)

- `20261023020000_lol_ranked_daily.sql`(SHA-256 `493cd7b8…beb44`)과 `20261023030000_lol_ops_metrics.sql`(SHA-256 `465dfcb1…bdb9c`)을 임시 workdir(원격 이력 174개 자리표시 + 대상 2개)로 `--dry-run` 확인 후 적용했다.
- 확인: `lol_ops_daily` RLS 활성, anon·authenticated의 테이블 SELECT와 신규 RPC 4개 EXECUTE 불가, service_role 가능.
  실제 검색 후 메트릭 행 기록, 운영 상태 패널에 오늘 Riot 호출·429 없음·테이블 용량(LoL 합계 약 2 MB)·만료 대기(캐시 8행) 표시.
- 정리 실행(배치)은 운영 삭제이므로 사용자 승인 전 실행하지 않았다. 자동 스케줄은 만들지 않았다.


## 보관 정책

`20261023040000_lol_player_summaries.sql`부터 적용할 정책이다. 이 절의 운영 적용은 아직 수행하지 않았다.
PUBG A안과 같은 원칙으로, 검색한 계정의 본인 이력은 남기고 재사용 가능한 대용량 원문은 짧게 보관한다.

| 구분 | 대상 | 보관·정리 기준 |
| --- | --- | --- |
| 영구 | `lol_accounts`, `lol_ranked_entries`, `lol_ranked_history` | 미접근 90일 자동 삭제 중단; 명시적 삭제 요청은 별도 처리 |
| 영구 | `lol_player_match_summaries` | 검색된 계정 본인만 저장; `(puuid,match_id)` 유일; 계정 삭제 시 cascade |
| 단기 | `lol_matches.request_json`, `lol_match_participants` | 기존 7일 TTL; 원문 삭제 시 참가자 cascade |
| 즉시 | 만료된 `lol_api_cache`, `lol_collection_leases`, `lol_public_rate_limits` | 배치 정리 시 삭제; 자동 정리는 저장소 변수 `LOL_CLEANUP_ENABLED=true`일 때만 적용 |

요약은 `lol_matches` FK를 두지 않는다. 계정 FK만 두어 원문 만료와 독립적으로 유지한다.
카드·요약 계산에 필요한 경기 시각·길이·패치·챔피언·포지션·승패·다시하기·KDA·CS·골드·피해량·시야·와드·목표물/포탑 피해를 보존한다.
팀 킬, 챔피언 레벨, 7개 아이템 ID, 주문 2개 ID, 핵심 룬/주계열/부계열 ID도 보존한다.
CS/분·골드/분·킬 관여율은 보관한 수치로 계산하고 챔피언 한글명·이미지·룬/주문 이름은 정적 데이터로 복원할 수 있다.
동료는 같은 팀 최대 4명의 `{riotId,win}`만 저장하며 동료 PUUID와 상대 팀 상세는 영구 보관하지 않는다.
공개 전 개인정보처리방침의 LoL 보관·삭제 문구는 별도 작업이 필요하며 `app/privacy`는 수정하지 않았다.
Riot 정책과 개인정보·저장 허용 범위는 공개 전 메인 담당자가 최신 공식 문서로 재확인해야 한다.

### 저장·백필·조회 계약

검색·상세·더 보기의 기존 트랜잭션 안에서 `upsert_lol_player_match_summaries(text,text)`를 호출한다.
원문 참가자 중 `lol_accounts`에 존재하는 PUUID만 upsert한다. 추가 Riot API 호출은 없다.
검색 계정 upsert 직후에는 해당 PUUID의 기존 참가자 행과 원문으로 백필한다.
migration 시점에는 저장된 전체 원문에서 검색 계정의 요약을 백필한다. 반복 실행해도 같은 기본 키를 갱신하므로 중복되지 않는다.
기존 저장 함수의 lease·검증·캐시·랭크 이력 본문은 유지하고 요약 호출만 추가한다.
`get_lol_player_match_summaries(p_puuid,p_limit,p_before)`는 최신 시각·match ID 역순으로 반환한다.
기본 20행, 최대 100행이며 `p_before`는 제외하는 timestamp 경계다. 이번에는 UI 읽기 경로에 연결하지 않는다.
새 테이블은 RLS 활성화, public/anon/authenticated 권한 회수, service_role만 DML한다. 신규 RPC도 service_role 전용이다.
운영 상태 RPC에는 요약 테이블 행 수·용량을 추가한다.

### 삭제 요청 처리 절차

1. 운영 담당자가 요청자의 권리와 대상 Riot ID를 확인한다. Riot 전달 요청도 같은 절차로 처리한다.
2. 관리자 운영 패널에서 `계정 데이터 삭제`에 Riot ID를 입력하고 `삭제 대상 확인`으로 저장 계정을 조회한다.
3. 표시된 Riot ID와 삭제 범위를 검토하고 영구 삭제 동의 체크 후 `계정 영구 삭제 실행`을 누른다.
4. 동일 출처·관리자·`confirm=true`를 확인한 API가 실행 시 계정을 다시 찾아 `delete_lol_account_data(p_puuid)`를 호출한다.
5. 삭제 행 수를 확인하고 요청 처리 결과를 별도의 승인된 운영 기록에 남긴다. 이 작업은 운영 삭제를 실행하지 않는다.

RPC는 계정 삭제로 랭크 엔트리·이력·본인 요약을 cascade 삭제한다.
다른 계정의 요약에서는 현재 Riot ID와 남아 있는 원문에서 확인 가능한 과거 Riot ID를 동료 목록에서 제거한다.
대상 PUUID가 들어 있는 경기 원문과 그 참가자 행도 삭제하여 원문에서 식별자가 다시 복원되지 않게 한다.
그 경기의 다른 검색 계정 본인 요약은 유지한다. 반환 `participant_rows`는 관련 원문 cascade로 제거한 모든 참가자 수다.
현재와 과거 이름이 남은 DTO까지 제거하려고 LoL 단기 캐시를 모두 무효화한다. 성공 후 현재 프로세스의 메모리 캐시도 비운다.
삭제 직전 시작된 저장을 막으려고 collection lease를 모두 무효화한다. 다른 진행 중 수집도 재시도할 수 있다.
캐시·lease 무효화는 삭제 RPC 안에서 원자적으로 수행한다. 다른 프로세스 메모리와 이미 응답 중인 요청은 원격 프로세스 무효화로 확인하지 않았다.
과거 Riot ID가 원문 TTL 이후에만 남아 있으면 PUUID 없는 동료 목록과 동일인임을 자동 식별할 수 없으므로 운영 요청 검토에서 별도 확인한다.
동일 PUUID 재삭제는 0행으로 수렴한다. 이후 새 검색으로 다시 수집할 수 있으며 영구 차단 명단은 이번 범위에 포함하지 않는다.
백업이 운영된다면 별도의 백업 보존·삭제 절차도 함께 확인해야 한다.

### 요약 기능 롤백 SQL 초안

운영 적용 전 검토용이며 실행하지 않았다. 애플리케이션의 요약·계정 삭제 호출을 먼저 되돌린다.
요약 데이터가 필요하면 사전에 승인된 백업을 확보한다. 아래 DROP은 저장된 요약을 삭제한다.
계정 자동 삭제 중단 정책은 유지하며 저장 함수에서 요약 호출과 상태 테이블 목록만 제거한다.

```sql
begin;
set local lock_timeout = '2s';
do $rollback$
declare v_signature text; v_definition text;
begin
  foreach v_signature in array array[
    'public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)',
    'public.persist_lol_match_details(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)'
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_signature::regprocedure);
    v_definition := replace(v_definition,'  perform public.upsert_lol_player_match_summaries(null,v_puuid);','');
    v_definition := replace(v_definition,'    perform public.upsert_lol_player_match_summaries(v_match_id,null);','');
    v_definition := replace(v_definition,'  perform public.upsert_lol_player_match_summaries(v_match_id,null);','');
    execute v_definition;
  end loop;
  v_definition := pg_catalog.pg_get_functiondef('public.get_lol_ops_status()'::regprocedure);
  v_definition := replace(v_definition, $remove$    union all select 'lol_player_match_summaries',
      (select pg_catalog.count(*) from public.lol_player_match_summaries),
      pg_catalog.pg_total_relation_size('public.lol_player_match_summaries'::regclass)
$remove$, '');
  execute v_definition;
end;
$rollback$;
drop function public.delete_lol_account_data(text);
drop function public.get_lol_player_match_summaries(text,integer,timestamptz);
drop function public.upsert_lol_player_match_summaries(text,text);
drop table public.lol_player_match_summaries;
commit;
```

### 약관 종료 시 전체 삭제 SQL 초안

약관 종료 범위와 법적 보존 의무를 확인하고 수집 트래픽·예약·수집 워커를 중단한 뒤 승인받아 실행할 초안이다.
다음 SQL은 LoL 전체 기록을 복구 불가능하게 삭제한다. DB 백업과 다른 프로세스 메모리·외부 보관물도 별도 절차로 처리해야 한다.
`CASCADE`를 쓰지 않으며 PUBG 테이블은 포함하지 않는다.

```sql
begin;
set local lock_timeout = '2s';
truncate table
  public.lol_api_cache, public.lol_match_participants, public.lol_matches,
  public.lol_player_match_summaries, public.lol_ranked_history,
  public.lol_ranked_entries, public.lol_accounts,
  public.lol_collection_leases, public.lol_rate_limit_state, public.lol_ops_daily
restart identity;
commit;
```

전체 삭제 후 서비스 재개 시 rate limit 초기 행 복구를 포함한 별도 초기화 검토가 필요하다.

### 보관 정책 로컬 검증 결과 (2026-10-23)

- `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations`: 통과; 실제 migration 이전 fixture의 원문 백필 포함.
- `bash scripts/verify_lol_persistence_local.sh`: 통과; 저장 경로 2개·늦은 계정 백필·멱등·원문 만료 후 요약 보존·계정 보존 검증.
- 삭제 RPC: 계정 cascade·현재/원문에서 확인한 과거 이름의 동료 참조 제거·원문/참가자 제거·수집 lease 차단·재실행 멱등·anon 거부 확인.
- `npm run verify:core`: ESLint/TypeScript 오류 0개, 기존 경고 47개.
- `npm run verify:lol`: 8개 파일, 205개 테스트 통과. 신규 읽기 RPC와 관리자 삭제 API 검증 포함.
- `npm run verify:admin`: 20개 파일, 423개 테스트 통과.
- `RUN_LOL_DEV_BROWSER=true` 브라우저 fixture: 25개 테스트 통과.
  운영 패널은 375×667, 390×844, 430×932, 1440×900에서 안내 문구·대상 조회·최종 확인·삭제 응답·넘침을 검증했다.
- PostgreSQL 17 + PostgREST 16.5의 populate/cache-hit/flag-off/db-error 네 모드 통과. 격리 포트 종료 확인.
- 위 요약 기능 롤백 SQL을 일회용 DB 트랜잭션에서 실행하고 상태 목록 9개·저장 함수 호출 제거를 확인한 뒤 롤백했다.
- 변경 범위의 300자 초과 줄 0개, 금지 식별자 0개, `git diff --check` 및 검증 스크립트 `bash -n` 통과.
- macOS Bash의 기존 `[[ ... ]]` 검사에는 명시적인 실패 종료를 추가하여 캐시 재시작·만료 lease·동시성 검증의 실패가 누락되지 않게 했다.
- 저장 함수 2개는 신규 요약 호출을 제외한 본문이 직전 migration과 동일함을 문자열 대조로 확인했다.
- 새 migration SHA-256: `9701a1b297ac3c3d7ec1a6f3050d618426555d8e86579d3e2f5b86a046932b50`.

교체한 기존 함수는 다음 여섯 개다. 시그니처와 기존 권한은 유지한다.

```text
persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)
persist_lol_match_details(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)
cleanup_lol_expired_data()
preview_lol_expired_data()
cleanup_lol_expired_batch(integer)
get_lol_ops_status()
```

신규 함수는 `upsert_lol_player_match_summaries(text,text)`,
`get_lol_player_match_summaries(text,integer,timestamptz)`, `delete_lol_account_data(text)`다.
이번 작업에서 운영 DB·Supabase 원격·실제 Riot 연결·개발 서버 재시작·staging·커밋은 수행하지 않았다.
실제 운영 적용·삭제 요청 처리와 개인정보처리방침 LoL 문구·Riot 정책 재확인·실기기는 메인 담당자 확인이 남아 있다.

## 보관 정책 운영 적용 (2026-10-23 01:06 UTC)

- `20261023040000_lol_player_summaries.sql`(SHA-256 `9701a1b2…32b50`)을 원격 이력 176개 자리표시 + 대상 1개 workdir로 `--dry-run` 후 적용했다.
- 교체 함수 6개(persist 2·정리 3·상태 1)는 직전 정의 대비 요약 upsert 호출 추가와 계정 자동 삭제 제거, 상태 테이블 목록 추가만 바뀐 것을 메인이 diff로 확인했다.
- 적용 후: 요약 23행(검색 계정 2개) 백필, RLS 활성, anon 조회·authenticated 삭제 RPC 실행 불가, service_role 가능, teammates에 PUUID 없음. 실제 검색 정상.
- 후속 최적화 후보: 검색마다 실행되는 요약 upsert가 저장 원문 전체의 참가자 배열을 펼친다. 7일 원문 범위에서는 문제없으나 공개 후 경기 수가 늘면 참가자 인덱스로 대상 경기를 먼저 좁히도록 바꾼다.
- 계정 삭제 기능은 fixture에서만 검증했고 운영 실계정으로 실행하지 않았다.

## 심사 전 자동 정리 확장 (2026-10-24, 운영 미적용)

`20261024020000_lol_review_hardening.sql`은 기존 preview·배치 RPC에 만료된 공개 요청 카운터와 배치 잠금·메트릭을 추가한다.
계정·본인 요약·랭크 이력의 보존 계약은 유지한다. 일일 스케줄은 기본 dry-run이다.
실행 상한, 신설 객체, 적용 순서는 [심사 전 안정화 운영 계약](../operations/2026-10-24-lol-review-hardening.md)을 따른다.
