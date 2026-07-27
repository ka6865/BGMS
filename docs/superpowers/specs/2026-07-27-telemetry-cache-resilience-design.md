# 텔레메트리 캐시 장애 격리 설계

## 목표

Supabase 캐시 쓰기 지연 또는 시간 초과가 발생해도 `/api/pubg/match`의 분석 결과는 정상 응답하고, 실패한 캐시 저장은 안전하게 재시도·관측할 수 있게 한다.

## 확인된 사실

- 2026-07-27 09:57~10:04 KST에 `/api/pubg/match` 500이 74건 발생했다.
- 오류는 `analysis:telemetry_cache_reserve` 31건, `analysis:telemetry_cache_finalize` 43건이었다.
- 해당 오류의 PUBG upstream status는 모두 200이었다.
- Supabase Postgres 로그에는 같은 시각 다수의 statement timeout과 잠금 대기가 있다.
- 한 분석 요청은 `reanalyzeAndSave` 시작 시 캐시를 예약하고, `writeTelemetryMapCache` 내부에서 같은 identity를 다시 예약한다.
- `finalize_telemetry_cache_write`와 `cleanup_expired_telemetry_matches`는 `telemetry_map_cache_entries` 테이블 잠금을 사용한다.

## 원인과 설계 판단

DB 혼잡 및 잠금 대기가 캐시 예약·완료 요청의 statement timeout으로 이어졌고, 현재 route가 이 저장 실패를 분석 전체 실패로 전파한다. 광범위 잠금과 중복 예약은 혼잡을 키우는 구조적 요인이다.

정리 RPC가 이번 모든 대기의 직접 선행 작업이었다는 것은 현재 보관된 로그만으로 확정하지 않는다. 따라서 구현 전에 오류 코드·대기 시간·정리 실행 상관관계를 기록한다. 다만 사용자 요청과 정리 작업이 같은 테이블 전체 잠금을 경쟁하지 않도록 만드는 개선은 이 상관관계와 무관하게 필요하다.

## 설계

### 1. 분석 응답과 캐시 지속성 분리

`reanalyzeAndSave`는 분석 계산과 기본 전적 저장을 완료한 뒤 캐시 저장을 시도한다. 캐시 저장이 최종 실패해도 분석 결과는 반환한다.

- 캐시 오류는 `telemetryCachePersistence` 결과로 수집한다.
- 응답에는 캐시 파일 URL이 없는 경우를 표현할 수 있는 안전한 상태만 포함한다. 내부 오류 문자열과 Supabase 세부 정보는 클라이언트에 노출하지 않는다.
- 서버 로그와 `pubg_api_errors`에는 실패 단계, Supabase 오류 코드, 재시도 횟수, 총 대기 시간을 기록한다.
- 캐시 미완료 레지스트리는 `pending` lease가 만료된 뒤 다음 분석 또는 정리 작업에서 회복할 수 있다.

### 2. 재시도 정책

캐시 예약과 캐시 완료에만 재시도를 적용한다.

- 대상: statement timeout, lock timeout, 연결 일시 실패, Supabase 5xx.
- 제외: 입력 검증 오류, 권한 오류, RLS 오류, unique constraint 이외의 데이터 무결성 오류.
- 횟수: 최초 시도 후 최대 2회 재시도.
- 지연: 250ms, 750ms에 0~150ms 난수를 더한다.
- 각 재시도에는 같은 cache identity를 사용한다. upsert와 완료 RPC는 idempotent여야 한다.

### 3. 중복 예약 제거

분석 시작의 예약은 R2 처리 전에 lease를 확보하는 역할을 유지한다. 이후 `writeTelemetryMapCache`는 이미 확보한 reservation을 다시 upsert하지 않는다.

- `writeTelemetryMapCache`에 이미 예약된 저장 경로 또는 reservation row를 받는 명시적 경로를 추가한다.
- 단독 호출자는 기존처럼 스스로 예약한다.
- route에서 시작 예약 후에는 "예약됨" 경로를 사용한다.

### 4. SQL 잠금 범위 축소

`finalize_telemetry_cache_write`의 `lock table ... row exclusive`를 제거한다. 세 개의 `INSERT ... ON CONFLICT DO UPDATE`는 각각 고유키 원자성을 사용한다.

`cleanup_expired_telemetry_matches`는 테이블 전체 `share row exclusive` 잠금을 사용하지 않는다.

- 정리 후보는 match_id 오름차순으로 제한한다.
- `match_master_telemetry`와 `telemetry_map_cache_entries`의 해당 행만 `FOR UPDATE SKIP LOCKED`로 확보한다.
- 잠긴 행은 이번 정리에서 건너뛰며, 이후 정리 실행에서 다시 후보가 된다.
- 삭제 전 cutoff와 lease 조건을 같은 트랜잭션에서 다시 검증한다.

### 5. 관측과 알림

`pubg_api_errors`에 cache persistence 실패의 구조화 정보를 보존한다.

- `error_code`: reserve/finalize와 재시도 소진 여부를 구분한다.
- `detail`: 외부 노출 없이 Supabase code, HTTP status, retry count, elapsed time을 JSON으로 기록한다.
- Discord는 동일 route/status/error code별 10분 창 하나만 발송한다.
- `pubg_api_alert_deliveries`의 중복 예약은 `ON CONFLICT DO NOTHING`으로 처리해 예상된 primary-key 충돌을 Postgres error log에 남기지 않는다.

## 변경 범위

- `app/api/pubg/match/route.ts`: 캐시 실패 격리 및 이미 예약된 캐시 쓰기 호출.
- `lib/pubg-analysis/telemetryMapCache.ts`: reservation 재사용 경로와 제한 재시도 의존성.
- `lib/pubg-analysis/telemetryRegistry.server.ts`: Supabase 오류를 분류 가능한 형태로 전달.
- `lib/pubg/apiHelper.ts`: cache persistence 오류의 구조화 기록 및 alert upsert 호출.
- `supabase/migrations/`: 완료/정리 RPC 잠금 축소와 alert delivery 충돌 억제.
- `tests/pubg-ingest-boundary.test.ts`, `tests/telemetry-cleanup.test.ts`, `tests/pubg-api-helper.test.ts`: 사용자 응답, 중복 예약, 재시도, SQL 잠금 계약 검증.

## 비범위

- PUBG API rate limit 정책 변경
- 기존 캐시 데이터의 대량 삭제 또는 복구
- Supabase 플랜 변경
- 클라이언트 UI 개편

## 완료 기준

- 캐시 reserve/finalize가 timeout으로 실패해도 `/api/pubg/match`는 분석 결과를 200으로 반환한다.
- 단일 분석의 registry reservation upsert는 한 번만 실행된다.
- 완료/정리 SQL에 테이블 전체 잠금이 없다.
- timeout·lock 오류는 최대 두 번만 재시도하며, 입력·권한 오류는 즉시 실패한다.
- 오류 로그만으로 실패한 DB 단계, Supabase 코드, 시도 횟수, 대기 시간을 구분할 수 있다.
- 관련 단위·회귀 테스트, `npm run verify:analysis`, `npm run verify:core`를 통과한다.

## 배포와 롤백

1. 마이그레이션을 먼저 적용한다. 변경은 함수 재정의와 충돌 억제이며 운영 데이터 삭제가 없다.
2. 애플리케이션을 배포한다.
3. 배포 직후 30분 동안 cache reserve/finalize 오류율과 p95 대기 시간을 관찰한다.
4. 새 RPC에서 오류가 발생하면 이전 함수 정의를 새 롤백 마이그레이션으로 복원한다. 애플리케이션의 캐시 실패 격리는 유지하므로 사용자 분석 500은 방지한다.
