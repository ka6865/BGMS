# 반격 지연 비교 분리와 AI 코칭 근거 보강 (2026-10-28)

## 배경

`AnalysisEngine`은 경기마다 반격 지연을 두 가지로 기록한다.

- `tradeStats.counterLatencyMs`/`reactionLatencyMs`(저장 열 `global_benchmarks.counter_latency_ms`): 3초 안에 대응하지 못하고 기습만 당한 경기는 패널티 `COUNTER_LATENCY_PENALTY_MS`(3000), 그 외에는 상대가 먼저 쏜 교전에서 **직전** 적 피격부터 내 모든 피격까지의 간격 평균이다. 교전 중 연사 간격이 섞여 0.09초 같은 값이 나온다.
- `duelStats.firstReplyWithin3sCount`/`firstReplyLatencySumMs`(계산 5): 기습당한 교전마다 첫 피격에서 첫 반격까지 걸린 시간이다. 반응 시간으로는 이 값이 맞다(`lib/pubg-analysis/firstReply.ts`).

운영 데이터 읽기 전용 집계(2026-10-28): 대응 값이 있는 경기의 55~66%가 패널티였고, 계산 4 기준 패널티 포함 평균은 2.13초였다. 계산 5 경기 26건에서 기존 값의 중앙값은 255ms(11건이 200ms 미만), 첫 반격 중앙값은 431ms였다.

## 계약

| 값 | 의미 | 사용처 |
| --- | --- | --- |
| `avg_counter_latency_ms` (`avgCounterLatency`) | 기존 값 그대로(패널티 포함) | 전술 점수, 역할 분류(`roleReference`), 대결 화면 |
| `first_reply_latency_ms` → `avg_first_reply_latency_ms` (`avgFirstReplyLatency`) | 첫 피격→첫 반격 평균 | 단판·요약 프롬프트, 요약 카드 `reaction_latency`, 요약 시각화 반응 등급 |
| `avg_counter_failure_rate` (`avgCounterFailureRate`) | 대응 값이 있는 경기 중 3000인 경기 비율(0~100) | 단판 패널티 경기 프롬프트, 요약 카드 `counter_failure_rate` |

- 두 새 지표는 `CALCULATION_5_REDEFINED_METRICS`라 계산 5 행끼리만 비교한다. 첫 반격 기록이 없는 결과(계산 5 이전)는 반응 시간을 "측정 불가"로 둔다.
- AI 해석과 요약 비교는 지표 표본이 `MIN_COMPARISON_SAMPLE_COUNT`(30) 이상일 때만 비교 평균을 쓴다. 노출 최소값(5)은 그대로다.
- 점수 계산식, `ANALYSIS_CALCULATION_VERSION`, `RESULT_VERSION`은 바꾸지 않는다. 여러 경기 요약 캐시는 `AI_SUMMARY_CACHE_VERSION` v22로 올렸다. 단판 AI 캐시는 읽을 때 `applyMatchAiEvidencePolicy`를 다시 적용하므로 올리지 않는다.

## migration

`supabase/migrations/20261028120000_benchmark_counter_latency_split.sql`

1. `global_benchmarks.first_reply_latency_ms` 열 추가. 새 분석은 `persistMatchAnalysis`가 채운다.
2. 이미 저장된 계산 5 행은 같은 경기·플레이어의 canonical `fullResult`에서 채운다(다른 열은 바꾸지 않음).
3. `upgrade_analysis_calculation`의 열 목록 두 곳에 새 열을 넣는다(본문 문자열 치환, 예상 위치가 정확히 두 곳이 아니면 실패).
4. `benchmark_stats_by_tier_v2` 끝에 첫 반격 평균·실패율과 표본 수 열을 추가한다. 기존 열·조건·`security_invoker`·권한은 그대로다.

- 텔레메트리 복구 경로(`finalize_telemetry_cache_recovery`)는 새 열을 쓰지 않아 그 경로로 저장된 행은 NULL(비교 제외)이다.
- 격리 검증: `npm run verify:migrations`의 `counter-latency-split-scenarios.sql`.
- 운영 적용: 파일 하나만 적용한다(`docs/operations/2026-10-10-remaining-review-fixes.md`). 코드는 열이 없으면 비교를 생략하므로 배포와 적용 순서는 상관없다. 적용 뒤 계산 5 행의 채움 건수를 읽기 전용으로 확인한다.
- **운영 적용 실적(2026-10-27 19:27:46 UTC)**: 임시 workdir에 원격 이력 191개 placeholder와 대상 파일만 두고 `supabase db push --linked --workdir`로 적용했다(dry-run으로 대상이 이 파일 하나인지 먼저 확인). 적용 뒤 확인: 원격 마지막 이력 `20261028120000`, 계산 5 행 24건 백필(적용 직전 예상 23건 + 그사이 새 분석 1건), view 318행 유지, RPC 열 목록 2곳 반영, `anon` RPC 실행 권한 없음, view `security_invoker`·공개 읽기 권한 유지. 새 열은 앱 배포 전까지 새 분석에서 채워지지 않는다.
- 되돌리기: view는 `DROP VIEW` 후 이전 정의로 다시 만들고 권한을 다시 준다. RPC는 이전 본문으로 다시 정의한다. 새 열은 남겨도 기존 경로에 영향이 없다.

## AI 코칭 근거 보강

실제 Gemini(`gemini-3.5-flash-lite`, 운영 라우트, DB 쓰기 차단)로 운영 플레이어 8명의 경기를 5회 반복 검증하며 고쳤다.

- 단판 후처리(`matchAiEvidence.ts`)는 해당 문장만 바꾸거나 뺀다. 처치·어시스트·기절·소생·전멸 기여가 있으면 "아무 기여 없음"을 실제 기록으로 바꾸고, 인성 표현·측정하지 않은 능력(집중력)·진입 위치(최전선·선두·돌격)·낮은 고립 지수의 부정 해석·표본 3회 미만(1:1, 선제, 투척)의 능력 평가·비교 없는 반응 속도 평가를 막는다. 근거가 모두 빠진 행동 제안은 항목째 뺀다.
- 단판 프롬프트는 1:1·선제 표본 수와 첫 반격 시간을 함께 주고, 적은 표본·비교 없는 평가·기여 인정·인성 표현·진입 추정·피드백 구성·마지막 한마디 규칙을 추가했다.
- 여러 경기 요약 카드는 근거 문장에 수치와 차이를 넣고, 승자를 비교 방향으로 정하며, 가장 불리한 지표에 맞춘 점검을 쓴다. 검증을 통과한 모델 칭호·칭찬·점검 문장은 살린다. 형식이 틀린 행동 제안은 항목만 뺀다. 카드 경기는 비교 기준과 같은 모드·매치 유형으로 좁힌다.

## 남은 과제

- **사망 페이즈 버그**: 첫 자기장 페이즈 전에 죽으면 `deathPhaseSnapshot`이 0이라 경기 종료 시점 페이즈(예: 9)가 사망 페이즈로 저장된다(`AnalysisEngine.ts` 결과 조립부). 생존 점수와 요약 평균 사망 페이즈에 영향을 준다. 이번에는 단판 프롬프트에서만 생존 6분 미만·페이즈 3 이상 값을 측정 불가로 처리했다. 엔진 수정은 계산 버전 결정과 함께 한다.
- 전술 점수 `(3000 - x) / 2000 * 10`은 1초 이하에서 10점으로 고정돼 사실상 대응 성공 여부를 잰다. 첫 반격 기준으로 바꿀지 점수 설계와 함께 검토한다.
- 역할 분류의 `reactionSec` 기준 분포는 기존 값으로 만들어졌다. 첫 반격 기준으로 바꾸려면 분포를 다시 만든다.
