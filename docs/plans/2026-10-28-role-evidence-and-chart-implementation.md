# 칭호 근거와 점수 표시 개선 구현 계획

> **For agentic workers:** superpowers:executing-plans 또는 superpowers:subagent-driven-development로 작업한다.

**Goal:** 개인 근거를 정확히 수집하고 검증된 분포에서만 새 칭호를 확정하며 삼각형의 배점 오류를 고친다.

**Architecture:** 기존 점수와 기본 역할 CDF를 유지하고 버전이 있는 칭호 관측 근거를 추가한다. 후보 reference가 새 근거 버전을 명시한 경우만 새 칭호 규칙을 사용한다. 기존 explicit reference 인자를 재사용하며 운영 활성화용 설정이나 DB 쓰기를 추가하지 않는다. 구현은 별도 하위 `ka6865/role-evidence-chart-improvements`에서 수행한다.

**Tech Stack:** 기존 TypeScript/Next.js/React/Vitest, Node24.

**Spec:** docs/plans/2026-10-28-role-evidence-and-chart-preparation.md

## Global Constraints

- bgms.kr 배포·main 병합·운영 DB/R2 쓰기·기존 캐시 삭제는 수행하지 않는다.
- 기존 점수 배점·legacy 관측값·계산5 결과·기본 CDF1을 보존한다. 새 개인 관측은 자체 evidenceVersion 1로 구분한다.
- 새 지표에 기존 분포를 적용하지 않는다. 새 분포는 evidenceVersion 1인 완전한 입력만 사용하며 미충족 조건은 보류한다.
- 최근 유효10→상위5 selector/retention을 재사용한다. 지정 계정은 학습 제외한다.
- 새 dependency, API 키 변경, README 변경 없음.

## Review Focus

- 구형 결과에 새 개인 관측이 없는 경우 추측 없이 보류한다.
- 관측된0·무기회·결측을 구분한다.
- legacy default classifier/점수는 새 후보 구현 때문에 달라지지 않는다.
- 솔로/팀 배점과 실제 tierMatchCount를 사용하고 구형 scope 미상 응답은 도형을 보류한다.
- 후보분포에 맞는 데이터 정의·모드/유형·계정 분리가 일치한다.

## Task 1: 개인 관측 근거

Files: lib/pubg-analysis/types.ts, AnalysisEngine.ts, handlers/CombatHandler.ts, handlers/ZoneHandler.ts, tests/calculation5-engine.test.ts

- [x] 본인 없는 협공·피해0·기절 대상·구조 중복·무관측의 회귀 테스트를 먼저 추가하고 실패 확인.
- [x] 기존 장부/거리 필드를 재사용해 엔진 결과에 roleEvidence.version=1 근거를 추가. 협공은 본인과 팀원 유효 무기 피해가 기존1초창에 함께 있는 개인 타격 수. legacy count와 pressure는 보존.
- [x] 유효 양의 서 있는 적 무기 피해·거리 관측 수, 관측 가능한 압박/위치 샘플, 구조 사건 성공/기회 정보를 포함.
- [x] 해당 테스트와 기존 엔진/개인귀속 테스트 통과 확인.

## Task 2: 삼각형

Files: components/stat/SpiderChart.tsx, tests/stat-components.test.ts; caller integration은 Task4.

- [x] 팀40/35/25·솔로50/15/35가 각각100% 좌표, 팀32/40=80%, missing scope/axis는 완성 도형 없음 테스트 실패 확인.
- [x] optional tierScope와실제경기수 props를 사용하고 원점수/만점 표시. 별도 자동 칭호 제거.
- [x] 테스트 통과; 기존 값 과대 fixture도 실제 배점 fixture로 변경.

## Task 3: 집계/역할 후보와 보정

Files: summaryAggregate.ts, roleClassifier.ts, roleReference.ts, referenceCalibration.ts 및 각 tests.

- [x] 새 근거 버전만 별도 집계, 분자/분모 동등 관측, 두 근거 필수·무관측·85반올림·지휘관 조건의 테스트 실패 확인.
- [x] 새 reference.evidenceVersion=1인 경우만 새 집계/판정 사용. 상태/사유/근거를 RoleInfo에 추가. 기존 default 경로 회귀 보존.
- [x] 균형형의 근거 범위와 점수 치우침, 대표/보조 역할의 경계를 개발 진단에서 결정하고 ledger에 기록. 근거 부족·기준 부재·경계 상태 구분.
- [x] 새 분포 학습은 버전 관측이 있는 프로필만 허용; legacy/new 혼합 금지. reference/bootstrap와 경기 하나 제외→재선정 검증 추가.
- [x] 원본 가용량을 확인하고 가능한 로컬 재생을 수행; 부족한 cohort는 후보 보류. 기존 확인을 새 독립 검증이라고 주장하지 않음.

## Task 4: 연결/호환/화면

Files: RecentAISummary.tsx, ai-summary route, constants.ts, bridge/cache/browser fixture tests.

- [x] graph에 tierScope와tierMatchCount 전달. role 상태/근거 정규화·상단/상세 문구 일치. default CDF와 계산 점수·캐시 유지 검증.
- [x] 기존 fixture 하네스로375x667·390x844·430x932·desktop 상태 확인. 실제 Gemini/DB 호출 안 함.
- [x] verify:core, verify:analysis, test:unit 실행. 새 변경 후만 추가 재검사.

## Task 5: 근거/리뷰

- [x] 원본 가용량, 재생 가능/불가, 역할 후보 이동·보류, 화면 근거를 운영 보고서에 기록.
- [x] 독립 변경 리뷰 후 지적 수정/재검증. 검토용 draft PR로 정리하고 배포/병합은 수행하지 않는다.
