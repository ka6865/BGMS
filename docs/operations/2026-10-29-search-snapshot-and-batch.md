# LoL 저장 전적 우선 표시·PUBG 최근 경기 일괄 수집 (2026-10-29)

[Riot 호출 제한 이동 구간 전환](2026-10-29-lol-riot-window-guard.md)(#384) 위에 쌓은 변경이다.

## LoL: 마지막 검색 결과를 먼저 보여 주기

### 배경

- 검색 결과 캐시(`lol_api_cache`, kind `search`)는 2분만 유지된다. 2분이 지나면 저장된 계정도 Riot을 처음부터 다시 조회했다.
- 경기 원문은 7일 보관되므로 재조회 때 경기 상세는 재사용됐지만, 계정·소환사·랭크·경기 ID·숙련도·도전과제 호출은 매번 나갔다.

### 변경

migration `20261029020000_lol_search_snapshot.sql`:

- `lol_api_cache.kind`에 `search_snapshot`을 추가했다. 만료 상한은 기존 규칙(검색 2분, 그 외 7일)을 그대로 따르므로 보관본은 7일이다. payload 상한은 검색 캐시와 같은 1MB다.
- `put_lol_search_snapshot(p_cache_key, p_platform, p_route, p_version, p_puuid, p_payload)`: `search-snapshot:` 키만 받고, `lol_accounts`에 있는 계정만 저장한다. 같은 키의 다른 종류 행은 덮어쓰지 않는다. service_role 전용, security invoker.
- 정리(`cleanup_lol_expired_batch`)와 계정 삭제(`delete_lol_account_data`의 `lol_api_cache` 전체 삭제)는 보관본에도 그대로 적용된다.

migration `20261029030000_lol_guard_snapshot_fixes.sql`(리뷰 반영, 아래 "리뷰 반영" 절):

- `lol_api_cache.owner_puuid`(서버 전용): 보관본을 저장한 계정.
- `put_lol_search_snapshot`: 계정 행을 `for key share`로 잠근 뒤 확인한다. 진행 중인 계정 삭제가 있으면 그 커밋을 기다리고, 삭제됐으면 저장하지 않는다.
- `get_lol_search_snapshot(p_key, p_platform, p_route, p_version, p_game_name, p_tag_line)`: 저장 계정이 지금도 그 Riot ID의 **유일한** 저장 계정일 때만 돌려준다. 이름 변경이 이미 저장됐거나 같은 이름의 계정이 둘 이상이면, 또는 `owner_puuid`가 없는 이전 행이면 돌려주지 않는다. Riot을 다시 부르지 않는 DB 검사다.
- `delete_lol_search_cache_for_name(p_platform, p_route, p_name_suffix)`: 한 Riot ID의 2분 캐시와 보관본을 모든 Data Dragon 버전에서 지운다.

코드:

- 키: `lolSearchSnapshotKey()` = 검색 키의 `search:` 접두사를 `search-snapshot:`으로 바꾼 값. 검색 DTO 버전(`v11`)과 Data Dragon 버전이 키에 들어간다.
- 저장: DB 모드 전체 검색이 끝나고 `matchStatus`가 `ready` 또는 `empty`일 때만 랭크 이력까지 채운 결과를 보관한다. `partial`·`failed`는 마지막 정상 보관본을 바꾸지 않는다. 저장 실패는 검색 응답을 막지 않고 `[lol-search] snapshot_save_failed`만 남긴다.
- 조회 순서(DB 모드, 갱신 아님): 2분 캐시 → 보관본 → Riot 전체 검색. 보관본 조회 DB 오류는 기존 캐시 조회처럼 503으로 닫는다. 갱신(`refresh: true`)은 보관본을 읽지 않는다.
- 보관본이 10분(`LOL_AUTO_REFRESH_AFTER_MS`)보다 오래됐고 갱신 쿨다운이 끝났으면 응답에 `autoRefresh: true`를 붙인다.
- 무효화: 전체 검색의 Account-V1이 404면 그 Riot ID의 캐시·보관본을 지운다(경기 404 등은 지우지 않는다). Account-V1 결과의 PUUID가 저장 계정과 같고 저장 이름이 다르면(이름 변경 확인) 저장 전에 옛 이름의 캐시·보관본을 지운다.
- 화면(`LolSearchPanel`):
  - `autoRefresh`를 받으면 결과를 먼저 그린 뒤 한 번만 기존 "전적 갱신"과 같은 요청을 보낸다. 이어 불러오기(복원)는 그 갱신이 끝난 뒤 진행한다.
  - 갱신 결과의 경기 ID가 현재 목록과 하나도 겹치지 않으면(그사이 20판 넘게 진행) 합치지 않고 갱신 결과로 바꾼다. 합치면 중간 경기가 빠지고 다음 페이지 위치가 틀어진다.
  - 갱신이 404(계정 없음)면 저장 전적을 내리고 오류를 보여 준다.
- 메모리 모드(`LOL_PERSISTENCE_ENABLED`가 꺼진 경우)는 바뀌지 않는다.

### 호환성과 롤백

- 적용 순서: `20261029010000` → `20261029020000` → `20261029030000` → 코드 배포. 새 코드는 `reserve_lol_riot_request(text,text,integer)`, `cancel_lol_riot_request`, `get_lol_search_snapshot`, `delete_lol_search_cache_for_name`을 부르므로 migration이 먼저다.
- `20261029030000` 이전에 저장된 보관본은 `owner_puuid`가 없어 읽히지 않는다(다음 검색에서 다시 저장).
- 롤백: 코드를 되돌린 뒤 `delete from public.lol_api_cache where kind='search_snapshot'`, 새 함수 drop, `owner_puuid` 열 drop, 두 검사 제약을 `20261022114157`(kind)과 `20261026020000`(payload) 정의로 다시 만든다. 예약 함수 롤백은 [호출 제한 문서](2026-10-29-lol-riot-window-guard.md)를 따른다.

## PUBG: 최근 경기 한 번에 수집

- `/api/pubg/matches-summary`가 요청 한 번에 새로 받는 경기 수를 5개에서 `RECENT_MATCH_LIMIT`(20)로 늘렸다. 화면은 최근 20개를 보내므로 처음 검색한 플레이어도 요청 1번으로 끝난다.
- `/matches`는 PUBG 호출 한도에 포함되지 않는다. 429·401·403 또는 전부 실패 시 `collectionStopped`로 멈추는 규칙은 그대로다. 입력이 최대 20개라 `nextMatchIds`는 지금 항상 빈 배열이고, 실패한 경기는 `missingMatchIds`로 남아 사용자의 다시 시도 대상이 된다.
- [2026-09-13 감사 기록](2026-09-13-ranking-refresh-audit.md)의 "최대 5건"은 당시 상태다.
- (2026-10-30) 같은 요청의 20개 경기 수집은 비공개 목록을 한 번만 읽어 넘긴다(`BasicMatchIngestOptions.privatePlayers`). 읽기에 실패하면 경기마다 다시 읽어 기존처럼 실패로 닫는다. DB 저장 동시 실행 수는 측정 전이라 20 그대로다.

## PUBG: 시즌 목록 공유와 갱신 재시도 안내 (2026-10-30)

- `/api/pubg/player`는 `/seasons` 결과를 플랫폼별 1시간 공유 캐시(`pubg_response_cache`, 키 `seasons:v1:{platform}`, `readPubgSeasonsCache`/`writePubgSeasonsCache`)로 재사용한다. 갱신·처음 검색마다 나가던 분당 10회 한도 호출이 1시간에 1번으로 준다. 캐시 장애는 PUBG 조회로 대신한다. 플레이어 응답 캐시(`player:*`)는 계속 쓰지 않는다.
- 강제 갱신(또는 자동 갱신)이 60초 잠금을 잡은 뒤 상류 오류로 실패하면 `Retry-After`와 본문 `retryAfterSeconds`를 60초 이상으로 돌려준다. 화면은 이 값으로 갱신 버튼을 막아, 안내(30초)대로 다시 눌렀다가 "1분에 한 번" 429를 받던 문제를 없앤다. 잠금은 그대로 유지한다(실패한 호출도 한도를 썼을 수 있어서).
- 웹의 오래된 프로필 자동 갱신은 켜지 않았다(공유 호출 예산과 같은 계정 동시 조회 합류가 먼저 필요).

## 리뷰 반영 (2026-10-30)

코드 리뷰와 GPT 6.1 Sol 토론에서 합의한 머지 전 필수 6건이다.

| 항목 | 변경 |
| --- | --- |
| 거절한 예약이 한도를 차지 | `lol_riot_request_log.lease_token`으로 허가와 묶었다. `reserve_lol_riot_request`에 `p_max_wait_ms`(코드는 4000)를 넘겨 그보다 먼 허가는 기록 없이 `window`로 거절한다. 시작 거절(`start_lol_riot_request`)과 보내기 전 취소(`cancel_lol_riot_request`)는 기록도 지운다. 보낸 요청의 기록은 그대로 한도 계산에 남는다. |
| `finish` 실패 | 허가 token을 `finish` 성공 뒤에만 비운다. 실패하면 Riot 429의 공유 차단을 먼저 걸고, 허가는 `finally`에서 해제한다. 키가 없으면 예약 전에 닫는다. |
| 오래된 보관본 갱신 병합 | 화면이 겹치지 않는 목록을 교체한다(위 화면 절). |
| 실패 결과가 보관본 덮어쓰기 | `ready`·`empty`만 보관한다. |
| 삭제와 저장 경합 | 계정 행 `for key share` 잠금. 두 세션 검증을 `verify:migrations`에 넣었다. |
| 이름 변경·계정 404 | 보관본 주인 확인과 무효화(위 코드 절). 미관찰 이름 변경은 잡지 못하며, 10분 자동 갱신과 "N분 전 저장" 표시로 완화한다. |

프로덕션 키 대비: 프로세스 안 동시 Riot 요청 수는 `LOL_RIOT_PARALLEL_REQUESTS`(기본 6, 1~32), 호스트별 동시 상한은 `lol_rate_limit_state.max_concurrency`(기본 8)로 조정한다. 호출 한도는 응답 헤더(`X-App-Rate-Limit`)를 읽어 맞추므로 키만 바꾸면 따라간다.

## 검증

- `tests/lol-riot-search.test.ts`: 보관본 저장 키·랭크 이력 포함, 저장 실패 무시, `ready`/`empty`만 보관, 10분 기준 `autoRefresh`, 2분 캐시 우선, 보관본 조회 DB 오류 503, 갱신은 보관본 미조회, 대기 초과 예약 취소, 키 없음 시 예약 안 함, `finish` 실패 시 429 차단·허가 해제, 계정 404만 무효화, 이름 변경 시 옛 이름 무효화.
- `npm run verify:migrations`: `lol-search-snapshot-scenarios.sql`, `lol-guard-snapshot-fixes-scenarios.sql`(대기 초과 거절 시 기록 없음, 취소·시작 거절 시 기록 삭제, 보낸 요청 기록 유지, 보관본 주인·중복 이름·이름 변경·이름 재사용·이전 행, 이름별 캐시 삭제 범위, 권한), 계정 삭제 중 보관본 저장 두 세션 경합.
- `tests/lol-public-browser.test.ts`(`RUN_LOL_PUBLIC_BROWSER=true`): 375x667·390x844·430x932·1440x900에서 저장 전적 표시 뒤 자동 갱신 1회, 겹치지 않는 갱신 목록 교체(수정 전 코드에서는 실패 확인), 가로 넘침 없음.
- `tests/matches-summary-route.test.ts`: 20개 한 번 수집, 요청 단위 오류 시 중단.
- 로컬 실측(2026-10-29, 개발 키, 일회용 PG17+PostgREST, DB 요청마다 45ms 지연 추가, `Hide on bush#KR1`): 처음 검색 3.6초(Riot 28회), 2분 안 재검색 0.33초, 11분 뒤 검색 0.36초(Riot 0회, `autoRefresh`), 이어진 자동 갱신 1.4초(Riot 6회, 저장 경기 재사용). 운영 Supabase 실측은 하지 않았다.
- PUBG `/matches` 읽기 비교(서로 다른 플레이어 각 20경기, 1회): 5개씩 4번 1.6초, 한 번에 0.53초. 서버 왕복 4번 대신 1번이 되는 효과는 포함하지 않은 값이다.
- `scripts/verify_lol_persistence_local.sh`는 `20261023060000`까지만 적용하는 별도 스크립트라 #384 이후 계약을 검증하지 않는다(package.json 미연결). 위 `verify:migrations`가 대신한다.
