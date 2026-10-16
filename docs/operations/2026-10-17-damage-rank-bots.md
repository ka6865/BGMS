# 경기 등급의 딜량 순위에서 봇 제외 — 2026-10-17

## 문제

`/api/pubg/match`는 딜량 순위 비율(`rankPct`)을 구할 때 봇을 빼려고 `participant.attributes.accountId`를 봤다. PUBG 참가자 데이터의 계정 ID는 `attributes.stats.playerId`에 있고 `attributes.accountId`는 없어서, 봇이 모두 사람으로 계산됐다.

`rankPct`는 두 곳에 쓰인다.

- 경기 상세 "티어 근거"의 "딜량 상위 X%"(`matchInfo.rankPct`)
- 비교 그룹 등급 S(10% 이내)·A(30%)·B(60%)·C를 정해 `benchmark_stats_by_tier_v2`에서 비교 평균을 고르는 값

봇은 대개 딜량이 낮아 순위 아래쪽을 채우므로, 봇이 많은 경기일수록 비율이 낮아져(좋아져) 한 단계 높은 그룹과 비교됐다. 경쟁전은 봇이 없어 영향이 없다.

실제 경기 58db73d8(62명 중 봇 30명)에서 사람 32명 중 14명의 비교 등급이 한 단계 높게 정해지고 있었다. 예를 들어 사람 기준 딜량 10위는 16%(A)로 계산됐지만 사람만 세면 31%(B)다.

## 변경

- `humanDamageRankPct`(`lib/pubg-analysis/botShare.ts`)로 봇(`stats.playerId`가 `ai.`)을 순위와 분모에서 모두 뺀다. 분석 엔진의 `damageRank`·점수 계산과 같은 기준이다.
- 내 기록을 찾지 못하면 이전에는 비율이 0(S 등급)이 될 수 있었다. 이제는 가장 낮은 비율 1로 둔다.

## 범위

- 비교 평균 자체(`global_benchmarks.tier`)는 엔진 점수로 정한 등급이고, 엔진은 이미 봇을 빼고 있어 이번 변경과 무관하다.
- `RESULT_VERSION`·`ANALYSIS_CALCULATION_VERSION`은 올리지 않았다. 새로 분석하는 경기부터 바른 값이 저장되고, 이미 저장된 결과는 이전 값을 유지한다. 14일이 지난 경기는 텔레메트리가 없어 다시 계산할 수 없기 때문이다.
