# 전술 안정도 계산 6 설계

상태: 구현(2026-11-11, 운영 적용 전). 계산 5(`docs/specs/2026-10-28-tactical-score-v5.md`) 위에 쌓는다. 근거는 2026-11-11 전체 점검 보고서의 F01·F02와 사용자 결정(계산 버전 6으로 올림)이다.

## 1. 목적

점수 배점과 대체값은 바꾸지 않는다. 두 점수 입력이 입력 순서나 오래된 관측에 따라 달라지던 문제를 고친다. 입력 의미가 바뀌므로 `ANALYSIS_CALCULATION_VERSION`을 6으로 올린다. `RESULT_VERSION`(73)과 `TELEMETRY_VERSION`(63)은 그대로다.

## 2. 엔진 변경

| 항목 | 계산 5까지 | 계산 6 |
| --- | --- | --- |
| 딜량 순위 `rankPct` | 엔진과 전적 화면이 각자 안정 정렬로 순위를 정해, 딜량이 같으면 참가자 배열 순서가 순위를 바꿨다(사람 10명 0딜에서 0.1↔1.0, 전투 점수 30.8↔15.8) | 엔진도 `botShare.humanDamageRankPct` 하나만 쓴다. 순위는 내 딜량 이상인 사람 수다(동점자 중 가장 낮은 순위). 내 기록이 없으면 1 |
| 고립 지수 표본 | 팀원·적 위치의 기록 시각을 보지 않았고, 관측된 적이 없으면 적 거리를 아주 먼 값으로 두어 고립 지수 0의 유효 표본이 됐다 | 팀원·적 위치는 15초(`DEATH_CONTEXT_MAX_LOCATION_AGE_MS`, 사건 시점 근접 거리와 같은 기준) 안의 샘플만 쓴다. 최근 관측된 적이 없으면 표본을 만들지 않는다 |

분석 엔진은 `mode: "full"` 텔레메트리(모든 선수 위치, 약 10초 간격)를 받는다. lite 표시용 텔레메트리의 적 위치 1/10 샘플링은 분석 입력에 쓰지 않는다.

같은 고립 표본에서 나오는 최소 아군 거리·높이 차·근접 아군 수도 같은 표본 기준으로 바뀐다.

## 3. 비교 표본 공존

- 지표별로 같은 정의를 쓰는 최소 계산 버전으로 평균을 낸다(`benchmarkLookup.ts`).
  - 계산 5에서 의미가 바뀐 지표(`CALCULATION_5_REDEFINED_METRICS`): 계산 5·6 행
  - 계산 6에서 의미가 바뀐 위치 지표(`CALCULATION_6_REDEFINED_METRICS`: `avg_isolation_index`, `avg_min_dist`): 계산 6 행만
  - 나머지: 지원 버전 2~6 합산
- 칸별 현재 계산 표본이 300경기(`CALCULATION_5_FULL_SWITCH_MIN_MATCHES`) 이상이면 전 지표를 현재 계산만 쓴다(계산 5와 같은 규칙).
- AI 최근 요약의 비교 게이트(`aiSummaryCards.ts`): 계산 5 지표는 계산 5 미만 경기가 섞였을 때만, 고립 지수 카드와 위치 비교 평균은 계산 6 미만 경기가 섞였을 때 비교 평균을 뗀다. 계산 6 배포 직후에도 계산 5 경기의 교전·전멸 비교는 유지된다.
- 스쿼드 AI 캐시 키(`AI_SQUAD_CACHE_VERSION`)는 계산 버전을 포함하므로 자동으로 새로 만든다.

## 4. DB

`supabase/migrations/20261111200100_analysis_calculation_v6.sql`
- `upgrade_analysis_calculation`·`upgrade_analysis_calculation_canonical`: 계산 6 저장 허용, 이전 1~5 행만 올림
- `finalize_telemetry_cache_recovery`: provenance에 6 추가
- 랭킹(`p_calculation>=3`)과 성과 작업(`p_calculation<3`) guard는 계산 5에서 일반화돼 그대로다

검증: `tests/fixtures/migration-check/calculation-v6-scenarios.sql`(5→6 CAS, 하향·미지원 7 거부, 같은 경기 새 계산 우선 랭킹, provenance·ACL).

## 5. 기존 데이터

저장 데이터만으로 다시 계산할 수 없다(텔레메트리 필요). 새 분석과 텔레메트리 재분석만 계산 6으로 저장하고, 기존 점수는 그대로 둔다.
