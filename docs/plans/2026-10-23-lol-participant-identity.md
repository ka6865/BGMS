# LoL 참가자 식별자와 현재 이름 표시

## 목표와 설계

이름이 바뀌어도 같은 참가자로 이동하고 함께 플레이 집계를 유지한다. 경기 원문의 PUUID는 서버 캐시와 영구 요약 teammates에 보관한다. 클라이언트 DTO에서는 모든 puuid 필드를 제거하고 `playerKey`와 `ref`만 제공한다.

- `playerKey`: HMAC-SHA256(secret, puuid)의 앞 32자리 hex. 서버 비밀 값 없이 원문을 유추할 수 없는 결정적 집계 키다.
- `ref`: 버전 1바이트, 12바이트 랜덤 IV, 16바이트 인증 태그, AES-256-GCM 암호문을 이어 base64url로 인코딩한다. AES 키는 secret의 SHA256이며 AAD는 `lol-participant:v1`이다. 매 응답의 토큰은 달라도 playerKey는 같다.
- `lib/lol/participantIdentity.server.ts`가 검색·더보기·상세의 캐시 조회 이후 복제 DTO를 만든다. 원본 캐시·DB 이름은 표시 목적으로 수정하지 않는다.
- `get_lol_account_names_by_puuids(text[])`는 service_role만 실행한다. `security invoker`, 빈 search_path, 최대 100개 요청으로 현재 이름을 일괄 조회한다. 100명을 넘는 응답은 분할한다.
- `/admin/lol/kr/by-ref/[ref]`는 기존 페이지와 같은 관리자 가드를 적용한다. 봉인을 연 뒤 24시간 이내 lol_accounts 이름을 사용한다. 없거나 오래됐으면 asia Account-V1 by-puuid를 기존 요청 가드·메트릭 경로로 1회 호출하고 `lolRiotIdPath`로 307 이동한다. 이름 저장은 도착한 검색 페이지의 기존 snapshot upsert가 수행한다.
- 위조·손상 ref는 HTTP 400, Riot 404는 HTTP 404와 “계정을 찾을 수 없습니다.”를 반환한다. 응답과 이동은 private/no-store다.
- 클라이언트 함께 플레이 집계는 playerKey를 사용한다. 식별자가 없는 이전 캐시는 riotId로 폴백한다. 검색 응답의 요약도 덮어쓴 이름으로 재계산한다.

## 정책 근거와 한계

요구사항에 제시된 Riot LoL 게임별 정책의 historic Riot ID 노출 금지를 근거로 한다. 이름 변경 이력, 과거/현재 이름 병기, 옛 이름을 별도 이력으로 찾는 기능을 만들지 않는다. 기본 모드는 이미 알고 있는 현재 이름만 덮어쓰며, 미검색 계정은 요구된 폴백에 따라 경기 당시 이름을 유지한다. 이 폴백까지 정책상 허용된다고 확정하는 구현은 아니며 공식 해석 확인은 별도로 남는다.

## 환경 변수

| 변수 | 기본값과 동작 |
| --- | --- |
| `LOL_PARTICIPANT_REF_SECRET` | 서버 전용 고엔트로피 secret. 미설정이면 ref/playerKey 발급 없이 이름 링크로 폴백하고 `missing_participant_ref_secret` 사유 코드만 로그에 남긴다. 값과 PUUID는 로그에 남기지 않는다. |
| `LOL_PARTICIPANT_NAME_MODE` | 기본 `known_current`: lol_accounts에서 확인된 현재 이름으로 덮어쓴다. `match_time`: 조회를 생략하고 경기 당시 이름을 유지한다. 두 모드 모두 secret이 있으면 ref와 playerKey를 발급한다. |

secret은 클라이언트 환경 변수로 만들지 않는다. secret 교체 시 기존 ref가 무효가 되고 playerKey도 달라지므로 열린 화면을 다시 검색해야 한다. 테스트는 고정 테스트 secret을 사용한다.

## DB 계약과 백필

신규 `20261023060000_lol_participant_identity.sql`은 기존 JSONB `teammates` 항목에 puuid를 추가하는 추출기로 `upsert_lol_player_match_summaries(text,text)`를 교체한다. `persist_lol_search_snapshot`과 `persist_lol_match_details`는 이미 이 추출기를 호출하므로 새 정의를 즉시 사용하며 함수 시그니처·lease fencing을 유지한다. `delete_lol_account_data(text)`도 교체하여 원문이나 계정 이름이 사라진 뒤에도 PUUID로 동료 참조를 삭제한다.

백필은 원문 JSON이 남아 있는 경기만 공통 추출기로 처리한다. 원문이 없는 기존 요약은 보존하고 puuid 없이 이름 폴백을 유지한다. 참가자 이름을 lol_accounts에 일괄 upsert하지 않는다. 검색 캐시 키는 v9, 상세 DTO 버전은 v4로 올려 식별자가 없는 캐시를 재사용하지 않는다.

## 구현과 검증 순서

1. 서버 전용 식별자·DTO 변환, 기존 Riot 요청 분류·세 응답 경로를 연결한다.
2. 새 migration과 권한·100개 상한·백필·PUUID 삭제 시나리오를 추가한다.
3. 카드·상세·함께 플레이 버튼에서 ref를 전달하고 기존 router 이동을 사용한다. 스타일은 유지한다.
4. `npm run verify:core`, `npm run verify:lol`, `npm run verify:migrations`를 실행한다. 기존 LoL fixture 브라우저 하네스로 모바일 3종과 데스크톱을 확인한다.

## 롤백

이름 덮어쓰기만 끄려면 `LOL_PARTICIPANT_NAME_MODE=match_time`으로 바꾼다. ref 발급과 이동을 끄려면 secret을 제거해 새 응답을 이름 링크로 폴백시킨다. 이미 열린 화면의 ref는 더 이상 복호화할 수 없어 400 안내가 나온다. 전체 코드 롤백 시에도 추가 JSON 필드를 이전 코드가 무시하므로 DB migration을 즉시 되돌릴 필요가 없다. DB 복원이 필요하면 20261023040000 migration의 추출기·삭제 함수 정의로 복원하고 새 조회 RPC를 제거한다. 영구 요약의 puuid 제거는 필요할 때 별도 검토하며 운영 데이터를 자동 삭제하지 않는다.

운영 적용은 담당자가 migration 적용과 환경 변수 2개 설정을 진행한다. 이 작업은 운영 DB 적용·커밋·push·배포·개발 서버 재시작을 하지 않는다.

## 이번 작업 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm run verify:core` | 종료 0, ESLint 오류 0·기존 경고 47, TypeScript 통과 |
| `npm run verify:lol` | 13개 파일·253개 통과, 별도 실행 조건 검사 36개 skip |
| 새 식별자·HTTP route 단위 테스트 | 2개 파일·15개 통과; by-puuid 공유 가드·메트릭·404 검사 3개도 전체 LoL 실행에 포함 |
| `npm run verify:migrations` | 일회용 PostgreSQL에서 선택된 migration 93개와 RPC 시나리오 통과 |
| `bash scripts/verify_lol_persistence_local.sh` | 격리 PG17의 LoL migration 8개, 권한·원자 저장·백필·lease fencing·재시작 후 캐시·8개 동시 요청 중 2개 허가 검증 통과 |
| 기존 LoL fixture 브라우저 | 29개 통과; `375×667`, `390×844`, `430×932`, `1024×900`, `1440×900` 포함 |
| ref 이동 추가 fixture 브라우저 | 카드·상세·함께 플레이 3개 통과 (`1440×900`) |
| `git diff --check` 및 수정 코드 행 길이 | 통과; 수정 대상 코드 300자 초과 없음 |

기본 LoL 실행의 36개 skip은 브라우저 32개와 실제 연결 통합 테스트 4개다. 브라우저는 기존 fixture와 추가 ref 선택 실행으로 총 32개를 별도 확인했다. 실제 Riot 호출, 운영 DB, 실기기/iOS Safari/Android WebView 검증은 하지 않았다. 로컬 보조 지침 `.agents/rules/project_rules.md`는 작업 폴더에 없었다.

Migration SHA256: `b45d620ddd3253a8e66456a3726cb8a65eab2aee2b1b9abff245ebd37bba2d76`.

- 신설: `public.get_lol_account_names_by_puuids(text[])`.
- 교체: `public.upsert_lol_player_match_summaries(text,text)`, `public.delete_lol_account_data(text)`.
- 저장 경로: 기존 `persist_lol_search_snapshot`·`persist_lol_match_details`의 공통 추출기 호출을 유지하여 새 teammates 계약을 적용했다.

담당자 후속 작업은 운영 migration 적용, 서버 `LOL_PARTICIPANT_REF_SECRET` 설정, `LOL_PARTICIPANT_NAME_MODE=known_current` 설정(또는 기본값 사용)이다. secret 교체 시 열린 화면의 ref/playerKey가 바뀌며, 미검색 계정의 당시 이름 폴백에 대한 Riot 정책 해석은 미확정이다.

## 변경 파일

- 서버: `lib/lol/participantIdentity.server.ts`, `lib/lol/riotSearch.server.ts`, `lib/lol/persistence.server.ts`, `lib/lol/types.ts`, `lib/lol/summary.ts`.
- 이동 경로: `app/admin/lol/kr/by-ref/[ref]/route.ts`.
- UI: `components/lol/LolMatchCard.tsx`, `components/lol/LolMatchDetail.tsx`, `components/lol/LolSummary.tsx`, `components/lol/LolSearchPanel.tsx`.
- DB: `supabase/migrations/20261023060000_lol_participant_identity.sql`.
- 검증 스크립트: `scripts/verify_migrations_local.sh`, `scripts/verify_lol_persistence_local.sh`.
- SQL fixture: `tests/fixtures/migration-check/lol-identity-backfill-setup.sql`, `tests/fixtures/migration-check/lol-participant-identity-scenarios.sql`, `tests/fixtures/migration-check/lol-player-summaries-scenarios.sql`.
- 단위·브라우저 검사: `tests/lol-participant-identity.test.ts`, `tests/lol-participant-ref-route.test.ts`, `tests/lol-riot-search.test.ts`, `tests/lol-persistence.test.ts`, `tests/lol-collect.test.ts`, `tests/lol-dev-browser.test.ts`.
- 문서: 이 문서와 `docs/plans/2026-10-23-lol-production-key-readiness.md`.

## 운영 적용 실적 (2026-10-23)

- 09:01 UTC에 `20261023060000_lol_participant_identity.sql`(SHA256 b45d620d…)을 임시 workdir 단독 push로 적용했다. dry-run 대상은 이 파일 하나였다. 적용 후 운영 migration 이력은 179건이다.
- 적용 후 확인 결과
  - `get_lol_account_names_by_puuids(text[])`는 service_role만 실행할 수 있다. anon과 authenticated는 실행 권한이 없다.
  - 요약 204행 모두 teammates에 puuid가 백필됐다. 원문이 7일 이내였다.
- 로컬 Chrome에서 경기 카드의 참가자 이름을 클릭하면 `by-ref` 307을 거쳐 현재 Riot ID 페이지 200으로 이동하는 것을 확인했다. 페이지 HTML에는 `"puuid"`가 없다.
