# Task 5 구현 보고서

- 작업일: 2026-08-10 KST
- 브랜치: `codex/opgg-stats-redesign`
- 시작 기준: `edcaff696eb5fd6534d5b3fcf4c7902685d5a3f1`
- 범위: 반응형 광고 registry/viewport hook/provider 안전 경계의 foundational 구현

## 구현 결과

### viewport와 선언형 placement registry

- `useAdViewportClass`는 `useSyncExternalStore`의 server snapshot을 `unknown`으로 고정하고 768/1280/1600px media query를 mobile/tablet/desktop/wide로 분류한다.
- `createStatsAdPlacements`는 상단 AdFit, mobile after-6 AdSense, tablet+ after-5/10/15 슬롯을 한 곳에 선언한다.
- mobile은 renderable match 7개부터 after-6 하나, tablet+는 6/11/16개부터 after-5/10/15를 추가해 광고가 마지막 항목이 되지 않는다.
- `unknown`은 같은 threshold로 mobile/tablet 예약 token을 반환하지만 provider creative는 선택하지 않는다.
- feed AdFit unit은 trim한다. `undefined`, 빈 문자열, 공백 문자열이면 `stats-after-10` 자체가 `null`이며 예약 container도 만들지 않는다. 상단 `DAN-dPiCxgIGtXKjLPP3`를 feed fallback으로 재사용하지 않는다.

### ResponsiveAdSlot과 CSS 예약

- `ResponsiveAdSlot`은 viewport `unknown`에서 wrapper 예약 token만 렌더하고 provider component를 마운트하지 않는다.
- resolved viewport는 registry가 선택한 creative 하나만 마운트하며 320→728 전환은 React key로 provider를 교체한다.
- `data-ad-placement`는 `ResponsiveAdSlot` wrapper 한 곳만 소유한다. nested provider DOM은 `data-ad-owner-key`만 사용한다.
- `.stats-page` 범위에 mobile-only/tablet-up visibility와 768px breakpoint, 상단 100/90px, fluid 130px, tablet horizontal 90px 예약 token을 추가했다.
- Task 5는 foundational boundary만 제공한다. 실제 `.stats-page` root와 상단/MatchFeed placement wiring 및 live uniqueness는 Task 7/9 소유이며 이번 커밋에서 `StatSearch`에 연결하지 않았다.

### provider와 전역 script 소유권

- `shouldLoadExternalAdScripts`를 공통 pure helper로 두어 provider와 layout 모두 `NODE_ENV === "production"`일 때만 외부 광고를 초기화한다. layout module에는 임의 export를 추가하지 않았다.
- `app/layout.tsx`만 production AdSense main script `adsbygoogle-main-js` 한 개를 소유한다. `AdSenseBanner`는 main script fallback을 제거했다.
- `AdSenseBanner`는 optional `placementId`/`minHeight` 계약을 추가하고 기존 props를 보존했다. `adsbygoogle.push` 예외를 내부에서 격리하고 실패한 DOM을 정리해 다음 mount가 재시도할 수 있다.
- `AdfitBanner`의 `placementId`는 optional, width/height는 기존 `number`로 유지해 160×600 소비자와 호환된다.
- AdFit creative signature별 claimant registry는 StrictMode/duplicate render에서 live area/script 한 개만 유지한다. 현재 owner가 unmount되면 남은 claimant로 creative를 이전하고, 마지막 claimant unmount에서는 DOM/registry를 제거하며 remount가 정상 재초기화된다.
- local/test는 AdSense/AdFit 외부 script DOM을 만들지 않는다. provider 초기화 오류는 콘텐츠로 전파하지 않는다.
- Google side rail과 top anchor JSX는 만들지 않았다. 둘은 AdSense console/Auto Ads 소유다.

## 변경 파일

- `hooks/useAdViewportClass.ts` (신규)
- `lib/ads/statsAdPlacements.ts` (신규)
- `components/ads/ResponsiveAdSlot.tsx` (신규)
- `components/ads/AdSenseBanner.tsx`
- `components/ads/AdfitBanner.tsx`
- `app/layout.tsx`
- `app/globals.css`
- `tests/stats-ad-placements.test.ts` (신규)
- `tests/responsive-ad-slot.test.ts` (신규)
- `tests/ad-provider-initialization.test.ts` (신규)
- `tests/stats-auto-ads-boundary.test.ts` (신규)

## TDD 증거

### RED 1 — 기존 registry/provider 경계

```text
$ npx vitest run tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/stats-auto-ads-boundary.test.ts
Test Files  4 failed (4)
Tests       5 failed | 1 passed (6)
```

세 suite는 viewport/registry/ResponsiveAdSlot 모듈 부재로 load되지 않았다. 실제 provider suite에서는 local/test 외부 script 2개, production AdSense main script 재삽입, 동일 AdFit creative 2개, owner handoff 전 live creative 2개, provider 예외 `AggregateError` 전파를 확인했다.

### RED 2 — preflight 안전 경계 보강

registry/provider 1차 구현 후 unknown threshold, React 19 hydration, DOM identity, `adsbygoogle.push`, CSS selector를 추가해 다시 실패를 확인했다.

```text
$ npx vitest run tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/stats-auto-ads-boundary.test.ts
Test Files  3 failed | 1 passed (4)
Tests       5 failed | 38 passed (43)
```

실패는 nested `data-ad-placement` 2~3개, throwing push 미호출, CSS 규칙 부재와 StrictMode render count assertion에서 발생했다. StrictMode는 component render를 두 번 호출할 수 있으므로 마지막 항목은 provider call count 대신 live DOM 하나와 media-query subscribe/unsubscribe를 검사하도록 바로잡았다.

### GREEN — Task 5 Step 6

```text
$ npx vitest run tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/stats-auto-ads-boundary.test.ts
Test Files  4 passed (4)
Tests       43 passed (43)
Duration    2.15s

$ npx tsc --noEmit --pretty false
exit 0 (출력 없음)

$ npm run verify:core
exit 0
eslint: 0 errors, 기존 43 warnings
tsc: 0 errors

$ git diff --check
exit 0 (출력 없음)
```

초기 TypeScript 실행에서는 AdSense queue의 `never[]`, test spy `this`, ES2017 regex flag 총 6개 오류를 확인했다. queue 타입을 명시하고 spy generic `this`를 선언하며 regex를 현재 target에 맞춰 수정한 뒤 최종 TypeScript/core gate를 통과했다. Task 5 파일 대상 ESLint는 warning도 0건이다.

## 자체 검토

- registry threshold를 mobile 6/7, tablet+ 5/6/10/11/15/16, unknown 5/6/7/10/11/15/16 표로 고정해 trailing ad를 막았다.
- missing feed env 테스트는 resetModules 전 공백 env를 주입하고 registry factory는 undefined/empty/whitespace를 별도 검증해 hermetic하게 유지했다.
- hydration은 `renderToString → hydrateRoot(StrictMode)`와 React 19 `onRecoverableError` 0회, 세 media query subscribe/unsubscribe 균형, 최종 active creative 한 개를 확인했다.
- AdFit은 owner unmount handoff, last unmount 0개, remount 1개까지 확인했다. 생성 Kakao DOM id는 추가하지 않았다.
- only wrapper placement identity, AdSense adapter의 placementId/minHeight/fluid props, 320→728 key remount를 테스트했다.
- provider props 확장은 optional이고 기존 광고 consumer의 number width/height 계약을 바꾸지 않았다.
- 외부 provider 실패를 stats/controller 오류 상태와 연결하지 않았고 PUBG/AI/telemetry 코드는 수정하지 않았다.

## 운영 상태와 후속 작업

- 현재 `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`은 설정되어 있지 않다. 안전 동작은 after-10 creative/container/reservation 미노출이며 상단 unit fallback도 없다.
- 따라서 코드 경계와 로컬 테스트는 완료됐지만 광고 운영 상태는 `광고 운영 설정 대기`다. 별도 승인된 728×90 AdFit unit 생성, 환경변수 등록, 새 Preview build 실광고 확인이 필요하다.
- Task 7/9에서 `.stats-page` live root와 MatchFeed placement를 연결하기 전까지 실제 stats 페이지 광고가 통합됐다고 주장하지 않는다.
- CSS 100/90/130px 실제 예약 높이, hidden provider network 0건, Auto Ads side rail/Top-only anchor와 콘텐츠 겹침은 Task 10 browser/Preview QA 대상이다.
- 저장소 전역 기존 ESLint warning 43개는 이번 범위에서 변경하지 않았다.
