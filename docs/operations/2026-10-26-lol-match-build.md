# LoL 경기 상세 빌드 탭

경기 상세의 "빌드·흐름" 탭은 아이템 구매 순서, 스킬 레벨업 순서와 참가자별 골드·CS 변화를 보여 준다. 2026-10-26 PR #358 구현에 2026-11-04 경기 흐름을 추가했다.

## 경로와 접근

- 공개: `GET /api/lol/matches/{matchId}/build`. `guardLolPublicRequest(request, "read")`로 공개 플래그(`LOL_PUBLIC_ENABLED`), 같은 출처, IP별 요청 제한을 상세 경로와 같은 기준으로 확인한다. DB에 저장된 경기만 응답하고, 저장 기능이 꺼져 있으면 404다.
- 관리자: `GET /api/admin/lol/matches/{matchId}/build`. 저장 여부와 관계없이 조회한다.
- 경기 ID는 상세 경로와 같이 `KR_` + 숫자, 24자 이하만 받는다.

## 데이터와 캐시

- 경기 원문은 상세와 같은 경로(`getLolMatchDetailsAndRaw`)로 읽고, 타임라인 `/lol/match/v5/matches/{matchId}/timeline`을 1회 요청한다. 응답 상한은 8MB다.
- 타임라인 원문은 DB에 저장하지 않는다. 가공 결과(`parseLolMatchBuild`)만 서버 메모리에 `build:v2:{matchId}` 키로 30분 둔다. 결과에는 팀ID·챔피언ID·분 단위 아이템·스킬 순서와 참가자별 `timeline: { timestamp, gold, cs }[]`가 있고 PUUID는 없다. `timestamp`는 경기 시작 후 밀리초, `gold`는 `totalGold`, `cs`는 `minionsKilled + jungleMinionsKilled`다. 결측·음수·유효하지 않은 수치는 null이며 CS의 한쪽 수치가 빠져도 합계를 만들지 않는다.
- 화면은 탭을 처음 열 때만 요청한다. 소환사 선택은 `팀ID:팀 안 순서`로 하고 챔피언ID로 한 번 더 맞춘다. 같은 챔피언을 여럿 고르는 모드에서도 다른 소환사의 빌드가 섞이지 않는다.
- 같은 응답으로 골드/CS 전환과 경기 시점 슬라이더를 제공한다. 누락된 값이나 90초 초과 프레임 간격은 선을 끊고, 마지막 프레임도 실제 시각을 표시한다. 그래프 조작·소환사 선택·탭 재진입으로 Riot 요청을 추가하지 않는다.

## 한계

- 메모리 캐시는 서버 인스턴스마다 따로 있다. 인스턴스가 바뀌거나 30분이 지나면 같은 경기도 타임라인을 다시 요청한다. 저장 기능이 켜진 환경에서는 Riot 호출이 공용 호출 한도(`reserveLolRiotRequest`)를 거치므로 한도를 넘지는 않지만, 개발 키처럼 한도가 작으면 다른 검색과 호출량을 나눠 쓴다.
- 호출량이 문제가 되면 가공 결과를 DB 캐시(`lol_api_cache`)에 저장하는 방안을 검토한다. 이때는 새 cache kind와 migration이 필요하다.
