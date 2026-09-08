# Task 7: 관리자 운영 패널

## 변경

- `/admin/bot`에 기존 관리자 대화와 커뮤니티 운영을 전환하는 접근 가능한 탭을 추가했다. 기존 인증, feedback query 처리, `AdminAgentChat` callback은 그대로 유지한다.
- `CommunityAgentPanel`은 Task 5의 community 상태/설정/run API만 호출한다. 운영 상태, 오늘 발행·보류, 최근 7일 발행·오류·기록된 토큰, 세 출처의 상태·필터 전후 수치·링크, 저장 초안, 다음 09:00 KST 예약 기준을 표시한다.
- 설정 실패는 낙관적으로 바뀐 토글을 이전 상태로 되돌리고 오류를 남긴다. 관리자 시험 실행은 dry-run start와 필요한 단계만 수행하며, terminal/in-progress 상태에서 멈추고 publish API를 호출하지 않는다.
- 저장 초안은 React text node로만 표시하며 HTML을 주입하지 않는다.
- automation contract에 커뮤니티 정책 범위 자동 발행을 별도 계약으로 추가했다. 정책 입력이 없을 때 active로 표시하지 않으며, 일반 관리자 도구의 승인 정책과 구분한다.

## 검증

`PATH=/opt/homebrew/bin:/usr/local/bin:$PATH npx vitest run tests/community-agent-panel.test.ts tests/community-agent-automation-contracts.test.ts tests/community-agent-api.test.ts`

- PASS: 3 files, 25 tests. 조회 503 오류, 정책 롤백, 정확한 출처 링크와 한국어 상태, terminal dry-run의 no-step/no-publish, trial 오류 유지, automation contract 상태, 기존 community API를 포함한다.

`PATH=/opt/homebrew/bin:/usr/local/bin:$PATH npx tsc --noEmit --pretty false`

- PASS.

`PATH=/opt/homebrew/bin:/usr/local/bin:$PATH npx eslint components/admin/CommunityAgentPanel.tsx app/admin/bot/page.tsx lib/admin-agent/automation-contracts.ts tests/community-agent-panel.test.ts tests/community-agent-automation-contracts.test.ts`

- PASS.

`git diff --check`

- PASS.

## 브라우저 QA

격리된 Vite harness (`127.0.0.1:4176`)에서 실제 `app/admin/bot/page.tsx`와 `CommunityAgentPanel`을 렌더링했다. auth/router/chat과 community API만 local fixture로 대역했으며, 프로덕션 인증·DB·제공자·외부 발행 호출은 하지 않았다.

- Desktop `1280x800`, mobile `375x667`, `390x844`, `430x932`: 문서 overflow와 버튼/링크/본문 clipping 없음. 1280과 390은 시각 검토도 완료했다.
- chat ↔ panel 탭 전환, 계정 준비 → 수집 재개 → 6단계 dry-run → 발행 준비됨, draft question, pause/resume, 구성 POST 503 롤백, 상태 GET 503와 retry recovery를 확인했다.
- dry-run에서 publish action은 0회였다. 세 외부 출처 링크는 URL만 검증했고 외부로 이동하지 않았다.
- 증거: `ui-1280.png`, `ui-375.png`, `ui-390.png`, `ui-430.png`, `ui-error-390.png`, 상세 기록 `task7-browser-qa.md`.

## 범위와 주의점

브라우저 결과는 mock auth/API harness의 UI 계약 검증이다. 실제 Next route, DB/RLS, 환경변수, 외부 제공자, 배포와 실제 모바일 Safari는 이 Task에서 실행하지 않았다.
