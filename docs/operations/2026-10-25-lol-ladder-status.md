# LoL 랭크 컷 기록·서버 상태 운영 계약

이 문서는 트랙 B 구현과 로컬 격리 검증을 설명한다. 운영 적용·배포 기록이 아니다.

## 수집·저장

- 공식 [League-V4](https://developer.riotgames.com/apis#league-v4)의 한국 서버 `challengerleagues`, `grandmasterleagues`, `masterleagues` by-queue를 사용한다.
- 큐는 `RANKED_SOLO_5x5`, `RANKED_FLEX_SR` 두 개이며 정상 실행 한 번에 Riot 요청 6회다. 재시도는 하지 않는다. 수동 dry-run도 6회를 사용한다.
- 실행 시각은 매일 UTC 20:19, KST 다음 날 05:19다. 기존 LoL·PUBG 예약 실행 분과 다르지만 GitHub 예약 지연까지 분리를 보장하지는 않는다.
- 기존 `requestJson`의 공유 permit·429 차단·네트워크 제한·메트릭을 사용한다. CLI에서도 `LOL_PERSISTENCE_ENABLED=true`가 필요하다.
- 마스터 명단 크기를 고려해 지정된 6개 집계 경로만 최대 32MiB를 허용한다. 다른 응답은 기존 1MiB 제한을 유지한다.
- 원본 명단은 TTL 0으로 조회하며 메모리·DB 캐시에 남기지 않는다. 저장과 로그에는 PUUID·계정명·리그 식별자를 포함하지 않는다.
- `lol_ladder_daily` PK는 `(day, queue, tier)`다. `day`는 수집 시작 시각 `observed_at`의 KST 날짜이며, 자정을 넘겨 완료해도 시작 날짜로 묶는다.
- 집계는 인원, 최저 LP(`cutoff_lp`), 최고 LP(`top_lp`), 중위 LP, `freshBlood` 인원, `hotStreak` 인원이다. 짝수 표본의 중위 LP는 가운데 두 값의 평균이다.
- 빈 티어의 LP는 `null`이다. 6개 응답이 모두 유효할 때 한 RPC로 저장하며 같은 시각 재실행은 멱등이다. 오래된 실행이 최신 값을 덮지 않는다.
- `freshBlood`·`hotStreak`는 Riot 응답 플래그의 개수다. 이전 날짜와 비교해 실제 승급자나 연승 횟수를 계산한 값이 아니다.
- `/lol/kr/ladder`는 오늘의 관측값과 최근 KST 30일 기록을 표시한다. 없는 날짜는 보간하지 않으며 그래프 선도 끊는다. 승급 예측 기능은 없다.
- 관리자 운영 패널의 마지막 스냅샷은 30일 조회 범위와 무관한 전체 기록의 최대 관측 시각이다. 운영 상태 새로고침으로 갱신한다.

```sh
# Node 22, 운영과 분리된 검증 환경에서 실행한다.
LOL_PERSISTENCE_ENABLED=true npx tsx scripts/lol_ladder_snapshot.ts --dry-run
# 적용은 메인이 승인한 환경에서만 수행한다.
LOL_PERSISTENCE_ENABLED=true LOL_LADDER_ENABLED=true npx tsx scripts/lol_ladder_snapshot.ts --apply
```

워크플로는 main에서만 실행하며 저장소 변수 `LOL_LADDER_ENABLED=true`일 때만 `--apply`를 사용한다. 기본값은 dry-run이다.
CLI는 Node의 모듈 loader로 Next 빌드 전용 `server-only` 표시만 처리한다. 서버 전용 모듈의 공유 호출·서비스 역할 권한 검사는 유지한다.

## 서버 상태

- 공식 [LoL-Status-V4](https://developer.riotgames.com/apis#lol-status-v4)의 `/lol/status/v4/platform-data`를 한국 서버에서 호출한다.
- `lol_platform_status_cache`와 인스턴스 메모리에 공개 공지를 5분간 캐시한다. 한 인스턴스에서는 inflight를 합치고 인스턴스 간에는 기존 수집 lease를 사용한다.
- 갱신 lease 획득 후 DB 캐시를 다시 검사한다. Riot 호출 전에 다음 갱신 시각을 미뤄 키 만료·upstream 장애 때도 반복 호출을 억제한다.
- DB나 공유 가드를 사용할 수 없으면 Riot 호출을 우회하지 않는다. 영속 저장 비활성화 시 상태는 확인 불가로 표시한다.
- 제목·게시된 업데이트는 `ko_KR`를 우선하고 없으면 `en_US`를 사용한다. 종료된 점검·보관된 공지와 비공개 업데이트는 표시하지 않는다.
- 공개·관리자 LoL 레이아웃의 배너와 `/lol/kr/status`는 같은 캐시를 사용한다. 공개 페이지는 기존 `LOL_PUBLIC_ENABLED` 가드를 유지한다.
- 갱신 실패 시 마지막 공지는 오래된 상태임을 명시한다. 조회 불가를 정상 상태로 표시하지 않으며 상태 페이지에 공식 상태 링크를 둔다.
- 두 테이블은 RLS를 활성화하고 anon·authenticated 접근을 철회한다. RPC는 모두 service_role 전용, `SECURITY INVOKER`, 빈 `search_path`다.
- Discord 알림은 후속 과제다. 기존 Discord 앱 연동·알림 중복 방지·승인 범위를 별도로 검토한 뒤 구현한다.

## 운영 적용 순서

1. 트랙 A와 변경을 합치고 core·LoL·security·workflow·migration 검증 결과를 다시 확인한다. 검색 패널과 검색 DTO는 이 트랙에서 수정하지 않았다.
2. `20261025200000_lol_ladder_status.sql`의 SHA256을 확인하고 메인이 승인한 운영 migration 경로로 먼저 적용한다.
3. 앱 서버의 기존 Supabase 서버 자격증명·`RIOT_API_KEY`·`LOL_PERSISTENCE_ENABLED` 설정을 확인하고 코드를 배포한다. 비밀 값은 로그에 출력하지 않는다.
4. `LOL_LADDER_ENABLED`를 끈 상태로 main의 수동 workflow dry-run을 한 번 실행한다. 6개 집계·공유 호출 제한·날짜와 계정 식별자 미포함을 확인한다.
5. 저장소 변수 `LOL_LADDER_ENABLED=true`를 메인이 설정한 뒤 수동 적용 한 번을 실행하고 6개 행과 운영 패널 스냅샷 시각을 확인한다.
6. 기존 공개 플래그가 활성화된 환경에서 `/lol/kr/ladder`, `/lol/kr/status`, 공개·관리자 배너를 확인하고 다음 KST 05:19 수집을 확인한다.
7. 중지할 때는 먼저 `LOL_LADDER_ENABLED`를 끈다. 이는 기록 쓰기만 중지하고 dry-run Riot 요청과 상태 조회는 계속될 수 있으므로 완전 중지는 workflow·공개 경로 운영 설정에서 별도로 한다.

추가 테이블은 기존 전적을 변경하지 않는다. 앱 롤백 시 테이블을 남길 수 있으며 데이터 삭제·운영 승인 우회는 필요하지 않다.

Migration SHA256:

```text
f1fed17c2a49893bf14a4d72b7f8058f6f6bc88da6df7d9e766d07988e9817b4
```

## 검증

- 로컬 PostgreSQL 17 임시 클러스터에 99개 지정 migration 적용 및 전체 기존·신규 SQL 시나리오 통과.
- 신규 SQL 시나리오: RPC·테이블 권한, RLS·invoker·search_path, 6개 원자 저장, 멱등·오래된 값 덮어쓰기 방지, KST 자정, 개인 식별자 거부, 집계 범위, 마지막 관측 시각, 5분 상태 캐시.
- CLI 실제 진입점 fixture 2개 통과: dry-run·apply 각각 Riot/permit 6회, 집계 저장 0회/1회, 식별자 로그·저장 없음.
- 신규 공개 브라우저 4개 통과: 각 뷰포트에서 ladder·status와 각각의 빈/오류 상태 등 24개 화면 시나리오 확인.
- 신규 브라우저 크기: 375×667, 390×844, 430×932, 1440×900. 긴 공지·SVG·법적 고지·가로 넘침을 검사했다.
- 기존 공개 브라우저 14개 통과. 기존 관리자 전체는 36/37 통과 후 375px 확인 버튼의 렌더 경합을 고쳤으며 운영 패널 4개 뷰포트를 분리 재검증해 통과했다.
- 시스템 Chrome을 사용했다. 자동 다운로드 Chrome은 이 환경에서 WS endpoint 대기 중 타임아웃됐다. 개발 서버는 시작·재시작하지 않았다.
- 이미지: `tmp/lol-ladder-status-review/`, `tmp/lol-public-review/`, `tmp/lol-detail-alignment/`. 신규 모바일과 데스크톱 이미지를 시각적으로 확인했다.
- 실제 Riot 호출·운영 DB·PostgREST 실연결·Vercel·GitHub 설정 변경·배포·실기기 검증은 수행하지 않았다. API 응답 형태는 공식 문서와 fixture로 검증했다.
- `.agents/rules/project_rules.md`와 `docs-private/.project_context.md`가 없어 AGENTS.md·추적 문서·실제 구현을 기준으로 작업했다.

| 최종 명령 | 결과 |
| --- | --- |
| `npm run verify:core` | 통과, ESLint 0오류·기존 47경고, TypeScript 오류 없음 |
| `npm run verify:lol` | 29파일·469개 통과, 5파일·64개 조건부 생략 |
| `npm run verify:security` | 6파일·91개 통과 |
| `npx vitest run tests/actions-workflow-safety.test.ts` | 1파일·10개 통과 |
| `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations` | 99개 지정 migration 및 기존·신규 RPC 시나리오 통과 |
| 변경 파일 줄 길이·`git diff --check`·Bash 문법 | 통과 |

LoL 기본 검증에서 조건부 생략된 브라우저는 위에 적은 별도 실행 결과를 따른다. 전체 관리자 브라우저의 마지막 실행 결과와 수정 후 해당 4개 재검증 결과는 구분했다.

## 변경 파일 (28개)

- `.github/workflows/lol-ladder.yml`
- `app/admin/lol/layout.tsx`
- `app/lol/kr/ladder/page.tsx`
- `app/lol/kr/status/page.tsx`
- `app/lol/layout.tsx`
- `components/lol/LolLadderView.tsx`
- `components/lol/LolOpsPanel.tsx`
- `components/lol/LolStatusBanner.tsx`
- `components/lol/LolStatusView.tsx`
- `docs/operations/2026-10-25-lol-ladder-status.md`
- `lib/lol/ladder.server.ts`
- `lib/lol/ladder.ts`
- `lib/lol/ops.server.ts`
- `lib/lol/riotSearch.server.ts`
- `lib/lol/status.server.ts`
- `lib/lol/status.ts`
- `lib/lol/types.ts`
- `scripts/lol_ladder_snapshot.ts`
- `scripts/verify_migrations_local.sh`
- `supabase/migrations/20261025200000_lol_ladder_status.sql`
- `tests/fixtures/migration-check/lol-ladder-status-scenarios.sql`
- `tests/lol-dev-browser.test.ts`
- `tests/lol-ladder-script.test.ts`
- `tests/lol-ladder-status-browser.test.ts`
- `tests/lol-ladder-status.test.ts`
- `tests/lol-ops.test.ts`
- `tests/lol-public-browser.test.ts`
- `tests/lol-riot-search.test.ts`
