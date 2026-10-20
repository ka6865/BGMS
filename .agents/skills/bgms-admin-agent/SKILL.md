---
name: bgms-admin-agent
description: Use when working on BGMS Admin Agent tools, monitoring, approvals, analytics, user metrics, community assistant runs and review queues, or administrator operations UI.
---

# BGMS Admin Agent Skill

## 언제 사용하나

- `lib/admin-agent/*`, `app/api/admin/agent/*`, `app/admin/bot/*`, `app/admin/dashboard/*` 수정
- 운영 브리핑, 승인 큐, monitor, data-quality, user metrics, traffic summary 수정
- 관리자 페이지 시스템/유저관리/캐시 관제 고도화
- `lib/community-agent/*`, 커뮤니티 비서 실행·검토 큐·예약 worker 수정

## 핵심 해석 규칙

- 전적 검색 대상 닉네임과 로그인 활동 회원을 분리한다.
- `/stats/{platform}/{nickname}` 조회수는 해당 닉네임 계정의 활동으로 단정하지 않는다.
- analytics `user_id`가 0명이어도 Auth/profile 활동과 분리해 설명한다.
- 로컬/개발 이벤트는 `source_host`, `client_environment`, `is_internal` 기준으로 별도 취급한다.

## 유저 활동/조회수 오해 점검 시 우선 읽을 파일

- `lib/admin-agent/user-metrics.ts`
- `lib/admin-agent/tools.ts`
- `lib/admin-agent/traffic-summary.ts`
- `tests/admin-agent-user-metrics.test.ts`
- `tests/analytics-event.test.ts`
- `app/api/analytics/event/route.ts`
- `lib/analytics.ts`

조회수 오해 점검 요청에서는 `lib/admin-agent/*`, `app/api/admin/agent/*`처럼 넓은 범위를 먼저 잡지 말고 위 파일을 우선 확인한 뒤 필요한 호출부로 확장한다.

## 안전 등급

- `lib/admin-agent/tool-catalog.ts`와 `tools.ts`의 실제 `safetyLevel`을 기준으로 `read`, `write`, `dangerous`를 구분한다. Admin Agent 도구의 `dangerous` 작업은 승인 경로로 실행한다.
- 조회 도구도 외부 호출, 비용, 운영 기록 쓰기가 있는지 확인한다. 이미 허가한 진단 범위는 추가 확인 없이 진행한다.
- 승인 API는 관리자 권한과 `pending` 상태를 확인하고 impact를 재계산한다. `executionGate=block`이면 실행하지 않는다.
- `confirmedImpact=true`는 승인 route의 `HIGH_RISK_APPROVAL_ACTIONS` 대상에 필요하다. 모든 action에 같은 확인·재검증 절차가 있다고 일반화하지 않는다.
- identity repair 등 대상 재검증이 필요한 action은 해당 executor의 현재 조건을 확인한다. 코드·문서 수정 허가를 운영 실행 허가로 해석하지 않는다.

승인 계약 변경 시 `lib/admin-agent/impact.ts`, `lib/admin-agent/approval-execution.ts`, `app/api/admin/agent/approvals/[id]/approve/route.ts`, `tests/admin-agent-api.test.ts`를 함께 확인한다.

## 커뮤니티 비서 작업

- 우선 `docs/community-agent-operations.md`, `lib/community-agent/service.ts`, `lib/community-agent/reviews.ts`, `lib/community-agent/auth.ts`를 읽고 관련 route와 workflow로 확장한다.
- 수집·초안 생성·보존 정리는 예약 실행될 수 있다. 글·답글 발행은 항목별 관리자 검토를 거친다. `publishing_enabled=true`는 허용하지 않으며 기존 직접 발행 action은 `approval_required`를 반환한다.
- 관리자 세션과 worker 권한을 구분한다. worker는 검토 API의 `process`만 실행할 수 있고 게시 승인·거절·검토 알림 결정 권한을 갖지 않는다. run의 retry/dry-run 권한도 해당 route에서 확인한다.
- `COMMUNITY_AGENT_SCHEDULE_ENABLED`와 앱 정책의 실행 가능 상태를 함께 확인한다. cleanup-only는 수집·모델 호출·게시를 수행하지 않는다. workflow 정지 또는 서버 접속 실패 시 정리도 실행되지 않을 수 있다.
- 실제 수집·AI 호출·Discord 알림·게시와 로컬 fixture 검증을 구분한다. 운영 문서의 날짜별 과거 기록을 현재 정책으로 사용하지 않는다.

## 작업 루프

1. 도구 계약을 변경하는 경우 declaration, 안전 등급과 executor를 함께 확인한다.
2. 결과 JSON은 실제 소비자의 계약을 따른다. `traffic-summary`와 `user-metrics`처럼 `readable`을 사용하는 결과는 해당 요약을 유지한다.
3. recommendation 문구는 단정하지 않고 데이터 출처를 함께 말한다.
4. approval이 필요한 작업이면 `impact.ts`, `approval-execution.ts`, tests를 함께 맞춘다.

## 추천 검증

```bash
npm run verify:admin
npm run verify:core
```

변경별 추가 검증:
- 커뮤니티 비서: `npm run verify:community`
- 커뮤니티 persistence/retry SQL: `bash scripts/verify_community_agent_migration.sh`
- 항목별 검토·발행 SQL: `bash scripts/verify_community_reviews.sh`
- AI 관측·회원 타임라인·command center: 관련 `tests/admin-agent-api-error-summary.test.ts`, `tests/admin-agent-match-collection-progress.test.ts`, `tests/admin-user-command-center-ui.test.ts`, `tests/admin-membership-timeline.test.ts`

두 커뮤니티 SQL 스크립트는 일회용 PostgreSQL 검증이며 Docker/psql 전제를 확인한다. `verify:admin`은 커뮤니티와 위 추가 테스트 전체를 포함하지 않는다. 변경 파일에 맞는 집중 테스트를 실행하고 넓은 영향은 `npm run test:unit`으로 확인한다.
