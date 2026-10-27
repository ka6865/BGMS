# 반격 지연 비교 기준 분리 (2026-10-28)

## 배경

`AnalysisEngine`은 경기마다 반격 지연(`tradeStats.counterLatencyMs`, `reactionLatencyMs`, 저장 열 `global_benchmarks.counter_latency_ms`)을 이렇게 기록한다.

- 기습당한 뒤 3초 안에 대응 피해를 준 적이 있으면 그 반격들의 평균(항상 3000ms 미만)
- 3초 안에 대응한 적이 없고 기습만 당했으면 패널티 `COUNTER_LATENCY_PENALTY_MS`(3000)
- 기습을 당하지 않았으면 측정 불가(`null`, 저장 시 `-1`)

운영 `global_benchmarks` 읽기 전용 집계(2026-10-28)에서 대응 값이 있는 경기의 55~66%가 패널티였다. 계산 4 기준으로 패널티 포함 평균은 2.13초였지만, 3초 안에 반격한 경기만의 평균은 0.63초였다. 그래서 기존 평균을 "피격 시 반격 시간"으로 보여 주면 사실상 실패 비율을 반응 시간처럼 말하게 된다.

## 계약

| 값 | 의미 | 사용처 |
| --- | --- | --- |
| `avg_counter_latency_ms` (`avgCounterLatency`) | 패널티 포함 평균. 기존 그대로 | 전술 점수, 역할 분류(`roleReference`), 대결 화면 |
| `avg_measured_counter_latency_ms` (`avgMeasuredCounterLatency`) | 3000 미만 경기만의 실측 평균 | 단판 프롬프트, 여러 경기 요약 프롬프트·카드, 단판 비교 후처리 |
| `avg_counter_failure_rate` (`avgCounterFailureRate`) | 대응 값이 있는 경기 중 3000인 경기 비율(0~100) | 단판 패널티 경기 프롬프트, 요약 프롬프트·카드(`counter_failure_rate`) |

- 두 새 지표는 `CALCULATION_5_REDEFINED_METRICS`에 넣어 계산 5 행끼리만 비교한다.
- 새 열이 없는 저장 비교 근거(이전에 분석한 단판)는 해당 비교를 노출하지 않는다. 기본값으로 채우지 않는다.
- 저장 데이터, 점수 계산식, `ANALYSIS_CALCULATION_VERSION`, `RESULT_VERSION`은 바꾸지 않는다. 여러 경기 요약 캐시는 `AI_SUMMARY_CACHE_VERSION`을 `2026-10-28.counter-latency-split-v22`로 올렸다. 단판 AI 캐시는 읽을 때 후처리가 반응 속도 비교를 실측 비교 기준으로 검사하므로 버전을 올리지 않는다.

## migration

`supabase/migrations/20261028120000_benchmark_counter_latency_split.sql`은 `benchmark_stats_by_tier_v2` view 끝에 열 4개(평균·표본 수 2쌍)를 추가한다. 기존 열·조건·`security_invoker`·권한은 그대로다. 적용 전 운영 view 정의가 `20260907133015_analysis_calculation_version.sql`과 같은지 확인했다(2026-10-28).

- 격리 검증: `npm run verify:migrations`의 `counter-latency-split-scenarios.sql`
- 운영 적용: 파일 하나만 적용한다(`docs/operations/2026-10-10-remaining-review-fixes.md`의 절차). 코드는 열이 없을 때 비교를 생략하므로 배포와 적용 순서는 상관없다.
- 되돌리기: 이전 view 정의로 `CREATE OR REPLACE`할 수 없다(열 삭제 불가). `DROP VIEW` 후 이전 정의를 다시 만들고 권한을 다시 준다.

## 남은 과제

- 전술 점수 `(3000 - x) / 2000 * 10`은 1초 이하에서 10점으로 고정된다. 실측 평균이 약 0.6초라 실제로는 대응 성공 여부에 가깝다. 점수 설계와 함께 따로 검토한다.
- 경기 안에서 3초 안에 반격한 적이 한 번이라도 있으면, 그 경기에서 실패한 기습은 평균에 들어가지 않는다. 기습 단위 집계로 바꾸려면 계산식 버전과 텔레메트리 재계산이 필요하다.
- 여러 경기 요약 시각화의 `reactionTier`(0.4/0.6/0.8초 기준)는 패널티 포함 평균을 받아 대부분 C로 나온다. 화면 변경과 함께 다룬다.
