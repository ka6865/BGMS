# 코칭 기준 2차 재산출·검증 결과

> 이 문서는 최초 402계정 수집 당시의 역사적 결과다. 이후 실제 요약의 14일 유효 창과 고정 조회 시각을 보정 도구에 반영했다. 아래 54프로필은 보완 전 분모이므로 확대 검증의 프로필 수와 직접 비교하지 않는다. 기존 JSON은 당시 근거로 보존한다. 확대 표집·분리 규칙은 [반복 검증 계획](../plans/2026-10-28-coaching-reference-iterations.md), 최종 결과는 [확대 검증 보고서](2026-10-28-coaching-reference-expanded.md)를 따른다.

## 결론

**현재 자료로 전체 칭호 기준을 교체하지 않는다.** 진단용 CDF는 산출했지만 모든 cohort가 최소 학습50·holdout20 조건을 충족하지 못했다. 운영 기본 분포 버전1·점수·캐시는 유지한다. benchmark도 일부 기술적 표본 조건만 충족하며 운영 재적재·비교 기준 활성화는 하지 않았다.

## 표본과 처리

- 최근 Steam 저장 전적 20,000행(조회 상한 도달)의 스쿼드 후보552계정에서 seeded400계정과 지정2계정을 선택했다. 계정별 실제 최근 유효 최대10경기를 별도 조회해 요청3,604 player-match /3,275 실제 경기 키를 확보했다.
- 공통 원본1,188경기(기존 로컬126·새 GET1,062)를 검증해 1,357 player-match를 계산5·결과73으로 재계산했다. 공통 원본 없는 키는2,087개이며 만료라고 단정하지 않는다. canonical fallback은0건이다. 원본 checksum 오류·실행 오류는0건이었다.
- 같은 계정·매치 중복은0건이다. 표본은 기존 검색·저장 및 원본 보관에 영향을 받으며 전체 PUBG 이용자를 대표하지 않는다. 실제 전적은 조회 시각 상한으로 고정했지만 프레임 수집 자체는 여러 읽기 쿼리이므로 DB 트랜잭션 snapshot을 주장하지 않는다.
- 331계정은 최신 창의 점수를 모두 확인할 수 없어 분포 학습에서 제외했다. 모드/유형 혼합14, 3경기 미만2, 대상 팀 모드 외1도 제외했다. 더 오래된 경기나 임의의0점으로 채우지 않았다.
- 최종54프로필은 학습36·holdout16·지정대상2이다. 한 계정은 한 프로필만 기여하며 지정대상은 학습에서 제외했다. source/analysis/계정 목록은 로컬 비공개에 보관하고 공개 자료에는 원본 계정 식별자를 넣지 않았다.

## 조건별 역할 분포 커버리지

| 조건 | 학습 | holdout | 지정대상 | 선봉 진단 점수 학습/holdout | 채택 |
|---|---:|---:|---:|---|---|
| steam|duo|competitive | 1 | 0 | 2 | 1/0 | 보류 |
| steam|duo|official | 0 | 1 | 0 | 학습 분포 없음 | 보류 |
| steam|squad-fpp|competitive | 8 | 3 | 0 | 6/1 | 보류 |
| steam|squad-fpp|official | 2 | 0 | 0 | 0/0 | 보류 |
| steam|squad|competitive | 4 | 3 | 0 | 2/2 | 보류 |
| steam|squad|official | 21 | 9 | 0 | 11/4 | 보류 |

50/20은 작업자가 정한 소표본 보호 최소치이며 정확도 보증이나 충분한 모집단 크기가 아니다. `trainingQuantiles`는 진단용 산출값이고, 검증 가능한 `reference`와 구분된다. 이번에는 모든 reference가 보류 상태라 bootstrap/title stability를0회·null로 남겼다. 진단 분포를 검증 완료 기준으로 바꿔 쓰지 않았다.

## 지정 계정의 변경 전후

두 계정의 최근 상위5경기는 실제로 모두 **듀오 경쟁전**이었다. 스쿼드 기준에 섞지 않고 별도 검증 cohort로 처리했다. 두 계정 모두 최근10경기의 점수를 확인했으며, 선제율은 상위5경기 집계다.

| 계정 | 1차 로직의 칭호 | 선제 타격 성공률 | 반격 소요 시간 | 새 기준 전환 |
|---|---|---:|---:|---|
| KangHeeSung_ | 화력의 중심 | 50% | 1.61s | 듀오 표본 부족으로 보류 |
| MiaeQ_Q | 난전의 지배자 | 88% | 측정 불가 | 듀오 표본 부족으로 보류 |

candidate의 ‘전술 분석 중’은 비어 있는 기준을 입력했을 때의 안전한 시뮬레이션 결과다. 실제 서비스 칭호를 이 값으로 변경한 것이 아니다. 무작위 holdout16계정도 후보 판정을 보류했고 1차 분포의 기존 판정은 그대로 두었다.

## benchmark 후보와 독립 표본

benchmark는 전체 프로필 완전성과 별개로 유효한 개인 경기 관측을 사용한다. 같은 raw mode·match type·정확 티어 또는 기존 reader가 허용하는 티어군을 구분한다. 계정당 최대10경기이며 원본이 없는 경기를0으로 채우지 않는다. 지표별 표본 수가 다르다. 학습 계정에서만 후보 평균을 만들고 holdout은 따로 집계했다.

| 학습 후보에서 n≥30인 조건 수 | 선제 타격 성공률 | 반격 소요 시간 | 3초 내 대응 실패율 |
|---|---:|---:|---:|
| 정확 티어 | 12 | 0 | 9 |
| 동일 티어군 | 7 | 1 | 7 |

서로 다른 셀은 중복 관측을 포함할 수 있으므로 독립 표본 수처럼 합산하지 않는다. 반격 시간의 유일한 학습 후보 조건은 Steam 스쿼드 경쟁전 A 티어군(A+·A·A-)이다.

| 반격 소요 시간 | 유효 전적 | 계정 | 평균 | 한 계정 최대 비중 |
|---|---:|---:|---:|---:|
| 학습 | 35 | 32 | 0.833초 | 5.7% |
| 독립 holdout | 12 | 10 | 0.758초 | 16.7% |

holdout은12전적·10계정으로 여전히 적고 n30에 못 미친다. 두 평균의 차이를 실력 차이·반사신경 또는 안정성 입증으로 해석하지 않는다. 나머지 조건은 새 시간을 구 평균으로 대체하지 않는다.

## 재현과 검증

생산 UI와 같은 `selectRecentMatches`→`selectBestMatches`→공통 `aggregateMatches`를 쓴다. 역할은 동일 `classifyRole`에 후보 reference만 전달하며 production 기본 호출과 계산은 유지한다. 계정 단위80/20 split·seed·pool checksum·pipeline code hash는 JSON 근거에 기록했다.

```bash
npx tsx scripts/calibrate_coaching_reference.ts --pool /tmp/bgms-phase2/pool-private.json --output /tmp/bgms-phase2/run --reuse-source-dir /tmp/bgms-reply-expanded/sources
npx tsx scripts/calibrate_coaching_reference.ts --pool /tmp/bgms-phase2/pool-private.json --output /tmp/bgms-phase2/run --reuse-source-dir /tmp/bgms-reply-expanded/sources --offline
```

- 최종 코드의 offline 재생은 새 네트워크 다운로드0·새 분석0·오류0으로 같은1,357전적을 검증했다. 검증된 분석 snapshot만으로 다시 산출한 candidate도 deep equality가 일치했다. 원본과 canonical cache가 없으면 offline은 네트워크로 대체하지 않는다.
- 집중 테스트282개(후속 CLI 경계16개), 전체 단위5,584통과/219skip, 분석702통과/6skip, 공통0오류/기존49경고. CPU가 높은 최초 통합 실행에서 유지보수 알림 테스트1건이5초 timeout됐고, 개별10개와 전체 단위를 낮은 worker 수로 재실행해 통과했다. 실패를 제품 수정으로 덮지 않았다.
- 독립 코드 검토는 주요 결함 없음. 검토 후 실제 듀오 대상·티어군 fallback을 추가한 변경은 각각 RED→GREEN 및 전체 단위로 검증했다.
- 제품 UI 문구·배치·응답 계약은 변경하지 않았다. 집계 본문 이동은 기존 AI route 테스트와 독립 집계 테스트로 검증했으며 모바일 브라우저 검사를 새로 실행한 결과로 보고하지 않는다. 실제 Gemini·운영 DB/R2 쓰기·migration·배포도 실행하지 않았다.

## 다음 수집 조건

- 듀오 경쟁전은 지정 두 계정을 제외한 학습1·holdout0으로 역할 기준을 만들 수 없다. 듀오의 완전한 최근 경기 창과 적격 반격 관측을 가진 독립 계정을 먼저 확보해야 한다.
- 가장 큰 스쿼드 일반전도 전체 학습21·holdout9, 선봉 진단 점수11·4이다. 기준을 낮춰 통과시키지 않고 동일 조건에서 부족한 관측을 추가한다. 필요한 양은 ‘아무 계정 수’가 아니라 지표/역할의 유효 계정 수다.
- 유효 학습/holdout 확보 후 같은 도구로 bootstrap·칭호 이동을 재검증한다. 운영 schema 선행 여부·재적재 영향·기준 활성화는 그 결과를 검토한 뒤 별도 적용한다.

근거 JSON: `2026-10-28-coaching-reference-coverage.json`, `2026-10-28-coaching-reference-candidate.json`.
