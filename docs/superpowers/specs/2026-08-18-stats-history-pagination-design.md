# 전적 페이지 번호형 페이지네이션 설계

## 목표

현재의 `전체 전적 불러오기` 누적 방식 대신, 저장된 전적을 20개씩 페이지 단위로 교체해 보여주는 일반적인 페이지네이션을 제공한다.

## 사용자 경험

- 매치 목록 아래에 `‹ 이전`, 페이지 번호, `다음 ›`을 표시한다.
- 현재 페이지는 선택 상태로 강조하고, 첫 페이지에서는 이전 버튼을 비활성화한다.
- 마지막 페이지에서는 다음 버튼을 비활성화한다.
- 페이지당 20개를 유지하며 페이지 이동 시 이전 페이지 목록은 화면에서 교체한다.
- 초기 페이지는 1페이지이며, 페이지네이션 요청은 저장된 DB 전적만 사용한다.
- 로딩 중에는 페이지 버튼을 비활성화하고 `페이지 불러오는 중...` 상태를 표시한다.

## 데이터 흐름

1. 플레이어 조회가 완료되면 `/api/pubg/player/matches?page=1`을 호출한다.
2. 서버는 `pubg_player_matches`에서 `played_at DESC, match_id DESC` 순서로 20개와 정확한 전체 개수를 반환한다.
3. 클라이언트는 현재 페이지의 match ID만 MatchFeed에 전달하고, 저장 행으로 즉시 기본 매치 카드를 만든다.
4. 페이지 이동은 `/api/pubg/player/matches?page=N`만 호출하며 PUBG player API는 호출하지 않는다.

## API 계약

`GET /api/pubg/player/matches?nickname=<name>&platform=<platform>&page=<positive integer>`

응답은 다음 필드를 포함한다.

```ts
{
  matches: PlayerMatchRecord[];
  page: number;
  pageSize: 20;
  totalCount: number;
  totalPages: number;
}
```

## 범위와 비범위

- 포함: DB 기반 전체 개수, 번호형 UI, 이전/다음 이동, 로딩·오류 상태, 페이지 전환 테스트.
- 유지: 최근 매치 상세 요약, 매치 유형 필터, 매치 상세 lazy loading, API quota 보호.
- 비범위: PUBG API가 제공하지 않거나 DB에 저장되지 않은 과거 매치 복원, 필터별 서버 페이지네이션.
