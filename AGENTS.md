<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# BGMS 공통 작업 지침

## 작업 기준

- 설명, 계획, 리뷰, 최종 보고는 한국어로 작성한다. 코드 식별자, API 필드, 환경 변수와 파일명은 기존 표기를 유지한다.
- 현재 코드, `package.json`, 실제 검증 결과를 기준으로 판단한다. 과거 운영 기록을 현재 상태로 단정하지 않는다.
- 작업 시작 시 `git status --short`로 기존 변경을 확인하고 보존한다. 관련 없는 파일 수정과 미추적 파일의 일괄 추가를 피한다.
- 검토·방향성만 요청한 경우에는 조사와 제안을 수행한다. 구현·적용까지 요청했거나 이미 승인한 범위는 추가 확인 없이 진행한다.
- 코드 변경은 기존 구조와 스타일을 따르고, 관련 호출부·타입·저장 계약을 함께 확인한다.

## 프로젝트 문서와 스킬

로컬에 `.agents/rules/project_rules.md`가 있으면 보조 지침으로 읽는다. 다음 BGMS 스킬은 요청과 관련된 것만 `.agents/skills/<name>/SKILL.md`에서 읽는다.

| 작업 | 스킬 |
| --- | --- |
| 전적·텔레메트리·AI 코칭·점수·benchmark | `bgms-pubg-analysis` |
| Admin Agent·analytics·승인·커뮤니티 비서 | `bgms-admin-agent` |
| Supabase·migration·RLS·DB/R2 관제·정리·백업 | `bgms-supabase-ops` |
| 화면·공통 컴포넌트·반응형·브라우저 QA | `bgms-frontend-qa` |

관련 작업에서만 다음 문서를 확인한다.

- 전체 흐름과 운영 맥락: `docs-private/.project_context.md`
- 텔레메트리 해석: `docs-private/.pubg-telemetry-guide.md`, `docs-private/telemetry_data_classification.md`
- 개발용 점수 규칙: `docs-private/tier_score_rules.md`
- 사용자용 점수 설명: `docs/tactical_score_guide.md`
- 커뮤니티 비서 운영: `docs/community-agent-operations.md`
- 수집·랭킹·조우·운영 변경: 관련 `docs/operations/` 문서

`.agents/`, `.agents-drafts/`, `docs-private/`는 현재 Git 제외 대상이다. 이 파일들이 없는 작업 폴더에서는 실제 구현, `package.json`, 저장소에 포함된 `docs/`와 테스트를 사용하고 누락된 로컬 지침을 보고한다. `.agents-drafts/`는 초안이며 실사용 스킬을 대체하지 않는다. 공유할 공통 규칙은 이 파일에 유지한다.

## 검증

변경 범위에 맞는 검증을 실행하고 결과와 미실행 사유를 보고한다. 문서만 변경한 경우에는 경로·명령·스킬 형식·문서 간 일관성을 확인한다.

| 변경 범위 | 기본 검증 |
| --- | --- |
| 코드 공통 | `npm run verify:core` |
| 전적 분석·텔레메트리·AI 캐시 | `npm run verify:analysis`와 변경별 추가 테스트 |
| 관리자·analytics·보안 | `npm run verify:admin`와 변경별 추가 테스트 |
| 커뮤니티 비서 | `npm run verify:community` |
| 무기 패치 | `npm run verify:weapon-patch` |
| Overwolf 세션 | `npm run verify:overwolf` |
| 넓은 코드 영향·통합 전 단위 검증 | `npm run test:unit` |
| migration/RPC | `npm run verify:migrations` 및 해당 도메인의 DB 검증 |

`verify:analysis`와 `verify:admin`은 명시된 일부 테스트만 실행한다. `npm test`는 Jest의 `__tests__/` 검사이며 Vitest의 `tests/` 검사를 대체하지 않는다. 브라우저·실제 Gemini·실제 DB 연결 검증은 각 스킬의 실행 조건을 먼저 확인한다.

UI 변경은 최소 `375x667`, `390x844`, `430x932`와 데스크톱에서 확인하고 모바일 결과 또는 미실행 사유를 최종 보고에 포함한다. 전적 화면 브라우저 검증은 `bgms-frontend-qa`의 기존 fixture 하네스를 사용한다. 뷰포트 검증과 실제 모바일 앱·실기기 검증의 범위를 구분한다.

## 운영과 문서 갱신

- Supabase service role과 비밀 값은 서버와 운영 스크립트에서만 사용하며 클라이언트·문서·로그에 노출하지 않는다.
- DB·스토리지 명령의 대상 환경과 읽기·쓰기·삭제 범위를 먼저 확인한다. 로컬 격리 검증과 운영 적용을 구분한다.
- 운영 삭제·복구는 dry-run 대상과 영향, 현재 대상 재검증, 해당 실행 경로의 승인 조건을 확인한다. Admin Agent의 권한·승인 gate를 우회하지 않는다.
- 사용자에게 이미 받은 허가와 애플리케이션의 항목별 승인 절차를 구분한다. 코드·문서 수정에 운영 실행 허가를 확대 해석하지 않는다.
- `git reset --hard`, 기존 변경 폐기, 대량 삭제, Git 이력 파괴는 명시적인 요청 없이 실행하지 않는다.
- 계산식·캐시 키·운영 계약이 바뀌면 관련 문서를 갱신한다. 텔레메트리 필드 해석은 실제 의미가 바뀐 경우에 갱신하고 개발용·사용자용 점수 문서를 구분한다.
- README는 별도 요청 없이는 수정하지 않는다. 최종 보고에는 변경점, 검증, 남은 미확인 사항을 짧게 적는다.
