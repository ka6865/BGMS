---
name: bgms-frontend-qa
description: Use when changing visible BGMS UI in stats, maps, admin, boards, support or shared layouts, including responsive behavior, request states, Tailwind v4 styling and browser regression checks.
---

# BGMS Frontend QA Skill

## 언제 사용하나

- `components/stat/*`, `components/map/*`, `components/admin/*`, `components/support/*`, 게시판 및 `app/**/page.tsx` UI 수정
- 모바일 접힘, 카드 레이아웃, 관리자 화면, 전적 분석 화면 수정
- 텍스트 겹침, 버튼 상태, 로딩/에러 상태, 반응형 QA 필요
- 화면에 보이는 기능 구현, 업데이트, 문구/카드/탭/버튼 변경이 있으면 모바일 영향이 작아 보여도 사용한다.

## 디자인 원칙

- 실제 기능 화면을 우선한다. 불필요한 랜딩/홍보형 섹션을 만들지 않는다.
- 운영/관리자 화면은 조용하고 정보 밀도 있게 구성한다.
- 카드 안에 카드를 중첩하지 않는다.
- 버튼/툴은 가능한 아이콘과 명확한 레이블을 사용한다.
- 모바일에서 긴 텍스트가 버튼/카드 밖으로 넘치지 않게 한다.

## QA 체크

- 모바일 사용자를 기본 사용자로 보고, UI 변경 최종 보고에는 모바일 확인 결과 또는 미실행 사유를 반드시 포함한다.
- 최소 모바일 뷰포트는 `AGENTS.md`의 기준(`375x667`, `390x844`, `430x932`, 데스크톱)을 따른다.
- 공통 컴포넌트, 전역 CSS, 네비게이션, 카드/버튼/탭/필터 변경은 모바일 확인을 생략하지 않는다.
- 데스크톱과 모바일에서 주요 텍스트가 겹치지 않는지 확인한다.
- 모바일 기본 접힘 상태가 요구사항과 맞는지 확인한다.
- 버튼/탭/필터의 터치 영역, 줄바꿈, 하단 내비게이션 간섭을 확인한다.
- 로딩, 빈 상태, 에러 상태가 깨지지 않는지 확인한다.
- 관리자 위험 버튼은 충분한 설명과 확인 절차가 있는지 확인한다.
- 검색 계정·플랫폼·시즌 전환, 늦게 도착한 응답, 재시도와 저장 실패 안내가 현재 화면의 대상과 맞는지 확인한다.

## 도구 선택 기준

- 로컬 UI, 모바일 반응형, 텍스트 겹침, 카드/버튼/탭 검증은 격리된 브라우저(Codex는 Browser/in-app Browser, Claude는 Playwright MCP 또는 `agent-browser` CLI)를 우선 사용한다.
- 실제 사용자 Chrome 프로필, 로그인 쿠키, 확장 프로그램, 기존 탭 상태가 필요한 경우에만 개인 Chrome(claude-in-chrome 등)을 사용한다. 관리자·로그인 화면은 개인 세션에 붙지 않고 별도 프로필을 쓴다.
- 연결이 불안정하면 로컬 서버 상태와 dev server 첫 컴파일을 확인하고 다른 브라우저 도구로 대체 검증할 수 있다.
- Computer Use는 브라우저가 아닌 Mac 앱 조작이나 화면 기반 클릭/입력이 필요한 경우에 사용한다.

## 모바일 디버깅 범위

- 가능한 범위: 모바일 뷰포트 렌더링, 반응형 breakpoint, 터치 대상 크기, 텍스트/카드 넘침, 하단 내비게이션 간섭, 로딩/빈/에러 상태, 기본 접힘 상태.
- 제한 범위: iOS Safari 고유 버그, Android WebView, Capacitor 네이티브 런타임, 실제 기기 권한/푸시/키보드/주소창 변화는 실기기 또는 에뮬레이터 확인이 필요할 수 있다.

## 로컬 UI QA 실패 복구 루틴

- `npm`, `node`, `npx`가 안 보이면 `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`로 일반 Node/npm을 우선 사용한다.
- `lsof -nP -iTCP:3000 -sTCP:LISTEN`으로 기존 dev server를 확인한다. 서버가 있으면 새로 띄우지 않는다.
- `localhost`가 막히면 `http://127.0.0.1:3000`으로 확인한다.
- `.next/dev/lock`은 실제 서버 존재 여부를 확인하기 전 임의 삭제하지 않는다.
- 격리 브라우저 도구가 있으면 우선 사용하고, 없을 때만 Puppeteer/Chrome 우회를 고려한다.
- Puppeteer 검증은 모바일/데스크톱 결과를 각각 기록하고, `data-testid`나 안정적 selector를 우선 사용한다. 기존 하네스가 두 환경을 검증하면 재사용한다.
- 자동화 실패, 서버 접근 실패, selector 실패, 실제 UI 깨짐을 분리해서 최종 보고한다.

## 스쿼드 원인 장면 UI QA 시 우선 읽을 파일

- `components/stat/SquadCauseScenes.tsx`
- `components/stat/SquadAnalysisPanel.tsx`
- `components/stat/StatSearch.tsx`
- `tests/squad-cause-scenes.test.ts`
- `tests/squad-recovery-stats.test.ts`

스쿼드 원인 장면 모바일 QA에서는 실제 컴포넌트명을 먼저 제시한다. 최소 확인 뷰포트는 `375x667`, `390x844`, `430x932`, `768x1024`, `1280x720`으로 잡고, 모바일 최초 접힘 상태와 `sm` 이상 기본 펼침 상태를 분리한다.

## 추천 검증

```bash
npm run verify:core
```

변경한 UI의 실제 컴포넌트·상태 테스트를 추가로 선택한다. 전적은 `tests/stats-page-shell.test.ts`, `tests/stats-page-controller.test.ts`, `tests/stats-layout-boundary.test.ts`, `tests/stats-sync-failure-ui.test.ts`, 관리자는 `tests/admin-user-command-center-ui.test.ts`, `tests/community-agent-panel.test.ts`, `tests/ai-coaching-review-ui.test.ts`, 지원센터는 `tests/support-center-ui.test.ts`, `tests/support-admin-ui.test.ts`를 확인한다. 정적 검사와 jsdom 테스트만으로 브라우저 레이아웃이 검증됐다고 보고하지 않는다.

## 전적 화면 브라우저 하네스

- `tests/stats-browser-smoke.test.ts`, `tests/helpers/statsBrowserHarness.ts`, `tests/fixtures/stats/browserScenarios.ts`의 기존 fixture·요청 원장을 재사용한다. 요청 중복, 이전 검색 응답 경합, 404/429/500 재시도, 저장 실패 안내, AI 요청 경계와 레이아웃을 검사할 수 있다.
- 브라우저 테스트는 `RUN_STATS_BROWSER_SMOKE=true`가 없으면 skip된다. 일반 `test:unit` 통과를 브라우저 검증 통과로 보고하지 않는다.
- 기존 로컬 서버를 재사용할 때 실제 주소를 `STATS_BASE_URL`로 제공한다. 기본 포트를 사용하는 예시는 다음과 같다.

```bash
RUN_STATS_BROWSER_SMOKE=true STATS_BASE_URL=http://127.0.0.1:3000 npx vitest run tests/stats-browser-smoke.test.ts
```

- `STATS_BASE_URL`이 없으면 하네스가 빈 포트에 자체 dev server를 생성한다. 기존 `.next/dev/lock`이 있으면 중단하므로 lock을 삭제하지 않고 기존 서버 주소를 사용한다. 자신이 생성한 서버만 종료한다.
- 기존 테스트의 기능·레이아웃·스크린샷 뷰포트는 목적별로 다르다. 실제 실행된 뷰포트, 요청 검증 결과, 화면 증거를 기록하고 빠진 모바일 크기는 추가 확인한다. 스크린샷 저장만으로 기능 검증을 대신하지 않는다.
- 외부 서비스·회원 데이터 쓰기·실제 OAuth·네이티브 모바일 검증은 fixture 브라우저 확인과 구분한다.

## 수동 확인 후보

- `/stats`
- `/stats/steam/{nickname}`
- `/stats/battle`
- `/maps/erangel`
- `/admin/dashboard`
- `/admin/bot`
- `/admin/ai-coaching`
- `/admin/support`
- `/board`
- `/support`
