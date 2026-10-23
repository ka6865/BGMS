# LoL 전적 검색 범위와 용량 추정

> **2026-10-22 19:52 UTC 변경:** 사용자 결정으로 하루 40회 자체 예산을 제거했다(`supabase/migrations/20261022200000_lol_remove_daily_budget.sql`, 운영 적용 완료). `reserve_lol_riot_request`는 더 이상 `daily_budget`을 반환하지 않으며 `used_count`는 관측용으로만 센다. Riot 응답 헤더 기반 감속, 429 쿨다운, 요청 lease 2개, 최소 1.5초 간격은 유지한다. 아래 40회 관련 서술은 적용 당시 기록이다.

기준일: 2026-10-22  
범위: 현재 LoL 검색·상세 API, Riot 호출 예산, migration 저장 계약, 격리 PostgreSQL 17 합성 측정. 운영 DB·Riot 키·실계정은 조회하지 않았다.

## 요약

- 현재 검색은 한국 플랫폼 `kr`와 지역 라우트 `asia`를 사용한다. 계정 Riot ID 조회 1회, 소환사·랭크·최근 경기 ID 3회, 경기 상세 최대 5회로 검색 cache miss당 **최대 9 Riot API 요청**이다. 경기 ID를 현재 5개로 고정하며 Match-V5 상세 조회는 순차 처리한다.
- DB 가드의 현재 전역 ceiling은 예약 40회/UTC일, 동시 Riot 요청 lease 최대 2, 최소 시작 간격 1.5초다. 이를 1인 비공개 개발의 구현 상한으로 보고, steady usage 제안은 별도로 3 cold search miss/day 정도로 둔다. DB가 켜진 같은 프로세스에서는 요청 queue가 직렬이라 실제 Riot fetch는 한 번에 하나씩 실행된다. Riot의 공식 키 한도와 별개의 BGMS guard다.
- 40회 예산은 5경기 검색 miss **4회(36요청)**를 온전히 수용하고, 4회를 넘는 잔여 4요청은 단일 새 검색에 부족하다. 20경기 검색은 최대 24요청, 100경기 검색은 최대 104요청이므로 현재 예산·제품 범위에 맞지 않는다.
- 2분 검색 DTO cache hit은 Riot 0회, DB RPC 1회다. DTO가 만료돼도 저장된 경기 raw JSON이 유효한 7일 안이면 검색과 상세 경로가 이를 재사용해 match-detail Riot 호출을 줄인다. 별도 상세 DTO cache는 7일이다.
- 운영 요청량·실사용 행수·DB bytes·CPU/메모리/compute는 확인하지 않았다. 단독 로컬 PG17 합성 측정은 DB 구조·쿼리의 작은 표본일 뿐 운영 용량으로 환산할 수 없다.

## 현재 검색 경로

`lib/lol/riotSearch.server.ts`의 `searchLolRiotId()`는 다음 순서로 조회한다.

| 단계 | API / 위치 | 요청 수 | 역할 |
| --- | --- | ---: | --- |
| Riot ID → PUUID | Account-V1, `asia` | 1 | 계정 이름/태그 및 PUUID |
| 프로필 | Summoner-V4, `kr` | 1 | 아이콘, 소환사 레벨 |
| 현재 랭크 | League-V4, `kr` | 1 | Solo/Flex의 현재 티어·LP·승패 |
| 경기 ID | Match-V5, `asia`, `count=5` | 1 | 최근 5개 ID |
| 경기 요약 | Match-V5 상세, `asia` | 0–5 | 각 경기 상세에서 검색 사용자 요약 생성 |
| 정적 이름·이미지 | Data Dragon CDN, 메모리 cache | cache miss 시 최대 2개 HTTP 요청 | 챔피언·아이템 정적 리소스, Riot API 키·Riot API rate bucket과 별개 |

최대치는 `1+1+1+1+5=9`다. DB 모드에서는 앞의 3개 요청이 순차 실행되고, 경기 상세도 한 건씩 순차 조회한다. Riot 호출 오류 중 rate limit·키/권한·저장소 오류는 검색 전체 오류로 올라온다. 경기 상세의 기타 오류는 첫 실패 뒤 반복을 멈추고 성공분만 반환해 `partial`로 표시한다. ID가 있었지만 유효 요약이 하나도 없으면 `failed`; ID 없음은 `empty`다. 계정/프로필/랭크/ID 단계가 실패하면 부분 경기 목록 DTO를 저장하지 않는다.

최근 경기 DTO는 검색 사용자 관점의 결과, 챔피언, K/D/A, 라인 CS+정글 CS 합계다. 상세 endpoint는 저장 경기 상세 DTO에서 양 팀 참가자, 아이템·피해·CS·시야를 반환한다. 현재 League-V4 랭크는 조회 시점의 랭크이며 각 경기 당시 랭크 이력이 아니다.

### Cache와 저장 재사용

| 조회 종류 | 유효기간/동작 | 만료 후 |
| --- | --- | --- |
| 검색 결과 DTO (`lol_api_cache`, `kind=search`) | 2분, 요청 계정·라우트·버전 키 | Riot 검색 전체를 다시 수행 |
| 경기 상세 DTO (`kind=match_details`) | 7일 | 상세 화면에서 Riot Match-V5 상세를 다시 요청 |
| `lol_matches.request_json`, 경기 및 참가자 | 원본 Riot Match-V5 JSON은 최대 1 MiB/경기, 경기 `expires_at` 최대 7일 | 유효한 경기 행이 있으면 search/detail 경로에서 원본 JSON 재사용. 재사용은 `fetched_at`/만료시각을 연장하지 않으며, 만료 후 새 원본을 성공 저장할 때만 갱신; cleanup 실행 시 경기 삭제, FK cascade로 참가자 삭제 |
| 계정·현재 랭크 | 계정은 마지막 저장 접근 90일 후 cleanup 대상; 랭크는 계정별 현재 snapshot | cleanup 실행 시 계정 삭제 및 랭크 cascade |
| Data Dragon 정적 자료 | 프로세스 메모리 24시간 | CDN 재조회; Riot 키 호출 아님 |

Persistence flag가 꺼진 로컬 경로는 같은 프로세스의 endpoint-response cache를 쓴다. account/profile/rank/IDs와 검색 결과는 2분, Riot match response는 10분이며 전체 최대 100 entries/entry value 256 KiB 제한이다. DB 영속 cache와 별개의 단일 프로세스 cache다.

검색 경로는 검색 DTO miss 후 각 Match-V5 ID마다 `get_lol_match_request_json` RPC를 조회한다. 유효한 경기 원본 JSON이 이미 `lol_matches.request_json`에 저장되어 있으면 다시 Riot을 호출하지 않는다. 원본 행을 다시 써도 기존 만료시각은 미끄러지지 않으며, 기존 행 만료 후 새 Riot 응답이 저장될 때 원본·`fetched_at`·만료시각을 함께 갱신한다. 별도 `/matches/{matchId}` 상세 endpoint도 먼저 7일 `match_details` DTO cache를 확인하고, DTO cache miss이면 경기 원본 JSON을 조회한다. 상세 DTO의 만료시각은 원본 경기 만료시각을 넘지 않는다. 따라서 검색 DTO는 2분, 재사용 가능한 원본 경기 데이터는 최대 7일이다. Cache read RPC는 `expires_at > clock_timestamp()`인 행만 반환하므로 만료행은 읽히지 않지만, 만료 시각에 물리 삭제되는 것은 아니다. cleanup 함수가 실행될 때 만료 cache·경기와 90일 미접근 계정을 삭제한다. migration만으로 주기 실행은 설정되지 않았고 삭제 batch 상한도 없다.

## 호출 예산과 guard 의미

### Riot 공식 한도와 BGMS 자체 한도

Riot 포털의 현재 안내는 Development 키가 24시간마다 비활성화되고, Personal 키는 지역별 20요청/초 및 100요청/2분, Production 시작 한도는 지역별 500요청/10초 및 30,000요청/10분이다. Personal은 작은 비공개 프로젝트 용도이고 공개 소비 서비스에는 쓸 수 없다. 공개 서비스는 Production 키와 제품 심사/등록이 필요하다. Riot 한도는 API key·region·endpoint method의 제한을 포함하며 실제 헤더가 제공하는 method limit도 따라야 한다.

현재 DB guard는 더 낮은 **BGMS 내부 가드**를 둔다.

- `reserve_lol_riot_request()`가 모든 host 합산 40회를 UTC 날짜 기준 예약한다. 실제 HTTP 완료 시점이 아니라 요청 시작 전 permit 예약 시 카운터가 증가하므로 Riot 호출 전에 취소·실패해도 예산이 소진될 수 있다. 검색 hit·DB cache hit은 permit을 예약하지 않는다.
- 예약 lease를 동시에 최대 2개 허용한다. 동일 Riot ID 검색은 별도 collection lease로 중복 실행을 막는다. 같은 Node 프로세스의 promise queue는 upstream fetch 전체를 직렬화하므로 DB 모드에서는 단일 실행 인스턴스 내 동시 Riot fetch가 1개다. 복수 인스턴스 간 상태는 DB가 공유한다.
- 모든 Riot 요청의 기본 최소 간격은 1,500ms다. 응답 `X-App-Rate-Limit`/`X-Method-Rate-Limit`을 저장하고 관측 window의 80% 이상이면 window 전체 cooldown을 설정한다. 계산된 간격이 기본값보다 크면 전역 다음 permit 시각을 늦춘다. 잘못되거나 지원하지 않는 헤더는 UTC 다음 날까지 fail-closed다. `Retry-After`도 global/host 차단에 반영한다.
- Riot의 App/Method window는 region와 endpoint method별인데 BGMS는 관측한 window로 단일 global 최소 간격·host/global cooldown을 보수 적용한다. Header count는 응답 시점의 표본이고 Riot이 별도로 계산하는 다른 호출·동시 인스턴스 사용량을 즉시 반영하지 않을 수 있다. 이 가드는 정확한 Riot bucket mirror가 아니므로 Riot 429/Retry-After 처리도 유지한다.
- 실제 키에 적용된 Riot method limit, 이 시점의 header count, 429 빈도는 읽지 않았다. 저장된 header text는 runtime 관측값이지 키 승인·처리량 보증이 아니다.
- persistence flag가 꺼진 로컬 메모리 경로에는 40회/day guard가 없다. 메모리 동시 검색 2개, 동일 프로세스 요청 queue, 1.5초 간격, 429 cooldown만 적용된다. 이 로컬 경로를 운영 예산으로 해석하면 안 된다.

| 경기 수 | 검색 cache miss당 Riot 호출 | 모두 새 경기일 때 40회 예산 내 온전한 검색 |
| ---: | ---: | ---: |
| 5 (현재) | 최대 9; 모두 7일 내 raw cache hit이면 4 | 새 경기 기준 4회/일 (36회 사용, 4회 잔여) |
| 20 | 최대 24; 원본 JSON 50% hit이면 14; 모두 hit이면 4 | 새 경기 기준 1회/일 (24회 사용, 16회 잔여) |
| 100 | 최대 104; 원본 JSON 50% hit이면 54; 모두 hit이면 4 | 새 경기 기준 0회/일 (단일 검색도 내부 예산 초과) |

전제는 모든 호출이 성공하고 cache hit·기존 ID 중복과 기타 상세 화면 호출이 없다는 보수 계산이다. 한 경기 목록 자체를 얻는 데 4회가 필요하며 상세 경기 수가 `n`이면 `4+n`회다. 40회까지 연속 사용해도 기본 1.5초 간격으로 최소 58.5초에 걸쳐 진행된다. 일일 예산은 이 시간 간격보다 먼저 전체량을 제한한다.

40회/day는 따라서 “4명 또는 동접 4명”이 아니다. 새 경기만 반환하는 5-match 검색은 4회/day가 안전한 상한이다. 이전 7일의 원본 경기 5개가 모두 재사용 가능하면 검색당 Riot 요청은 4회이므로 최대 10회/day까지 예산상 가능하다. 첫 검색 9회 뒤 다른 검색들이 원본을 모두 재사용한다면 총 8회(9+7×4=37, 다음 41회는 차단)가 가능하다. 실사용 수는 원본 match ID 중복과 경기 연령에 따라 달라진다.

### DB RPC 수와 각 hit/miss

저장소 함수는 `lib/lol/persistence.server.ts`의 Supabase RPC wrapper다. 검색 완전 DTO hit은 `get_lol_api_cache` **1 RPC**, Riot 0회다. 검색 miss에는 cache read + lease acquire + snapshot persist의 고정 3 RPC가 있고, 경기 ID마다 raw JSON 조회 1 RPC가 있다. 각 Riot HTTP 요청마다 reserve/start/header observe/release 4 RPC가 붙는다. 경기 ID 수를 `m≤5`, Riot HTTP 요청 수를 `k=4+raw miss 상세 수≤9`라 하면 검색 miss는 `3+m+4k` RPC, 최악 **44 DB RPC**다. Search snapshot persist RPC가 collection lease를 원자적으로 삭제하므로 저장 성공 뒤 별도 lease-release RPC는 없다. 매치 원본이 7일 내 전부 hit이면 현재 5경기 검색은 `3+5+4×4=24 RPC`, Riot 4회다.

| 흐름 | DB RPC | Riot API |
| --- | ---: | ---: |
| 검색 DTO hit (2분 내) | 1 | 0 |
| 검색 miss, `m` ID, `k` Riot HTTP 요청 후 정상 저장 | `3+m+4k` (`m≤5`, `k≤9`, 최대 44) | `k` |
| 현재 5 IDs가 raw cache 모두 hit | 24 | 4 |
| 검색 miss가 저장 전에 실패 | cache+lease 해제 3 + ID별 raw 조회 + 요청별 4회, 실행된 요청 수만큼 | 실행된 요청 수 |
| 상세 DTO hit (7일 이내) | 1 | 0 |
| 상세 DTO miss, 경기 raw cache hit 후 저장 | cache read + lease acquire + raw lookup + persist = 4 | 0 |
| 상세 DTO 및 raw cache miss 후 정상 저장 | cache read + lease acquire + raw lookup + request 4 + persist = 8 | 1 |

`3+m+4k`에는 DTO cache read, lease 획득, snapshot 저장 3회, 최대 5개 raw 조회, Riot당 4회(reserve/start/header/release)가 들어간다. 저장 RPC가 lease를 삭제한다. reserve가 거절되거나 header 관측이 실패하면 실제 RPC 수는 다를 수 있다.

## Riot Match-V5 기능 범위

- 공식 경기 ID 목록 API `count` valid range는 0–100, 기본값은 20이며 `start` pagination, `queue`, `type`, `startTime`, `endTime` 등 필터를 지원한다. 현재 BGMS는 `start=0&count=5`만 구현한다. 수집 확대는 현재 UI/API가 제공하는 범위와 별도다.
- 경기 목록 페이지네이션은 목록 API에서 지원되지만 과거 경기 전체를 영구·완전 제공한다는 보장은 확인하지 못했다. Riot의 2019년 공식 공지는 match history 보관을 rolling 2년으로, timeline은 1년으로 줄였다고 안내했다. 해당 공지는 오래된 공지이므로 현 시점의 endpoint별 보장으로 확장 해석하지 않는다.
- Match-V5 timeline은 경기별 별도 요청이며 구매·킬 등 이벤트 및 시간별 프레임 데이터를 제공한다. 현재 검색은 timeline을 호출하지 않는다. timeline 요청을 추가하면 경기마다 적어도 한 번 더 API 요청되고 payload와 저장 크기도 별도 측정해야 한다.
- League-V4는 현시점 Solo/Flex 랭크를 조회한다. 경기별 과거 랭크·LP 변경 이력은 현재 저장 계약에 없다.

공식 출처: [Riot Developer Portal: 키와 rate limit](https://developer.riotgames.com/docs/portal), [LoL API 및 정책](https://developer.riotgames.com/docs/lol), [Match-V5 API 명세](https://developer.riotgames.com/api-details/match-v5), [Match History retention 공지(2019)](https://www.riotgames.com/en/DevRel/match-history-retention-Change). Match-V5 명세의 저장된 당시 공식 문서 텍스트는 `tmp/lol-api-research/match-v5.txt`에서 확인했다. API 화면의 `count` 설명은 0–100이다.

## 수요 지표: 서로 다른 질문

| 지표 | 단위·정의 | 현재 확인 가능성 |
| --- | --- | --- |
| 사용자 동시명수 | 일정 시점에 요청/검색 처리 중인 서로 다른 사용자 수 | 현재 사용자별 active counter 없음. request lease는 API 요청 동시성이지 사용자 수가 아님 |
| 분당 신규 검색 | cache miss로 시작한 서로 다른 Riot ID 검색/분 | 검색 event counter 없음; 테스트에서만 fixture 호출을 계수 가능 |
| cache 조회 TPS | 검색·상세 DB 조회 RPC/sec | DB `pg_stat_statements` 또는 서비스 관측 필요, 현재 운영 자료 미조회 |
| 하루 고유 검색 | 정규화한 계정/route 기준 성공·실패 포함 검색 시도 수 | 별도 analytics/counter 없음. Riot `used_count`는 API permit 수라 검색 수가 아님 |
| 누적 경기 수 | `lol_matches` 경기 ID 행수; 참가자 행수와 구분 | 운영 row estimate/COUNT가 필요; 이 작업에서는 운영 DB를 읽지 않음 |
| 보관 가능량 | 실제 row bytes, toast/index, cache payload, 보관기간과 조회/쓰기 부하를 포함 | 로컬 합성 byte/game만 측정. 운영 DB quota·CPU·memory·compute 확인 불가 |

이 숫자들은 서로 대체되지 않는다. 40 API requests/day로 보장할 수 있는 것은 최대 4회의 5경기 검색 cache miss 같은 Riot 호출 예산 계산뿐이다. 사용자 동시명수·웹 요청 TPS·일일 사용자 수·DB 저장 총량을 도출할 수 없다. CPU/compute plan과 운영 DB 관측 없이는 “동시 몇 명 보장”을 제시하지 않는다.

### 운영 적용 후 writer 최소 실측

2026-10-22 11:47 UTC, DB writer가 적용·권한·server-side 연결 및 실제 Riot 검색 흐름에서 보고한 제한 집계다. 이 문서 작성자는 운영 DB/Riot에 직접 접속하지 않았고, 계정·PUUID·match ID·JSON·키·rate header 값은 전달받지 않았다.

- 서버 전용 env/flag가 활성 상태인 기존 Next 16.3.8 서버에서 직접 backend search를 실행했다. 처음 검색은 `ready` 5경기를 반환했고 Riot HTTP wrapper 계수는 9회(4개 endpoint × 1회 + Match-V5 상세 5회, 모두 HTTP 200), 16.25초였다. 같은 검색 재조회는 DB search cache hit으로 추가 Riot 호출 0회였다. 403은 없었다. 이는 한 번의 검색 검증이며 처리량/동시 사용자 보장이 아니다.
- LoL 한정 aggregate SQL은 MCP 왕복 1회, 1.60초였다. 행수: accounts 1, ranked entries 2, matches 5, participants 50, search cache 1, match_details cache 0, rate-limit state 3. `request_json` 총 payload bytes 428,133, `lol_api_cache.payload` 총 1,850 bytes였다.
- `pg_total_relation_size` 기준 relation별 total bytes: accounts 81,920; api_cache 49,152; collection_leases 49,152; participants 147,456; matches 368,640; ranked_entries 32,768; rate_limit_state 32,768. 합계 **761,856 bytes**(약 744 KiB)로, LoL 7개 relation의 현재 작은 스냅샷이며 미래 보관량이나 DB 여유 용량 추정치가 아니다.
- `pg_class.reltuples`는 모든 대상 relation에서 -1이라 planner estimated rows는 사용할 수 없었다. API/DB query/RPC 실행 횟수를 독립 계측한 앱 counter도 없어 이 검색의 DB RPC 총량은 미확인이다. 집계 query 1.60초는 DB RPC 내부 latency가 아니라 writer가 보고한 MCP round-trip 시간이다.
- 권한 확인: 7/7 relation RLS enabled; `service_role`은 각 테이블 SELECT/INSERT/UPDATE/DELETE(총 28 grants), `anon`/`authenticated` table grant 0; 12/12 LoL RPC는 `service_role` execute만, `anon`/`authenticated`/PUBLIC execute 0. 이 요약은 권한 점검 결과이며 검색 처리량 근거는 아니다.

같은 시점의 사전 환경 요약은 조직 Pro, PostgreSQL 17.6.1, 전체 DB 2,246,904,979 bytes(약 2.09 GiB), `max_connections=60`, backend 20, 다른 active 1, lock waiter 0이었다. 전체 DB 수치는 LoL 저장량이 아닌 DB 전체 크기다. CPU·memory·compute 사용량, 인덱스별 scan, cache 만료/유효 비율 및 expiration 범위, DB의 실제 query counter는 전달되지 않았다. 운영 검색에서 Riot 9 HTTP calls와 동일 검색 0 추가 호출은 관측됐지만 DAU·검색률·다중 사용자 경합 데이터는 없으므로 동시 사용자 수를 보장할 수 없다.

## PostgreSQL 17 합성 측정

환경/재현은 [측정 report](../../tmp/lol-capacity/report.md)와 [합성 fixture](../../tmp/lol-capacity/benchmark.sql)를 따른다. migration 전체를 새 임시 PostgreSQL 17.10 cluster에 적용하고 10개 합성 계정, 100개 경기 × 10 참가자, 합성 search/detail JSON을 넣었다. 별도 Supabase 전체 스택·운영 DB·실 Riot 요청은 사용하지 않았다.

관측값:

- migration 직후 기준 total relation bytes 196,608; 경기 1개와 참가자 10명 저장 후 344,064 bytes; 100개 경기/1,000 참가자 후 1,122,304 bytes다. 100-match 단계에서 데이터·인덱스 포함 증분은 925,696 bytes, 약 9,257 bytes/match다. 기준값은 relation 초기 페이지와 계정 10개를 포함하므로 선형 환산치/운영 저장비로 쓰지 않는다.
- 100경기 상태에서 search DTO 10개를 추가하면 total relation size가 16,384 bytes 늘었다. `payload::text` 합은 약 6,203 bytes였고, 나머지는 PostgreSQL page/TOAST/index 할당 영향이다. raw Match-V5 JSON은 100행 합계 613,900 bytes, 평균 6,139 bytes/경기였다. 합성 match detail cache 100개는 약 13,700 payload bytes였으나 최소 DTO 형태라 실제 상세 DTO를 대표하지 않는다.
- `persist_lol_match_details` lease 획득과 함께 1경기/10명 저장 호출은 별도 실행에서 4.5 ms와 8.0 ms; 이어서 99경기 저장 묶음은 82.4 ms와 132.5 ms(평균 약 0.83–1.34 ms/경기)였다. 작은 실행 두 번으로 시간 변동의 신뢰 구간을 추정하지 않았다. 개별 서버 RTT/Riot 호출/UI는 포함하지 않는다.
- cache getter 한 회의 `EXPLAIN ANALYZE`는 반복 실행에서 검색 0.049–0.078 ms, 상세 0.027–0.051 ms였다. loopback PG의 warm tiny dataset 수치다.
- 최종 migration 재실행 후 `pgbench` 3초 cache-read만 수행한 단일 PostgreSQL에서 동시 client 1/2/5의 평균 latency는 각각 0.041/0.043/0.059 ms, throughput은 24,310/46,477/84,921 tx/s였다. 타당성 확인용 단일 노트북 수치이며 네트워크, Vercel, Supabase compute, 경쟁 workload를 반영하지 않는다. 서비스 처리량으로 곱하지 않는다.

최종 재실행은 검색 SQL 해시 `1f1bf392424c5cd0ceaff09c64c3fcdff201477e8a193d5dc86b9ac87fa47146`, persistence wrapper 해시 `cc3100fbff96f8e35d387e7c8b6347134b1f3e930a74a9522b24473a0efb2705`, migration SQL 해시 `d43e4137287025a76ae9cb47629c8aef7e26837897220b0c208a7001f2c4d36c` 상태에서 수행했다. 로컬 migration 경로는 운영 원격 이력과 맞춰 `supabase/migrations/20261022114157_lol_persistence_foundation.sql`로 정합화했으며, SQL 내용 해시는 바뀌지 않았다. writer의 TTL·저장 오류 처리 변경을 다시 읽고 해당 migration으로 수행한 격리 측정의 과거 기록은 재실행하지 않았다. 상세 결과와 재현 명령은 `tmp/lol-capacity/report.md`에 있다. 계량 단위는 bytes, ms, tx/s다. fixture는 synthetic이며 결과의 분산/반복 신뢰 구간이나 운영 대표성을 측정하지 않았다.

## 수요 민감도 예시

아래 표는 **예측이 아니라 고정 가정으로 계산한 민감도**다.

- DAU 중 매일 새 검색 cache miss를 만드는 사람 10% (하루 1회), 검색 1회당 경기 5개, cohort 안에서 경기 ID 중복 50%, 같은 사용자가 반복되어 새 계정 저장은 없다고 가정.
- search DTO TTL 2분보다 일간 간격이 길어 재검색 간 DTO hit은 0이다. cohort 첫 검색은 5개 raw miss, 나머지 검색의 절반 match ID는 7일 raw JSON hit으로 재사용한다고 둔다. 따라서 총 Riot 요청은 고정 4S base requests + S×5×(1−0.5) new match detail requests = 6.5S다. 경기 상세 화면 요청/재시도와 지난 cohort의 추가 cache hit은 제외한다.
- BGMS 보관 제안 기간은 7일로 두되, Riot이 요구/허가한 보관기간이라는 뜻이 아니다. 로컬 fixture의 9.3KB/경기는 압축성이 큰 합성값이라 운영 예측치로 쓰지 않는다. 용량 민감도는 경기 raw JSON, 정규화 참가자, DTO cache, 인덱스 여유분을 합친 **가정 50/150/300 KiB per unique match**를 각각 적용한다.

| 가정 DAU | 신규 검색 miss/일 | Riot 요청/일 | 40-call 내부 예산 대비 | 신규 고유 경기/일 | 7일 경기 / 참가자 행 | 7일 LoL 저장 bytes: 50 / 150 / 300 KiB per 경기 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 10 | 65 | 1.63배 | 25 | 175 / 1,750 | 약 8.5 / 25.6 / 51.3 MiB |
| 1,000 | 100 | 650 | 16.25배 | 250 | 1,750 / 17,500 | 약 85.4 / 256.3 / 512.7 MiB |
| 10,000 | 1,000 | 6,500 | 162.5배 | 2,500 | 17,500 / 175,000 | 약 0.83 / 2.50 / 5.01 GiB |

DB bytes 표는 **운영 비용 예측이 아닌 가정 민감도**다. 일 10% DAU 검색, 5경기/검색, 경기 ID 50% 중복, 7일 유지, 1,000 participant rows per 100 matches(경기마다 10명)를 고정했다. 새 Riot 요청은 cohort 첫 5경기 상세와 이후 중복되지 않은 신규 경기 상세만 발생한다고 계산했다. 계정/검색 cache의 별도 bytes, 실제 JSON 분포, vacuum 여유공간, backup/WAL, 다중 패치/갱신은 제외했다. 일일 Riot requests도 retry, 상세화면, 외부 사용량/별도 endpoint를 포함하지 않는다.

## 1인 비공개 개발의 운영 제안

1. `count=5`와 DB guard 40회/UTC일을 그대로 유지한다. 초기에는 하루 신규 검색 miss를 3회 정도(27 Riot call)로 운영하고 나머지 최대 13회는 실패 재시도·상세 화면을 위한 여유로 둔다. 이 제안은 사용자 수 보장이 아니다.
2. 최대 5개 ID 검색에 필요한 cache miss 호출 수를 기준으로 UI/테스트에서 계산한다. 20/100개 확장, 전체 과거 pagination, timeline은 수요와 API 승인 및 저장량을 별도 검토한 뒤 결정한다. Riot 공식 100 ID/page는 API 입력 상한이지 내부 검색/요청/보관 허용치가 아니다.
3. 기존 index를 사용한다: `lol_accounts(lower(game_name),lower(tag_line))`, `lol_accounts(last_accessed_at)`, match PK, 참가자 PK와 `(puuid,played_at desc,match_id desc)` partial index, cache/match expiry index. 현재 query shape와 운영 `idx_scan` 검토 없이 index를 추가하지 않는다.
4. 2분 search DTO / 7일 match cache TTL은 구현값이다. 7일은 BGMS의 현 보수 제안이고 Riot retention approval이 아니다. 90일 계정 정리도 cleanup 함수가 실제 실행돼야 한다. DB writer가 하루 사용량, 만료 cache 비율, DB 크기/compute와 Riot 승인 조건을 확인하기 전 cleanup 자동화나 광범위한 데이터 backfill은 피한다.
5. 현재 cleanup RPC는 만료된 전체 cache/matches와 90일 비접근 계정을 한 번에 삭제하고 batch size limit가 없다. 운영 정리 전에 예상 삭제건수와 cascade 영향량을 확인한다. 대량 누적이 확인되면 writer가 transaction 단위 상한(예: 실행당 500 match ID와 참가자 cascade)을 두고 여러 회로 나누는 방식과 주기를 별도 승인·DDL 검토한다. 이 문서의 제안은 현재 구현 사항이 아니다.
6. 다음 확장 판정에 필요한 관측을 추가/수집한다: 기간별 cache hit/miss, 신규 검색 ID 수, endpoint별 Riot 요청/429/error 및 header window, 검색당 match 상세 성공 수, cache payload bytes, table+index bytes와 증가량, cleanup 처리시간/대상 행수, DB CPU·memory·connection·query latency. 운영 지표는 서비스/DB owner가 제공한 read-only snapshot으로 확인한다. 확장 한도는 Riot method/app limit와 실제 compute 예산을 둘 다 넘지 않는 범위에서만 설정한다.

## 미확인·제한

- 현재 writer 샘플의 LoL row/bytes와 단일 검색 호출 수는 확인했지만, 표본은 계정 1개와 경기 5개뿐이다. DB plan/compute 사용량·CPU·memory, 검색 외 query latency, `pg_stat_statements`, 인덱스 사용량, cache 만료/유효 비율, 동시 사용자·분당 검색·DAU·장기 cache hit ratio는 미확인이다. 운영 실측은 용량·동접 보증이나 선형 확장 근거가 아니다.
- 실제 Riot 키 권한/승인/할당량과 match-ID 과거 조회 가능성, 경기별 historical rank는 확인하지 않았다. 외부 Riot API 호출, 키 출력은 없었다.
- cleanup schedule이 실제 외부에 설정되어 있는지는 DB migration 외부 시스템 확인이 필요하다. 현재 확인된 것은 migration 함수 자체가 자동 실행 설정을 포함하지 않는다는 점이다.
- 합성 PG 측정은 작은 10인 경기 schema sampling으로 운영 TPS·동시성 보장을 나타내지 않는다.
