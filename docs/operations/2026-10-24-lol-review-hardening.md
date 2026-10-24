# LoL 심사 전 안정화 운영 계약

작성일: 2026-10-24. 이 문서는 코드와 격리된 로컬 검증을 설명하며 운영 적용 기록이 아니다.

## 적용 범위

- 기존 전적 저장·계정 보존·원문 7일 정책은 유지한다.
- 기존 preview·배치 정리 RPC에 공개 요청 제한의 만료 행을 추가한다.
- 키 없음·Riot 401/403은 503과 `reasonCode: riot_key_renewal`, 한국어 안내, 영문 보조 문구로 전달한다.
- 공개 첫 화면은 키 미설정 안내를 표시한다. 갱신 실패 시 화면의 기존 전적을 유지하고 캐시 적중은 기존처럼 우선 반환한다.
- 관리자 운영 패널의 `키 확인 필요`는 유지한다.

## 자동 정리

```sh
npx tsx scripts/lol_cleanup_expired.ts --dry-run
LOL_CLEANUP_ENABLED=true npx tsx scripts/lol_cleanup_expired.ts --apply
```

`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 서버 운영 환경에서 제공한다.
인자를 생략하면 preview만 읽는다. `--apply`와 정확한 `LOL_CLEANUP_ENABLED=true`가 함께 있어야 삭제한다.

- 순서: preview → 기존 `acquire_lol_collection_lease` → 정리 배치 반복 → lease 해제 → JSON 요약.
- lease 키 `ops:expired-cleanup`, 유효 기간 120초. 반복은 80초 경과 또는 50회에서 중단한다.
- RPC별 타임아웃 5초, 배치 사이 250ms 대기, 배치당 각 부모 테이블 최대 100행.
- 배치 자체도 transaction advisory lock `20261024020000`을 얻어 관리자 정리와 겹친 실행을 거절한다.
- 경기 참가자의 cascade 삭제는 부모 경기 수와 별도이며 전체 자식 행 수 상한을 뜻하지 않는다.
- 삭제 진전이 없으면 중단한다. dry-run 또는 `remainingCount > 0`이면 Actions 경고를 출력한다. 적용 후 만료 경기 원문(`remaining.match_rows > 0`)이 남으면 종료 코드 1로 실패한다.
- 출력은 `preview`, `deleted`, `remaining`, `deletedCount`, `remainingCount`, `batches`, `durationMs`이다.

워크플로 `.github/workflows/lol-cleanup.yml`은 매일 UTC 19:11 / KST 04:11과 수동 실행을 제공한다.
저장소 변수 `LOL_CLEANUP_ENABLED`가 정확히 `true`일 때만 `--apply`를 전달한다. 기본값은 dry-run이다.
기존 PUBG 일일 작업의 UTC 18:00, 보존 작업의 매시 08·23·38·53분과 예약 시작 분을 분리했다.
기존 작업의 실제 실행 시간이 길면 동시 실행 가능성은 남으므로 운영 관제를 함께 본다.
워크플로 concurrency와 DB lease가 중복된 자동 정리를 막는다.

운영 패널의 최근 7일 메트릭:

| 메트릭 | 의미 |
| --- | --- |
| `cleanup_deleted` | KST 일자별 누적 삭제 부모 행 수 |
| `cleanup_remaining` | 마지막 완료 배치 후 남은 대상 행 수 |
| `cleanup_duration_ms` | 마지막 완료 배치의 DB 소요 시간(ms), 전체 스크립트 시간은 JSON 출력 |

미리보기는 메트릭을 기록하지 않는다. 계정·랭크·본인 경기 요약과 마지막 성공 Data Dragon 버전은 자동 삭제하지 않는다.

## Data Dragon 버전

- 서버 `dataDragon.server.ts`가 공식 `versions.json`의 첫 버전을 검증한다.
- 메모리와 DB의 갱신 TTL은 6시간이며 외부 요청은 3초·64KiB로 제한한다. 길이 헤더가 없어도 스트림 읽기를 중단한다.
- 한 프로세스의 중복 갱신은 Promise를 공유한다. DB 읽기·쓰기 타임아웃은 각각 1초다.
- DB `lol_data_dragon_versions`는 singleton 한 행에 마지막 성공 버전과 성공 시각을 남긴다.
- 기존 `lol_api_cache`는 2분/7일 만료 및 정리 대상이므로 장기 장애 시 마지막 성공값 보존 계약에 맞지 않아 별도 한 행을 사용한다.
- 장애 시 마지막 성공값, 없으면 서버 코드 기본값 `16.21.1`을 쓴다. 실패 재시도 간격은 1분이다.
- DB 캐시는 기존 `LOL_PERSISTENCE_ENABLED=true`에서 사용한다. DB 실패는 정상적인 Data Dragon 응답 사용을 막지 않는다.
- 검색·상세·경기 카드 DTO에 `dataDragonVersion`을 전달하며 클라이언트에 버전 상수를 두지 않는다.
- 기존 DTO 호환을 위해 필드는 선택형이다. 구형 검색·상세 캐시 적중 시 서버가 버전을 보완한다.
- 상세 캐시 키는 `match:v1:kr:asia:<버전>:v4:<경기ID>`이며 버전 변경 시 저장 원문으로 새 상세 DTO를 생성한다.
- 증강 `patchMap.ts`는 게임 패치↔표시 연도 변환용이며 최신 정적 자산 버전 선택과 계약이 달라 직접 결합하지 않는다.

## 공개 요청 제한과 IP 신뢰 경계

검색·갱신은 IP당 분당 10회, 더보기·상세·ref 이동은 분당 30회 공유 버킷을 유지한다.
`consume_lol_public_rate_limit`은 하나의 upsert에서 증가·윈도우 초기화·허용 여부를 결정한다.
거부 시 `allowed=false`, 남은 초인 `retry_after`를 반환하며 HTTP는 429와 `Retry-After`를 전달한다.

- IP 원문은 저장·로그하지 않는다. 버킷 키는 `search:<64자리 HMAC>` 또는 `read:<64자리 HMAC>`이다.
- HMAC 키는 `LOL_PARTICIPANT_REF_SECRET`에서 HKDF SHA-256으로 파생한다. salt는 `bgms-lol`, info는 `public-rate-limit:v1`이다.
- 모든 인스턴스는 같은 기존 비밀을 사용해야 한다. 비밀 교체는 버킷도 교체하며 이전 해시는 만료 정리된다.
- DB 오류·1초 타임아웃·잘못된 응답·비밀 누락은 기존 메모리 제한으로 대체한다. 성공 요청도 메모리 카운터에 반영한다.
- 로그는 `db_error`, `db_timeout`, `missing_participant_ref_secret` 사유 코드만 남긴다.
- 대체 메모리는 최대 10,000버킷이며 포화 시 429를 반환한다. 장애 중에는 인스턴스 간 합산 제한을 보장하지 않는다.
- DB 또는 비밀의 장기 장애는 `LOL_PUBLIC_ENABLED=false`로 공개 경로를 닫고 복구한다.

기존 `extractClientIp`는 `x-forwarded-for`의 첫 값, `x-real-ip`, `0.0.0.0` 순서다. 공용 유틸은 수정하지 않았다.
Vercel 공식 문서는 일반 경로에서 위조 방지를 위해 `x-forwarded-for`를 덮어쓴다고 설명한다.
별도 프록시나 Enterprise Trusted Proxy로 헤더 전달 설정을 바꾼 배포는 다시 검증해야 한다.
로컬 서버에 직접 보낸 헤더는 신뢰 가능한 프록시의 증거가 아니다.
[Vercel 요청 헤더 문서](https://vercel.com/docs/headers/request-headers#x-forwarded-for).

## DB 변경

파일: `supabase/migrations/20261024020000_lol_review_hardening.sql`.

| 구분 | 객체 |
| --- | --- |
| 신설 테이블 | `lol_public_rate_limits`, `lol_data_dragon_versions` |
| 신설 RPC | `consume_lol_public_rate_limit(text,integer,integer)` |
| 교체 RPC | `preview_lol_expired_data()`, `cleanup_lol_expired_batch(integer)` |
| 정리 인덱스 | `lol_public_rate_limits_expiry_idx` |
| 증강 FK 인덱스 | `lol_augments_first_seen_patch_idx`, `lol_augments_last_seen_patch_idx` |
| 증강 FK 인덱스 | `lol_augment_aliases_source_idx`, `lol_augment_ingestion_runs_source_idx` |
| 증강 FK 인덱스 | `lol_augment_patch_changes_platform_idx`, `lol_augment_patch_changes_source_idx` |
| 증강 FK 인덱스 | `lol_augment_publication_patch_idx`, `lol_augment_publication_run_idx` |

신설 테이블은 RLS 활성, 공개 정책 없음, `service_role`에만 DML을 부여한다.
신설 RPC는 `security invoker`, `search_path = ''`, `service_role` 전용이며 교체 RPC의 기존 권한을 보존한다.
두 신설 테이블에는 FK가 없다. PG17 `pg_constraint`·`pg_index` 검사에서 migration 전 증강 FK 인덱스 누락 8개,
적용 후 누락 0개를 확인한다. 기존 migration은 수정하지 않는다.

## 메인의 운영 적용 순서

1. diff·검증 결과와 migration SHA256을 재확인하고 단일 PR로 커밋·push한다.
2. 저장소 `LOL_CLEANUP_ENABLED`를 꺼둔 상태에서 새 migration 하나를 운영에 적용한다.
3. 앱을 배포하고 기존 `LOL_PARTICIPANT_REF_SECRET`의 인스턴스 간 동일 설정을 확인한다. 비밀을 출력하지 않는다.
4. 공개 검색·캐시 적중·더보기·상세·키 갱신 안내와 관리자 `키 확인 필요`를 배포 환경에서 확인한다.
5. 수동 워크플로 dry-run의 대상 수·보존 범위·소요 시간을 검토한다.
6. 승인된 운영 정리 범위에서 저장소 변수 `LOL_CLEANUP_ENABLED=true`를 설정하고 수동 1회 적용 후 메트릭과 남은 대상을 확인한다.
7. 다음 KST 04:11 일일 실행을 확인한다. 중지 시 변수부터 끄며 앱 롤백 후에도 추가 테이블·인덱스는 남겨둘 수 있다.

운영 DB·Storage·Vercel·GitHub 변수 변경, 배포, 커밋·push는 이 워커가 수행하지 않는다.
실제 Riot API와 실기기 검증은 fixture·격리 PG17 검증과 별개다.

## 로컬 검증 결과 (2026-10-24)

| 명령·확인 | 결과 |
| --- | --- |
| `npm run verify:core` | 통과, ESLint 0오류·47경고, TypeScript 오류 없음 |
| `npm run verify:lol` | 25파일·413테스트 통과, 4파일·51테스트 조건부 생략 |
| `npm run verify:security` | 6파일·91테스트 통과 |
| `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations` | PostgreSQL 17, 96개 migration 적용 및 기존·신규 시나리오 통과 |
| 신규 migration 시나리오 | 19개 예외 기반 단정 지점, 권한 거부·윈도우 만료·배치 상한·정리 대상·메트릭·인덱스 검사 |
| DB 동시 카운터 | 8개 별도 연결 요청 중 정확히 1개 허용, 나머지 거부 |
| 증강 FK | 적용 전 누락 8개, 적용 후 0개 |
| `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-public-browser.test.ts tests/lol-dev-browser.test.ts` | 2파일·42테스트 통과 |
| 정리 CLI dry-run | 로컬 HTTP fixture에 실제 tsx CLI 실행, preview RPC 1회만 확인, 삭제 호출 0회 |
| `git diff --check`, Bash 문법, 변경 파일 줄 길이 | 통과, 각 줄 300자 이하 |

LoL 기본 검증에서 생략된 테스트 중 공개·관리자 브라우저 42개는 별도 실행했다.
브라우저 크기는 375×667, 390×844, 430×932와 데스크톱 1440×900을 포함한다.
키 만료·미설정 안내 8개 화면과 갱신 실패 후 기존 전적·상세 보존을 확인했다.
주요 스크린샷은 `tmp/lol-public-review/`와 `tmp/lol-detail-alignment/`에 남겼으며 모바일 안내와 보존 화면을 시각적으로 확인했다.
브라우저는 가상 Riot ID·fixture만 쓰며 외부 이미지·Riot API를 호출하지 않는다. 실제 앱·실기기 검증은 하지 않았다.

운영 DB·Storage·배포·저장소 변수는 변경하지 않았다. 실 Riot API, 실 PostgREST 통합 및 증강 브라우저는 이 작업에서 실행하지 않았다.
`.agents/rules/project_rules.md`가 이 작업 폴더에 없어 AGENTS.md·실제 코드·추적 문서·테스트를 기준으로 진행했다.

Migration SHA256:

```text
f7d3193e866fdd2bcd8342ecc1037545860bd6e951a44dab1d17ad582faa8aed
```

## 변경 파일 (36개)

- `.github/workflows/lol-cleanup.yml`
- `app/api/lol/matches/[matchId]/route.ts`
- `app/api/lol/matches/more/route.ts`
- `app/api/lol/search/route.ts`
- `app/lol/kr/by-ref/[ref]/route.ts`
- `app/lol/kr/page.tsx`
- `components/lol/LolMatchCard.tsx`
- `components/lol/LolMatchDetail.tsx`
- `components/lol/LolOpsPanel.tsx`
- `components/lol/LolSearchPanel.tsx`
- `components/lol/LolSummary.tsx`
- `docs/operations/2026-10-24-lol-review-hardening.md`
- `docs/plans/2026-10-23-lol-chapter4-ops.md`
- `docs/plans/2026-10-23-lol-chapter5-review.md`
- `docs/plans/2026-10-23-lol-production-key-readiness.md`
- `lib/lol/dataDragon.server.ts`
- `lib/lol/keyNotice.ts`
- `lib/lol/ops.server.ts`
- `lib/lol/publicAccess.server.ts`
- `lib/lol/riotSearch.server.ts`
- `lib/lol/routes.server.ts`
- `lib/lol/types.ts`
- `scripts/lol_cleanup_expired.ts`
- `scripts/verify_migrations_local.sh`
- `supabase/migrations/20261024020000_lol_review_hardening.sql`
- `tests/fixtures/lol/browserScenario.ts`
- `tests/fixtures/migration-check/lol-review-fk-audit.sql`
- `tests/fixtures/migration-check/lol-review-hardening-scenarios.sql`
- `tests/lol-cleanup-script.test.ts`
- `tests/lol-collect.test.ts`
- `tests/lol-data-dragon.test.ts`
- `tests/lol-persistence-integration.test.ts`
- `tests/lol-public-access.test.ts`
- `tests/lol-public-browser.test.ts`
- `tests/lol-public-rate-limit.test.ts`
- `tests/lol-riot-search.test.ts`


## 전체 리뷰 후속 보완

`20261024040000_lol_review_fixes.sql`은 기존 RPC 세 개를 교체한다. 헤더 파서·권한은 유지하고 형식 오류 차단만 다음 UTC 자정에서 10분으로 바꾼다.
`delete_lol_account_data`는 해당 PUUID의 `collect:`와 알려진 현재·경기 당시 Riot ID의 `search:v10:`, 관련 원문의 `match:` lease만 제거한다.
다른 계정·운영 정리 lease는 보존한다. 원문·저장 계정에 연결이 없는 이름의 lease는 현재 데이터로 연관성을 판별할 수 없어 제거하지 않는다.

삭제 요청은 비회원도 개인정보 보호책임자 이메일로 Riot ID를 제시할 수 있다. 운영자는 Account-V1 by-riot-id로 PUUID를 확인한 뒤 기존 PUUID 삭제 RPC를 실행한다.
공개 더보기의 명시적 경기 ID는 서버가 해당 PUUID의 해당 페이지에서 받은 ID에 포함되어야 하며, 공개 상세는 `lol_matches`에 존재하는 KR/asia 경기만 허용한다.
관리자 조회의 임의 ID 처리 계약은 유지한다. 증강 아이콘 프록시는 공개 플래그와 관계없이 기존 관리자 가드를 거친다.

검색·더보기 lease와 `acquire_lol_collection_lease`의 TTL 상한은 180초다. 저장 RPC의 SQLSTATE `40001`은 처리 시간 초과 재시도 안내, 전역 permit 혼잡은 요청 혼잡 안내로 구분한다.
커스텀·제한 경기는 실패 카드 대신 숨긴 개수만 표시한다. 숙련도 최근 성과는 솔로·자유·일반·칼바람(100/450)에서 승패가 있는 유효 경기만 집계한다.
부정적인 숙련도 배지는 제거하고 `challenges`는 서버 저장 요약에만 남기며 클라이언트 DTO에서 제거한다.


후속 보완 검증: `verify:core` 오류 0·기존 경고 47, `verify:lol` 446 통과·60 skip, `verify:security` 91 통과,
워크플로 안전성 10 통과, 로컬 PostgreSQL 지정 migration 98개 및 RPC 시나리오 통과.
기본 Turbopack 빌드는 worktree 외부 node_modules 심볼릭 링크 때문에 실패했으며 `npm run build -- --webpack`은 전체 빌드에 성공했다.
공개 브라우저 14개 통과, 관리자 마지막 전체 실행 36/37 통과(운영 패널 375px 타임아웃 1개), 해당 패널 분리 재실행은 4개 뷰포트 모두 통과했다.
최소 375×667·390×844·430×932·데스크톱을 fixture로 확인했으며 실기기·운영 연결은 검증하지 않았다.
후속 migration SHA256: `33b63464c101ea5b4ddd16519ec5f492b5ecefed3c721b7d92569c77fab531c5`.
