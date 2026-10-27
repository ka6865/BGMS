# 전술 안정도 계산 5 설계

상태: 구현(2026-10-28, 운영 적용 전). 계산 4(`docs/specs/2026-10-17-tactical-score-v4.md`) 위에 쌓는다. 근거는 2026-10-27 2차 3자 회의(GPT 6.1 Sol, Claude Opus 5.5)와 사용자 결정이다.

## 1. 목적

텔레메트리 엔진이 팀 전멸·소생·교전을 "내 기여"와 다르게 귀속하던 문제를 고친다. 점수 배점과 계산 4 대체값은 바꾸지 않는다. 점수 입력의 의미가 바뀌므로 `ANALYSIS_CALCULATION_VERSION`을 5로 올린다. `RESULT_VERSION`(73)과 `TELEMETRY_VERSION`(63)은 그대로다.

## 2. 엔진 변경(점수 입력이 바뀌는 것)

| 항목 | 계산 4까지 | 계산 5 |
| --- | --- | --- |
| 팀 전멸 `tradeStats.enemyTeamWipes`(점수 `teamWipes`) | 팀원이 그 팀을 때렸거나 내가 마지막 처치를 하면 인정 | 내가 서 있는 적에게 피해, 기절, 처치·확킬·기절 유발(`killer`·`finisher`·`dBNOMaker`) 중 하나가 있을 때만 인정. 이미 기절한 적에게 피해만 준 것은 기여가 아니다(결정 1a). 마지막 사망 원인(자기장·출혈·다른 팀)은 묻지 않는다. 시간 창은 두지 않고 `lastMyContributionMs`를 기록한다. |
| 재투입 | `LogPlayerRecall`만으로 생존 복구 | Recall은 대기로만 기록. `LogPlayerRedeploy`·`LogPlayerRedeployBRStart`(대소문자 별칭 포함)·사망 뒤 `LogPlayerCreate`에서만 생존과 roster 명단을 복구. 전원 사망 뒤 복귀는 새 전멸 회차, 일부 복귀는 기여 유지. |
| 처치·소생 중복 | 같은 이벤트가 두 번 오면 두 번 셈 | 처치는 victim+생명 번호, 소생은 victim+생명 번호+기절 사건 기준으로 한 번만 센다. 귀속이 늦게 보강되면 귀속만 갱신한다. |
| 자가 소생 | 내 소생으로 셈 | 내 소생·안전 소생·임팩트 소생에서 제외하고 `selfReviveCount`로 기록. 팀원 자가 소생은 내 연막 구출이 아니며 구조 기회에서도 뺀다(결정 3b). |
| 연막 구출 | 조건에 맞는 첫 기절 사건에만 연막을 붙임 | 조건(100m·20초)에 맞는 열린 기절 사건 모두에 붙인다. 안전 소생은 `myReviveCount - reviveWithOwnSmokeCount`로 사건 기준 계산한다. |
| 교전 세션·반격·선제·역전 | 팀원·자해 피해와 기절한 적 피격이 섞임 | 같은 팀·같은 사람 사이의 피해·기절·처치를 교전, duel 결과, 선제, 역전, 반격 지연, KNOCK/KILL 타임라인, 차량 교전에서 뺀다. 기절한 적 피격은 교전을 새로 시작하지 않는다. |
| lite 분석 | 내 팀 사망 30초 뒤 이벤트를 건너뛰어 전멸 판정이 full과 달라질 수 있음 | 타임라인·리플레이 기록 제한은 유지하고 사망·재투입 상태 전이는 끝까지 처리한다. |

점수 분모 `totalTeammateKnocks`는 바꾸지 않는다(계산 4 대체값과 같은 분모 유지). 분자만 위 수정이 반영된다.

## 3. 기록만 하는 필드(점수·칭호 산식 그대로)

- `tradeStats.rescueOpportunityCount`·`rescueCount`·`reviveWithOwnSmokeCount`: 구조 사건 단위. 기회는 팀원 기절 사건이 열려 있는 동안 내가 한 번이라도 서 있던 경우다(결정 2a). 성공은 내가 살렸거나 내 연막이 붙은 사건이 소생으로 끝난 경우다(합집합). `0 <= rescueCount <= rescueOpportunityCount`.
- `tradeStats.selfReviveCount`·`teammateSelfReviveCount`
- `tradeStats.teamParticipationWipes`(계산 4까지의 전멸 의미), `tradeStats.wipeEvidence[]`(`rosterSize`, `wipedAtMs`, `lastMyContributionMs`, `kinds`, `botMembers`)
- `teamContext`(`myRosterSize`, `aliveTeammatesAtMyDeath`)
- `duelStats.firstReplyWithin3sCount`·`firstReplyLatencySumMs`
- `combatPressure.maxHitDistUpright`, `itemUseStats.distanceDamageUpright`

## 4. 버전 공존 계약

텔레메트리가 있어야 다시 계산할 수 있어 저장 데이터 기반 보정은 없다. 새 분석과 텔레메트리 재분석(기존 업그레이드 경로)만 계산 5로 저장한다. 계산 2·3 행의 계산 4 저장 보정(`scripts/upgrade_calculation_v4_from_stored.ts`)은 계산 5 배포 뒤에도 쓸 수 있고, 계산 5 행은 RPC가 거부한다.

| 읽는 곳 | 계산 5 방침 |
| --- | --- |
| 비교 표본 `benchmark_stats_by_tier_v2`(`fetchTierBenchmarkStats`) | 의미가 바뀐 지표(`CALCULATION_5_REDEFINED_METRICS`: 전멸, 소생, 연막, 트레이드, 트레이드 지연, 반격 지연, 선제, 역전, 교전 승률, 압박, 단독 킬 비중)는 계산 5 행만 쓴다. 딜량·킬·생존 시간·고립·최소 거리·사망 단계는 2~5를 합친다(결정 4a). 지표별 표본 수는 계산 5 기준으로 붙어, 5 미만이면 그 지표만 노출하지 않는다. |
| 전체 전환 | 한 티어·모드 칸(정확 티어, 없으면 티어 계열)의 계산 5 표본이 `CALCULATION_5_FULL_SWITCH_MIN_MATCHES`(300경기) 이상이면 그 칸은 모든 지표를 계산 5로만 비교한다. 날짜가 아니라 칸별 표본 기준이다. |
| 팀 비교 기준 `pubg_team_benchmarks` | 2~5를 합친다. 팀 관측 수집기(`SquadObservationCollector`)는 바뀌지 않았다. |
| 랭킹 `get_pubg_rankings` | 계산 5 요청에서 2~5를 합치고 같은 경기는 높은 버전을 고른다(계산 4 결정 유지). |
| 성과 작업 `seed_pubg_performance_jobs` | 이전 버전(2 이상 현재 미만) 자료가 있는 경기는 다시 계산하지 않는다. |
| 업그레이드 RPC | 계산 5 저장을 허용하고 이전 1~4 행만 올린다. 하향은 거부한다. |
| 칭호(구조율) | 지금은 계산 4까지와 같은 식(소생+연막 구출 / 팀원 기절)을 쓴다. 계산 5 경기의 `rescueCount / rescueOpportunityCount`로 바꾸는 일은 기준 분포 재생성과 함께 칭호 PR에서 한다. |

migration: `supabase/migrations/20261028000000_analysis_calculation_v5.sql`(함수 본문의 버전 목록만 치환, 예상 문자열이 없으면 실패). 격리 검증: `tests/fixtures/migration-check/calculation-v5-scenarios.sql`.

## 5. 계산 6 후보(이번에 하지 않음)

1인 roster·봇 전멸 점수 제외, 팀 딜 비중 인원 보정, 기절 관리 중립화, cleanup 킬 분리, 맵 보정, 점수 분모 교체, 반격 3000ms 산식 변경.

## 6. 미확인 사항

실제 텔레메트리로 확인하지 못한 형태: 자가 소생 이벤트 모양, 출혈사 `LogPlayerKillV2`의 필드, Recall→Redeploy 순서, `LogPlayerRedeployBrStart` 표기의 실제 존재, 봇 roster 구조. 엔진은 손으로 만든 fixture(`tests/calculation5-engine.test.ts`)로만 검증했다.
