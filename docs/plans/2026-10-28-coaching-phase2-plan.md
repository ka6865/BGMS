# Coaching Reference Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 동일 선택·집계에 기반한 benchmark/CDF 후보와 독립 검증·칭호 이동 보고서를 만든다.
**Architecture:** 화면 집계를 순수 모듈로 공유하고, 같은 classifier를 외부 후보 reference로 실행한다. 수집/재계산 CLI는 읽기 전용이며 공개 결과와 비공개 원본을 분리한다.
**Tech Stack:** 기존 TypeScript·Vitest·tsx·Supabase select·R2 GET.
**Spec:** `docs/plans/2026-10-28-coaching-phase2-design.md`.

## Global Constraints

- 운영 기본 분포·점수·cache/version은 변경하지 않는다. 실제 선제 발사 지표는 제외한다.
- 원본/canonical identity·checksum·계산 버전을 확인한다. 새 의존성·migration·운영 쓰기를 추가하지 않는다.
- 생성 문서와 후보는 BGMS 저장 표본의 결과이며 전체 PUBG 모집단이라고 표현하지 않는다.

## Review Focus

- 원본/점수 누락 경기를 빼서 잘못된 best5를 만들지 않는다(Task 2).
- 계정·매치 중복과 holdout 누수가 없어야 한다(Task 2).
- 비어 있는 후보 metric/role이 구 분포나 0점으로 대체되지 않아야 한다(Task 1).
- 서로 다른 모드·경기 유형·버전은 동일 기준에 섞지 않는다(Task 2).
- CLI의 module import는 네트워크나 운영 쓰기를 시작하지 않는다(Task 2).

### Task 1: 동일 집계와 후보 역할 평가 공통화

Files: `lib/pubg-analysis/summaryAggregate.ts`(신규), `app/api/pubg/ai-summary/route.ts`, `lib/pubg-analysis/roleReference.ts`, `lib/pubg-analysis/roleClassifier.ts`, `tests/summary-aggregate.test.ts`(신규), `tests/role-classifier-rules.test.ts`.
Interfaces: `aggregateMatches(matches: any[])`; `RoleReference`의 metric/role quantile map; `classifyRole(stats, bench, tier, reference?)` 기본 인자 호환 유지.

- [x] 적격 시간의 경기별 동일 가중치·누락 처리, 비어 있는 candidate 분포 보류 테스트를 먼저 작성하고 실패 확인.
- [x] 기존 aggregate 본문을 이동하고 호출을 연결. 기존 역할 raw composite 계산을 공유하고 optional reference로 후보만 평가.
- [x] 신규·role·AI cache route·recent-selection 테스트 통과 후 커밋.

### Task 2: 읽기 전용 표본 재계산과 후보 산출

Files: `lib/pubg-analysis/referenceCalibration.ts`(신규), `scripts/calibrate_coaching_reference.ts`(신규), `tests/reference-calibration.test.ts`(신규).
Interfaces: seed·고정된 로컬 snapshot→계정 분리/완전성/quantiles/benchmark/칭호 이동 결과. CLI는 수집/로컬 재계산 단계를 구분하며 import 시 부작용 없음.

- [x] 중복·계정 단위 split·불완전 창·mixed cohort·30/50/20 표본 경계·raw 반격 fallback 금지 테스트를 RED→GREEN으로 확인.
- [x] 기존 공통 source parser·engine·selection·aggregate·classifier 재사용. 필요 원본은 기존 로컬 캐시 우선, 최대400계정·최근10경기·2 worker로 제한한다.
- [x] 학습/holdout·지표별 결측·benchmark·CDF·bootstrap 민감도를 산출한다. 원본과 계정은 로컬 비공개에 두고 익명 결과만 추적한다.
- [x] 실제 수집·재계산을 실행하고 canonical/원본 부재 사유와 budget/truncation을 결과에 포함한다. 핵심 테스트 후 커밋.

### Task 3: 보고서·독립 검토·PR

Files: `docs/operations/2026-10-28-coaching-reference-calibration.md`와 비식별 후보 JSON.

- [x] 후보별 유효 표본과 칭호 이동, holdout·민감도 결과를 보고한다. 부족하면 부족하다고 명시하며 활성화하지 않는다.
- [x] verify:core·verify:analysis·test:unit 실행. 제품 UI 변경이 없으면 모바일 재검증을 생략한 근거를 보고한다.
- [ ] 독립 코드 검토 후 필요한 수정·검증을 완료한다. #378 기반 별도 PR로 올리고 운영에는 반영하지 않는다.
