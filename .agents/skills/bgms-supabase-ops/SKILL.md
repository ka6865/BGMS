---
name: bgms-supabase-ops
description: Use when working on BGMS Supabase schema, migrations, RLS, Auth, database or R2 capacity, cleanup, backups, data repair, and restore verification.
---

# BGMS Supabase Ops Skill

## 언제 사용하나

- Supabase migration, SQL, RLS, Auth, service role 사용
- DB/R2 용량과 비용 기준, cleanup, audit, 백업·복구 작업
- `analytics_events`, `agent_*`, AI 캐시, PUBG 분석 캐시 테이블 수정
- 운영 데이터 삭제, repair, approval 흐름 작업

## 먼저 확인할 것

- 프로젝트 계약은 helper와 실제 SQL을 먼저 확인한다. Supabase API·권한·요금제처럼 변동 가능한 사실은 최신 공식 문서 또는 MCP docs로 확인한다.
- 단순 계획 요청이면 프로젝트 파일로 범위를 좁히고 운영 DB·스토리지 호출을 자동으로 실행하지 않는다.
- 명령이 연결하는 환경과 읽기·쓰기·삭제 여부를 확인한다. SQL 재적용 여부는 migration 이력과 기존 정의로 판단하며 `IF NOT EXISTS`만으로 정의가 일치한다고 가정하지 않는다.
- 삭제성 작업은 dry-run 결과, 대상 샘플, impact를 먼저 제공한다.

## DB/R2 용량 점검 시 우선 읽을 파일

- `lib/admin-agent/storage-health.ts`
- `lib/admin-agent/storage-limits.ts`
- `lib/pubg-analysis/r2Service.ts`
- `scripts/monitor_storage.ts`
- `app/api/admin/dashboard/route.ts`
- `lib/admin-agent/tools.ts`
- `app/api/admin/agent/monitor/route.ts`
- `components/admin/GameDataEditor.tsx`
- `docs-private/.project_context.md` (로컬에 있는 경우)
- `tests/admin-agent-api.test.ts`
- `tests/admin-agent-data-quality.test.ts`
- `tests/storage-health-sizes.test.ts`

용량 점검 계획 요청에서는 삭제·cleanup·대량 list를 실행하지 않는다. `scripts/monitor_storage.ts`는 DB/R2 조회와 호출 비용이 있는 점검 후보이며 env와 요청 범위를 확인한다. `configured=false`, `unavailable`, `truncated=true`는 측정 불가 또는 과소 집계 위험이다.

## 핵심 정책

- service role key는 서버에서만 사용한다.
- 클라이언트 직접 접근이 필요 없는 캐시/운영 테이블은 RLS 활성화 후 공개 정책을 두지 않는다.
- 운영 삭제는 해당 실행 경로의 권한·승인 조건을 따른다. Admin Agent approval 경로와 CLI/workflow의 적용 조건을 구분한다.
- `processed_match_telemetry` repair는 targets 재검증 후 현재도 mismatch인 row만 처리한다.
- analytics는 로컬/개발 이벤트를 운영 데이터와 섞지 않는다.

## 용량과 정리 기준

- DB 관제값은 `storage-limits.ts`의 `getSupabaseDatabaseLimitBytes()`를 사용하며 유효한 `SUPABASE_DATABASE_LIMIT_BYTES`가 기본값을 덮어쓴다. 기본값과 R2 관제 상수는 코드에서 직접 확인한다.
- 코드의 관제값을 현재 가입 요금제나 공급자의 무료 한도로 단정하지 않는다.
- `getR2BucketUsage`는 pagination과 최대 집계 제한을 사용한다. `truncated` 결과로 전체 버킷이 안정권이라고 보고하지 않는다.
- 정리 작업은 `scripts/cleanup_telemetry.ts`, 관련 orphan cleanup, `lib/pubg-analysis/r2DeletionGuard.ts`와 실제 호출 workflow를 확인한다. orphan analysis/replay cleanup은 기본 dry-run이고 `--apply`가 삭제를 허용한다. 다른 cleanup도 같은 기본값이라고 가정하지 않는다.
- R2 `backups/` 등 보호 키와 활성 캐시 claim/lease 보호를 유지한다. 승인·적용 직전 현재 참조와 삭제 대상을 재검증한다.
- `.github/workflows/daily-tasks.yml`, `.github/workflows/r2-json-maintenance.yml`, `docs/operations/2026-10-04-actions-safety-review.md`, `docs/operations/2026-10-04-discovery-r2-maintenance.md`를 작업별로 확인한다. inventory/dry-run/apply와 실제 객체 교체·삭제 범위를 구분한다.

## 백업과 격리 DB 검증

- `npm run db:backup:dry`도 DB를 읽으며 R2 업로드는 하지 않는다. 기본 `db:backup`은 조회 결과를 R2에 쓴다. `scripts/backup_core_tables.ts`의 보존 상수만으로 자동 만료·삭제가 구현됐다고 가정하지 않는다.
- `npm run verify:migrations`는 `scripts/verify_migrations_local.sh`의 명시된 migration과 RPC 시나리오를 일회용 PostgreSQL에서 검증한다. 저장소 전체 이력 재생이나 운영 적용을 대체하지 않는다.
- `npm run verify:baseline`은 Docker/psql을 사용해 baseline으로 빈 DB 복구를 검증한다. `db:baseline:refresh`는 기존 linked 스키마 덤프를 읽어 로컬 fixture를 갱신하는 별도 작업이다. 덤프를 새로 가져오는 명령은 운영 DB 조회임을 구분한다.
- `verify:telemetry-db`는 `PGHOST` 등 지정된 DB에 fixture 쓰기·삭제를 수행하므로 일회용 DB에만 연결한다. `verify:board-image-storage`도 로컬 테스트 DB와 테스트 owner가 필요하다. 검증 명령이라는 이름만으로 읽기 전용이라고 판단하지 않는다.

## 추천 검증

```bash
npm run verify:admin
npm run verify:core
```

스키마/RPC 변경은 `verify:migrations`와 해당 도메인의 DB 검증을 추가한다. 백업·복구 경로 변경은 `verify:baseline`, telemetry 정리·R2 관제 변경은 관련 `tests/player-cache-retention.test.ts`, `tests/telemetry-cleanup.test.ts`, `tests/storage-health-sizes.test.ts`, `tests/admin-storage-compact.test.ts`를 우선 확인한다. 환경 전제 미충족 시 운영 DB로 대체하지 않고 미실행 사유를 보고한다.

## 보고 기준

- 작성·격리 검증·운영 적용한 마이그레이션 이름을 구분
- 변경된 테이블/인덱스/정책
- 운영 데이터 삭제 여부
- 관제 설정값과 실제 요금제 기준을 구분한 용량 영향
- rollback 또는 자연 복구 경로
