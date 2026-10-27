# LoL 챔피언 통계 수집과 화면 (2026-10-27)

## 범위

- 공개 `/lol/kr/champions`: 포지션별 승률·픽률·밴률·판수 표, 티어 필터(모든 티어, 에메랄드+, 다이아몬드+, 마스터+, 티어별).
- 공개 `/lol/kr/champions/{영문 ID 소문자}`: 포지션 요약(승률·픽률·밴률·KDA·분당 CS·분당 피해량·15분 골드 차이), 룬, 소환사 주문, 시작 아이템, 코어 빌드, 스킬 순서, 신발, 많이 가는 아이템, 라인 상대.
- 수집기 `scripts/lol_collect_champion_stats.ts`와 migration `20261028130000_lol_champion_stats.sql`.
- 표본은 BGMS가 모은 솔로 랭크(420) 경기다. 화면에 경기 수를 같이 표시하고 20판 미만은 승률 대신 "표본 부족"으로 둔다.

## 저장 계약

- 경기 원문·참가자 행·PUUID·Riot ID는 저장하지 않는다. 수집기가 메모리에서 경기 하나의 기여분을 계산해 `ingest_lol_stat_match` 한 번으로 누적한다.
- `lol_stat_processed_matches`: 경기 ID·패치·큐·티어·timeline 여부·제외 사유. 같은 경기는 한 번만 누적한다.
- 제외: 사용자 설정 게임(`custom`), 솔로 랭크가 아닌 큐(`queue`), 다시하기(`remake`), 5분 미만(`short`), 참가자·패치 형식 오류(`invalid`).
- 집계 테이블: `lol_stat_totals`(분모), `lol_stat_champions`(포지션별 판수·승리·KDA·CS·골드·피해·시간·15분 골드 차이), `lol_stat_bans`(경기당 챔피언 1회), `lol_stat_builds`, `lol_stat_matchups`.
- 티어는 수집 출발 계정의 현재 티어다. 경기 참가자 10명의 평균 티어가 아니다.
- 모든 테이블은 RLS를 켜고 service_role만 접근한다. 화면은 서버에서 `get_lol_stat_patches`, `get_lol_champion_stats`, `get_lol_champion_detail`을 호출한다.
- 기존 `lol_benchmark_*`·`lol_champion_ban_*` 집계(검색·상세 저장 경로)와 별개다.

## 계산

- 픽률 = 포지션 판수 / 같은 패치·티어의 처리 경기 수. 밴률 = 밴된 경기 수 / 처리 경기 수.
- 라인 상대 = 상대 팀에서 같은 `teamPosition`을 맡은 한 명. 한쪽에 같은 포지션이 둘이거나 없으면 상대 지표를 만들지 않는다.
- 15분 골드 차이 = timeline 15분 프레임의 `totalGold` 차이.
- 완성 아이템: Data Dragon `item.json`에서 신발·장신구·소모품이 아니고, 상점에서 살 수 있고, 총 가격 2200 이상이며, 상위 아이템이 상점 판매 대상이 아닌 아이템. 신발은 `Boots` 태그이면서 900골드 이상.
- timeline 항목: 시작 아이템(90초 안 구매, 장신구 제외), 코어 빌드(완성 아이템 첫 3개 구매 순서, 되돌리기 반영), 스킬 순서(Q·W·E 중 5레벨을 먼저 찍은 순서, 9레벨 미만 제외).

## 수집기 실행

```sh
# 로컬 main 폴더. .env.local에 RIOT_API_KEY, LOL_PERSISTENCE_ENABLED=true, Supabase service role이 필요하다.
npx tsx scripts/lol_collect_champion_stats.ts --dry-run                 # Riot 호출만, 저장 없음(기본 3경기)
LOL_COLLECT_ENABLED=true nohup npx tsx scripts/lol_collect_champion_stats.ts --apply > tmp/lol-stats.log 2>&1 &
```

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `--per-2min` | 20 | 수집기 자체 호출 상한(2분당). 개발 키 100회의 20%. 최대 80 |
| `--timeline-ratio` | 0.5 | timeline을 받는 경기 비율. 경기 ID 해시로 정해 재실행해도 같다 |
| `--ids-per-seed` | 10 | 출발 계정당 최근 경기 ID 수 |
| `--days` | 7 | 출발 계정 경기 조회 기간 |
| `--max-minutes`, `--max-matches` | 0 | 0이면 멈출 때까지 |

- 출발 계정: 아이언~다이아 I~IV는 `League-V4 entries` 페이지, 마스터 이상은 리그 명단. 한 바퀴(40칸)에 티어마다 4번씩 돈다.
- 진행 위치(구간별 페이지·순번)는 `lol_stat_collector_state`에 저장한다. 계정 식별자는 저장하지 않으므로 페이지는 다시 받는다.
- Riot 호출은 기존 공유 호출 제한(`lol_rate_limit_state`)을 거친다. 운영 검색과 같은 제한을 쓰므로 수집 속도를 올리기 전 운영 검색의 혼잡 응답(503 `congested`)과 `lol_ops_daily`의 `riot_429`를 확인한다.
- 429·혼잡은 기다렸다가 같은 요청을 다시 보낸다. 401·403(키 만료)은 즉시 멈추고 종료 코드 2를 반환한다. 키를 바꾸고 다시 실행하면 저장된 위치부터 이어간다.
- 동시 실행은 `ops:lol-stat-collector` lease로 막는다. Ctrl+C 한 번은 현재 경기까지 저장하고 멈춘다.

## 처리량과 용량

- 기본값(2분 20회, timeline 50%)에서 경기당 평균 1.5회 + 출발 계정당 1~2회 호출로 하루 약 8천 경기다.
- 원문을 저장하지 않으므로 증가분은 집계 행이다. 패치·티어·포지션·챔피언·빌드 값 조합만큼 늘며 패치가 바뀌면 새 행이 생긴다. 오래된 패치 정리는 아직 없다.

## 정책 메모

- Riot 정책상 개발 키는 공개 서비스용이 아니다. 운영 키 승인 전 공개 화면에 개발 키 수집 통계를 표시하는 것은 담당자 결정으로 진행했다. 승인 심사에서 문제가 되면 통계 칸만 숨길 수 있다.

## 롤백

수집기를 멈춘 뒤 이전 화면 코드로 배포하고, 승인된 대상 DB에서 다음을 실행한다. 누적 집계는 복구할 수 없다.

```sql
begin;
drop function public.get_lol_champion_detail(text,integer,text[],integer);
drop function public.get_lol_champion_stats(text,integer,text[]);
drop function public.get_lol_stat_patches(integer);
drop function public.ingest_lol_stat_match(text,text,integer,text,boolean,text,jsonb);
drop table public.lol_stat_collector_state, public.lol_stat_matchups, public.lol_stat_builds, public.lol_stat_bans,
  public.lol_stat_champions, public.lol_stat_totals, public.lol_stat_processed_matches;
drop function public.lol_stat_tiers();
commit;
```

## 검증

- `npm run verify:migrations` (`tests/fixtures/migration-check/lol-champion-stats-scenarios.sql`)
- `npx vitest run tests/lol-champion-stats.test.ts`
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-champions-browser.test.ts` (375/390/430/1440)
