# LoL Production Key 신청 준비 점검 (2026-10-23)

Riot 공식 문서(Developer Portal 문서, General Policies, League of Legends 게임별 정책, API Terms)를 2026-10-23에 직접 읽고 현재 구현과 대조했다. 정책 문구는 요약이며 신청 직전에 원문을 다시 확인한다.

## 1. 신청 절차와 Riot이 보는 것

- 절차: Developer Portal 로그인 → Register Product → 대규모 제품(Production) 선택 → 제품 정보 양식 → 개발자 본인 확인(verify) → Developer Relations 검토 → 포털 메시지로 승인·거절·질문.
- 제품마다 별도 등록·승인. PUBG용 등록과 무관하게 LoL 제품을 새로 등록한다. Production 키 하나를 여러 제품에 쓰지 않는다.
- 검토 기준: 정책·법 위반 없음, 플레이어에게 측정 가능한 도움(성장·추적), 게임을 대신 풀지 않음, 완성도(미완성 사이트는 승인 가능성 낮음).
- 증빙: "Riot이 테스트할 수 있는" 동작 사이트·프로토타입 또는 사용자 흐름이 보이는 목업, 그리고 그 **링크**. 계정 생성·로그인·주요 흐름을 이해할 수 있어야 한다.
- Development Key는 24시간마다 비활성화되며 공개 제품 운영 금지(오픈 알파·베타 포함).
- 시작 한도: Production 500회/10초, 30,000회/10분(리전별). Personal 키는 20회/초, 100회/2분이며 증설 불가.

## 2. 승인·불승인 용도 (LoL 게임별 정책)

- 승인 예시: 본인 플레이어 통계, 자기 전적·집계를 보는 훈련 도구, 특정 플레이어가 아닌 집계 통계, 공식 래더 리더보드, LFG, 경기 전 정적 정보 오버레이.
- 불승인 예시: 증강·아레나 아이템 승률 표시, 플레이어가 몰랐던 게임 세션 정보 제공, 플레이어 결정을 지시하는 앱, 사용자 지정(커스텀) 게임 전적을 본인 동의 없이 공개 표시.
- 게임 무결성: 공식 랭크 대체(MMR·ELO 계산기) 금지, 보이는 정보로 식별 불가능한 플레이어 비익명화 금지, **플레이어의 과거 Riot ID 노출 금지**, 결정 다양성 감소·결정 제거 금지(중요 결정을 강조하고 여러 선택지를 주는 것은 허용).
- 수익화: 등록 상태가 Approved/Acknowledged일 때만, 무료 등급 필수(광고 가능), 유료 콘텐츠는 변형적이어야 함, 도박·암호화폐 금지.
- 법적 고지: 플레이어가 쉽게 볼 수 있는 곳에 공식 문구 게시 — "[제품명] isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc."
- 데이터: Riot 지원 서비스로 수집, 키는 서버에만·HTTPS. Riot이 전달하는 최종 사용자 개인정보 삭제 요청(GDPR) 처리, 약관 종료 시 보유 게임 정보 전부 삭제.

## 3. 현재 상태 대조

| 항목 | 상태 | 근거 / 남은 일 |
| --- | --- | --- |
| Riot ID 기반 검색(소환사명 미사용) | 충족 | Account-V1 by-riot-id → PUUID 흐름 |
| API 키 서버 전용·HTTPS | 충족 | 서버 route에서만 호출, 클라이언트 비노출 |
| 429·Retry-After 준수 | 충족 | 중앙 쿨다운·헤더 감속·lease 2·1.5초 간격 |
| MMR·자체 실력 점수 없음 | 충족 | 합산 KDA·공식 랭크만 표시. 향후 "경기 기여 점수"는 경기 단위·근거 공개·순위화 금지로 설계 |
| 커스텀 게임 비공개 | 충족 | queueId 0·CUSTOM_GAME을 목록·요약·집계에서 제외 |
| 집계 통계 익명성 | 충족(진행 중) | 벤치마크 집계에 PUUID·Riot ID 미저장 |
| 삭제 요청 처리 | 충족 | 관리자 계정 데이터 삭제 RPC·UI(fixture 검증) |
| 과거 Riot ID 노출 금지 | 해석 확인 필요 | 경기 원문의 참가자 Riot ID는 경기 당시 이름이며, 다른 공개 전적 서비스도 옛 경기에 당시 이름을 그대로 표시한다(관찰). 조항은 이름 변경 이력 조회·옛 이름→현재 계정 연결 같은 기능을 겨냥한 것으로 해석한다(추정). 원칙: 이전 닉네임 목록·옛 이름 검색 연결 기능을 만들지 않고, `lol_accounts`는 현재 이름만 유지. 신청서에 명시해 Riot 판단을 받는다 |
| 법적 고지 공식 문구 | 부분 | 현재 한국어 번역 문구만 있음. 영문 공식 문구(제품명 포함)를 함께 게시 |
| Riot이 테스트 가능한 동작 사이트 링크 | 미충족 | 현재 관리자 전용·로컬. 검토용 공개(또는 검토자 접근 가능) 경로 필요 |
| 사용자 흐름 설명 자료 | 미충족 | 검색→전적→상세→더 보기→갱신 흐름 캡처·설명 |
| 개인정보처리방침·이용약관 LoL 항목 | 미충족 | 현재 방침은 PUBG 90일 문구. LoL 보관(영구 기록·7일 원문)·삭제 요청 방법 추가 |
| 광고 | 보류 | 승인(Approved/Acknowledged) 전 LoL 페이지 광고 금지 |
| AI 코칭 | 미구현 | "지시"가 아닌 근거 제시·선택지 제공 형태로 설계 |
| Development Key 24시간 만료 대응 | 부분 | 운영 패널 '키 확인 필요' 표시. 실서비스는 Production 키로만 |

## 4. 실서비스 전 해야 할 일 (권장 순서)

1. **이름 이력 기능 금지 원칙 확정**: 경기 당시 이름 표시는 유지, 이름 변경 이력·옛 이름 연결 기능은 만들지 않음. 신청서에 명시.
2. **검토용 공개 경로**: `/lol/kr/<Riot ID>` 등 공개 라우트(또는 기능 플래그로 검토 기간만 열기). 게임 전환 메뉴는 이후. PUBG URL(`/`, `/maps/*`, `/stats/*`) 유지.
3. **법적 고지**: 영문 공식 문구 + 한국어 번역을 LoL 모든 페이지 하단에.
4. **개인정보처리방침·약관 LoL 항목**: 수집 항목, 보관 기간, 삭제 요청 경로(문의 채널), Riot 데이터 출처.
5. **신청 자료**: 제품 설명(플레이어 성장 지원 — 본인 전적·집계 통계·경기 복기), 사용자 흐름 스크린샷, 호출량 추정(검색당 4~9회, 더 보기 0~6회, 갱신 쿨다운 120초), 데이터 보관·삭제 정책, 보안(키 서버 전용·RLS).
6. **배포 환경 검증**: Vercel Preview에서 검색·더 보기·갱신·운영 패널 동작, 첫 컴파일 지연 없는 환경에서 타임아웃 재확인.
7. 승인 후: Production 키 교체, 호출 간격·동기 상세 수 상향, 광고 적용 여부 결정, 래더 수집·벤치마크 확대.

## 5. 결정이 필요한 사항

1. (해결됨) 과거 Riot ID: 경기 당시 이름 표시 유지 + 이름 이력 기능 금지. Riot 해석은 신청 시 확인. 필요 시 Developer Discord 사전 문의.
2. 검토용 공개 범위: 공개 라우트를 바로 열지, 검토 기간 한정 플래그로 열지.
3. 제품명: 신청서·법적 고지에 쓸 이름(예: "BGMS LoL").

## 6. 확인하지 못한 것

- 신청 양식의 실제 항목(문서에 구체 항목 없음, 로그인 후 확인 필요).
- 본인 확인(verify) 방식의 구체 절차.
- 검토 소요 기간(문서상 프로젝트·리전에 따라 다름).
- "Showing (self) player stats" 문구가 타인 Riot ID 검색 서비스를 어디까지 포함하는지 — 일반 전적 사이트 관행상 허용되나 신청서에 "공개 전적 조회"임을 명확히 적고 Riot 판단을 받는다.

출처: Riot Developer Portal 문서·General Policies·API Terms(developer.riotgames.com), League of Legends 게임별 정책(support-developer.riotgames.com, 2026-10-23 열람).


## 7. 참가자 이름(과거 Riot ID) 정책 검토 (2026-10-23)

- **D안 구현됨 (2026-10-23):** 서버 PUUID 보관, 봉인 ref 이동, `known_current` 기본 이름 덮어쓰기와 `match_time` 폴백을 추가했다. 아래 현황·설계안은 구현 전 검토이며 실제 계약은 [참가자 식별자 문서](2026-10-23-lol-participant-identity.md)를 따른다.

### 근거 구분
- **Riot 공식(확정):** LoL 게임별 정책에 "Products may not expose a player's historic Riot IDs"가 있다. 이 조항이 Match-V5 경기 데이터에 담긴 당시 Riot ID를 전적 화면에 표시하는 것까지 포함하는지는 공식 문서에 명시되어 있지 않다(미확인). Match-V5 `riotIdGameName`이 경기 시점 값인지 현재 값인지도 공식 문서에서 찾지 못했다(미확인). PUUID가 API 키(Development→Production)에 따라 달라지는지도 공식 문서에서 찾지 못했다(미확인).
- **다른 공개 전적 서비스 관행(공개 자료로 확인):** 한 서비스는 공식 변경 기록에서 2020-12 닉네임 변경 이력 기능을 추가했다가 2023-09-15 "모든 공개·비공개 프로필에서 이름 변경 이력 표시를 중단"했고, 이력 검색은 대회 운영자용으로 제한·감사 기록을 남긴다. 다른 서비스 도움말은 Riot ID 변경 직후 이전 Riot ID로 검색해 갱신하라고 안내한다. 이름 변경 이력을 전면 공개하는 서비스도 존재하나 Riot 승인 여부는 알 수 없다. 세부 출처는 `docs-private/lol-research/`에 둔다.
- **추정:** 조항의 주 대상은 이름 변경 이력 조회·옛 이름→현재 계정 연결 기능일 가능성이 높다. 그러나 Riot 답변 전까지 경기 당시 이름 표시가 허용된다고 단정하지 않는다.

### 현재 구현 (코드 근거)
- 경기 원문 `lol_matches.request_json`(7일): 참가자 `puuid`·`riotIdGameName`·`riotIdTagline`을 모두 포함.
- `lol_match_participants`: `puuid`는 저장, 이름 없음. `lol_matches` 삭제 시 cascade로 함께 삭제된다(7일 후 참가자 PUUID 소실).
- `lol_player_match_summaries.teammates`(영구): `[{riotId, win}]`만 저장, **PUUID 없음** → 원문 만료 후에는 팀원의 현재 이름을 다시 조회할 방법이 없다.
- `lol_accounts`(영구): 검색된 계정의 **현재** Riot ID만 유지(검색 시 덮어씀). 경기 화면의 참가자 이름에는 반영되지 않는다.
- 경기 카드·상세: 원문 참가자의 당시 Riot ID 사용(`lib/lol/riotSearch.server.ts` 카드 참가자 매핑 약 795~810행, 팀원 추출 약 582~589행).
- 함께 플레이: 경기 안에서는 PUUID로 중복 제거하지만 경기 간 집계 키가 **Riot ID 문자열**(`lib/lol/summary.ts` 66~95행) → 이름을 바꾼 팀원이 두 사람으로 갈라지고 옛 이름이 함께 노출될 수 있다.
- 익명 벤치마크 집계(진행 중): 이름·PUUID 미저장이므로 이 문제와 충돌 없음.

### 설계안 비교
| 안 | 추가 Riot 호출 | DB 변경 | UX | 정책 위험 |
| --- | --- | --- | --- | --- |
| A. 현행(당시 이름 표시) | 0 | 없음 | 일반 전적 사이트와 동일 | 해석 불확실 |
| B. 표시 시 Account-V1로 전원 현재 이름 조회 | 20경기 기준 고유 참가자 약 100~180회(검색 1회당). Development 키(100회/2분)로는 사실상 불가, Production에서도 검색 비용이 20배 | 이름 캐시 테이블 | 정확(캐시 TTL 동안 지연) | 낮음 |
| C. 본인 외 이름 비표시 | 0 | 없음 | 팀원·함께 플레이 가치 크게 하락 | 가장 낮음 |
| D. 혼합: 확인된 계정은 현재 이름, 나머지는 플래그로 당시 이름/익명 | 0(검색된 계정은 이미 현재 이름 보유) | 팀원 PUUID 서버 보관(요약에 추가 또는 별도 테이블), 표시 모드 플래그 | A와 같고, 검색된 사람은 항상 최신 이름 | Riot 답변에 따라 플래그 전환 |

### 권장: D (기본값은 A와 같은 표시, Riot 답변 대기)
1. 팀원 PUUID를 서버에만 영구 보관(응답·DOM 비노출). 함께 플레이 집계 키를 PUUID로 바꾸고 표시 이름은 "검색된 계정이면 `lol_accounts` 현재 이름, 아니면 가장 최근 경기의 이름" 1개만 쓴다 → 옛 이름 여러 개가 함께 보이는 경로 제거, 추가 호출 0.
2. 참가자 이름 표시 모드 플래그 `match_time | known_current_only`. Riot이 당시 이름 표시를 허용하면 `match_time` 유지, 불허하면 `known_current_only`로 전환(미확인 참가자는 챔피언·결과만). 재수집 없이 전환 가능.
3. 금지 원칙: 이름 변경 이력 목록, 옛 이름 검색→현재 계정 연결, 여러 이름 병기 — 만들지 않는다.
4. B(전원 현재 이름 조회)는 Riot이 요구하고 Production 한도가 확보된 뒤 "화면에 보이는 경기만, 참가자별 장기 캐시"로 부분 도입을 검토.

### Riot 문의 초안 (영문)
> Subject: Clarification on "historic Riot IDs" policy for a match history product (KR)
>
> We are building a League of Legends match history site for the KR region. Match data is fetched via Match-V5 and stored to show players their own and searched players' past games.
>
> 1. The LoL policy states "Products may not expose a player's historic Riot IDs." Does this apply to displaying the `riotIdGameName`/`riotIdTagline` values contained in a Match-V5 response on that match's detail view, if a participant later changed their Riot ID? Or is it limited to features such as name-change history lists or linking previous names to a current account?
> 2. Are Match-V5 `riotIdGameName`/`riotIdTagline` the values at the time of the match, or are they updated to the player's current Riot ID?
> 3. If match-time names are not allowed, is it acceptable to show current Riot IDs only for players whose current ID we have already confirmed via Account-V1, and hide names for other participants?
> 4. Are PUUIDs consistent between a Development/Personal key and the Production key of the same product, or should stored PUUIDs be re-resolved after approval?
> 5. We store per-player match summaries for searched accounts long-term and anonymous aggregate stats without identifiers, and we handle deletion requests by PUUID. Is there any retention limit we should follow?

### 검증 필요 항목
- Riot ID 변경 계정의 옛 경기 원문 이름과 Account-V1 현재 이름 비교(실측). 2026-10-23 01:49 UTC 시도 시 Development 키가 401(24시간 만료 추정)이라 미실시. 키 재발급 후 30명 표본으로 재시도.
- Production 키 수령 직후: 저장된 계정 몇 개를 Riot ID로 재조회해 PUUID 동일성 확인. 다르면 `lol_accounts`·요약을 Riot ID 기준으로 재매핑(계정당 1회 호출), 익명 집계는 영향 없음.
