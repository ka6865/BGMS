# LoL Production Key 신청서 초안 (2026-10-30)

[준비 점검](2026-10-23-lol-production-key-readiness.md)의 4번 "신청 자료"를 채우기 위한 초안이다. 실제 양식 항목은 Developer Portal 로그인 후 확인해 맞춘다. 정책 문구는 신청 직전에 원문을 다시 확인한다.

## 1. 제품 설명 (영문, 양식 붙여넣기용)

> **BGMS (https://bgms.kr/lol/kr)** is a Korean-language match history site for League of Legends players on the KR server.
>
> Players search a Riot ID (game name + tag) and see their current solo/flex rank, recent matches (champion, KDA, CS, damage, vision, items, runes, objectives), per-match team breakdowns, champion mastery, challenges, and trends across their stored matches. A match detail view shows all ten participants and the item/skill build from the match timeline. Aggregate champion statistics are computed from anonymized match data without player identifiers.
>
> The goal is to help players review their own games and track their growth. We do not compute MMR or any replacement for official ranks, do not show augment or Arena item win rates, do not expose in-game session information the player did not already have, and do not show custom games. We do not provide Riot ID change history or link previous names to accounts.
>
> Data handling: the API key is used only on our servers over HTTPS. Searched accounts' summaries are stored until a deletion request; raw match payloads and cached search results expire after 7 days. Deletion requests are handled through our support center and remove the account's stored data. Requests follow Riot rate-limit headers and Retry-After through a shared server-side limiter.

## 2. 사용자 흐름 (캡처 목록)

배포된 최신 코드에서 아래 순서로 캡처한다. 모바일(390x844)과 데스크톱(1440x900) 각 1장씩. 캡처에는 공개된 프로 선수 계정만 쓰고 일반 사용자 계정을 남기지 않는다.

| 순서 | 화면 | 보여 줄 것 |
| --- | --- | --- |
| 1 | `/lol/kr` 검색 | Riot ID 입력(게임 이름#태그), KR 서버 표시, 하단 법적 고지 |
| 2 | 검색 결과 | 프로필·레벨, 솔로/자유 랭크, 최근 경기 목록, "최근 갱신 N분 전"과 "전적 갱신" 버튼 |
| 3 | 경기 상세 | 10명 참가자, 팀 합계·오브젝트, 빌드 탭 |
| 4 | 통계 탭(모바일) | 최근 성과, 숙련도, 도전과제, 함께 플레이한 소환사 |
| 5 | 더 보기·갱신 | "경기 더 불러오기"와 갱신 후 시각 변경 |
| 6 | 오류 안내 | 없는 Riot ID, 요청 많음(429), 키 갱신 안내 문구 |
| 7 | 고지·정책 | 하단 Riot 법적 고지, `/privacy` LoL 항목, `/support` 삭제 요청 경로 |

브라우저 fixture(`tests/lol-public-browser.test.ts`)가 같은 화면을 가상 데이터로 `tmp/lol-public-review/`에 저장하므로 배치 확인용으로 쓸 수 있다. 신청서에는 실제 배포 화면을 쓴다.

## 3. 호출량과 데이터 보관

- 호출량: [준비 점검 4-1절](2026-10-23-lol-production-key-readiness.md) 표를 그대로 옮긴다.
- 보관: 검색 결과 캐시 2분, 경기 원문·경기 상세·마지막 검색 결과 7일, 검색 계정 요약·랭크 기록은 삭제 요청 전까지, 익명 통계는 식별자 없이 보관.
- 보안: 키는 서버 전용, Supabase RLS로 LoL 테이블을 공개 역할에서 차단, service_role만 접근.

## 4. 신청 전 남은 일

- [ ] 이번 브랜치(#384 포함) 머지와 운영 migration 적용(`20261029010000` → `20261029020000` → `20261029030000`), 배포.
- [ ] 배포 화면에서 2절 캡처.
- [ ] 개인정보처리방침 시행일 갱신 여부 결정(2026-10-30 LoL 캐시 보관 문구 수정).
- [ ] 과거 Riot ID 정책 해석 문의 여부 결정(준비 점검 7절 초안).
