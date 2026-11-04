# LoL 검색 저장 시간 초과와 검색 추천

## 장애 근거

2026-11-04 16:40–16:50 KST 운영 Postgres 로그에서 `persist_lol_search_snapshot` 내 계정별 `upsert_lol_player_match_summaries(null,v_puuid)` 2건과 `aggregate_lol_match_benchmarks` 1건이 `57014 statement timeout`으로 취소됐다. DB API 연결의 statement timeout은 8초이고 애플리케이션 DB 호출 제한은 10초다. API로 받은 결과라도 저장 트랜잭션이 실패하면 공개 검색은 503 `LoL 저장소를 사용할 수 없습니다.`를 반환한다.

## 변경 계약

- 참가자 인덱스로 계정별 요약 백필 대상 경기 ID부터 제한한다. 이미 요약이 있는 계정 백필은 건너뛰고, 경기별 갱신과 전체 관리용 백필은 기존대로 갱신한다. 선택된 원문의 `info`를 materialized CTE로 한 번 추출한다. 다른 계정의 원문 JSON을 펼치지 않는다.
- benchmark 표본을 구간별로 한 번 계산한 후 정렬한 히스토그램 배열로 조립한다. 0 구간, 오른쪽 경계, 결측·음수·분모 0 제외, 경기별 중복 방지와 집계 행 잠금 순서는 유지한다.
- 전적 저장 RPC의 시그니처·원자성·lease·계정 삭제 경합·RLS·service_role 전용 권한은 유지한다. benchmark는 검색 저장 트랜잭션에서 제외하고 성공 응답 뒤 Next `after`에서 경기별 RPC로 처리한다(시작 20초 상한, RPC 10초 상한). 제한 시간 증가나 외부 큐 테이블은 추가하지 않는다.
- 응답 뒤 집계가 중단되면 `get_lol_pending_benchmark_matches`가 기존 원문과 `lol_benchmark_processed_matches`의 차집합을 만료 가까운 순서로 찾는다. 3시간 챔피언 통계 workflow에서 기존 쓰기 플래그를 사용해 최대 100경기·60초 동안 경기별로 재처리한다. 각 경기 집계는 별도 트랜잭션이며 기존 고유 경기 marker로 동시 중복 누적을 막는다. 재처리 실패는 workflow 경고로 기록하고 챔피언 통계 수집은 계속한다.
- `GET /api/lol/suggest?q=...`는 공개 LoL read gate와 요청 한도를 사용한다. 2–81자 입력에서 저장된 KR/asia 계정의 이름·태그 접두어를 최대 8개 반환한다. `%`, `_`, 역슬래시는 리터럴이다. PUUID나 랭크 등은 반환하지 않고 Riot API를 호출하지 않는다. 응답은 `private, no-store`, DB 2초 제한, 실패 시 503 빈 추천이다.
- 검색 UI는 입력 포커스에서 즐겨찾기 우선·최근 중복 제외 목록을 제공한다. 두 글자 이상은 300ms 디바운스 추천을 표시한다. 추천이 없더라도 전체 Riot ID를 직접 입력해 최초 검색할 수 있다. 기록의 localStorage 키와 한도는 기존 계약을 유지한다.

## 검증

- `npm run verify:migrations`: 일회용 PostgreSQL 17에서 전체 시나리오 통과. 기존 요약·benchmark 수치/경계/중복/lease/삭제/권한 회귀 포함.
- 신규 대용량 fixture: 20경기 전적 원자적 저장, 미집계 목록 조회·별도 집계, 반복 저장 중복 방지, 대상 밖 원문 미접근을 검사하고 저장 4초 상한을 확인한다. 이 수치는 격리 로컬 DB 결과이며 운영 지연을 보장하지 않는다.
- 추천 RPC: prefix·태그·와일드카드 리터럴·KR 범위·8개 상한·직접 공개 호출 차단 검증.

## 운영 재현 기록

첫 SQL 최적화 후에도 등록되지 않은 실제 계정 검색은 집계 SQL에서 8초를 초과했다. 동일한 실제 요청 20경기(약 2.54MB)를 일회용 PG에서 재생하면 약 306ms였고, 선수·팀 CTE를 추가 materialize하는 후보는 약 342ms로 개선되지 않아 적용하지 않았다. 운영과 로컬 실행 환경의 세부 성능 차이는 미확정이다. 이 결과에 따라 앞서 설계한 응답 뒤 집계 분리를 적용한다.

## 무한 재시도의 근본 원인과 복구

최소 705바이트의 만료 lease 요청도 응답 없이 반복되는 것을 확인했다. 운영 로그에서 같은 backend가 `40001`을 초당 한 번씩 반복했고, Supabase 공식 KB의 PostgREST 14 무한 재시도 문제와 일치했다. [공식 문서](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions).

`20261104084320_lol_rpc_conflicts_without_retry`는 지정된 LoL RPC 7개의 의도적 충돌 코드 11곳을 `PT409`로 바꾼다. 함수별 signature와 변경 개수를 확인하고 기존 함수의 나머지 정의와 ACL은 유지한다. 애플리케이션은 배포 전후 호환을 위해 `40001`과 `PT409`를 모두 lease/cursor 충돌로 분류한다. 자연 발생한 DB 직렬화 실패 처리 범위는 바꾸지 않는다.

운영 적용 뒤 동일한 만료 요청은 912ms에 `PT409`를 반환했고, 같은 실제 최초 검색 대상은 6,871ms에 200·20경기·ready·실패 0건으로 성공했다. 특정 반복 backend 종료도 조건을 재검증했지만 실행 순간 대상이 일치하지 않아 종료한 backend는 없다. 이 수치는 한 계정의 실측이며 모든 계정의 응답 시간을 보장하지 않는다.

운영 적용 migration: `20261104081659_lol_search_storage_performance`, `20261104083223_lol_defer_search_benchmarks`, `20261104083246_lol_account_suggestions`, `20261104084320_lol_rpc_conflicts_without_retry`. 데이터 삭제와 RLS 완화는 없다. 마지막 사용자 지시대로 앱 변경은 main 머지까지만 진행하고 배포하지 않는다. 새 앱의 응답 뒤 집계 코드는 배포 전이므로, 전환 전 새 원문은 미집계 목록에 남을 수 있다.
