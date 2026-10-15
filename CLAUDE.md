# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

위 `AGENTS.md`가 공통 작업 지침(언어, 검증 매트릭스, 운영 안전 규칙)이다. 아래는 Claude Code용 보충 정보이며 `AGENTS.md`와 중복하지 않는다. 로컬에 `.agents/rules/project_rules.md`가 있으면 함께 따른다(주석은 이모티콘 없이 한글, 임시 디버그 출력·죽은 코드 금지).

## 명령

```bash
npm run dev                 # next dev (실행 시 AGENTS.md의 Next.js 블록을 재생성함)
npm run build
npm run verify:core         # eslint + tsc --noEmit (CI 첫 단계)
npm run test:unit           # Vitest 전체: tests/**/*.test.ts (CI 두 번째 단계)
npm test                    # Jest: __tests__/ 만 (jsdom), Vitest를 대체하지 않음

# 단일 테스트
npx vitest run tests/telemetry-contract.test.ts
npx vitest run tests/telemetry-contract.test.ts -t "테스트 이름 일부"
npx jest __tests__/backpackUtils.test.ts
```

- Vitest는 `environment: 'node'`, `globals: true`, `@` → 저장소 루트 alias(`vitest.config.ts`).
- 실제 Gemini 호출 테스트는 `npm run test:ai:gemini`(`RUN_REAL_GEMINI=true`)로만 실행된다. 기본 단위 테스트는 외부 호출을 모킹한다.
- 셸에서 `npm`/`node`가 없거나 Vitest 네이티브 바인딩이 실패하면 `/opt/homebrew/bin` 또는 `/usr/local/bin`의 Node를 사용한다.
- CI(`.github/workflows/pr-verify.yml`, Node 22): `verify:core` → `test:unit`, 별도 job으로 `verify:migrations`, `npm audit --omit=dev --audit-level=high`.

## Migration 검증 계약

- migration은 `supabase/migrations/`에 있다. 저장소 전체 재생은 baseline 결함으로 불가능하다.
- `npm run verify:migrations`(`scripts/verify_migrations_local.sh`)는 일회용 PostgreSQL 17(Docker 또는 로컬)에 `tests/fixtures/migration-check/prerequisites.sql`을 적용한 뒤 **스크립트의 `MIGRATIONS` 배열에 명시된 migration만** 적용하고, 같은 폴더의 `*-scenarios.sql`을 실행한다. 새 migration/RPC를 추가하면 이 배열과 필요한 prerequisites·시나리오 SQL도 함께 갱신해야 검증된다.
- 도메인별 DB 검증: `verify:telemetry-db`, `verify:overwolf-db`, `verify:board-image-storage`, 빈 DB 복구는 `verify:baseline`.

## 아키텍처 개요

Next.js 16 App Router(React 19, TS, Tailwind v4) 단일 앱이며 Vercel에 배포된다. 서버 기능은 대부분 `app/api/**/route.ts`에 있고, 공용 로직은 `lib/`에 도메인별로 나뉜다.

- **요청 경계**: Next 16에서는 middleware 대신 루트 `proxy.ts`가 모든 경로에서 `lib/supabase-middleware.ts`의 `updateSession`으로 Supabase 세션 쿠키를 갱신한다.
- **Supabase 클라이언트**: 브라우저는 `lib/supabase.ts`(→ `utils/supabase/client.ts`), 서버 SSR은 `utils/supabase/server.ts`를 쓴다. 많은 API route는 모듈 최상위에서 service role 키로 `createClient`를 직접 만든다(테스트에서 env 자리표시자가 필요한 이유). 관리자 권한 검사는 `lib/server/adminGuard.ts`, 비밀 헤더 인증은 `lib/server/secretAuth.ts`.
- **PUBG API 계층(`lib/pubg/`)**: PUBG API 호출·에러 리포팅(`apiHelper.ts`), 응답 캐시(`responseCache.ts`, DB 기반), 비공개 플레이어 차단(`privatePlayer*`), 매치 수집·discovery 워커(`matchDiscovery*`, `discoveryBatch.server.ts`), 랭킹/성능 계산, ban watch. `*.server.ts`는 서버 전용 모듈이다.
- **분석 엔진(`lib/pubg-analysis/`)**: `AnalysisEngine`이 텔레메트리 이벤트를 `handlers/`(Combat, Zone, Position, Utility, MapReplay)에 분배해 `AnalysisState`를 누적하고 결과를 만든다. 스쿼드 분석(`squad*`), 벤치마크·티어 점수(`benchmark*`, `tierAveraging.ts`), AI 코칭 프롬프트·증거·품질 게이트(`*AiCoachingPrompt.ts`, `*AiEvidence.ts`, `aiCoachingQuality.ts`, `aiSummary*`)가 이를 소비한다. AI는 Vercel AI SDK + Google Gemini.
- **캐시 식별성과 버전**: `lib/pubg-analysis/constants.ts`의 `RESULT_VERSION`(DB 분석 결과), `ANALYSIS_CALCULATION_VERSION`(계산식), `TELEMETRY_VERSION`(R2 텔레메트리/리플레이 파일명)이 캐시 무효화 키다. 분석 결과나 텔레메트리 산출물 형식이 바뀌면 해당 버전과 관련 문서를 함께 검토한다. 캐시 키는 플랫폼·플레이어·모드·버전을 포함한다(`lib/pubg-analysis/`의 `cacheIdentity.ts`, `telemetryIdentity.ts`, `telemetryCacheKey*.ts`).
- **텔레메트리 저장**(`lib/pubg-analysis/`): 가공된 텔레메트리는 Cloudflare R2(`r2Service.ts`, AWS S3 SDK)에 저장되고, Supabase 레지스트리/맵 캐시 테이블(`telemetryRegistry.server.ts`, `telemetryMapCache.ts`)이 claim → write → finalize/release 수명주기로 동시 생성을 조정한다. 대표 흐름은 `app/api/pubg/telemetry/route.ts`. R2 삭제는 `r2DeletionGuard.ts`를 거친다.
- **기타 도메인(`lib/`)**: `admin-agent/`(관리자 운영 에이전트, 승인 gate), `community-agent/`·`discord/`(커뮤니티 비서·Discord 리뷰), `board/`(게시판: Turnstile, 작성 쿼터, HTML sanitize), `hotdrop/`, `replay/`(2D/3D 리플레이), `overwolf/`, `patch-notes/`.
- **화면**: 지도는 React-Leaflet(`components/map`, `hooks/useMapData.ts`), 전적 화면은 `app/stats` + `components/stat` + `hooks/useStatsPageController.ts`, 3D 리플레이는 Three.js(`components/replay`). 모바일 웹 전용 API는 `app/api/mobile/`.
- **운영 스크립트·자동화**: `scripts/`의 `tsx` 스크립트(`db:*`, `community:run`, AI 감사 등)는 실제 환경 변수로 운영 DB/R2에 접근할 수 있다. 정기 작업은 `.github/workflows/`(daily-tasks, r2-json-maintenance, pubg-match-retention, community-agent 등)가 앱 API 또는 스크립트를 호출한다. 운영 절차 문서는 `docs/operations/`.

## 운영 절차 메모

- **운영 migration 적용**: `supabase db push`는 원격 이력과 로컬 파일의 시간 식별자 불일치(3건)로 중단되고, 일괄 적용 시 순서 제약이 있는 migration까지 함께 들어갈 수 있다. 파일 하나씩 적용한 절차와 확인 방법은 `docs/operations/2026-10-10-remaining-review-fixes.md`의 "준비 migration 적용 실적"을 따른다.
- **핵심 테이블 백업**: daily-tasks와 수동 `Core Backup` 워크플로가 `scripts/backup_core_tables.ts`로 R2에 manifest + part 파일을 올리고, 바로 `scripts/verify_core_backup.ts`로 part 목록대로 복원 검증한다. 수동 확인은 `npm run db:backup:verify -- --key backups/core-<시각>.json`(R2 읽기 전용).
- **작업 공간**: 새 작업은 최신 `origin/main`에서 별도 worktree를 만들어 진행한다. 오래된 로컬 브랜치 위에서 이어 작업하지 않는다.
