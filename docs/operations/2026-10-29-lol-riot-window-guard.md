# LoL Riot 호출 제한 이동 구간 전환 (2026-10-29)

## 배경

- 공유 호출 제한(`lol_rate_limit_state`)은 모든 Riot 호출 사이에 최소 1.5초(`min_interval_ms`)를 두었다. 처음 검색은 호출 약 26회라 대기만 39초가 걸렸다.
- `requestJson`은 프로세스 안에서 모든 호출을 한 줄로 세웠고(`state.queue`), 경기 상세 20개도 차례로 받았다.
- 호출마다 DB 왕복이 4번(예약·시작·헤더 기록·해제) 있었다.
- 로컬 실측(개발 키, 운영 DB): 처음 검색 59초, 캐시가 끝난 재검색 17초, 2분 안 재검색 1~2초.

## 변경

migration `20261029010000_lol_riot_window_guard.sql`:

- `lol_riot_request_log(host, priority, started_at)`: 호스트별 예약 기록. 하루가 지난 행은 예약 때 지운다. RLS, service_role 전용.
- `reserve_lol_riot_request(p_host, p_priority default 'interactive')`
  - 최근 헤더의 앱 한도(`app_rate_limit`, 없으면 `20:1,100:120`)마다 구간 안 예약 수를 센다.
  - 사용자 검색은 한도의 90%, 백그라운드(`background`)는 50%까지 바로 허가한다. 넘치면 가장 이른 시각으로 예약한다.
  - 호스트(asia, kr)별로 따로 센다. Riot 앱 한도가 지역마다 따로이기 때문이다.
  - 동시 요청 상한은 `lol_rate_limit_state.max_concurrency`(기본 8)로 호스트별이다.
  - 바로 시작할 수 있으면 `started=true`를 함께 돌려준다.
- `start_lol_riot_request`: 예약 시각이 미래였던 요청만 확인한다. 고정 간격 검사를 뺐다.
- `record_lol_riot_rate_headers`: 80% 사용 시 구간 전체를 막던 규칙과 `min_interval_ms` 증가를 뺐다. 한도를 다 쓴 구간이 보이면 해당 호스트만 그 구간(최대 10초) 동안 멈춘다. 형식 오류 헤더의 10분 차단은 그대로다.
- `finish_lol_riot_request`: 헤더 기록과 허가 해제를 한 번에 처리한다.
- 429의 `block_lol_riot_requests`(전 호스트 차단)는 그대로다.

코드:

- `requestJson`: 공유 DB 제한을 쓸 때 프로세스 안 동시 6개까지 보낸다. 바로 시작 허가를 받으면 시작 확인 RPC를 생략하고, 응답 후 `finish_lol_riot_request` 한 번만 부른다. 호출당 DB 왕복은 4번에서 2번이 된다.
- 경기 상세는 5개씩 동시에 받고 ID 순서로 모은다. 429를 만난 위치 뒤 결과는 버려 다음 페이지 위치가 연속된다.
- 숙련도·도전과제는 경기 상세와 함께 요청한다(실패해도 빈 값으로 대체).
- 챔피언 통계 수집기는 `LOL_RIOT_PRIORITY=background`로 예약한다.

## 호환성

- 기존 배포 코드가 `reserve_lol_riot_request(p_host)`만 보내도 기본값으로 새 함수가 호출된다. 추가 열 `started`는 무시되고, 기존처럼 시작 확인·헤더 기록·해제를 따로 부른다.
- 따라서 migration을 먼저 적용하고 배포해도 된다. 적용 직후부터 기존 코드도 고정 간격 없이 동작한다.

## 롤백

새 코드를 되돌린 뒤 `20261022200000_lol_remove_daily_budget.sql`의 `reserve_lol_riot_request(text)`,
`20261022114157_lol_persistence_foundation.sql`의 `start_lol_riot_request`,
`20261024040000_lol_review_fixes.sql`의 `record_lol_riot_rate_headers` 정의를 다시 만들고
`drop function public.reserve_lol_riot_request(text,text); drop function public.finish_lol_riot_request(uuid,text,text,text,text,text);`
`drop table public.lol_riot_request_log; alter table public.lol_rate_limit_state drop column max_concurrency;`를 실행한다.
`reserve(text,text)`를 지우기 전에 `reserve(text)`를 먼저 만들 수 없으므로 한 트랜잭션에서 drop 후 create 순서로 실행한다.

## 검증

- `npm run verify:migrations`: `lol-persistence-scenarios.sql`(동시 상한·즉시 시작·백그라운드 50%·구간 초과 예약·미래 허가 시작 거부·80% 비차단·소진 시 해당 호스트만 차단·finish 해제), `lol-persistence-verification.sql`(낮은 관측 한도, 429 공유 차단, 함수 권한).
- `tests/lol-riot-search.test.ts`: 경기 상세 동시 수(2~5), ID 순서 유지, 429 뒤 결과 폐기, 시작 확인 생략.
