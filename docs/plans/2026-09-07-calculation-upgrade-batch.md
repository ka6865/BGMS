# 계산 버전 2 순차 갱신 배치

`processed_match_telemetry`와 `global_benchmarks`의 구 계산 결과는 자동으로
버전을 바꾸지 않는다. `scripts/prepare_calculation_upgrade_batch.ts`가 최근
`match_stats_raw.is_analysis_sample`을 읽어 작은 배치의 **준비 manifest**를
만들고, `scripts/apply_calculation_upgrade_batch.ts`만이 검토된 manifest를 한
행씩 `upgrade_analysis_calculation` RPC로 적용한다.

## 원본 계약과 현재 보관 상태

- 허용 원본은 catalog에 명시한 `local_official_raw`의 official match JSON과
  원본 telemetry JSON 쌍이다. match/platform/player/roster/accountId,
  `LogMatchDefinition`, 시작·종료 이벤트를 재검증한다.
- 같은 match의 원본은 여러 player 행에서 메모리로 재사용한다. 매 행마다
  원본과 `full` projection을 다시 계산해 산술 결과가 같아야 한다.
- `telemetry_map_cache_entries`와 `match_master_telemetry`는 retention facts로
  manifest에 기록한다. `lite`와 `full` 지도 projection, 구 R2 키는 raw
  telemetry의 대체물이 아니므로 어떤 경우에도 apply 입력으로 쓰지 않는다.
- catalog에 항목이 없거나 원본이 불완전하면 `raw_unavailable`으로 남긴다. 이는
  이 배치가 허용한 catalog에서 확인하지 못했다는 뜻이며, 원본의 영구 부재를
  뜻하지 않는다. 해당 행은 기본 전적을 유지하며, worker가 PUBG/Gemini를
  호출하거나 새 원본을 수집하지 않는다.

## 준비와 검토

catalog는 다음처럼 match별로 하나만 둔다. 파일 경로는 catalog 파일 기준이다.

```json
{
  "version": 1,
  "sources": [{
    "kind": "local_official_raw",
    "matchId": "match-id",
    "platform": "steam",
    "matchFile": "raw/match.json",
    "telemetryFile": "raw/telemetry.json"
  }]
}
```

기본 catalog 경로는 `tmp/calculation-upgrade-raw-catalog.json`이다. 다음은
DB/R2 쓰기, PUBG 호출, Gemini 호출 없이 최근 후보를 최대 10개 준비한다.

```bash
npx tsx scripts/prepare_calculation_upgrade_batch.ts \
  --catalog /secure/raw/catalog.json \
  --output tmp/calculation-upgrade-prepared.json \
  --batch-size 10 --scan-limit 100
```

특정 닉네임의 순차 페이지를 확인해야 할 때는 저장된 정규화 닉네임을
`--player-id`로 지정한다. 이 필터도 동일하게 `scan-limit`과 offset cursor의
bounded read를 적용하며 원본을 수집하지 않는다. 예를 들어 `MiaeQ_Q`와
`KangHeeSung_`는 각각 다음처럼 별도 manifest를 만든다.

```bash
npx tsx scripts/prepare_calculation_upgrade_batch.ts \
  --catalog tmp/calculation-upgrade-raw-catalog.json \
  --player-id MiaeQ_Q --output tmp/calculation-upgrade-miaeq_q.json \
  --batch-size 10 --scan-limit 100

npx tsx scripts/prepare_calculation_upgrade_batch.ts \
  --catalog tmp/calculation-upgrade-raw-catalog.json \
  --player-id KangHeeSung_ --output tmp/calculation-upgrade-kangheesung_.json \
  --batch-size 10 --scan-limit 100
```

catalog 밖의 원본을 확보해야 할 때는 `fetch_calculation_upgrade_raw.ts`에
운영자가 고른 최대 3개 match ID를 `--match-id`로 명시해 실행한다. 이 보조 스크립트는 경기별
official match 요청과 telemetry asset 다운로드를 순차 실행하고, 15초 timeout,
HTTPS `api.pubg.com`/`*.pubg.com` 호스트 검사, redirect 거부, 0600 로컬 파일
권한을 적용한다. 응답은 `Content-Length`와 스트림 실제 바이트를 각각 32MiB,
telemetry 누적 96MiB로 제한하고 초과 시 reader를 취소한다. Supabase에는 쓰지
않으며, 실패한 대상은 자동 재시도하지 않는다.

```bash
npx tsx scripts/fetch_calculation_upgrade_raw.ts \
  --match-id 61fb7fc0-5d36-4706-b0a8-a4297f5f7ba6 \
  --match-id 08c29ff1-4f08-4df0-a6d0-b3f8319e6064
```

후속 후보 페이지는 출력의 `cursor.nextCursor`를 명시해 조회한다. 같은 페이지에서
`prepared` 행을 적용한 뒤에는 먼저 같은 cursor로 다시 준비해 `deferred_batch_limit`
행을 처리한다. 그 페이지에 더 이상 준비할 행이 없을 때만 다음 cursor를 사용한다.

```bash
npx tsx scripts/prepare_calculation_upgrade_batch.ts \
  --catalog /secure/raw/catalog.json \
  --cursor 100 --output tmp/calculation-upgrade-page-2.json \
  --batch-size 10 --scan-limit 100
```

cursor는 `created_at DESC, match_id, platform, player_id` 순서의 bounded offset이다.
새 전적이 앞에 추가되면 다음 페이지에서 이미 확인한 행을 다시 볼 수 있지만, current
version 확인과 RPC CAS가 재적용을 막는다. 이 cursor는 원본 보관의 완전성을 보장하는
목록이 아니라, 고정 첫 100행에 멈추지 않기 위한 안전한 순회 지점이다.

출력에는 `prepared`, `already_current`, `canonical_missing`,
`benchmark_missing`, `benchmark_ineligible`, `raw_unavailable`,
`deferred_batch_limit`, `source_byte_cap`별 identity와 count가 있다.
`raw_unavailable`에는 catalog 미등록·형식 불완전의 구체 이유가,
`deferred_batch_limit`에는 다음 작은 배치로 넘긴 이유가 남는다. 준비 상태는 아직 실행 중이
아니다. 비용 상한은 manifest의 `localSourceBytes`, DB read/write count,
`providerCalls: 0`, `upstreamDownloads: 0`으로 남긴다.

## 적용과 재개

검토 뒤 명시적으로 apply를 요청한다. 한 RPC가 성공한 뒤 즉시 fullResult와
benchmark를 읽어 postcondition을 검증하고 checkpoint를 저장한다.

```bash
npx tsx scripts/apply_calculation_upgrade_batch.ts \
  --apply --plan tmp/calculation-upgrade-prepared.json

npx tsx scripts/apply_calculation_upgrade_batch.ts \
  --apply --resume tmp/calculation-upgrade-prepared.json.checkpoint.json
```

적용 출력의 `completed`는 preflight에서 이미 목표와 일치한 행도 포함한다.
실제 RPC 시도 수는 `rpcWriteAttempts`와 checkpoint의
`counters.databaseWrites`로 따로 확인한다.

checkpoint는 `prepared → running → completed`만 실제 apply 중에 전이한다.
각 checkpoint는 mode 0600 임시 파일을 같은 디렉터리에 쓴 뒤 atomic rename으로
교체한다. `<checkpoint>.lock`이 있으면 동시 실행을 거부한다. 비정상 종료 뒤 남은
lock은 실행하지 않은 상태를 확인한 운영자가 제거한 뒤에만 재개한다.
경합은 `contended`로 끝내고, timeout/rate limit 등 일시 실패는
`transient_failed`로 남겨 다음 `--resume`에서만 다시 시도한다. 요청·원본
bytes·쓰기·에러·시간 상한에 닿으면 `paused`로 저장한다. 한 run의 오류 상한은
의도적으로 1이다. 불명확한 write 결과 뒤 다른 행을 계속 처리하지 않는다. resume은
매 runnable 행을 먼저 readback하여 목표 fullResult와 benchmark가 이미 일치하면
`completed`로 처리하고 RPC를 다시 쓰지 않는다. 계획의 hash가
원본 snapshot/result에서 달라지면 apply를 거부한다.

이 도구는 대량 실행, migration, 배포, Gemini 재생성을 수행하지 않는다.

## 기존 전적 화면의 상태 경계

계산 대기 단일 경기·스쿼드 기본 조회는 `analysisAvailability: basic_only`와
`analysisUnavailableReason: calculation_upgrade_required`를 제공한다. 공식 기본
기록은 유지하고 구 전술 수치는 전달하지 않는다. AI 생성은 기존
`PUBG_CALCULATION_UPGRADE_REQUIRED`로 차단한다. 화면은 자동 처리 중이나 완료
예정이라고 추정하지 않는다. 혼합 스쿼드는 계산 완료 경기만 전술 집계하며 제외 수를
표시한다. Gemini POST 자동 재호출은 하지 않는다.

`raw_unavailable`, `prepared`, `running`, `completed`, `contended`,
`transient_failed`를 사용자 화면에 정확히 표시하려면 배치 checkpoint 결과를 보존할
운영 저장소와 그 identity별 조회 API가 필요하다. 이 변경은 그 저장소·queue·관리자
대시보드를 만들지 않으며, 따라서 UI가 그 상태를 추정하지 않는다. 비교 표본 부족은
기존 v2 카드의 비교 불가·판정 보류 상태로 계속 표시한다.

부모 최종 점검: 준비 이후 canonical 행이 사라진 경우에는 재쓰기 없이 contended로 중단한다. runner 회귀 테스트로 확인했다.
