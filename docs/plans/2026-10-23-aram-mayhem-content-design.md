# 무작위 총력전: 아수라장(증바람) 콘텐츠 조사·설계 (2026-10-23)

- 기준일: 2026-10-23. 외부 출처는 모두 이 날짜에 열람했다.
- 범위: 조사와 설계만 한다. 구현·migration·외부 서비스 등록·배포·push는 하지 않았다.
- 전제: LoL 기능은 아직 main에 없다. 미병합 PR #336(`ka6865/lol-private-dev`, 관리자 전용 전적·저장·운영 기반)과 그 위의 PR #337(`ka6865/lol-review-route`, 플래그 공개 경로·법적 고지·개인정보처리방침)을 기준으로 분석했다.
- 표기: **확정**(공식 문서·Riot 직원 발언·직접 호출로 확인), **추정**(간접 근거), **미확인**(라이엇 문의 또는 추가 조사 필요).
- 경쟁 서비스 이름은 저장소 문서에 쓰지 않는다. 비교 대상은 `국내 A`~`해외 J`처럼 익명 기호로 적었다.
  - 실명, URL, 원본 JSON 스키마는 비공개 `docs-private/lol-research/`에 둔다. 저장소에는 포함하지 않는다. 대상 파일: `2026-10-23-aram-mayhem-competitors.md`, `-riot-policy.md`, `-data-sources.md`

## 1. 핵심 결론

1. **공식 API로는 아수라장 경기 데이터를 얻을 수 없다(확정).**
   - Match-V5에서 queue 2400 경기는 비공개다. 상세 조회는 403이고 매치 목록에서도 빠진다. 다만 1000경기 한도에는 포함된다.
   - Riot 직원이 "Mayhem matches are private."라고 답하며 이슈를 닫았다. [#1109](https://github.com/RiotGames/developer-relations/issues/1109), [#1175](https://github.com/RiotGames/developer-relations/issues/1175)
   - 공개를 요청한 [#1154](https://github.com/RiotGames/developer-relations/issues/1154)는 열려 있고 Riot 답변이 없다.
   - BGMS 개발 키로 두 계정의 최근 100경기를 큐별로 조회했다. queue 2400은 둘 다 0건이었고, 전체 목록의 모든 경기가 다른 큐로 설명됐다. 위 결론과 모순은 없지만, 해당 계정들이 아수라장을 플레이했는지는 확인하지 못했다.
2. **증강 승률 표시는 명시적으로 금지다(확정).**
   - "Products cannot display win rates for Augments or Arena Mode items. This applies to all websites, applications and overlays." ([LoL 개발자 정책](https://developer.riotgames.com/docs/lol))
   - 픽률·티어·추천 순위에는 명시 조항이 없다. 하지만 "Apps that dictate player decisions" 불승인 사례, "solve our games" 지양 취지와 충돌할 수 있다(문의 필요).
3. **증강의 정적 데이터는 확보할 수 있다(확정).**
   - CommunityDragon 클라이언트 추출본에서 다음을 얻을 수 있다: 현재 풀 249개, 한국어 클라이언트 이름·설명·툴팁·수치·아이콘·등급.
   - 26.21 신규 35개의 한국어 이름은 한국어 패치 노트와 클라이언트 문자열이 35개 모두 일치했다.
4. **챔피언별 증강 풀 원천 데이터는 없다(확정).** CommunityDragon의 `augmentgroups.bin`·`augmentoperators.bin`이 16.19부터 비어 있다. 따라서 "이 챔피언에게 이 증강이 안 나온다"를 공식 데이터로 판정할 수 없다.
5. **"출현 검증" 핵심 기능은 MVP에 넣지 않는다.**
   - 지금 바로 만들 수 있는 것은 공식 근거만 쓰는 도감, 패치 변경 기록, "안 나옴" 질문 안내다.
   - 관측 기반 판정은 제보 체계와 Riot 답변이 필요하므로 2·3차로 보류한다.
6. **게임 중 실시간 추천·오버레이·LCU 수집은 하지 않는다.**
   - 허용 오버레이는 "경기 전에 알 수 있는 정적 데이터"뿐이다.
   - 한국 LCU 앱 금지(2019-01)는 해제했다는 공지가 없다(미확인).

## 2. 조사 요약 (확정·추정·미확인)

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| queue 2400 = "ARAM: Mayhem" | 확정 | [queues.json](https://static.developer.riotgames.com/docs/lol/queues.json), [#1114](https://github.com/RiotGames/developer-relations/issues/1114) |
| Mayhem 경기 비공개(403, 목록 제외) | 확정 | #1109(2025-12-18 종료), #1175(2026-08), BGMS 직접 호출 |
| 아레나(1700)는 선택 증강 ID만 제공 | 확정 | 공식 문서는 `playerAugment1~4`. BGMS 호출에서 2025-07 아레나 경기 값이 `81/107/71/250/0/0`. 제시 선택지 필드는 없음. 5·6번은 항상 0([#1059](https://github.com/RiotGames/developer-relations/issues/1059)) |
| 공개 패치 26.NN = 클라이언트 16.NN | 추정(강함) | [패치 일정](https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends) "YEAR.PATCH-NUMBER", [Data Dragon versions](https://ddragon.leagueoflegends.com/api/versions.json) 최신 `16.21.1`과 개수가 일치, BGMS 저장 경기 `gameVersion 16.21.x`. Riot이 직접 밝힌 대응 문장은 없음 |
| 26.21 신규 35 / 삭제 13 | 확정 | [한국어 패치 노트](https://www.leagueoflegends.com/ko-kr/news/game-updates/league-of-legends-patch-26-21-notes/)와 [영문 패치 노트](https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-21-notes/) 모두 같음. 2026-10-20 18:00Z 공개. 신규는 실버 10, 골드 19, 프리즘 6 |
| 클라이언트 diff는 신규 40 / 삭제 14 | 확정 | 추가분 5개는 펜타킬 헤드라이너 내부 증강 `GoH_PentakillAug_*`. 삭제분 1개(`ARAM_YowchMyCoins`, id 2089)는 패치 노트에 없음(사유 미확인) |
| 헤드라이너 8종 | 확정 | 패치 노트. 디스코·꿀벌은 게임 안 이름(우주 그루브·꿀벌 유랑단)이 패치 노트와 다름 |
| 이벤트 해금 증강 목록 | 미확인 | 패치 노트에 "임무 보상으로 증강" 문구만 있음. 클라이언트 `kiwi-hub.json`도 보상을 UUID로만 참조 |
| 26.21 핫픽스 | 미확인 | 패치 노트·검색에서 찾지 못함 |
| `Enabled:false` 증강 9개 | 확정(의미는 미확인) | `kiwi.bin.json` AugmentData 플래그 |
| `buildTags`·`augmentTags`(비트마스크) 의미 | 미확인 | 챔피언 적격 조건일 가능성이 있으나 해석하지 못함 |
| 한국 LCU 앱 금지(2019) 현재 유효 여부 | 미확인 | [2019-01 공지](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy) 이후 해제 공지 없음 |
| 예외 접근(게임모드팀 계약) | 미확인 | #1154 댓글에 제3자 1인의 주장만 있음. 공개 신청 경로 없음 |

## 3. 경쟁 서비스 비교 (익명)

조사 대상은 10곳(요청 8곳 + 추가 2곳)이다. 직접 본 것과 사이트 문구로만 주장하는 것을 구분했다.

| 기호 | 지역 | 최신 패치 | 한국어 | 챔피언별 증강 | 승률 표시 | 표본 수 | 미등장 판정 | 데이터 출처(확인 문구 기준) | 제보 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 국내 A(대형 전적) | KR | 16.21 | O | O | 텍스트로는 안 보임 | 안 보임 | X | 자사 수집이라는 주장만 있음. 오버레이 배포 | X |
| 국내 B(대형 전적) | KR | 16.21 | O | O | **O** | 선택 수 O | X | 미표기. 오버레이·코칭 판매 | X |
| 국내 C(조합 도감) | KR | 당일 갱신 | O | O(큐레이션) | X | X | "현재 안 나옴" 태그(기준 미확인) | 외부 CC BY 데이터 + 영상·커뮤니티 큐레이션 | X |
| 국내 D(조합 찾기) | KR | 26.17(4패치 늦음) | O | 일부 | X | X | X | 정적 데이터 + 운영자 검토 | 텍스트 제보판 |
| 국내 E(증바람 통계) | KR | 16.21 | O | O | **O** | O(약 158만 판) | **O**(기대 등장 수 대비 0회, 기대 8회 미만이면 보류) | 클라이언트(LCU) 전적, 데스크톱 분석기 업로드, 관전 수집 | 분석기 |
| 해외 F | CN 통계 | 26.21 | 어색함 | O | **O** | 최소 기준만 공개 | X | 중국 서버 클라이언트 익명 업로드 | X |
| 해외 G(오픈 데이터) | 미공개 | 26.20 | O(7개 언어) | O | **의도적으로 제외** | X | 삭제 패치 표시 | "limited sample". 데이터 파일은 CC BY 4.0 | 조합 제출 |
| 해외 H | 미공개 | 26.20 | X | O | **O** | O | 공식 제공 조건 + "Unavailable" 필터 | 미표기 | X |
| 해외 I | 미공개 | 16.21 | 미확인 | O | 빌드 승률 | O | X(삭제 증강이 남아 있음) | "Riot doesn't provide Mayhem API data"라고 명시 | X |
| 해외 J | 미공개 | 26.21 | 미확인 | 검색으로만 확인 | 챔피언 티어 | 비어 있음 | X | 미표기 | X |

관찰 결과는 다음과 같다.

- 웹만으로 증강 데이터를 모으는 곳은 없다. 모두 클라이언트 수집·업로드·해외 통계에 기대고 있다.
- 다섯 곳이 증강 승률을 표시한다. Riot 정책에 정면으로 걸리는 영역이므로 BGMS가 따라갈 이유가 없다.
- 품질 결함이 흔하다: 내부 키 노출(`GoH_PentakillAug_Generic_BlankName`), 삭제 증강 잔존, 4패치 지연.
- 증강이 선택지에 **제시된 횟수**(offered)는 어느 곳도 공개하지 않는다.
- 국내 E의 데이터는 약관이 크롤링·재배포를 금지하므로 재사용할 수 없다.

## 4. Riot 정책 검증표

| 기능 | 판정 | 근거 |
| --- | --- | --- |
| 증강 이름·설명·아이콘 등 정적 정보 표시 | 허용 가능(자산 출처는 문의 필요) | 정적 데이터·Data Dragon은 허용 자산이다. 단, 증강은 Data Dragon에 없고 공식 매핑도 없다([#1157](https://github.com/RiotGames/developer-relations/issues/1157)). CommunityDragon은 Riot의 "Legal Jibber Jabber" 아래 운영되며 Riot이 보증하지 않는다 |
| 패치별 추가·삭제 기록 | 허용 가능 | 공식 패치 노트의 사실 정보 |
| 증강 **승률**, 승률 기반 순위·조합 점수 | **금지** | 위 정책 원문. 데이터 출처와 무관하게 "all websites, applications and overlays"에 적용 |
| 증강 픽률·티어 리스트·추천 순위 | 문의 필요(위험 높음) | "Apps that dictate player decisions", "should increase... the diversity of game decisions". 관련 출처: [docs/lol](https://developer.riotgames.com/docs/lol), [portal](https://developer.riotgames.com/docs/portal) |
| 조합(시너지) 설명 | 문의 필요 | 여러 선택지와 근거를 함께 제시("give multiple choices")하면 상대적으로 안전하다. 단일 정답을 지정하면 위험하다 |
| 게임 중 실시간 증강 추천, "지금 뜬 3개 중 고르기" | **금지에 가까움** | "previously unknown" 세션 정보 금지. "Drawing conclusions for you during gameplay" 불허([제3자 앱 안내](https://support.riotgames.com/en-us/riot/events/third-party-applications)) |
| LCU 수집 | 하지 않음 | "not officially supported", 엔드포인트 신고 필요. 게임 메모리 접근은 2026-10-06부터 차단([공지](https://support.riotgames.com/en-us/riot/performance/game-memory-access-removed-for-third-party-apps)) |
| 한국 대상 LCU 앱 | 미확인(하지 않음) | 2019-01 공지 "no longer allow players in Korea" |
| 사용자 스크린샷 제보로 만든 통계 공개 | 문의 필요 | 직접 다루는 조항이 없다. Riot이 비공개로 정한 취지를 우회하는 것으로 보일 수 있다 |
| 제품 등록 | **필수**(API를 쓰지 않아도) | "regardless of whether or not your product uses official documented APIs"([docs/lol](https://developer.riotgames.com/docs/lol)) |
| 비보증 고지 | 필수 | PR #337에서 모든 LoL 페이지 하단에 반영됨 |
| 403 우회·비공식 엔드포인트 | 하지 않음 | "The client should not continue to make similar requests."([portal](https://developer.riotgames.com/docs/portal)) |

## 5. 데이터 공급원 비교

| 공급원 | 형태 | 최신성 | 제공 내용 | 라이선스·조건 | 활용 |
| --- | --- | --- | --- | --- | --- |
| Riot 패치 노트(ko-kr·en-us) | HTML 기사 | 패치 전날 공개 | 신규·삭제·수치 변경, 헤드라이너, 이벤트 문구 | Riot 콘텐츠. 사실 인용·요약만 한다 | **MVP 1차 근거**(변경 기록) |
| CommunityDragon 버전 폴더(`16.21/`) | 클라이언트 추출 JSON | 라이브 반영 약 13시간 뒤 | `augment-lists.json`(모드별 풀, `KIWI` 249개), `cherry-augments.json`(id·이름·아이콘·등급), `kiwi.bin.json`(설명·툴팁 키·수치·플래그), `lol.stringtable.json`(ko/en 문자열) | 별도 라이선스는 없다. Riot 자산이며 CDragon 문구상 Riot 비보증이다. 출처 표기 권장, 라이엇 문의 필요 | **MVP 1차 근거**(도감) |
| 외부 오픈 데이터(해외 G) | JSON·CSV 패치별 스냅샷 | 1패치 늦음(26.20) | 픽률·픽률 순위·변화, 도입·삭제 패치(공식 기록과 어긋나는 값 있음), 7개 언어 이름 | 데이터 파일만 CC BY 4.0이다. 사이트 HTML은 판권 소유이므로 스크래핑 금지 | 2차 후보(픽률 표시 허용 여부를 Riot에 확인한 뒤) |
| 해외 F | HTML·유료 API | 26.21 | 승률·픽률(중국 서버) | 재사용 라이선스 없음, AI 크롤러 차단 | 사용 안 함 |
| 국내 E | 정적 JSON | 당일 | 승률·미등장 판정 | 약관상 크롤링·재배포 금지 | 사용 안 함 |
| GitHub 개인 데이터셋(LCU 수집) | JSON | 16.21 | 챔피언×증강 승률·풀 | 라이선스 파일 없음, LCU 경로 | 사용 안 함 |
| 공개 원시(경기별) 데이터셋 | — | — | 찾지 못함 | — | 없음 |

## 6. 증강 ID·한국어 매핑 설계

- **기본 키는 `AugmentPlatformId`이다.** `cherry-augments.json`의 `id`와 같고, 클라이언트 숫자 ID이며 삭제된 뒤에도 재사용되지 않는다(관찰).
  - 이름은 키로 쓰지 않는다. 내부 ID와 표시 이름이 다른 경우가 있다(`BloodMoneyBurn` = 타오르는 이자).
- 보조 식별자는 `augmentNameId`(예: `ArcaneAxiom`)다. `augment-lists.json` 경로의 끝 부분과 1:1로 대응하며, 249개 전부 매핑된다.
- **모드는 ID 대역이 아니라 `augment-lists.json`의 `modeName`으로 구분한다.** 아레나(CHERRY)와 아수라장(KIWI)이 같은 ID 대역을 쓰고 33개를 공유하기 때문이다.
  - `KIWI_JADE`(188개)는 의미가 미확인이므로 현재 풀로 보지 않는다.
- **한국어 이름은 클라이언트 `ko_kr` 문자열만 쓴다.** AI 번역으로 만들지 않는다.
  - 조회 경로: `kiwi.bin.json`의 `NameTra` 키 → `lol.stringtable.json` 값. 평문 키와 xxh3_64 하위 38비트 해시 키를 모두 확인한다.
  - 패치 노트 표기와 클라이언트 표기가 다르면 클라이언트 표기를 대표 이름으로 쓰고, 패치 노트 표기는 별칭으로 저장한다.
  - 영어 이름이 대문자뿐인 경우(`BEES!!!` 등)는 원문을 유지하고, 검색용 정규화 이름을 따로 둔다.
- **외부 공급원 ID는 매핑 테이블로 연결한다.**
  - 키: `(source, external_id) → platform_id`
  - 매핑 방법: 숫자 ID가 같으면 자동으로 연결하고, 이름으로만 맞춰지는 경우는 관리자 승인 대기로 둔다.
  - 충돌 검사: 외부 ID 하나가 플랫폼 ID 여러 개에 대응하거나, 같은 플랫폼 ID에 공급원별 등급이 다르면 반영을 막는다.
- **툴팁은 서버에서 렌더링한다.**
  - `@Var@`, `@Var*100@`, `@Var*-1@` 토큰을 `RootSpell` DataValues·Calculations로 치환한다.
  - `{{문자열키}}` 중첩 참조를 해석한다.
  - 서식 태그는 허용 목록으로 변환하고 나머지는 제거한다(기존 `lib/board` sanitize 방식 참고).
  - 치환에 실패한 토큰이 남으면 해당 증강을 "설명 검증 필요"로 표시하고 원문 desc만 보여준다.
  - 추출기 실측(16.21, 2026-10-23)
    - 한국어 툴팁 토큰 793회 중 338회(42.62%, 164개 증강)는 클라이언트 정적 데이터만으로 치환할 수 없었다.
    - 원인은 `f1`·`f2`·`SpellName` 같은 게임 실행 중에만 값이 정해지는 토큰과, 지원하지 않는 계산 8종(챔피언 능력치 기반)이다.
    - desc에도 토큰이 있다. 일반 증강 244개 기준 결과는 다음과 같다.
      - desc: 완전 치환 179개(73%), 일부 치환 45개, 실패 20개
      - tooltip: 완전 치환 84개(34%), 일부 치환 124개, 실패 36개
    - 표시 규칙
      - tooltip이 `ok`면 tooltip을 보여준다.
      - 아니면 desc가 `ok`면 desc를 보여준다.
      - 둘 다 아니면 desc를 보여주되, 미치환 자리를 "(수치 미확인)"으로 바꾸고 "일부 수치는 게임 안에서 확인하세요" 안내를 붙인다.
      - 미치환 값을 0이나 추정값으로 채우지 않는다.
    - 남은 65개를 줄이려면 런타임 토큰(`f1`·`f2`)의 의미 해석과 미지원 계산 8종 지원이 필요하다(2차).
- **패치 키는 클라이언트 `16.21`을 쓰고 화면에는 `26.21`을 표시한다.** 대응 표는 Data Dragon `versions.json`과 패치 노트 발행일로 매번 검증한다. 둘이 맞지 않으면 게시를 중단한다.
- **헤드라이너 전용 내부 증강**(`GoH_` 접두사)과 `Enabled:false` 증강은 도감 목록에서 분리해 표시한다. 일반 증강 수 계산에서도 뺀다.

## 7. 출현 판정 설계

### 7.1 구분해야 하는 일곱 가지

1. 선택되지 않음(제시됐지만 고르지 않음)
2. 제시되지 않음(선택지에 없었음)
3. 공식 비활성화·삭제
4. 해당 챔피언 풀에서 제외
5. 플레이어가 해금하지 않음(이벤트 보상 등)
6. 등장 조건 미충족(아이템 보유, 등급 새로고침 헤드라이너 등)
7. 데이터 미수집

선택 수나 픽률 0은 1번과 2번을 구분하지 못한다. 그래서 픽률 기반 외부 데이터만으로는 "안 나온다"를 판정하지 않는다.

### 7.2 상태 모델

| 상태 | 진입 조건 | 사용자 문구 예시 |
| --- | --- | --- |
| `official_removed` | 공식 패치 노트의 삭제 목록에 있고, 클라이언트 `KIWI` 목록에서도 빠짐 | "26.21 패치에서 삭제된 증강입니다(공식 패치 노트, 2026-10-20)." |
| `client_absent_unannounced` | `KIWI`에서 빠졌지만 패치 노트에 언급이 없음 | "26.21 클라이언트 데이터에서 빠졌지만 공식 공지는 없습니다. 확인 중입니다." |
| `official_active` | 현재 `KIWI` 목록에 있고 `Enabled`가 false가 아님 | "현재 패치(26.21) 증강 목록에 있습니다." |
| `unlock_required` | 공식 문구로 해금 대상임을 확인함 | "이벤트 임무 보상으로 해금되는 증강입니다(조건: …)." 근거가 없으면 이 상태를 쓰지 않는다 |
| `observed`(챔피언별) | 해당 패치 이후 검증된 제시 증거가 1건 이상 | "26.21에서 ○○에게 제시된 기록이 있습니다(검증된 제보 N건, 최근 MM-DD)." |
| `suspected_missing`(챔피언별) | 7.3의 조건을 모두 충족 | "26.21 이후 ○○에게 제시된 기록이 없습니다. 공식 확인은 아닙니다. (기대 제시 E회, 관측 0회, 제보자 K명)" |
| `insufficient_data` | 기본값 | "판단할 데이터가 부족합니다." |
| `external_claim_only` | 외부 출처·커뮤니티 주장만 있음 | "일부 커뮤니티에서 안 나온다는 주장이 있으나 BGMS가 검증하지 않았습니다." |
| `stale_patch` | 근거 자료의 패치가 현재 패치보다 이전 | "이 정보는 26.20 기준입니다. 26.21에서는 검증되지 않았습니다." |

전역 상태(`official_*`, `client_absent_unannounced`)와 챔피언별 상태(`observed`, `suspected_missing`, `insufficient_data`, `external_claim_only`)는 따로 저장한다. 전역 삭제는 챔피언별 판정보다 우선한다.

### 7.3 출현 중단 의심 기준 (3차, 제보 데이터가 있을 때만)

- **긍정 증거와 부정 증거는 증명 방식이 다르다.** 검증된 제시 화면 1건은 "출현 가능"을 증명한다. 반대로 미관측 수백 건은 "출현 불가"를 증명하지 못하고 의심만 높인다.
- 관측 단위는 선택 화면 한 번이다(그 시점에 제시된 증강 3개). 선택 결과가 아니다.
- 필요한 기대 제시 수는 다음과 같이 계산한다.
  - 같은 등급 선택 기회 중 해당 챔피언의 검증된 화면 수 n_c
  - 같은 패치·같은 등급에서 다른 챔피언들에 대한 그 증강의 제시 비율 p(최근 패치 전체)
  - 기대 제시 수 E = n_c × p × 3
- 판정 조건(모두 충족해야 `suspected_missing`)
  1. E ≥ 10이고 관측 0이다.
  2. 직전 패치에서 같은 챔피언에게 관측된 적이 있다. 처음부터 관측이 없었다면 "원래 안 나옴 의심"으로 따로 표기한다.
  3. 서로 다른 제보자 수가 5명 이상이다. 같은 제보자의 여러 화면을 1명으로 줄여 계산해도 E ≥ 10을 충족한다.
  4. 해당 증강이 전역으로 비활성화되지 않았고, 해금 대상이 아니다.
  5. 등급 새로고침 헤드라이너(커맨드 라인 등)가 적용된 화면은 제외하고 계산했다.
  6. 패치·핫픽스 경계 이후의 화면만 사용했다.
- **이항·포아송 확률을 그대로 쓰지 않는다.** 제보는 독립 표본이 아니다. 희귀·재미 화면이 과대 제보되고, 같은 플레이어가 반복 제보하고, 시간대가 몰린다. 그래서 확률값(p-value)을 보여주지 않고, 위 조건을 충족한 "의심" 상태와 E·관측·제보자 수만 공개한다.
- 해제 조건: 검증된 제시 증거가 1건 나오면 즉시 `observed`로 바꾸고 이력에 "재관측"을 남긴다.

### 7.4 반례 (허위 판정 방지)

- 이벤트 해금 증강: 해금하지 않은 플레이어의 화면이 대부분이면 미관측처럼 보인다 → 해금 대상 목록이 미확인인 동안 해당 증강은 판정에서 제외한다.
- 아이템·조건부 제공(예: 특정 아이템 보유 시 미제공): 조건을 모르면 챔피언 제외로 오인한다 → 조건부 플래그 해석 전에는 "조건부 가능성 있음" 경고를 붙인다.
- 헤드라이너 규칙: 등급과 선택지 수가 바뀐다 → 헤드라이너 정보 없는 화면은 판정에서 뺀다.
- 등급 쏠림: 프리즘 선택 기회가 적은 챔피언은 E가 작다 → 등급별로 계산한다.
- 이름 변경·ID 변경: 이름이 같아도 ID가 다르면 다른 증강이다 → ID로만 집계한다.
- 클라이언트 데이터 diff 오류: `Yowch` 사례처럼 공지 없이 빠질 수 있다 → `client_absent_unannounced`로 두고 확정하지 않는다.
- 외부 픽률 0: 선택 안 됨일 수 있다 → 출현 판정에 쓰지 않는다.

## 8. 커뮤니티 제보 (3차, Riot 문의 결과에 따라)

- 입력 항목: 챔피언, 패치(자동 제안 + 확인), 경기 시각(대략), 선택 화면 이미지 1장, 화면에 보인 증강 3개(이미지 인식 제안 + 사용자 확인), 헤드라이너 종류
- 업로드 보호
  - PNG/JPEG/WebP만 받고 최대 5 MB, 해상도는 상한을 둔다.
  - 서버에서 다시 인코딩해 EXIF와 메타데이터를 제거한다.
  - 기존 게시판의 Turnstile과 작성 쿼터(`lib/board`)를 재사용한다.
  - 지각 해시로 중복을 탐지하고, 같은 화면의 재업로드를 차단한다.
- 개인정보
  - 채팅·Riot ID·친구 목록 영역은 업로드 전 클라이언트에서 가리기를 안내한다.
  - 서버에서는 선택 화면 영역만 잘라 저장한다.
  - 제보자는 BGMS 계정 ID만 저장한다. Riot ID는 받지 않는다.
- 저장: 원본은 Supabase Storage 비공개 버킷 `lol-augment-evidence`에 30일 둔다. 기존 `support-evidence` 비공개 버킷과 같은 방식이다.
  - 검증 뒤에는 잘라낸 증거 이미지와 판독 결과만 남긴다.
  - 공개하는 증거 이미지는 내용 해시를 경로에 넣어 같은 경로의 내용이 바뀌지 않게 한다. 게시판 이미지 프록시(`app/api/board/images/[...path]/route.ts`)처럼 1년 `immutable` CDN 캐시로 내보낸다. 원본 Storage 다운로드는 경로별 첫 요청(CDN 캐시 미적중)에만 생긴다.
  - 승인 전 원본은 관리자만 `private, no-store`로 열람한다.
  - 삭제 요청은 고객센터에서 처리한다. 공개 이미지는 경로를 무효화하고 DB 참조를 끊는다. 이미 퍼진 CDN 캐시는 만료 전까지 남을 수 있으므로 삭제 요청 처리 때 Vercel 캐시 무효화를 함께 실행한다.
- 검토: 관리자 승인 전에는 통계에 반영하지 않는다. 신고가 들어오면 재검토하고, 판정을 바꿀 때 이력을 남긴다. 허위 제보가 반복되면 작성을 제한한다.
- 이미지 인식
  - 아이콘 대조가 1차다. 249개 아이콘 템플릿 매칭이나 지각 해시로 하며, 비용은 서버 CPU 정도다.
  - 실패할 때만 멀티모달 모델을 쓴다. 기존 Gemini 경로를 쓰며 건당 수 원 이하로 추정한다(미검증).
  - 정확도는 관리자 검토 샘플로 측정한다. 95% 미만이면 자동 제안을 끈다.
- 정책: 스크린샷 기반 통계 공개는 Riot 문의 대상이다(4절). 답변 전에는 "제시 증거" 개별 열람만 허용하고 집계 통계는 공개하지 않는다.

## 9. 사례별 화면 문구 (26.21)

| 사례 | 예 | 보여줄 문구·증거 | 주의사항 |
| --- | --- | --- | --- |
| A. 공식 제거 | 도박꾼(High Roller, 2095) | "26.21에서 삭제됨". 링크: 패치 노트(2026-10-20). 함께 표시: 클라이언트 목록 제외 확인 | 26.21 이전 패치 페이지에서는 "당시 존재"로 표시 |
| B. 데이터상 선택되지 않음 | 외부 픽률 매우 낮음 | **화면에 표시하지 않는다.** 픽률 표시 자체를 보류한다 | 픽률 0을 "안 나옴"으로 쓰지 않음 |
| C. 특정 챔피언 미출현 추정 | 사용자 예시(럼블·취약) | 제보 데이터가 없으므로 "판단할 데이터가 부족합니다. 26.21 공식 패치 노트에는 해당 챔피언 제한이 없습니다." | 3차 전에는 `suspected_missing`을 쓰지 않음 |
| D. 이벤트 해금 | 임무 보상 증강 | "이번 패치는 임무 보상으로 증강이 해금됩니다(패치 노트). 어떤 증강이 대상인지는 아직 확인되지 않았습니다." | 목록 확인 전에는 개별 증강에 해금 배지를 달지 않음 |
| E. 신규라 데이터 없음 | 비전 원칙(3118) 등 35개 | "26.21 신규 증강. 출현·선택 데이터가 아직 없습니다." | 이전 패치 통계와 섞지 않음 |
| F. 다시 등장 | 26.18 "다시 활성화" 사례 | "26.18에서 다시 활성화됨"(패치 노트 링크). 이력에 삭제·복귀 구간 표시 | 외부 데이터셋의 도입·삭제 패치는 공식 기록과 어긋날 수 있어 사용하지 않음 |

## 10. 데이터 모델 (Supabase, 신규 `lol_augment_*`)

기존 계약을 따른다: `public.lol_*` 접두사, RLS를 켜고 anon·authenticated 권한을 회수, service_role 전용 RPC, security invoker, `search_path ''`. 기존 LoL 전적 테이블과는 외래 키로 연결하지 않는다(독립).

| 테이블 | 주요 열 | 비고 |
| --- | --- | --- |
| `lol_game_patches` | `client_patch`('16.21') PK, `display_patch`('26.21'), `released_at`, `ddragon_version`, `cdragon_version`, `notes_url_ko`, `notes_url_en`, `verified_at` | 패치 대응 표. 전적 쪽 패치 표시에도 재사용 가능 |
| `lol_augments` | `platform_id` PK, `name_id`, `rarity`, `icon_small_path`, `icon_large_path`, `first_seen_patch`, `last_seen_patch`, `is_internal`(GoH), `updated_at` | 이름은 키가 아님 |
| `lol_augment_patch_states` | (`platform_id`, `client_patch`, `mode_name`) PK, `in_pool`, `enabled`, `quest`, `ability`, `build_tags`, `augment_tags`, `data_values` jsonb, `source_hash` | 패치별 스냅샷. 수치 변경 diff의 기준 |
| `lol_augment_localizations` | (`platform_id`, `client_patch`, `locale`) PK, `name`, `description`, `tooltip_raw`, `tooltip_rendered`, `render_status` | ko_kr·en_us. 패치마다 문구가 바뀔 수 있음 |
| `lol_augment_aliases` | (`platform_id`, `alias`) PK, `kind`(patch_note·search·en_upper), `source_id` | 검색·패치 노트 표기 차이 |
| `lol_augment_patch_changes` | id, `client_patch`, `platform_id` null 허용, `change_type`(added·removed·reenabled·changed·unannounced_absent), `official` bool, `summary_ko`, `source_id`, `review_status` | 공식 노트 + 클라이언트 diff를 합친 결과. 불일치는 검토 대기 |
| `lol_augment_champion_states` | (`platform_id`, `champion_id`, `client_patch`) PK, `state`, `expected`, `observed`, `reporters`, `evidence_count`, `computed_at`, `published` | 3차. 2차까지는 외부 주장만 기록 |
| `lol_augment_evidence` | id, `platform_id`, `champion_id`, `client_patch`, `kind`(screenshot·official_note·client_data·external), `offered_ids` int[], `headliner`, `image_path`(Storage, 내용 해시 경로), `image_phash`, `submitter_user_id`, `review_status`, `expires_at` | 제보·공식 근거 공통. 원본 30일 |
| `lol_augment_claims` | id, `platform_id`, `champion_id` null 허용, `claim`, `source_url`, `seen_at`, `status` | 외부 주장(검증 전) |
| `lol_augment_data_sources` | id, `kind`, `url`, `license`, `attribution`, `enabled`, `blocked_reason` | 라이선스가 바뀌면 `enabled=false` |
| `lol_augment_external_ids` | (`source_id`, `external_id`) PK, `platform_id`, `match_method`, `approved_by` | 충돌 검사는 unique와 검증 RPC로 |
| `lol_augment_ingestion_runs` | id, `source_id`, `client_patch`, `started_at`, `finished_at`, `status`, `snapshot_path`(Storage), `counts` jsonb, `error_code`, `lease_until` | 중복 실행 방지(lease), 실패 시 이전 게시본 유지 |

- 읽기 최적화: 공개 화면은 "게시된 패치" 기준의 비정규화 뷰 또는 RPC 하나로 읽고, Next 쪽 캐시(ISR 또는 `use cache`, 패치 단위 태그)로 둔다. 증강이 249개 수준이라 DB 부하는 무시할 만하다.
- 보존
  - 패치 스냅샷·변경 기록은 영구 보존한다. 연 26패치 × 약 250행이다.
  - 제보 원본 이미지는 30일, 증거 이미지는 판정에 쓰이는 동안 보존한다.
  - 외부 주장은 90일 뒤 검토하고 만료 처리한다.
- 기존 LoL DB와의 관계
  - `lol_matches`·`lol_benchmark_*`와 공유하는 키는 없다. 챔피언 ID만 같은 Riot 숫자 ID다.
  - 아수라장 경기는 Match-V5에서 오지 않으므로 기존 벤치마크·요약 테이블에는 들어갈 경로가 없다.

## 11. 수집 파이프라인

1. **패치 감지(GitHub Actions 하루 1회 + 수동 실행)**: Data Dragon `versions.json`과 CommunityDragon 버전 폴더 목록을 확인한다. 새 `16.NN`이 있으면 실행을 시작한다.
2. **스냅샷**: 필요한 파일 5종을 내려받아 Supabase Storage 비공개 버킷 `lol-augment-snapshots`에 `{client_patch}/{sha256}.json` 경로로 원본과 해시를 저장한다. 수집 파이프라인만 읽으므로 외부 전송량은 거의 없다.
   - 대상: `augment-lists`, `cherry-augments`(ko/en), `kiwi.bin`, `kiwi-hub`, `stringtable`(ko/en)
   - 크기 상한과 타임아웃을 두고, 내려받은 JSON은 데이터로만 파싱한다.
3. **추출·검증**
   - `KIWI` 풀, ID, 이름, 툴팁, 수치를 추출한다.
   - 다음 중 하나라도 해당하면 게시를 차단한다: 풀 수가 직전 대비 ±30% 넘게 변동, 이름 누락 3개 초과, 등급 불일치.
   - 미치환 토큰 비율은 패치 전체 차단 기준으로 쓰지 않는다. 실측에서 런타임 토큰 때문에 42.62%가 나오기 때문이다.
     - 대신 증강별로 6절 표시 규칙(tooltip → desc → "수치 미확인" 표기)을 적용한다.
     - desc가 비어 있는 증강이 있으면 차단한다(16.21 실측 0개).
     - desc 완전 치환 비율이 직전 패치보다 10%p 넘게 떨어지면 관리자 검토로 넘긴다. 16.21 기준값은 73%다.
     - 현재 `validate.ts`의 5% 기준은 2번 PR에서 이 규칙으로 바꾼다.
4. **패치 노트 대조(반자동)**
   - 패치 노트 URL 규칙: `league-of-legends-patch-26-NN-notes/`
   - 본문에서 아수라장 섹션의 신규·삭제 목록을 추출해 클라이언트 diff와 비교한다.
   - 일치하는 항목은 자동으로 반영한다. 불일치(GoH, 미공지 삭제)는 관리자 검토 큐로 보낸다.
5. **외부 데이터(2차)**: 허용된 공급원의 패치를 확인한다. 현재 패치와 다르면 "이전 패치 자료"로 표시하고 별도로 저장한다.
6. **게시**: 관리자가 승인해야 공개 버전이 바뀐다. 실패하거나 차단되면 이전 게시본을 유지하고 관리자 화면에 사유를 보여준다.
7. **안전장치**
   - 실행 lease로 중복 실행을 막는다(기존 `lol_collection_leases` 패턴).
   - 재시도는 지수 백오프로 최대 3회 한다.
   - 공급원별 요청 간격을 1초 이상으로 둔다. Cloudflare 캐시를 존중한다.
   - 라이선스·robots가 바뀌면 해당 공급원을 자동으로 비활성화한다.
   - 실행 로그는 `ingestion_runs`에 남긴다.
- **비용 추정**(가정: 패치당 약 50 MB 원본, 연 26패치)
  - Supabase Storage
    - 스냅샷은 연 약 1.3 GB다. 원본 대신 추출본만 남기면 더 줄어든다.
    - 2026-10-23 운영 Storage 사용량은 버킷 5개 합계 약 24 MB라서, 유료 플랜 포함 용량 안에서 추가 비용은 사실상 없다(요금표는 적용 시점에 공식 페이지로 다시 확인).
    - Storage 파일은 DB 일일 백업에 포함되지 않는 것으로 안다. 하지만 스냅샷은 CommunityDragon에서 다시 받을 수 있고, 제보 원본은 30일 뒤 지울 데이터라 별도 백업은 두지 않는다.
  - 이미지 전송
    - 증강 아이콘(249개, 수 MB)은 버전 고정 경로를 Next 이미지 최적화나 1년 `immutable` 캐시 프록시로 내보낸다.
    - 제보 증거 이미지도 같은 방식이다.
    - 원본 다운로드는 CDN 캐시 미적중 때만 생긴다. 공개 이미지 트래픽이 커져 미적중 전송량이 문제가 될 때만 R2(외부 전송 무료) 이전을 검토한다.
  - Supabase DB: 연 수천 행이라 무시할 만하다.
  - GitHub Actions: 하루 1분 이내 확인 + 패치일에 수 분 정도다.
  - Vercel: 정적에 가까운 공개 페이지라 ISR 캐시를 적중하면 함수 호출이 적다.
  - 3차 제보: 이미지 저장 30일, 인식 비용은 제보 수에 비례한다(미추정).

## 12. 페이지 구조와 모바일 UX

모든 경로는 `/lol` 아래에 두고, PR #337의 공개 레이아웃·법적 고지·광고 차단을 따른다. 공개 전에는 같은 플래그(`LOL_PUBLIC_ENABLED`) 또는 별도 플래그 뒤에 둔다.

| 경로 | 내용 | 색인 |
| --- | --- | --- |
| `/lol/aram-mayhem` | 현재 패치 요약(신규·삭제 수, 헤드라이너), 검색, 등급 필터 | 공개 후 색인 |
| `/lol/aram-mayhem/augments/[platformId]-[slug]` | 한국어 이름·설명·수치(등급별), 아이콘, 상태 배지, 패치 이력, 영문 이름 | canonical은 ID 기준. slug가 달라도 같은 문서 |
| `/lol/aram-mayhem/patches/[displayPatch]` | 패치별 추가·삭제·수치 변경·헤드라이너, 공식 링크 | 패치 단위 |
| `/lol/aram-mayhem/champions/[championKey]` | 챔피언 기본 정보. "증강 제한 공식 정보 없음"이나 근거 있는 제한 표시. 2차부터 관측 정보 | 데이터가 있는 챔피언만 색인 |
| `/lol/aram-mayhem/faq/augment-missing` | "증강이 안 나와요" 안내: 7.1절 일곱 가지 원인, 확인 방법, 판단 기준 | 색인 |

- 모바일 우선
  - 검색창은 상단에 고정한다. 결과는 아이콘·이름·등급·상태 배지의 한 줄 카드로 보여준다.
  - 상세 화면은 "설명 → 수치 → 이력 → 근거" 순서로 접는다.
  - 뷰포트는 기존 기준(375/390/430/데스크톱)으로 확인한다.
- 검색
  - 한국어 공식 이름, 영문 이름, 별칭, 초성을 지원한다(PUBG 쪽에 초성 검색 유틸이 있는지 확인 필요).
  - 효과 본문 전문 검색도 지원한다(데이터가 249개라 클라이언트 측 검색으로 충분).
- SEO
  - `title.absolute`를 쓰고, 증강 상세에는 `Article` 또는 `DefinedTerm` 구조화 데이터를 넣는다.
  - 패치별 페이지와 증강 상세의 중복을 피하기 위해 패치 페이지는 요약과 링크만 둔다.
  - 공개 승인 전에는 noindex를 유지한다.
- 정책 경계
  - 승률·승률 순위는 표시하지 않는다.
  - 픽률은 Riot 답변 전까지 표시하지 않는다.
  - 조합은 "근거 있는 설명 + 여러 선택지" 형태로만 보여준다.
  - AI가 생성한 문장은 "AI 요약" 배지로 데이터와 구분하고, 검증되지 않은 시너지를 단정하지 않는다.

## 13. 로드맵

| 단계 | 범위 | 데이터 | 정책 위험 | 난이도 |
| --- | --- | --- | --- | --- |
| **MVP** | 도감(현재 풀 249개, 한국어 이름·설명·수치·아이콘·등급), 패치 변경 기록(26.21부터, 공식 노트 + 클라이언트 diff 검토 결과), 검색, "안 나옴" FAQ, 해금·헤드라이너 안내(확인된 문구만) | CommunityDragon + 패치 노트 | 낮음(제품 등록·자산 출처 문의만 필요) | 중간(툴팁 렌더링·해시 키) |
| 2차 | 챔피언 페이지, 근거 있는 조합 설명(큐레이션), 외부 주장 기록, 과거 패치 소급(16.10 이후 CDragon 버전 폴더), 신뢰 수준 표시. Riot이 허용하면 픽률(출처 표기) | + 외부 CC BY 데이터(조건부) | 중간(픽률·조합은 Riot 답변 필요) | 중간 |
| 3차 | 스크린샷 제보, 제시 증거 열람, 챔피언별 상태 계산, 출현 중단 의심 알림 | + 제보 | 높음(Riot 문의 필수) | 높음(업로드 보안·검토 운영) |
| 보류·제외 | 증강 승률, 승률 기반 티어·추천, 게임 중 실시간 추천, LCU·오버레이, 외부 사이트 크롤링 | — | 금지 또는 미확인 | — |

## 14. PR #336·#337과의 관계

### 14.1 재사용할 모듈

| 모듈 | 용도 |
| --- | --- |
| `lib/lol/access.server.ts`(관리자 가드), `app/admin/lol/layout.tsx` | 증강 수집 검토·승인 관리자 화면 |
| `lib/lol/publicAccess.server.ts`(공개 플래그·IP 제한), `lib/lol/routes.server.ts` | 공개 증강 페이지·검색 API |
| `components/lol/LolLegalNotice.tsx`, `SidebarFooterWrapper`의 `/lol` 광고 차단 | 증강 페이지에 그대로 적용 |
| `lib/lol/ops.server.ts`(운영 지표), `lol_collection_leases` 패턴 | 수집 실행 지표·중복 실행 방지 |
| `riotSearch.server.ts`의 Data Dragon 로더(`LOL_DATA_DRAGON_VERSION`) | 챔피언 이름·아이콘(한국어) |
| `lib/server/serviceRoleSupabase.server.ts`(Storage 비공개 버킷 접근), `support-evidence` 버킷 운영 방식 | 스냅샷·제보 원본 저장 |
| `app/api/board/images/[...path]/route.ts`(Storage 원본 → 1년 `immutable` CDN 캐시 프록시) | 증강 아이콘·공개 증거 이미지 전송 |
| `lib/board`의 HTML sanitize, Turnstile, 작성 쿼터 | 툴팁 정리(MVP), 제보(3차) |

### 14.2 새로 필요한 모듈

- `lib/lol/augments/`
  - `cdragonClient.server.ts`: 버전 고정, 크기 상한
  - `extract.ts`: 풀·이름·해시 키·수치
  - `tooltip.ts`: 토큰 치환, 허용 태그
  - `patchMap.ts`: 16.NN ↔ 26.NN 대응
  - `diff.ts`: 패치 간 비교
  - `persistence.server.ts`: RPC 래퍼
- `scripts/lol_augments_ingest.ts`와 `.github/workflows/lol-augments-sync.yml`
- `app/admin/lol/augments/`(검토·게시), `app/lol/aram-mayhem/**`(공개), `components/lol/augments/**`
- migration 1개(`lol_augment_*` 테이블 + RPC)와 검증 시나리오 SQL. `scripts/verify_migrations_local.sh` 목록도 갱신한다.

### 14.3 독립성과 기존 기능 수정 여부

- 증강 콘텐츠는 Riot API 키를 쓰지 않는다. 전적 수집기·호출 가드·캐시·벤치마크와 데이터 경로가 분리된다.
  - 키가 만료되거나 429가 나도 증강 페이지는 영향을 받지 않는다.
  - 반대로 증강 수집이 Riot 호출 예산을 쓰지도 않는다.
- **MVP에서 기존 기능을 수정할 필요는 없다.** 다만 다음 두 가지는 별도의 작은 PR로 권장한다.
  1. `lib/lol/summary.ts`와 `LolSearchPanel`의 칼바람 필터 `queueId === 450 || gameMode === "ARAM"`에서 `gameMode` 조건을 빼고 queueId만 쓴다. 지금은 2400 경기가 목록에 오지 않아 섞이지 않는다. 하지만 Riot이 공개로 바꾸고 gameMode를 "ARAM"으로 주면 일반 칼바람 통계에 섞인다.
  2. 패치 대응 표(`lol_game_patches`)를 전적 화면의 패치 표시에도 쓰도록 연결한다(선택).
- 회귀 위험
  - PUBG: 새 테이블·라우트·워크플로만 추가하므로 낮다.
  - 공유 지점: `SidebarFooterWrapper`(이미 #337에서 `/lol` 처리), sitemap·robots(공개 시), 같은 Supabase 자원(행 수가 작음).
  - LoL 관리자: 관리자 레이아웃에 메뉴를 하나 추가하는 정도다.

### 14.4 병합 전후 순서

- **#336·#337 병합 전에 할 수 있는 일**(충돌 없음)
  - 추출기·툴팁 렌더러·패치 대응 순수 모듈과 단위 테스트(`lib/lol/augments/*`, fixture는 CDragon 일부 발췌)
  - 26.10~26.21 스냅샷 추출 실험(로컬)
  - Riot 문의 발송, 제품 등록 문구 준비
- **병합 후에 할 일**
  - migration 적용(파일 하나씩 적용하는 기존 절차)
  - 관리자 검토 화면, 수집 워크플로, 공개 페이지(#337의 공개 가드 사용)
- 충돌 위험
  - `scripts/verify_migrations_local.sh`의 목록 배열(#336에서도 수정함) → 병합 후 작업하면 해소된다.
  - `docs/project-map.md` 링크 → 마지막 PR에서 한 번만 수정한다.

### 14.5 후속 PR 단위 제안

1. `feat: LoL 증강 정적 데이터 추출기와 툴팁 렌더러`: 순수 모듈 + 테스트. DB·화면 없음. 병합 전에 시작할 수 있다.
2. `feat: LoL 증강 저장 테이블과 수집 실행 기록`: migration + RPC + 검증 SQL.
3. `feat: LoL 증강 수집 워크플로와 관리자 검토 화면`: Actions, Storage 스냅샷 버킷, 게시 승인.
4. `feat: 아수라장 증강 도감·패치 기록 공개 페이지(플래그)`: 공개 경로, 검색, FAQ, SEO.
5. `fix: 칼바람 필터에서 gameMode 조건 제거`: 독립. 작은 PR.
6. (2차 이후) 챔피언 페이지·외부 데이터·제보는 Riot 답변 뒤 별도 설계 PR.

## 15. 개발 전 Blocker

| # | 항목 | 담당 | 영향 |
| --- | --- | --- | --- |
| 1 | Riot 제품 등록(API 미사용 콘텐츠도 등록 대상), 증강 아이콘·이름의 공식 정적 데이터 출처 문의 | 사용자(Developer Portal) | 공개 전 필수 |
| 2 | Riot 문의: 픽률·티어·조합 지표 허용 여부, "Augments" 승률 금지의 아수라장 적용 범위, 스크린샷 제보 통계 허용 여부, 2400 예외 접근 경로, RSO match API의 2400 포함 여부, 한국 LCU 금지 현행 여부 | 사용자 | 2·3차 범위 결정 |
| 3 | PR #336·#337 병합 | 사용자 | 공개 경로·가드·DB 재사용 |
| 4 | 이벤트 해금 증강 목록 확보 방법(공식 공지가 나오는지) | 조사 | D 사례 문구 |
| 5 | `buildTags`·`augmentTags` 비트마스크 의미 해석 | 조사 | 챔피언 제한 공식 근거 |
| 6 | `KIWI_JADE`의 의미 | 조사 | 현재 풀 정의 |
| 7 | 헤드라이너 이름 기준(패치 노트 vs 게임 안 이름) | 사용자 결정 | 표기 일관성 |

## 16. 검증 기록

- 문서만 변경했다. 코드·migration·운영 설정은 바꾸지 않았다.
- 운영 DB는 읽기만 했다. `lol_matches`의 큐 분포는 420·440만 있었고, 2400·450 경기는 0건이었다.
- Riot API(개발 키)로 공식 엔드포인트만 호출했다(약 30회). Account-V1, match ids의 queue 필터(400·420·440·450·480·490·900·1700·1900·2400), 아레나 경기 상세 1건이다. 403 우회는 시도하지 않았다.
- 외부 사이트는 공개 페이지만 열람했다(로그인·제출 없음). 대량 수집은 하지 않았다.
