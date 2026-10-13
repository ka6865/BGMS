# 텔레메트리 lease 오류의 PostgREST 재시도 차단 — 2026-10-14

## 문제

PostgREST 14는 RPC 함수가 직접 던진 SQLSTATE `40001`(serialization_failure)을 일시적 오류로 보고 같은 요청의 트랜잭션을 반복 실행한다. PostgREST 16에서 수정됐고, 운영(`BGMS`)은 PostgREST v14.5다.
[Supabase 안내](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b)

2026-08-02 긴급 조치로 텔레메트리 finalize 함수의 의도적 `40001`을 `P0001`로 바꿨지만, `20260904130000_telemetry_cache_recovery_safety`가 두 함수를 다시 정의하며 lease 유실·조건 실패에 `40001`을 다시 넣었다. 2026-10-13 운영 스키마 기준 남은 위치는 다음과 같다.

| 함수 | 의도적 `40001` | 메시지 |
| --- | --- | --- |
| `finalize_telemetry_cache_write` | 2 | `telemetry-finalize-lease-lost` |
| `finalize_telemetry_cache_recovery` | 3 | `telemetry-recovery-finalize-processed-update-failed`, `-benchmark-update-failed`, `-lease-lost` |

일반 캐시 저장 경로는 `40001`을 일시적 오류로 보고 앱에서 최대 3번 다시 호출하므로, 각 호출이 서버 안에서 또 반복될 수 있다. lease 유실은 다시 실행해도 결과가 같다.

## 변경

- `20261013185213_telemetry_lease_errors_without_postgrest_retry`: 두 함수 정의에서 `using errcode = '40001'`을 개수(2, 3)를 확인한 뒤 `P0001`로 바꾼다. 이미 바뀐 정의는 건너뛰고, 개수가 다르면 적용을 중단한다. 메시지, 보안 모드(SECURITY INVOKER), `search_path`, 권한은 그대로다.
- `telemetryRegistry.server.ts`: 복구 finalize 에서 `P0001`을 롤백이 확정된 오류로 분류한다. 함수가 직접 던진 예외이므로 트랜잭션은 커밋되지 않았다. 기존 `40xxx` 분류와 같은 보상 경로를 탄다.
- 일반 캐시 저장의 재시도 분류에는 `P0001`을 넣지 않는다. lease 유실을 다시 호출하지 않는다. 실제 직렬화 충돌(`40001`)은 기존처럼 제한 재시도한다.

## 운영 적용

PR 병합(앱 배포)과 migration 적용 순서는 어느 쪽이 먼저여도 된다. 새 앱은 `40001`과 `P0001`을 모두 롤백 확정으로 처리하고, 기존 앱은 `P0001`을 받으면 응답 모호로 보고 한 번 재확인한 뒤 재확인 실패로 끝내므로 객체를 지우지 않는다. 앱을 먼저 배포하는 쪽을 권장한다.

1. 적용 전 두 함수의 `40001` 개수가 2, 3인지 운영 스키마 덤프로 확인한다.
2. `supabase db push`는 쓰지 않는다. 원격 이력 버전을 자리표시 파일로 채운 임시 작업 폴더에 이 파일 하나만 넣고 `--dry-run`으로 대상이 하나인지 확인한 뒤 `supabase db push --linked --workdir <폴더>`로 적용한다(`2026-10-10-remaining-review-fixes.md`의 적용 실적과 같은 방법).
3. 적용 후 운영 스키마를 다시 덤프해 두 함수에 `40001`이 없고 `P0001`이 2, 3개인지, 보안 모드와 권한이 그대로인지 확인한다.

## 검증

- `npm run verify:migrations`: 새 migration 적용, 두 함수 SQLSTATE·보안 모드·`search_path`·anon 권한 확인, 같은 migration 재실행 무변경, 일반 저장 lease 유실 시나리오가 `P0001`로 거부되고 쓰기가 없음을 확인했다.
- `tests/telemetry-retry-sqlstate.test.ts`: 복구 finalize 가 `P0001`·`40001`에서 한 번만 호출하고, 응답이 모호하면 한 번 재확인하며, 일반 캐시 저장은 `P0001`을 재시도하지 않음을 확인한다.

현재 운영에서 재시도 폭주가 실제로 발생하고 있는지는 확인하지 않았다(DB 로그 미조회).
