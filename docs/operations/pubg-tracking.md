# PUBG 매치 보존과 개인 제재 추적 운영

## 동작

- 플레이어 신규 조회·명시적 갱신·연동 동기화에서 실제 받은 매치 ID 전체를 `pubg_player_match_discovery`에 저장한다. 화면과 프로필 캐시의 최근 목록은 20개다.
- 기존 플레이어의 일반 검색은 외부 PUBG 조회를 추가하지 않는다. 검색되지 않았거나 갱신하지 않은 기간의 모든 경기를 보장하지 않는다.
- 수집 worker는 원장의 대기 작업을 매치 상세로 확인하고 `pubg_player_matches`에 기본 전적을 저장한다. 동일한 플랫폼·계정 ID·매치 ID가 이미 저장되어 있으면 외부 요청 없이 완료 처리하고, 그 외에는 공식 참가자 ID를 재검증한다.
- 사용자 화면은 worker의 내부 대기 건수를 노출하지 않는다. BGMS에 실제 저장된 필터별 전체 경기 수와 페이지를 표시하며, 최근 20경기는 프로필·요약 계산 범위일 뿐 저장 전적의 상한이 아니다.
- 제재 추적은 경기 상대를 서버 원본으로 확인한 뒤 로그인한 사용자의 개인 목록에 저장한다. 제재 사유·신고 처리 결과를 판단하지 않는다. 표시 시각은 관찰 시각이다.
- `/matches`·텔레메트리는 플레이어 조회의 10 RPM 한도에서 제외되지만 실행 시간·네트워크·저장 비용은 발생한다. 공식 원본 매치 보존 기간은 14일이므로 ID만 저장하고 수집하지 않으면 복구를 보장할 수 없다.

## 배포 순서

1. 임시 DB에서 `npm run verify:migrations`와 관련 테스트를 통과시킨다.
2. 새 migration 다섯 개를 검토하고 대상 DB에 적용한다. 기존 데이터/테이블을 삭제하지 않는다.
   - `20260911100000_pubg_match_discovery.sql`
   - `20260911110000_pubg_ban_watch.sql`
   - `20260913090000_pubg_rankings_and_performance.sql`
   - `20260913100000_pubg_encounter_page.sql`
   - `20260915090000_pubg_release_hardening.sql`
3. 애플리케이션 코드를 배포한다. 전적 화면에서는 내부 수집 상태 대신 저장 완료된 경기만 전체 건수와 페이지로 보여 준다.
4. 기존 캐시에서 이미 알고 있는 ID를 옮기려면 먼저 아래 dry-run을 실행한다. 현재 캐시가 20개라면 그 20개만 옮길 수 있다.
5. GitHub Actions 수동 실행에서 3건 canary를 실행해 DB 쓰기·중복 생략·오류를 확인한다. 이상이 없으면 20건을 실행하고, 대기 감소와 실패율을 확인한 뒤에만 활성화 변수를 설정한다. 코드 추가만으로 정기 스케줄은 켜지지 않는다.

## 매치 보존 명령

```bash
# 읽기 전용: 전체 대기 작업 수와 지금 처리 가능한 작업 중 가장 오래된 시각
npx tsx scripts/ingest_discovered_matches.ts
# 읽기 전용: 특정 플레이어 기존 캐시 확인 (닉네임의 _를 와일드카드로 쓰지 않음)
npx tsx scripts/ingest_discovered_matches.ts --seed-cache --nickname Zucchini__
# 검토 후 기존 캐시의 ID 원장 등록
npx tsx scripts/ingest_discovered_matches.ts --seed-cache --nickname Zucchini__ --apply
# 1차 canary: 최대 3개 처리
npx tsx scripts/ingest_discovered_matches.ts --apply --limit 3
# 2차 canary: 3건 결과 확인 후 최대 20개 처리
npx tsx scripts/ingest_discovered_matches.ts --apply --limit 20
# 정기 작업과 같은 최대 300개 처리
npx tsx scripts/ingest_discovered_matches.ts --apply --limit 300
```

`--seed-cache --apply`는 운영 DB 전체를 한 번에 등록하지 못하도록 정확한 `--nickname`을 필수로 요구한다. dry-run 결과를 확인한 플레이어만 순서대로 실행한다.

매치 worker: 수동 실행은 활성화 변수 없이 1·3·10·50·300건 canary를 선택할 수 있다. 정기 실행은 GitHub variable `PUBG_MATCH_RETENTION_ENABLED=true`일 때만 매시 17분에 작동하며 회당 최대 300건, 동시 3건, 처리 8분이다. 필요한 secrets는 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, 선택적으로 `PUBG_API_KEY`다. service key는 브라우저에 전달하지 않는다.

canary마다 Actions 요약의 `claimed/saved/retry/unavailable/rateLimited/durationMs`를 확인하고, 처리 전후 dry-run의 `pending`과 `oldestReadyAt`을 비교한다. `retry` 또는 `unavailable`이 예상보다 많거나 `rateLimited=true`이면 다음 단계로 늘리지 않는다.

## 제재 확인 명령과 API 예산

```bash
# 기본 실행: 외부 조회·DB 쓰기 없이 실행 설정 확인
npx tsx scripts/refresh_pubg_bans.ts
# 운영 적용 후 실제 활성 대상 확인
npx tsx scripts/refresh_pubg_bans.ts --apply
```

제재 worker는 `PUBG_BAN_WATCH_ENABLED=true`일 때 매시 37분에 실행한다. 같은 플랫폼의 고유 계정을 최대 10개씩 묶고 API 호출 간격은 65초, 회당 최대 6회, 전체 8분이다. job 제한은 10분이며 concurrent 실행은 막는다. 필요한 secrets는 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBG_API_KEY`다.

- PUBG 기본 플레이어 API 예산 10 RPM은 기존 전적 조회와 공유한다. worker는 실행 중 약 1 RPM을 사용하며, 남은 예산을 보장하는 예약 시스템은 아니다. 429를 받으면 Retry-After/한도 reset 이후로 재예약하고 현재 실행을 중단한다.
- 플랫폼별 배치가 꽉 찰 때 최대 60계정/시간, 1,440확인/일이다. 플랫폼이 섞여 작은 배치가 생기거나 장애가 나면 처리량은 더 낮다. 활성 고유 계정이 증가하면 대기 시간을 확인하고 주기/예산을 조정해야 한다.
- 상태별 다음 확인은 제재 표시 없음·unknown 24시간, 임시 6시간, 영구 7일이다. 최초 대상은 즉시 대기열에 들어가지만 실제 확인은 다음 worker 실행 시점이다. 기존 프로필 새로 조회에서 얻은 상태도 공통 캐시에 기록하므로 같은 계정을 중복 호출하지 않는다.
- 개인 등록은 활성 50대상(플랫폼+계정), 대상당 활성 10경기, 기본 30일이다. 여러 사용자가 같은 계정을 추적해도 상태 확인은 공유한다.
- '다시 확인'은 확인 예약이며 신선한 캐시의 TTL이나 실패 후 재시도 대기를 우회하지 않는다. 기존 확인 시각을 현재 시각으로 꾸미지 않는다.
- 경기 상대 조회·등록의 사용자별 5회/분·동시 1개 보호는 프로세스 메모리 기준이다. 서버 인스턴스 전체를 합산하는 전역 제한은 아니다. 검증된 원본 결과만 짧게 재사용하며 원본 telemetry를 이 기능 때문에 대량 저장하지 않는다.
- 인게임 신고 내역·별표 닉네임 알림은 API에서 직접 연결하지 않는다. 경기에서 확인한 실제 상대 계정을 개인 목록에 등록하는 방식이며 제재 원인, 시작 시각, 신고 성공 여부를 단정하지 않는다.

공식 근거: [PUBG API rate limits](https://documentation.pubg.com/en/rate-limits.html), [플레이어 API](https://documentation.pubg.com/en/players-endpoint.html), [매치 API](https://documentation.pubg.com/en/matches-endpoint.html).

## 관찰 지표와 오류

- 회당 claimed/saved/retry/unavailable, rateLimited, durationMs와 원장의 `first_seen_at`, `next_attempt_at`, `last_error_code`를 함께 확인한다.
- pending이 줄지 않으면 worker 활성화/실행 결과/DB 권한/외부 API 실패를 먼저 확인한다. 저장 실패를 완료로 바꾸지 않는다.
- 404는 6시간 후 한 번 더 확인하고 계속 없으면 unavailable로 남긴다. 다른 네트워크 오류는 별도 retry다. 404는 제재의 증거가 아니다.
- 실행 중단은 15분 lease 만료 후 재개한다. 두 실행이 동일 작업을 소유하지 않도록 DB claim과 GitHub concurrency를 사용한다.
- 새 테이블의 실제 인덱스 포함 용량과 최대 대기 시간을 확인한다. 대기 증가가 처리량을 넘으면 실행량/주기를 조절한다. 무제한 무료 저장을 전제하지 않는다.
- 문제 시 워크플로 활성화 변수를 false로 바꿔 수집을 중단한다. 저장된 전적과 개인 추적 항목은 삭제하지 않는다.

## Zucchini__ 대조

실행 시점에 공식 응답에서 accountId를 확인하고 플랫폼 steam과 정확한 닉네임 `zucchini__`로 DB를 읽는다. API ID 집합과 DB 집합의 차이를 대상으로 상세 조회 결과(성공/404/일시 오류)를 기록한다. 저장 후 같은 ID 집합으로 다시 대조한다. OP.GG의 확인 가능한 경기와 비교할 때는 날짜를 KST로 맞추고 모드·순위·킬도 비교한다. 예전에 관찰한 API 99개/DB 30개는 현재 수치가 아니다.

### 2026-09-12 06:22 KST 읽기 전용 실측

- Steam `Zucchini__`의 공식 계정과 DB 프로필 계정이 일치했다.
- 공식 API 매치 ID 107개, DB 전체 기본 전적 40행. API ID와 겹치는 저장 전적은 38개, 미저장은 69개였다.
- 미저장 69개를 공식 match 상세로 다시 읽어 전부 해당 account ID의 참가를 확인했다. 경기 시간은 2026-09-02 19:03:32부터 2026-09-12 02:11:43 KST까지다.
- 마지막 프로필 캐시는 2026-09-11 22:00:58 KST이며 ID 20개만 보관했다. 미저장 69개 중 52개는 그 갱신 이전 경기, 17개는 이후 경기다. 따라서 새 경기 반영 지연만으로 전체 차이를 설명할 수 없다.
- OP.GG 직접 브라우저 접근은 CloudFront 403으로 막혔고, 검색 도구의 페이지는 2주 전 수집본이며 경기 목록이 없었다. OP.GG와의 개별 경기 일치 여부는 확인하지 못했다.
- 이 점검은 DB와 공식 API 조회만 수행했으며 운영 데이터를 보정하지 않았다. 원시 대조 결과는 로컬 `tmp/pubg-tracking-qa/zucchini-audit.json`에 남겼다.

### 2026-09-15 저장 현황 재확인

- Steam `Zucchini__`의 프로필 캐시는 최근 20개 ID를 보관하고, `pubg_player_matches`에는 62경기가 저장되어 있다. 따라서 사용자 화면의 전체 전적은 20경기 고정이 아니라 20개씩 4페이지로 표시되어야 한다.
- discovery 원장에는 100건이 대기 상태였으며, 그중 42개 match ID는 이미 저장 행이 있고 58개는 미저장이었다. 같은 account ID까지 일치하는 기존 행은 12개였으므로 worker는 정확한 계정 ID 일치 행만 외부 호출 없이 완료 처리한다.

## 로컬 구현 검증 결과

- 매치 보관 관련 66개, 기존 분석 회귀 618개, 제재 API/저장/worker/화면/원본 검증 32개, 전적 진행 화면 관련 31개 테스트 통과.
- `verify:core` 실행: 린트 오류 없음(경고 44개), TypeScript 통과.
- 일회용 PostgreSQL 검증에서 제재 이력 중복 방지, 만료 lease 차단, 활성 대상/경기 상한과 기간 연장 우회 방지를 확인했다.
- 격리된 브라우저 fixture에서 375/390/430/1280px의 상대 등록·재확인 예약·삭제·상태 변화 표시를 확인했다. 가로 넘침과 페이지 오류가 없었다. 실제 사용자 세션·운영 쓰기는 사용하지 않았다.
- 2026-09-15 승인 후 운영 migration 5개를 적용하고 핵심 RPC를 확인했다. 애플리케이션 배포와 워크플로 활성화는 수행하지 않았다.
