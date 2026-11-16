# 증바람 등장 중단 추정 증강 조사

2026-11-17 KST 기준. 현재 활성 도감 235개 중 13개가 최근 저장 통계와 Mayhem:Meta 현행 목록에서 모두 미관측이다. 이 중 12개는 과거 등장과 중단 분석이 함께 확인됐고, 재장전 1개는 중단 시점을 확정할 근거가 부족하다. 공식 삭제와 구분한다.

## 대조 범위

운영 BGMS DB와 private Storage를 읽기 전용으로 조회했다. 아래 정규화 파일 677개의 SHA-256, 챔피언 ID와 원본 버전을 대조한 뒤 증강별 행 존재 여부와 양수 선택 근거를 집계했다. 수집 실행이나 운영 데이터 변경은 하지 않았다.

| 저장 버전 | 자료일 | 확인한 챔피언 | 범위 |
| --- | --- | --- | --- |
| 16.21.5 | 2026-10-30 | 173/173 | 승인본 |
| 16.22.1 | 2026-11-08 | 173/173 | 승인본 |
| 16.22.2 | 2026-11-10 | 173/173 | 현재 공개본 |
| 16.22.3 | 2026-11-15 | 158/173 | 진행 파일에 저장된 일부 |

이 조사에서 미관측은 통계 행 자체가 없다는 뜻이다. 경기 0건 또는 등장 불가능을 직접 증명하지 않는다. 최신 버전의 미수집 15명도 결론에 포함하지 않았다.

추가 대조 자료는 arammayhem.com의 [26.20](https://arammayhem.com/data/v1/26-20/augments.json), [26.21](https://arammayhem.com/data/v1/26-21/augments.json), [26.22](https://arammayhem.com/data/v1/26-22/augments.json) JSON과 [Mayhem:Meta 현행 목록](https://mayhemmeta.com/augments)이다. 전자는 원본 이름으로, 후자는 공식 증강 ID로 연결했다. 현행 목록의 222개 ID와 운영 도감의 차집합도 같은 13개다. 사이트 수를 독립 표본 수로 해석하지 않는다.

## 등장 중단 근거가 강한 12개

아래 항목은 네 저장 버전에서 모두 행이 없고, arammayhem.com의 26.20 자료에는 있지만 26.21·26.22 자료에는 없다. Mayhem:Meta의 [자체 경기 분석](https://mayhemmeta.com/articles/augments-silently-disabled-26-21)은 같은 12개가 2026-10-21 16:58 UTC 이후 관측되지 않았다고 보고한다. 서버 비활성화라는 설명은 분석자의 추정이다.

| 공식 ID | 운영 한국어 이름 | 영문 이름 | 등급 |
| --- | --- | --- | --- |
| 2032 | 상어 미끼 | Shark Bait | 골드 |
| 2034 | 상어 폭풍 | Shark Tempest | 골드 |
| 2043 | 자연의 회복 | Nature is Healing | 골드 |
| 2080 | 눈 폭발 | Snowblast | 골드 |
| 2083 | 이빨 요정 | Tooth Fairy | 골드 |
| 2091 | 끝없는 학살 | Endless Decimation | 골드 |
| 2104 | 영혼 폭탄 | Spirit Bomb | 프리즘 |
| 2107 | 열의 | Hellbent | 프리즘 |
| 2115 | 말랑 찰싹 손 | Squishy Slappy Grab | 프리즘 |
| 2127 | 장인의 솜씨 | Forged By The Master | 실버 |
| 2134 | 방출 역장 | Surge Field | 프리즘 |
| 2137 | 격려하기 | Pat On The Back | 골드 |

현재 운영 16.22 카탈로그에서는 12개 모두 `enabled=true`, `in_pool=true`, `state=official_active`다. 수집기는 클라이언트 파일의 활성 값을 그대로 사용하고 화면도 이 값으로 노출하므로 실제 등장 여부와 차이가 생긴다.

공식 변경 기록만으로 등장 여부를 확정할 수도 없다. 예를 들어 말랑 찰싹 손은 [Riot 26.22 패치노트](https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-22-notes/)에 상향이 적혀 있지만 위 통계에서는 미관측이다.

## 추가 후보 재장전

`2126`, 재장전(Reload, 골드)도 네 저장 버전과 Mayhem:Meta 현행 목록에 행이 없다. arammayhem.com의 위 세 패치 자료에도 없다. 다만 12개 중단 분석에 포함되지 않고, 이번 대조에서는 이전에 실제 선택됐던 자료를 확보하지 못했다. 분류는 **장기 미관측·추가 확인 필요**로 둔다.

공식 클라이언트 자료의 내부 이름은 `KeepGoing`이다. 16.22 `kiwi.bin.json`에는 `IsAbilityAugment=true`로 존재하며 `Enabled` 필드는 생략돼 있다. 기존 파서는 생략을 활성으로 처리한다. 이것만으로 비활성이나 내부 전용이라고 바꾸지 않는다.

## 수정 준비에 반영할 기준

- 근거가 강한 12개를 우선 대상으로 삼고, 재장전은 별도 검토 대상으로 둔다.
- 화면에서는 ‘등장 중단 추정’으로 설명하고 보관함의 기존 `unverified` 분류를 재사용하는 안을 권한다. 공식 `removed`·`disabled`로 덮어쓰지 않는다.
- 적용 패치는 우선 16.22로 한정한다. 16.21 당일 초반의 실제 선택 기록과 미래 복귀 가능성을 보존한다.
- 원본 파일, 공식 카탈로그, 챔피언별 미관측 이력은 보존한다. 후속 패치에서 재관측되면 근거와 적용 범위를 다시 검토한다.

집계 근거: [증강별 대조 JSON](2026-11-17-lol-mayhem-availability.json). 외부 자료 출처: arammayhem.com, Mayhem:Meta. arammayhem.com JSON은 CC BY 4.0으로 제공된다.
