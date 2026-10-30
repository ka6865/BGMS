# LoL 랭킹·장인 운영 절차 (2026-10-30)

설계 기준: [랭킹·장인 탭 구현 준비](../plans/2026-10-30-lol-ranking-mastery-tabs.md). 이 문서는 플래그, 적용 순서, 되돌리기, 첫 실행 확인을 정한다.

## 구성

| 구분 | 이름 | 위치 |
| --- | --- | --- |
| 수집기 | `scripts/lol_ranking_snapshot.ts` | dry-run 기본, `--apply`는 쓰기 플래그 필요 |
| 제외 등록 | `scripts/lol_ranking_exclude.ts` | Riot ID만으로 HMAC을 만들고 제외 목록에 넣는다. Riot API를 호출하지 않는다 |
| 워크플로 | `.github/workflows/lol-ranking.yml` | 하루 1회(KST 05:41), main만 |
| migration | `supabase/migrations/20261031030000_lol_ranking_publication.sql` | 게시 테이블 두 개, 제외 목록, RPC 다섯 개 |
| 화면 | `/lol/kr/ladder`(랭킹), `/lol/kr/masters`(장인) | 장인은 플래그 필요 |

## 플래그와 환경 변수

| 이름 | 어디 | 값 | 의미 |
| --- | --- | --- | --- |
| `LOL_PERSISTENCE_ENABLED` | 워크플로·서버 | `true` | DB 저장과 공유 호출 제한 사용. 꺼지면 게시본을 읽지 않고 빈 상태를 보인다 |
| `LOL_RIOT_PRIORITY` | 워크플로 | `background` | 수집기가 검색 몫(90%)이 아니라 background 몫(50%)만 쓴다. 랭크 컷 워크플로에도 같은 값을 넣었다 |
| `LOL_RANKING_ENABLED` | GitHub Variables | `true` | 켜야 `--apply`로 게시한다. 없으면 워크플로가 dry-run과 경고만 낸다 |
| `LOL_RANKING_HMAC_KEY` | GitHub Secrets | 32자 이상 | 제외 목록 키. 바꾸면 기존 제외가 전부 풀리므로 바꾸지 않는다 |
| `LOL_MASTERS_PUBLIC` | 서버 환경 | `true` | 장인 메뉴와 `/lol/kr/masters`를 연다. 꺼지면 경로 404, 메뉴 숨김 |
| `LOL_PUBLIC_ENABLED` | 서버 환경 | `true` | 기존 LoL 공개 전체 플래그. 장인도 이 값이 켜져 있어야 보인다 |

`LOL_RANKING_HMAC_KEY`는 한 번 만들고 보관한다. 만들 때는 `openssl rand -hex 32`를 쓴다. 값을 문서·로그·커밋에 적지 않는다.

## 적용 순서

1. 코드가 main에 들어가고 Vercel이 배포된다. 이 시점에는 `LOL_MASTERS_PUBLIC`과 `LOL_RANKING_ENABLED`를 모두 끈다.
2. 운영 migration을 **파일 하나씩** 적용한다(CLAUDE.md 운영 절차, `supabase db push` 사용 금지). 적용 뒤 `list_lol_ranking_exclusion_keys`가 빈 배열을 돌려주는지 확인한다.
3. `LOL_RANKING_HMAC_KEY`를 GitHub Secrets에 넣는다.
4. 프로덕션 키를 받은 뒤 수집기를 **dry-run으로 먼저** 실행한다(워크플로 수동 실행, `LOL_RANKING_ENABLED`는 아직 끈다). 확인할 항목은 아래 "첫 실행 확인"이다.
5. dry-run 결과가 맞으면 `LOL_RANKING_ENABLED=true`를 켜고 워크플로를 수동 실행한다. 게시 조건을 넘으면 `published: true`가 나온다.
6. 랭킹 화면을 확인한 뒤 `LOL_MASTERS_PUBLIC=true`를 켜서 장인을 연다.
7. 개인정보처리방침 갱신과 시행일 공지는 **수집을 켜기 전에** 끝낸다(설계 8절). 신청서 제품 설명도 같은 시점에 맞춘다.

## 첫 실행 확인 (dry-run)

- 명단 응답: 챌린저·그랜드마스터 두 번 호출이 성공하고 `counts.candidates`가 명단 수와 맞는지 본다.
- `counts.resolved / counts.candidates`가 95% 이상인지 본다. 낮으면 Riot ID 응답 형식이나 404가 늘었는지 확인한다.
- `counts.masteryCompleted`가 `resolved`의 95% 이상인지 본다.
- 출력에 PUUID가 없는지 본다. 수집기 출력은 개수만 찍는다.
- 개발 키로는 하루 1회 수집을 맡길 수 없다(24시간마다 만료). 개발 키 실측은 가능할 때 한 번만 하고, 운영 수집은 프로덕션 키 뒤로 미룬다.

## 게시 조건과 실패 처리

- 명단 형식이 하나라도 다르면 전체를 실패시키고 게시하지 않는다(`parseRankingLeague`).
- Riot ID 해석률과 숙련도 완료율이 각각 95% 이상이어야 게시한다. 못 넘으면 `--apply`가 exit 1로 끝나고 이전 게시본이 그대로 남는다.
- 혼잡(`congested`)과 한도 초과(`rate_limited`)는 1초, 2초, 4초 뒤 다시 보낸다. 그래도 실패한 계정은 해석 실패로 센다.
- 저장은 한 트랜잭션으로 교체한다. 더 오래된 실행이 뒤늦게 저장하려 하면 `stale ranking snapshot`으로 거절된다.
- 화면은 기준 시각(KST)을 보여 준다. 수집이 멈춰도 마지막 게시본과 그 시각이 남는다.

## 삭제 요청 처리

1. 요청을 받으면 Riot ID(게임 이름#태그)를 확인한다(개인정보처리방침의 절차).
2. 서버 환경에서 `LOL_RANKING_HMAC_KEY`와 `LOL_PERSISTENCE_ENABLED=true`로 dry-run을 먼저 한다.
   `npx tsx scripts/lol_ranking_exclude.ts "게임이름#태그" --dry-run`
3. 확인 뒤 `--apply`로 실행한다. 제외 목록에 넣고, 기존 게시본에서 행과 장인 항목을 지우고 순위를 다시 매긴다. 출력에는 Riot ID가 나오지 않고 제거 수만 나온다.
4. 다음 수집에서도 제외 목록을 다시 대조하므로 재수집되지 않는다.
5. 잔여 위험: Riot ID를 바꾸면 새 이름은 제외되지 않는다. 이 경우 요청자에게 새 Riot ID로 다시 요청하도록 안내한다(처리방침 초안 참고).

## 되돌리기

- 장인만 숨기기: `LOL_MASTERS_PUBLIC`을 끈다. 경로는 404가 된다. 데이터 변경은 없다.
- 수집 멈추기: `LOL_RANKING_ENABLED`를 끈다. 워크플로는 dry-run으로만 돈다. 기존 게시본은 남는다.
- 게시본 지우기: 운영 DB 쓰기다. 사용자 승인과 dry-run 대상 확인 뒤에만 한다. `delete from public.lol_ranking_publication` 과 `delete from public.lol_mastery_publication`. 빈 게시본이면 랭킹과 장인은 빈 상태를 보인다.
- 제외 목록은 되돌리지 않는다. 제외는 삭제 요청의 결과이므로 풀지 않는다.
- migration 자체는 `drop function`과 `drop table`로 되돌릴 수 있지만, 제외 목록이 쌓인 뒤에는 실행하지 않는다.

## 검증 기록

- `npm run verify:core`: eslint 오류 0, tsc 통과(기존 경고 43개는 이번 변경과 무관).
- `npm run verify:lol`: 파일 41개 통과, 브라우저 fixture 7개 파일은 환경 변수 없이 건너뜀.
- `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations`: 신규 migration과 `lol-ranking-publication-scenarios.sql` 포함 전체 통과(EXIT 0).
- 브라우저 fixture(`RUN_LOL_DEV_BROWSER=true`): 랭크 컷·랭킹 화면 4개 통과. 장인 화면과 랭킹 표 자체의 375·390·430·1440 브라우저 검증은 아직 하지 않았다.
