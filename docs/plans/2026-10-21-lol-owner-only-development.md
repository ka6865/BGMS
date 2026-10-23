# LoL 관리자 전용 개발 공간 구현 계획

> **문서·실행 지침:** 현재 계약은 2026-10-22 관리자 역할 기준이다. 작업 1~4의 체크박스와 당시 결과는 2026-10-21 본인 전용 구현의 역사로 보존하며 현재 계약과 구분한다. 구현은 사용자 지침에 따라 서브에이전트에 배정하고, 메인은 통합 및 독립/최종 검토를 담당한다.

**목표:** `/admin/lol`과 `/api/admin/lol/status`에 현재 `profiles.role = admin`인 모든 BGMS 관리자가 접근할 수 있는 최소 개발 공간을 만든다.

> **현재 후속 구현:** 빈 화면은 2026-10-22 [KR LoL 비공개 전적 검색 MVP](2026-10-22-lol-private-search-mvp.md)로 확장됐다. 이 문서의 본인 전용 접근 체크리스트와 결과는 과거 구현 이력으로만 읽는다.

**구조:** 기존 `requireAdmin()`에 개발 플래그 검사를 추가하는 LoL 전용 서버 가드를 둔다. 페이지·레이아웃·확인 API가 가드를 사용하며 기존 PUBG·공통 인증 코드는 유지한다. 실제 게임 데이터나 Riot 연결은 포함하지 않는다.

**기술:** 실제 설치 버전 Next.js 16.3.8, React 19.3.0, TypeScript, Supabase Auth, Vitest, 기존 Puppeteer·Tailwind 도구. 새로운 의존성 없음.

**설계 근거:** [멀티게임·LoL 확장 설계](../specs/2026-10-21-multigame-lol-architecture-design.md)의 8.0절과 12.1절. 공개 전적 서비스 조사(비공개 `docs-private/lol-research/`, 저장소 미포함)의 검색 UI는 다음 작업이며 이번 빈 화면에 추가하지 않는다.

**과거 최종 상태 (2026-10-21, 본인 전용 당시):** `/admin/lol` 본인 전용 비공개 빈 개발 공간의 코드와 격리 검증이 완료됐고 전체 최종 독립 검토를 통과했다(필수 수정 0건). 실제 Next HTTP·인증·RSC·캐시·Preview 검증 및 운영 활성화는 미실행이다. 환경 변수 설정·DB 변경·배포·커밋은 수행하지 않았다.

**공유 위치:** `docs/superpowers/`는 현재 Git 제외 대상이므로 다른 에이전트에게 문서를 남기려는 사용자 요청에 맞춰 기존 `docs/plans/`를 사용한다. 제외 규칙을 변경하거나 강제 추가하지 않는다.

## 이번 변경 및 검증 (2026-10-22)

`requireLolDevAdmin()`과 `requireLolDevPageAdmin()`이 기존 `requireAdmin()`으로 매 요청 현재 관리자 역할을 확인한다. 모든 관리자를 허용하며 일반 회원 403·익명 401·flag off 404, Bearer 우선·no-store·예외 비노출, 페이지/layout 독립 검사를 유지한다. 로컬 환경 파일의 요청한 flag 적용과 소유자 항목 제거를 완료했으며 다른 항목은 보존했다.

| 실제 실행 | 결과 |
| --- | --- |
| 수정 전 `npx vitest run tests/lol-dev-access.test.ts` | 예상 실패: 13 실패·5 통과, UUID 제한 회귀 확인 |
| `npm run verify:core` | exit 0, ESLint 오류 0·기존 경고 47, TypeScript 통과 |
| `npm run verify:admin` | exit 0, 20개 파일·423개 검사 통과 |
| `npx vitest run tests/lol-dev-access.test.ts tests/lol-dev-status.test.ts tests/lol-dev-page.test.ts tests/supabase-guard-bearer.test.ts tests/seo-metadata-contract.test.ts tests/player-page-seo.test.ts` | exit 0, 6개 파일·53개 검사 통과 |
| `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts` | exit 0, 4개 검사 통과: 375x667·390x844·430x932·1440x900 |

브라우저 증거는 `tmp/lol-dev-admin-role/`에 저장했다. 실제 HTTP·RSC·인증 캐시는 Kepler 담당으로 여기서는 미실행이다. 실기기·Preview·DB·Riot 검증도 미실행이다. 포트 59405의 기존 PID 36075를 중지·재시작하지 않았으며 커밋·배포·staging은 수행하지 않았다.

## 과거 실행 결과와 범위 (2026-10-21)

| 검증 | 결과 |
| --- | --- |
| `npm run verify:core` | 통과, 오류 0건, 기존 ESLint 경고 47건 |
| `npm run verify:admin` | 통과, 423개 검사 |
| 최신 LoL 접근/API/페이지·Bearer·SEO 회귀 | 통과, 43개 검사 |
| 격리 브라우저 렌더 | 통과, 4개 뷰포트 검사 (`375x667`, `390x844`, `430x932`, `1440x900`) |
| 전체 최종 독립 검토 | 통과, 필수 수정 0건. 검토 기록은 로컬 `.superpowers/sdd/2026-10-21-lol-owner-only-development/final-review.md` |

검증은 별도 격리 worktree에서 수행했다. 실제 Next HTTP/인증/RSC/캐시 동작, 보호 Preview 및 운영 활성화는 검증하지 않았고, 공개·운영 전 별도 통제 환경에서 확인해야 한다.

## 공통 제약

- 설명·화면·오류 문구는 한국어. 실제 회원 ID·키·쿠키를 문서·fixture·로그에 기록하지 않는다.
- `LOL_DEV_ENABLED`의 문자열 값이 정확히 `true`일 때만 활성화한다. 미설정·빈 문자열·`false`·`TRUE`·`1`은 비활성이다.
- 소유자 UUID 환경 설정·형식 검사·비교는 제거한다. `.env.local`은 요청한 개발 플래그를 적용하고 불필요한 `LOL_DEV_OWNER_USER_ID` 행만 제거하며 다른 환경 값은 보존한다.
- 유효한 로그인·매 요청 현재 `profiles.role = admin`을 요구한다. 모든 관리자를 허용하고 일반 회원·익명을 차단한다. `requireAdmin()`의 Bearer 우선 및 현재 DB 역할 확인 계약을 유지한다.
- 기존 `profiles`, `requireAdmin`, `withAuthGuard`, proxy, PUBG 경로·로그인·메뉴·광고 정책을 변경하지 않는다.
- `/lol/*`, `/api/lol/*`, 검색 API·Riot 호출·신규 경기 DB·R2·AI·큐·cron은 생성하지 않는다.
- `private, no-store`, 사용자 ID 비노출, 고정 `noindex` 메타데이터. 공유 인증 캐시·ISR·`use cache`를 사용하지 않는다.
- 검증 fixture는 가상 사용자만 사용한다. 운영 회원 생성·권한 변경·개인 브라우저 세션 사용 금지.
- 미추적 `.playwright-mcp/` 및 기존 문서 변경을 보존한다. README·잠금 파일·의존성 변경 없음.
- 사용자 요청에 따라 Git 커밋·배포·운영 환경 설정은 수행하지 않는다. 스킬의 일반적인 커밋 단계보다 이 조건이 우선한다.

## 집중 검토 항목

1. 개발 플래그 비활성은 인증 전에 404로 차단한다. 소유자 설정 없이 서로 다른 관리자 2명이 모두 성공해야 한다.
2. 일반 회원·역할 회수는 403, 익명은 401로 차단한다. 현재 역할을 매 요청 조회하며 과거 성공을 재사용하지 않는다.
3. 잘못된 Bearer와 유효한 쿠키 동시 전달: 쿠키로 우회하지 않아야 한다. 작업 2의 통합 회귀에서 검사한다.
4. 관리자 성공 응답 뒤 익명/일반 회원 요청: API가 앞선 성공 응답을 재사용하거나 식별자를 반환하지 않아야 한다. 작업 2의 연속 호출·헤더 테스트로 고정한다.
5. 레이아웃 재사용·직접 페이지 실행·RSC 접근: 각 데이터 진입점이 독립 검사해야 한다. 작업 3의 페이지 직접 실행과 후속 실제 Next 응답 점검을 구분한다.

## 확인한 기존 계약과 파일 범위

| 경로 | 용도·판단 |
| --- | --- |
| `lib/server/adminGuard.ts` | `requireAdmin(): Promise<AdminGuardResult>` 재사용. 성공 시 검증 사용자와 service role 클라이언트, 실패 시 `NextResponse`를 반환 |
| `utils/supabase/guard.ts` | `withAuthGuard()`가 `auth.getUser()`로 검증. 잘못된 Bearer에 쿠키 대체 없음 |
| `lib/supabase-middleware.ts`, `proxy.ts` | `/admin` 비로그인은 `/login`, 일반 회원은 `/`로 이동. `/api/admin`은 이 관리자 분기에 포함되지 않음 |
| `components/layout/SidebarFooterWrapper.tsx` | `/admin/` 광고 제외·고정 높이·overflow-hidden. 이번에는 기존 동작 재사용 |
| `vitest.config.ts` | `tests/**/*.test.ts`, 기본 Node 환경, `@/` 루트 별칭. 테스트는 `.test.ts`로 생성 |
| `tests/supabase-guard-bearer.test.ts` | 기존 Bearer 우회 방지 검사. 유지하고 함께 실행 |
| `tests/ai-coaching-review-api.test.ts` | Route Handler 직접 호출·Supabase 모의 응답·no-store 검사 방식 참고 |
| `tests/admin-ai-observability-browser.test.ts` | 격리 HTTP 서버·기존 Puppeteer·Tailwind·외부 요청 차단 방식 참고 |
| 설치 Next.js `01-app/02-guides/authentication.md` | 레이아웃만으로 자식 실행/RSC 노출을 차단할 수 없으므로 각 진입점 검사 |
| 설치 Next.js `01-app/01-getting-started/15-route-handlers.md` | GET 기본 비캐시. 그래도 명시적 API no-store와 실제 응답 검사 필요 |

**새 파일:** `lib/lol/access.server.ts`, `app/admin/lol/layout.tsx`, `app/admin/lol/page.tsx`, `app/api/admin/lol/status/route.ts`, `tests/lol-dev-access.test.ts`, `tests/lol-dev-status.test.ts`, `tests/lol-dev-page.test.ts`, `tests/lol-dev-browser.test.ts`.

**기존 수정:** 구현 상태를 반영할 설계서·이 계획 문서만 기본 대상이다. 기존 제품 파일 변경이 필요해지면 먼저 원인을 확인하며 무관한 인증 리팩터링을 끼워 넣지 않는다.

---

## 과거 작업 기록 (2026-10-21)

아래 작업 1~4의 함수명·소유자 설정·검사 수·환경 설명은 당시 기록이며 현재 계약이 아니다. 현재 함수는 `requireLolDevAdmin`과 `requireLolDevPageAdmin`이고 UUID 설정은 필요 없다. 이전 보고서와 독립 검토 결과는 변경하지 않는다.

## 작업 1. 본인 전용 서버 가드

**파일:** 신규 `lib/lol/access.server.ts`, `tests/lol-dev-access.test.ts`.

**인터페이스:**

- 입력: 인자 없음. 매 호출의 서버 환경 설정과 기존 `requireAdmin()` 결과를 사용한다.
- 출력: `requireLolDevOwner(): Promise<LolDevAccessResult>`.
- `LolDevAccessResult = { ok: true } | { ok: false; error: NextResponse }`.
- 성공 결과에 사용자 ID·이메일·service role 클라이언트를 노출하지 않는다. 이후 작업은 `ok`와 실패 응답만 사용한다.
- `server-only` 경계를 선언한다. 테스트에서는 기존 방식의 `vi.mock('server-only', () => ({}))`를 사용한다.

- [x] **1. 실패 테스트 작성.** `vi.stubEnv`와 테스트 종료 시 복구를 사용한다. 가상 UUID는 `11111111-1111-4111-8111-111111111111`, 다른 관리자는 `22222222-2222-4222-8222-222222222222`로 둔다. 설정 검사는 `requireAdmin` 모의 응답으로, 역할 검사는 실제 `requireAdmin`에 모의 `withAuthGuard`/프로필 조회를 연결한 별도 테스트 묶음으로 확인한다.

| 테스트 이름 | 고정할 검증 |
| --- | --- |
| 비활성 설정은 인증 전에 거부 | undefined/빈 값/false/TRUE/1 → 404, `requireAdmin` 호출 0회 |
| 활성 상태의 잘못된 소유자 설정은 거부 | undefined/빈 값/비UUID → 503, 인증 호출 0회 |
| 환경 설정의 공백·대소문자 정규화 | UUID 형식 검사 후 같은 UUID만 허용, 다른 값은 거부 |
| 본인 관리자만 성공 | `{ ok: true }`이며 추가 사용자·DB 필드 없음 |
| 다른 관리자는 거부 | 403 |
| 지정 본인도 관리자 역할이 없으면 거부 | 실제 가드 체인의 프로필 응답이 user/null/error인 경우 비성공 |
| 기존 인증 실패 보존 | 401/403/500 상태 유지, 응답 원문에 민감 정보 추가 없음 |
| 예상하지 못한 가드 예외는 차단 | 모의 `requireAdmin`이 throw하면 일반 500. 예외 원문은 클라이언트에 없음 |
| 역할·세션 결과는 다음 요청에 재확인 | 성공 후 거부 응답으로 바꾸면 두 번째 호출은 거부 |

- [x] **2. 실패 확인.** `npx vitest run tests/lol-dev-access.test.ts` 실행. 새 모듈 부재 또는 해당 보안 단언 실패인지 확인한다.
- [x] **3. 최소 구현.** 플래그 → 설정 → 기존 관리자 인증 → 본인 ID 순서. 실패 응답의 `Cache-Control`을 `private, no-store`로 설정하고 일반 한국어 문구로 반환한다. 기존 가드의 실패 상태는 보존하며 상세 본문은 재사용하지 않는다. 예상 밖 예외도 접근을 허용하지 않는다. 신규 DB 클라이언트를 만들지 않는다.
- [x] **4. 통과 확인.** 위 단위 검사와 `npx vitest run tests/supabase-guard-bearer.test.ts` 통과. 테스트가 운영 URL·키를 사용하지 않았는지 확인한다.
- [x] **5. 변경 검토.** 신규 가드가 기존 관리자 가드 호출부에 영향을 주지 않는지 diff 확인. 커밋하지 않는다.

## 작업 2. 최소 확인 API

**파일:** 신규 `app/api/admin/lol/status/route.ts`, `tests/lol-dev-status.test.ts`.

**인터페이스:** 작업 1의 `requireLolDevOwner()` 사용. `GET(): Promise<NextResponse>` 성공은 정확히 HTTP 200과 `{ ok: true }`, 실패는 가드의 상태와 일반 오류 본문. 모든 응답에 `Cache-Control: private, no-store`. GET 외 변경 동작 없음.

- [x] **1. 실패 테스트 작성.** 실제 GET을 직접 호출해 200/401/403/404/500/503의 상태·캐시 헤더를 검사한다. 성공 본문에 사용자 ID·키·환경 설정이 없는지 검사한다. 본인 성공→익명→다른 관리자 순서로 모의 인증 상태를 바꾸고 각각 200→401→403인지 확인한다.
- [x] **2. 실패 확인.** `npx vitest run tests/lol-dev-status.test.ts`가 새 라우트 부재 또는 기대 단언으로 실패하는지 확인한다.
- [x] **3. 최소 구현.** GET에서 매번 가드를 호출하고 성공 JSON만 반환한다. 별도 캐시·검색·DB 읽기·큐 등록을 추가하지 않는다.
- [x] **4. 실제 인증 체인 회귀 검사.** 별도 모의 범위에서 실제 GET→LoL 가드→`requireAdmin`→`withAuthGuard`를 연결하고 Supabase SDK/`next/headers`만 모의한다. 잘못된 Bearer + 본인 쿠키는 401이며 쿠키 `getUser`는 호출되지 않아야 한다. 성공 시 Auth 확인과 `profiles` 읽기만 허용하고 다른 테이블·RPC·외부 fetch가 있으면 실패시킨다.
- [x] **5. 통과 확인.** `npx vitest run tests/lol-dev-access.test.ts tests/lol-dev-status.test.ts tests/supabase-guard-bearer.test.ts`. 기존 API·설정 파일·워크플로 변경이 없는지 확인한다. 커밋하지 않는다.

## 작업 3. 보호된 빈 개발 화면

**파일:** 신규 `app/admin/lol/layout.tsx`, `app/admin/lol/page.tsx`, `tests/lol-dev-page.test.ts`. 작업 1의 `lib/lol/access.server.ts`에 페이지용 함수를 추가한다.

**인터페이스:**

- `requireLolDevPageOwner(): Promise<void>`: `requireLolDevOwner` 성공이면 반환. 401이면 `redirect('/login')`, 403/404면 `notFound()`, 500/503이면 민감 정보 없는 일반 오류를 throw한다. Next 제어 흐름의 throw를 일반 catch로 삼키지 않는다.
- `LolDevLayout({ children }: Readonly<{ children: React.ReactNode }>): Promise<React.ReactNode>`: 페이지용 가드를 호출하고 children을 반환한다.
- `LolDevPage(): Promise<React.ReactNode>`: 페이지용 가드를 독립 호출하고 제목 `LoL 비공개 개발`, 문구 `본인 전용 접근 확인이 완료되었습니다.`를 표시한다. 일반 여백·줄바꿈만 적용하고 아직 검색 버튼·확인 API 폴링을 만들지 않는다.
- 레이아웃의 정적 metadata는 PUBG 제목 템플릿을 덮는 `title.absolute`, `robots: { index: false, follow: false }`를 사용한다. 계정별 메타데이터·OG·사이트맵은 없음.

- [x] **1. 실패 테스트 작성.** `redirect`·`notFound`를 구분 가능한 예외로 모의한다. 401/403/404/500/503 페이지 분기, 예외의 일반 문구, 성공 JSX를 확인한다. 레이아웃을 거치지 않고 페이지 함수를 직접 실행해도 가드가 호출되어야 한다. 레이아웃 검사도 따로 실행한다.
- [x] **2. 실패 확인.** `npx vitest run tests/lol-dev-page.test.ts`가 해당 새 파일/함수 또는 단언 부재로 실패하는지 확인한다.
- [x] **3. 최소 구현.** 설치 Next.js의 동적 라우트 계약을 따라 보호 구간의 정적 캐싱을 끈다. 현재 `next.config.ts`에는 Cache Components 활성화가 없으므로 해당 버전에서 지원하는 `dynamic = 'force-dynamic'`을 보호 레이아웃에 적용한다. 전역 next.config·proxy·헤더 변경은 하지 않는다.
- [x] **4. 통과 확인.** 단위 검사와 `tests/seo-metadata-contract.test.ts`, `tests/player-page-seo.test.ts` 실행. 새 메타데이터에 Riot ID·PUUID·본인 ID가 없고 새 파일이 기존 PUBG 경로를 바꾸지 않는지 확인한다.
- [x] **5. 범위 검토.** 이 화면에는 개인 경기 데이터나 클라이언트 상태가 없다. 실제 전적 도입 시 로그아웃 후 상태 제거 검증을 추가해야 하며 이번 빈 화면 검사만으로 향후 전적 캐시까지 검증했다고 하지 않는다. 커밋하지 않는다.

## 작업 4. 격리 화면 검증과 실행 결과 기록

**파일:** 신규 `tests/lol-dev-browser.test.ts`. 이 계획과 주 설계서에 실제 검증 결과만 갱신한다.

**인터페이스:** `RUN_LOL_DEV_BROWSER=true`일 때만 실행하는 Vitest 브라우저 검사. 기존 Puppeteer·임시 loopback 서버·Tailwind 빌드 도구를 사용한다. 실제 페이지/레이아웃 함수의 서버 렌더 결과를 사용하며 권한 성공은 테스트 안에서만 모의한다. 앱에 테스트 계정·인증 우회 플래그를 넣지 않는다.

- [x] **1. 브라우저 검사 작성.** 실제 페이지·레이아웃 JSX를 서버 렌더하고 가드만 테스트 내 가상 fixture로 대체했다. 관리자 부모의 높이·`overflow-hidden`을 재현하고 외부 요청을 차단했다. 제목에 `격리 렌더링 — 실제 Next 인증 검증 아님`을 표시했다.
- [x] **2. 뷰포트 검증.** `375x667`, `390x844`, `430x932`, `1440x900` 모두 제목·문구, 가로 넘침 없음, 페이지 오류 없음, 외부 요청 0건을 확인했다. 스크린샷과 렌더 HTML은 Git 제외 `tmp/lol-dev-access/`에 저장했다.
- [x] **3. 실행.** `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts` 실행 결과 4개 검사 통과, skip 없음. 테스트가 연 브라우저와 loopback 서버를 종료했다.
- [x] **4. 필수 회귀.** `npm run verify:core`, `npm run verify:admin`, LoL 접근/API/페이지, 기존 Bearer·SEO 검사 통과. PUBG 분석 전체 검사와 DB migration 검사는 이번 접근 경계에 무관해 실행하지 않았다.
- [x] **5. 실제 Next 응답 점검의 범위 기록.** 미실행. worktree 최상위에는 `.env.example`만 있고 런타임 `.env` 및 기존 Next 서버가 없었다. 허용 산출물 밖에 `.next`를 생성하거나 인증 환경을 임의 준비하지 않는 조건에서 실제 Next 요청을 안전하게 확인할 경로가 없어 건너뛰었다. proxy/RSC/API 응답 헤더·직접 진입·인증/역할 회수·요청 간 캐시는 미확인이고 운영 활성화 전 검증 조건으로 남긴다.
- [x] **6. 최종 검토.** 전체 최종 독립 검토 통과, 필수 수정 0건. 접근 경계·공개 경로 부재·변경 범위 및 공유 문서 정합성을 확인했다. 실제 Next/인증/RSC/캐시·Preview는 미실행 상태로 남겼다.
- [x] **7. 인계.** 작업 보고서와 공유 계획에 파일·검사 결과·격리 worktree·미실행 범위·미커밋 상태를 기록했다. 배포·운영 설정은 하지 않았다.

## 완료 수준과 다음 작업

**코드 완료 조건:** 가드·API·페이지의 역할별 검사, 기존 인증/SEO 회귀, 지정 뷰포트의 격리 렌더링이 통과하고 키·데이터·공개 경로가 추가되지 않는다.

**활성화 전 조건:** 별도 허가된 환경에서 실제 Next/배포 응답의 인증·RSC·캐시·로그아웃·광고 제외 검증을 마친다. 소유자 UUID 설정은 필요 없으며 기존 서버의 중지·재시작 없이 로컬 설정 파일만 변경했다. 코드 완료와 배포/활성화 완료를 구분한다.

다음 계획은 **가상 전적 화면**이다. 이번 접근 경계가 검증되기 전에 실제 Riot 검색이나 신규 경기 테이블을 추가하지 않는다. 실행 방식 선택 뒤에도 기존 커밋·배포 금지는 유지한다.
