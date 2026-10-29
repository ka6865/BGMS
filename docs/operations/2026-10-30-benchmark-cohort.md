# 엘리트 벤치마커 전용 명단 (2026-10-30)

## 배경

`scripts/scrape_elite.ts`는 매일 pc-as 리더보드 6개 모드의 상위 5명을 새로 뽑아 최근 경기를 분석했다. 그 결과

- 리더보드의 옛 닉네임으로 `/api/pubg/match`를 불러 404가 하루 2~17건 났고,
- 리더보드 단계의 429 하나가 그날 수집 전체를 멈췄으며,
- 매일 대상이 바뀌어 상위 티어 표본이 들쭉날쭉했고(계산 5 상위 티어 1~4건),
- 404 한 건이 failed와 skipped에 두 번 집계됐다.

검색되지 않은 제3자인 벤치마커의 데이터가 일반 검색 플레이어와 같은 테이블(플레이어 캐시·경기 기록·장기 성과)에 남아 랭킹과 대결 비교에 노출되고, 정리 기준도 없었다.

## 설계

| 구성 | 내용 |
| --- | --- |
| `pubg_benchmark_cohort` | `(platform, account_id)` 기준 명단. 리더보드 출처(샤드·시즌·모드·순위), `first/last_ranked_at`, `last_collected_at`, `retired_at`, 수집에 쓴 정규화 닉네임 `collected_player_ids`. RLS 사용, service_role 전용 |
| 명단 갱신 | 리더보드 상위 `ELITE_PLAYER_LIMIT`(워크플로 10)명/모드를 upsert. 다시 나타나면 `retired_at`을 지운다. 6개 모드를 모두 확인한 날(404 미지원 모드 제외)에만 30일간 안 보인 사람을 은퇴 표시한다 |
| 하루 수집 | 현역 중 `last_collected_at`이 오래된 순으로 `ELITE_COHORT_DAILY_LIMIT`(기본 30)명. `/players?filter[playerIds]=`로 10명씩 조회해 응답의 현재 닉네임으로 분석하고, 분석 전에 그 이름을 명단에 남긴다 |
| 호출 간격 | 한도 대상 호출(seasons·leaderboards·players)만 6초 간격(분당 10회 한도). 429는 그 요청만 건너뛰고 `Retry-After`/`X-RateLimit-Reset`(최대 60초)만큼 다음 호출을 늦춘다. `/api/pubg/match`는 PUBG `/matches`·텔레메트리만 써서 한도에 들지 않으므로 1초 간격 |
| 집계 | 실패 1건은 failed 또는 skipped 하나로만 센다. 경기 404·409와 플레이어 묶음 404는 skipped. 단계별 실패는 `GITHUB_STEP_SUMMARY`에, 429 횟수는 `rate_limited` output에 남긴다 |
| 비공개 요청 | `source=scraper` route는 비공개 검사를 하지 않으므로 스크래퍼가 비공개 목록(계정 ID·닉네임)으로 명단 등록·수집을 막고 해당 명단 행을 지운다. 목록을 읽지 못하면 수집하지 않는다 |
| 참가자 샘플링 | 명단 밖 참가자를 분석하던 샘플링 경로는 정리 대상에서 빠지므로 제거했다 |

PUBG 한도 대상 호출은 하루 37회(seasons 1, leaderboards 6, players 30)에서 10회(1 + 6 + 3)로 줄었다.

### 저장 범위 (`persistMatchAnalysis`, match route)

`source=scraper`는 `pubg_player_cache`, `pubg_player_matches`, `pubg_match_performance`(장기 경기 성과)를 쓰지 않는다. `processed_match_telemetry`, `match_stats_raw`, `global_benchmarks(source='scraper')`, `weapon_meta_match_samples`는 그대로 저장한다.

의존성 확인 결과

- 스크래퍼의 이미 수집한 경기 건너뛰기: `processed_match_telemetry` + `global_benchmarks`만 읽는다.
- 팀 벤치마크(`refresh_pubg_team_benchmarks`): `processed_match_telemetry`만 읽는다.
- 계산 버전 갱신(`prepare/apply_calculation_upgrade_batch`, `run_calculation_upgrade`): `global_benchmarks`·`match_stats_raw`·`processed_match_telemetry`만 읽는다.
- 영향이 있는 곳: 랭킹(`get_pubg_rankings`)과 대결 비교는 `pubg_player_matches`·`global_benchmarks`를 읽으므로 새로 수집한 벤치마커는 랭킹 후보에서 빠진다(의도). 수동 도구인 benchmark recovery canary와 `backfill_weapon_meta_bursts`는 scraper 행에 대해 플레이어 캐시·경기 기록이 없어 해당 표본을 건너뛴다(fail closed).

### 정리 (`cleanup_retired_benchmark_cohort`, `scripts/cleanup_benchmark_cohort.ts`)

`retired_at`이 90일 지난 명단 행을 50명씩 처리한다. 기본은 dry-run, `--apply`일 때만 쓴다. daily-tasks의 `Cleanup Retired Benchmark Cohort` 단계가 `--apply`로 실행한다.

- 검색된 플레이어(플레이어 캐시의 `search_count > 0` 또는 `last_seen_at`, 또는 scraper가 아닌 벤치마크 행): 데이터는 방침상 별도 보관 대상이므로 두고 명단 행만 지운다.
- 그 외: `processed_match_telemetry`(계정 ID가 다른 같은 이름 행 제외), `pubg_match_performance`, 상세 범위 `pubg_player_matches`, 해당 계정의 `pubg_player_cache`를 삭제한다. `global_benchmarks`, `weapon_meta_match_samples`, `match_stats_raw`는 `player_id`를 대응표 없는 `retired:<md5>` 값으로 바꾼다(경기마다 다른 값). 명단 행을 지운다.
- 팀 벤치마크는 기간 없이 전체를 재집계하므로 삭제된 경기만큼 표본이 줄어든다. 정리 대상은 은퇴(30일) 뒤 90일이 지난 경기라 현재 계산 버전 표본에는 사실상 영향이 없다.
- `basic_only`·`legacy` 범위의 참가자 경기 기록은 기존 참가자 보존 정책을 따른다.

## 배포 순서

1. 앞서 밀린 운영 migration(`20261028140000`~`20261030010000`)을 기존 절차대로 적용한다.
2. `20261030020000_pubg_benchmark_cohort.sql`을 단독으로 적용한다(`docs/operations/2026-10-10-remaining-review-fixes.md`의 파일 단위 절차).
3. 앱을 배포한다(`persistMatchAnalysis`·match route 변경). 배포 전 스크래퍼가 돌면 기존처럼 플레이어 캐시·경기 기록이 쓰인다.
4. 워크플로 변경이 main에 들어가면 다음 daily-tasks부터 새 스크래퍼와 정리 단계가 동작한다. migration 전에 돌면 두 단계 모두 실패로 보고된다.

## 운영 확인 SQL (읽기 전용)

```sql
-- 명단 규모와 수집 순환
select count(*) filter (where retired_at is null) as active,
       count(*) filter (where retired_at is not null) as retired,
       count(*) filter (where retired_at is null and last_collected_at is null) as never_collected,
       min(last_collected_at) filter (where retired_at is null) as oldest_collected
from public.pubg_benchmark_cohort;

-- 새 scraper 표본이 플레이어 캐시·경기 기록에 쓰이지 않는지 (배포 이후 0이어야 함)
select count(*) from public.pubg_player_matches m
join public.pubg_benchmark_cohort c on c.platform = m.platform and c.account_id = m.account_id
where m.created_at > '<배포 시각>';

-- 정리 dry-run (쓰기 없음)
select public.cleanup_retired_benchmark_cohort(now() - interval '90 days', false, 50);

-- 계산 버전별 상위 티어 scraper 표본 추이
select calculation_version, tier, count(*) from public.global_benchmarks
where source = 'scraper' and created_at > now() - interval '7 days'
group by 1, 2 order by 1 desc, 2;
```

## 남은 일

- 명단 도입 전 scraper 전용 플레이어(운영 1,037명)의 기존 데이터는 명단에 없어 자동 정리 대상이 아니다. 별도 일괄 정리 또는 명단 소급 등록을 결정해야 한다.
- 개인정보처리방침의 시행일은 별도 브랜치(`ka6865/privacy-pubg-retention`)가 바꾸므로 이 변경에서는 건드리지 않았다.
