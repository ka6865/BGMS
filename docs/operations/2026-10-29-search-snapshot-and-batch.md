# LoL 저장 전적 우선 표시·PUBG 최근 경기 일괄 수집 (2026-10-29)

[Riot 호출 제한 이동 구간 전환](2026-10-29-lol-riot-window-guard.md)(#384) 위에 쌓은 변경이다.

## LoL: 마지막 검색 결과를 먼저 보여 주기

### 배경

- 검색 결과 캐시(`lol_api_cache`, kind `search`)는 2분만 유지된다. 2분이 지나면 저장된 계정도 Riot을 처음부터 다시 조회했다.
- 경기 원문은 7일 보관되므로 재조회 때 경기 상세는 재사용됐지만, 계정·소환사·랭크·경기 ID·숙련도·도전과제 호출은 매번 나갔다.

### 변경

migration `20261029020000_lol_search_snapshot.sql`:

- `lol_api_cache.kind`에 `search_snapshot`을 추가했다. 만료 상한은 기존 규칙(검색 2분, 그 외 7일)을 그대로 따르므로 보관본은 7일이다. payload 상한은 검색 캐시와 같은 1MB다.
- `put_lol_search_snapshot(p_cache_key, p_platform, p_route, p_version, p_puuid, p_payload)`: `search-snapshot:` 키만 받고, `lol_accounts`에 있는 계정만 저장한다(계정 삭제 뒤 늦은 저장 차단). 같은 키의 다른 종류 행은 덮어쓰지 않는다. service_role 전용, security invoker.
- 조회는 기존 `get_lol_api_cache`를 kind `search_snapshot`으로 부른다. 2분 캐시 조회(`search`)는 보관본을 돌려주지 않는다.
- 정리(`cleanup_lol_expired_batch`)와 계정 삭제(`delete_lol_account_data`의 `lol_api_cache` 전체 삭제)는 보관본에도 그대로 적용된다.

코드:

- 키: `lolSearchSnapshotKey()` = 검색 키의 `search:` 접두사를 `search-snapshot:`으로 바꾼 값. 검색 DTO 버전(`v11`)과 Data Dragon 버전이 키에 들어간다.
- 저장: DB 모드 전체 검색이 끝나면 랭크 이력까지 채운 결과를 보관한다. 실패해도 검색 응답은 그대로 돌려주고 `[lol-search] snapshot_save_failed`만 남긴다.
- 조회 순서(DB 모드, 갱신 아님): 2분 캐시 → 보관본 → Riot 전체 검색. 보관본 조회 DB 오류는 기존 캐시 조회처럼 503으로 닫는다. 갱신(`refresh: true`)은 보관본을 읽지 않는다.
- 보관본이 10분(`LOL_AUTO_REFRESH_AFTER_MS`)보다 오래됐고 갱신 쿨다운이 끝났으면 응답에 `autoRefresh: true`를 붙인다.
- 화면(`LolSearchPanel`)은 `autoRefresh`를 받으면 결과를 먼저 그린 뒤 한 번만 기존 "전적 갱신"과 같은 요청을 보낸다. 이어 불러오기(복원)는 그 갱신이 끝난 뒤 진행한다. 2~10분 된 보관본은 자동 갱신 없이 "최근 갱신 N분 전"과 갱신 버튼으로 둔다.
- 메모리 모드(`LOL_PERSISTENCE_ENABLED`가 꺼진 경우)는 바뀌지 않는다.

### 호환성과 롤백

- migration을 먼저 적용해도 기존 배포 코드는 `search_snapshot`을 쓰지 않으므로 동작이 같다.
- 롤백: 코드를 되돌린 뒤 `delete from public.lol_api_cache where kind='search_snapshot'`, `drop function public.put_lol_search_snapshot(text,text,text,text,text,jsonb)`, 두 검사 제약을 `20261022114157`(kind)과 `20261026020000`(payload) 정의로 다시 만든다.

## PUBG: 최근 경기 한 번에 수집

- `/api/pubg/matches-summary`가 요청 한 번에 새로 받는 경기 수를 5개에서 `RECENT_MATCH_LIMIT`(20)로 늘렸다. 화면은 최근 20개를 보내므로 처음 검색한 플레이어도 요청 1번으로 끝난다.
- `/matches`는 PUBG 호출 한도에 포함되지 않는다. 429·401·403 또는 전부 실패 시 `collectionStopped`로 멈추는 규칙과, 처리하지 못한 ID를 `nextMatchIds`로 돌려주는 계약은 그대로다.
- [2026-09-13 감사 기록](2026-09-13-ranking-refresh-audit.md)의 "최대 5건"은 당시 상태다.

## 검증

- `tests/lol-riot-search.test.ts`: 보관본 저장 키·랭크 이력 포함, 저장 실패 무시, 10분 기준 `autoRefresh`, 2분 캐시 우선, 보관본 조회 DB 오류 503, 갱신은 보관본 미조회.
- `tests/fixtures/migration-check/lol-search-snapshot-scenarios.sql`(`npm run verify:migrations`): 미저장 계정 거부, 7일 만료, 2분 캐시 분리, 1MB 상한, 키 접두사, 다른 종류 행 보호, 계정 삭제 시 제거, 권한.
- `tests/lol-public-browser.test.ts`(`RUN_LOL_PUBLIC_BROWSER=true`): 375x667·390x844·430x932·1440x900에서 저장 전적 표시 뒤 자동 갱신 1회, 가로 넘침 없음.
- `tests/matches-summary-route.test.ts`: 20개 한 번 수집, 요청 단위 오류 시 중단.
- 로컬 실측(2026-10-29, 개발 키, 일회용 PG17+PostgREST, DB 요청마다 45ms 지연 추가, `Hide on bush#KR1`): 처음 검색 3.6초(Riot 28회), 2분 안 재검색 0.33초, 11분 뒤 검색 0.36초(Riot 0회, `autoRefresh`), 이어진 자동 갱신 1.4초(Riot 6회, 저장 경기 재사용). 운영 Supabase 실측은 하지 않았다.
- PUBG `/matches` 읽기 비교(서로 다른 플레이어 각 20경기, 1회): 5개씩 4번 1.6초, 한 번에 0.53초. 서버 왕복 4번 대신 1번이 되는 효과는 포함하지 않은 값이다.
