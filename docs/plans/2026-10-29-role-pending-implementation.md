# 보류 사유·관측 성향·신규 칭호 검증 구현 계획

> **For agentic workers:** superpowers:executing-plans / superpowers:subagent-driven-development. 아래 작업을 추적하고 각 변경의 실패→통과를 확인한다.

**Goal:** 대표 칭호 미확정에도 근거 있는 관측 성향을 표시하고, 역할별 판정 기회와 실제 경기 구성 변화의 안정성을 검증한다.

**Architecture:** 개별 엔진 근거 version1과 기존 집계/판정 version1은 보존한다. 새로운 집계·자격 정책만 명시적 reference.evidenceVersion2로 분리한다. 같은 원본 관측에서 새 정책의 CDF를 다시 학습하며 기본 서비스 경로는 유지한다.

**Tech Stack:** 기존 TypeScript/React/Next.js/Vitest, Node24. 새 dependency 없음.

**Spec:** docs/plans/2026-10-29-role-pending-improvement.md

## Global Constraints

- bgms.kr 배포·main 병합·운영 DB/R2 쓰기·키 변경·기존 캐시 삭제 없음.
- 기존 계산5·점수·기본CDF1·reference.evidenceVersion1 및 기존 API 기본 응답 보존.
- 85 역할 문턱,80% 안정성,학습50/holdout20 가드를 낮추지 않음. 새 의미에는 새 CDF만 사용.
- 지정 계정 학습 제외. 기존 개발308명은 독립 최종 검증이 아님을 유지.
- 관측 성향은 raw 수치로 설명하고 실력·의도·상위권을 추론하지 않음. null/무기회/관측0 구분.

## Review Focus

- 총기 적중이 없지만 구조/투척 근거가 충분한 사용자는 관련 역할로 평가한다.
- 팀원 없는 한 경기가 다른 정상 팀 경기의 전체 지표를0/100으로 왜곡하지 않는다.
- 새 정책이 version1/운영 기본값에 자동 적용되거나 기존 분포와 혼합되지 않는다.
- 실제 선정 구성이 안 바뀌는 변형으로 안정성을 부풀리지 않는다.
- 성향/복합 관측을 UI와 AI가 확정 칭호로 부르지 않는다.

## Task 1 — 역할별 관측 집계 (분리 작업)

Files: summaryAggregate.ts, tests/summary-aggregate.test.ts

- [x] aggregateMatches(matches, {roleEvidenceVersion:2})만 새 집계를 반환. 기본 집계 수치 불변.
- [x] raw roleEvidence.version1 전 경기 검증을 재사용하고 집계 envelope version2 생성.
- [x] team 객체는 실제 roster>1 경기의 유효 관측만 별도 집계. 지표별 분자/분모·관측 경기 수를 유지한다.
- [x] 팀 경기/기회 없음, 일부 null,실제0,구조 중복,혼합 버전·malformed 자료를 회귀 검증.

## Task 2 — 후보 판정·성향·복합 설명 (주 작업)

Files: roleClassifier.ts, roleReference.ts, referenceCalibration.ts, 각 tests; 필요한 작은 공통 관측 요약 helper.

- [x] reference.evidenceVersion2 옵션에만 새 추출/자격 조건. 공통 총기6회 대신 역할별 기존 기회 조건 사용. 구조 opp>=3,교전 win/loss>=3,역전>=2,거리피해>=300 등.
- [x] 투척 후보는 적격 투척3회와 연결된 적중1회 이상으로 보수적 후보 정의를 사전 고정한다. 충분하지 않으면 사용 사실만 표시.
- [x] 완전한 입력 version2와 최소3경기는 유지. 지표에 대응하는 행동이 전혀 없으면 근거 수집 중.
- [x] presentation?:role|observed|combined|insufficient, observedRoles?:RoleKey[]를 기존 RoleInfo에 선택적으로 추가. 확정 칭호 status와 성향 표시를 구분.
- [x] 보류 시 거리 과반 기준의 관측 성향 또는 구조/투척 사실을 raw 수치·실제 경기 수로 설명. 85 미달을 새 확정 칭호로 바꾸지 않음.
- [x] 같은 cohort 내에서 선정. version2 경기 창의 안정성은 실제 best5 구성이 바뀌는 변형으로 계산하고 유효 변형3회 이상을 요구.
- [x] 두 역할 모두85이상이고 실제 변형80% 이상에서 그 역할 집합 안에 남으면 복합 관측으로 설명. status는pending 유지,새 칭호 확정 아님.
- [x] 새 version2 CDF 재산출/기존 version1 통제 비교. 기본 계산 점수·기본 분류·이전보정 CLI 보존.

## Task 3 — UI·AI 전달 문구 (분리 작업)

Files: RecentAISummary.tsx, ai-summary route, bridge/fixture browser tests.

- [x] presentation/observedRoles 정규화. 상단/상세의 성향·복합·근거 수집 상태 일치.
- [x] role=확정 칭호, observed/combined=관측된플레이성향. AI에 미확정 성향을 “부여된 칭호”로 넘기지 않음. legacyundefined 경로 원문 보존.
- [x] fixture 375x667/390x844/430x932/desktop에서 긴 복합명·수치·보류 사유 검증. 실제 외부 호출 없음.

## Task 4 — 새 칭호 가능성 검증 (분리 조사)

- [x] 빠진 거리대50m이상200m미만의 중거리 교전가 후보를 기존308명에서 평가한다.
- [x] 별도 midShare CDF와 역할 CDF,50/20 표본 가드,85문턱·자기 피해 과반 및80% 실제 변형 안정성을 사전 고정한다.
- [x] 기존 역할/기존 확정 사용자와의 중복,보류에서 새로 포착하는 수,계정별 경기 의존성을 함께 보고한다.
- [x] 효과가 검증되지 않거나 독립 검증이 없으면 운영/기본 역할에 추가하지 않고 근거 있는 후보만 남긴다.

## Task 5 — 재검증·리뷰·PR

- [x] 보관된 로컬 분석을 version2로 재집계·학습,같은 계정/분리 기준으로 비교. 313중 이전 gun6조건 탈락5는 가능한 원본에서 별도 확인.
- [x] 확정 수,복합/단일 관측 설명 수,진짜 자료 부족,미설명 보류를 따로 집계. “보류 감소=정답률 상승”으로 쓰지 않음.
- [x] verify:core,verify:analysis,test:unit와 해당 fixture/browser 검사. 독립 코드 리뷰 후 지적 수정.
- [x] 기존 draft PR #380에 결과·제한·재현 근거 갱신. 배포/병합 없음.

## 실행 결과와 남은 조건

- 구현·로컬 비교·회귀·PR 갱신 범위이며 운영 활성화는 하지 않는다. 결과는 `docs/operations/2026-10-29-role-pending-validation.md`와 JSON에 기록한다.
- 기존 308명은 새 독립 검증이 아니다. 원본 재생으로 기존 탈락 5명도 확인해 v2에서는 1명이 교전 결과 관측으로 포함되고 4명은 역할 기회 부재로 제외됐다.
- 새 중거리 역할은 개발 진단만 수행했다. 별도 독립 확인과 새 역할 분포의 재표집 검증은 남았으므로 정식 역할/운영에는 추가하지 않았다.
- 전체 단위 검사에는 로컬 디스크 여유량을 실제로 검사하는 기존 source-acquisition 테스트의 환경 실패가 남는다. 이 검사를 우회하거나 운영 수집 가드를 낮추지 않는다.
