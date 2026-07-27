# 텔레메트리 캐시 장애 격리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supabase 텔레메트리 캐시 쓰기가 timeout 또는 잠금 대기로 실패해도 매치 분석 결과는 200으로 반환하고, 캐시 쓰기는 제한 재시도·구조화된 관측·다음 요청 회복 경로를 갖게 한다.

**Architecture:** `telemetryMapCache`는 reservation 재사용과 transient DB 실패 재시도를 담당하고, registry adapter는 Supabase 오류를 보존한 도메인 오류로 변환한다. `/api/pubg/match`는 캐시 지속성 실패를 분석 계산과 파생 통계 저장에서 분리해 서버 관측만 남기며 성공 응답을 반환한다. SQL은 테이블 전체 잠금 없이 key 단위 upsert와 `SKIP LOCKED` cleanup을 사용한다.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Supabase Postgres/PLpgSQL, Cloudflare R2.

## Global Constraints

- 사용자·매치·계정 원문과 Supabase 세부 오류를 HTTP 응답 또는 Discord 본문에 노출하지 않는다.
- `processed_match_telemetry` identity는 `match_id + platform + player_id`를 유지한다.
- cache identity는 `match_id + platform + player_id + mode + telemetry_version`를 유지한다.
- transient 오류만 최대 두 번 재시도하고, 입력·권한·RLS·무결성 오류는 재시도하지 않는다.
- cleanup은 잠긴 대상 행을 건너뛰며 운영 데이터를 삭제하지 않는다.
- 기존 미커밋 UI 변경과 무관한 분리 worktree에서만 구현한다.
- 각 Task는 테스트를 먼저 실패시키고 최소 구현 후 해당 테스트를 통과시킨다.

---

## 파일 구조

- `lib/pubg-analysis/telemetryRegistry.server.ts`: Supabase 오류 코드를 보존하는 registry write adapter.
- `lib/pubg-analysis/telemetryMapCache.ts`: reservation 재사용, 제한 재시도, cache write 결과를 담당.
- `app/api/pubg/match/route.ts`: cache persistence best-effort 경계와 분석 응답 분리.
- `lib/pubg/apiErrorContext.ts`: cache persistence의 사용자 비노출 오류 분류.
- `lib/pubg/apiHelper.ts`: 구조화된 detail 저장과 Discord dedupe key 확장.
- `supabase/migrations/20260727000000_telemetry_cache_lock_resilience.sql`: RPC 잠금 축소와 alert reservation conflict suppression.
- `tests/telemetry-map-cache.test.ts`: reservation 재사용·재시도·비재시도 계약.
- `tests/pubg-ingest-boundary.test.ts`: cache write 실패에도 match 200 계약.
- `tests/telemetry-cleanup.test.ts`: cleanup migration의 row locking/`SKIP LOCKED` 계약.
- `tests/pubg-api-helper.test.ts`: 오류 detail과 error-code 단위 Discord dedupe 계약.

## Task 1: Supabase 캐시 오류를 분류 가능한 도메인 오류로 변환

**Files:**
- Modify: `lib/pubg-analysis/telemetryRegistry.server.ts`
- Test: `tests/telemetry-map-cache.test.ts`

**Interfaces:**
- Produces: `TelemetryRegistryError` with `operation`, `code`, `status`, and safe `message`.
- Consumes: Supabase `{ error: { code?: string; status?: number; message: string } }` responses.

- [ ] **Step 1: 실패 테스트를 작성한다**

`tests/telemetry-map-cache.test.ts`에 registry adapter를 직접 mock Supabase로 호출하는 테스트를 추가한다.

```ts
it("registry reserve가 Supabase timeout code를 보존한 오류를 던진다", async () => {
  const supabase = {
    from: vi.fn(() => ({
      upsert: vi.fn().mockResolvedValue({
        error: { code: "57014", status: 500, message: "canceling statement due to statement timeout" },
      }),
    })),
  } as any;

  await expect(upsertTelemetryMapCacheReservation(supabase, row)).rejects.toMatchObject({
    name: "TelemetryRegistryError",
    operation: "reserve",
    code: "57014",
    status: 500,
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npm run test:unit -- tests/telemetry-map-cache.test.ts`  
Expected: `TelemetryRegistryError`가 export되지 않았거나 generic error만 반환되어 FAIL.

- [ ] **Step 3: 최소 도메인 오류와 adapter 변환을 구현한다**

`lib/pubg-analysis/telemetryRegistry.server.ts`에 아래 형태를 추가하고, reserve/finalize의 `if (error)` 분기에서 사용한다.

```ts
export class TelemetryRegistryError extends Error {
  readonly operation: "reserve" | "finalize";
  readonly code: string | null;
  readonly status: number | null;

  constructor(
    operation: "reserve" | "finalize",
    error: { code?: string | null; status?: number | null },
  ) {
    super(`telemetry-cache-${operation}-failed`);
    this.name = "TelemetryRegistryError";
    this.operation = operation;
    this.code = error.code ?? null;
    this.status = error.status ?? null;
  }
}
```

원본 `error.message`는 서버 내부 console에만 선택적으로 사용하고, 이 오류의 public message와 route response에는 포함하지 않는다.

- [ ] **Step 4: 단위 테스트를 통과시킨다**

Run: `npm run test:unit -- tests/telemetry-map-cache.test.ts`  
Expected: PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add lib/pubg-analysis/telemetryRegistry.server.ts tests/telemetry-map-cache.test.ts
git commit -m "feat: 텔레메트리 registry 오류 코드 보존"
```

## Task 2: reservation 재사용과 transient 재시도 추가

**Files:**
- Modify: `lib/pubg-analysis/telemetryMapCache.ts`
- Modify: `app/api/pubg/match/route.ts`
- Modify: `app/api/pubg/telemetry/route.ts`
- Test: `tests/telemetry-map-cache.test.ts`

**Interfaces:**
- Produces: `TelemetryMapCacheWriteOptions`.
- `writeTelemetryMapCache(identity, payload, deps, options?)` accepts `{ reservedRow?: TelemetryMapCacheRegistryRow }`.
- `retryTelemetryRegistryWrite(operation)` retries only `TelemetryRegistryError` code `57014`, `55P03`, `40001`, or status `>= 500`.

- [ ] **Step 1: reservation 재사용과 재시도의 실패 테스트를 작성한다**

`tests/telemetry-map-cache.test.ts`에 다음 세 테스트를 추가한다.

```ts
it("이미 예약한 row를 받으면 write는 reserve를 다시 호출하지 않는다", async () => {
  const deps = createDeps();
  const reservedRow = createRegistryRow(identity, "pending", new Date("2026-07-18T00:00:00.000Z"));

  await writeTelemetryMapCache(identity, payload, deps, { reservedRow });

  expect(deps.reserve).not.toHaveBeenCalled();
  expect(deps.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
});

it("statement timeout reserve는 두 번 재시도 후 성공한다", async () => {
  const reserve = vi.fn()
    .mockRejectedValueOnce(new TelemetryRegistryError("reserve", { code: "57014", status: 500 }))
    .mockRejectedValueOnce(new TelemetryRegistryError("reserve", { code: "55P03", status: 500 }))
    .mockResolvedValue(undefined);

  await reserveTelemetryMapCache(identity, createDeps({ reserve, sleep: vi.fn() }));

  expect(reserve).toHaveBeenCalledTimes(3);
});

it("입력 오류 finalize는 재시도하지 않는다", async () => {
  const finalize = vi.fn().mockRejectedValue(
    new TelemetryRegistryError("finalize", { code: "22023", status: 400 }),
  );

  await expect(writeTelemetryMapCache(identity, payload, createDeps({ finalize, sleep: vi.fn() })))
    .rejects.toMatchObject({ code: "22023" });
  expect(finalize).toHaveBeenCalledOnce();
});
```

테스트가 실제 시간을 기다리지 않도록 `TelemetryMapCacheDependencies`에 `sleep(ms: number): Promise<void>`를 추가하고 fixture는 `vi.fn().mockResolvedValue(undefined)`를 제공한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npm run test:unit -- tests/telemetry-map-cache.test.ts`  
Expected: 새 option/dependency와 retry helper가 없어 FAIL.

- [ ] **Step 3: retry helper와 reservation 재사용 경로를 구현한다**

`telemetryMapCache.ts`에 아래 계약을 구현한다.

```ts
export type TelemetryMapCacheWriteOptions = {
  reservedRow?: TelemetryMapCacheRegistryRow;
};

const RETRY_DELAYS_MS = [250, 750] as const;

function isTransientTelemetryRegistryError(error: unknown): boolean {
  return error instanceof TelemetryRegistryError
    && (error.code === "57014" || error.code === "55P03" || error.code === "40001" || (error.status ?? 0) >= 500);
}
```

`reserveTelemetryMapCache`와 finalize 호출을 `retryTelemetryRegistryWrite`로 감싼다. retry helper는 `RETRY_DELAYS_MS`를 순서대로 사용하고, `Math.random()` 기반 0~150ms jitter를 더한다. 테스트는 `random` dependency를 주입해 `0`으로 고정한다.

`writeTelemetryMapCache`는 `options.reservedRow`가 있으면 reserve를 건너뛰고 그 row의 storage path를 사용한다. 없으면 기존처럼 reserve 후 진행한다. ready row는 pending row와 동일 identity·storage path를 유지하되 status와 lease만 바꾼다.

- [ ] **Step 4: 두 route의 중복 reservation을 제거한다**

`app/api/pubg/match/route.ts`와 `app/api/pubg/telemetry/route.ts`에서 분석/다운로드 전의 `reserveTelemetryMapCache` 결과 row를 저장하고, 마지막 `writeTelemetryMapCache`에 `{ reservedRow }`로 전달한다.

`reserveTelemetryMapCache`의 public return type을 string에서 `TelemetryMapCacheRegistryRow`로 바꾸지 않는다. 대신 새 함수 `reserveTelemetryMapCacheRow`를 export하고 기존 함수는 `storage_path`만 반환하는 compatibility wrapper로 유지한다.

```ts
const reservedRow = await reserveTelemetryMapCacheRow(identity, deps);
// expensive telemetry work
await writeTelemetryMapCache(identity, payload, deps, { reservedRow });
```

두 route 모두 reservation이 expensive telemetry fetch보다 앞서는 기존 lease 보호 순서를 유지한다.

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `npm run test:unit -- tests/telemetry-map-cache.test.ts tests/pubg-ingest-boundary.test.ts`  
Expected: PASS, 그리고 mock registry upsert가 match route 단일 분석당 한 번만 호출됨.

- [ ] **Step 6: 커밋한다**

```bash
git add lib/pubg-analysis/telemetryMapCache.ts app/api/pubg/match/route.ts app/api/pubg/telemetry/route.ts tests/telemetry-map-cache.test.ts tests/pubg-ingest-boundary.test.ts
git commit -m "fix: 텔레메트리 캐시 예약 재사용과 제한 재시도 적용"
```

## Task 3: `/api/pubg/match`에서 캐시 실패를 사용자 응답과 분리

**Files:**
- Modify: `app/api/pubg/match/route.ts`
- Modify: `lib/pubg/apiErrorContext.ts`
- Test: `tests/pubg-ingest-boundary.test.ts`

**Interfaces:**
- Produces: `PubgAnalysisStep` value `telemetry_cache_persistence` only for server-side cache persistence observations.
- Consumes: `TelemetryRegistryError` from Task 1.

- [ ] **Step 1: 실패 테스트를 작성한다**

`tests/pubg-ingest-boundary.test.ts`의 Supabase `mockFrom`과 `mockRpc`를 사용해 reserve/finalize가 transient failure를 모두 소진하는 상황을 만든다.

```ts
it("텔레메트리 캐시 저장이 최종 실패해도 매치 분석 결과는 200으로 반환한다", async () => {
  mockFrom.mockImplementationOnce(() => ({
    upsert: vi.fn().mockResolvedValue({
      error: { code: "57014", status: 500, message: "statement timeout" },
    }),
  }));

  const response = await GET(createMatchRequest());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ matchId: MATCH_ID }));
  expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
    message: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE",
    notify: true,
    context: expect.objectContaining({ failureStage: "analysis:telemetry_cache_persistence" }),
  }));
});
```

추가 테스트에서 `persistMatchAnalysis`는 여전히 한 번 호출되고, 응답 직렬화에 Supabase 원본 메시지나 account id가 없는지 확인한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npm run test:unit -- tests/pubg-ingest-boundary.test.ts`  
Expected: 현재 route가 cache failure를 outer catch로 전파해 500을 반환하므로 FAIL.

- [ ] **Step 3: best-effort 캐시 경계를 구현한다**

`reanalyzeAndSave`에서 telemetry payload 생성 뒤 cache write만 별도 `try/catch`로 감싼다. 분석 engine 결과와 `persistMatchAnalysis` 호출은 catch 밖에 둔다.

```ts
try {
  await writeTelemetryMapCache(telemetryIdentity, telemetryPayload, cacheDeps, { reservedRow });
} catch (error) {
  await reportPubgApiError({
    route: "/api/pubg/match",
    status: 503,
    message: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE",
    detail: serializeTelemetryCacheFailure(error, retryCount, startedAt),
    notify: true,
    context: { failureStage: "analysis:telemetry_cache_persistence", ...requestContext },
  });
}
```

초기 reservation도 같은 best-effort 경계에 넣는다. 초기 reservation이 실패하면 분석을 계속하고, 마지막 write가 자체 reservation 경로로 한 번 더 회복을 시도한다. `isR2Configured() === false`인 기존 503 정책은 바꾸지 않는다.

`classifyPubgMatchError`에는 cache persistence가 outer catch로 도달할 경우를 위한 explicit code를 추가하되, 정상 best-effort 경로에서는 이를 사용하지 않는다.

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `npm run test:unit -- tests/pubg-ingest-boundary.test.ts tests/pubg-api-error-context.test.ts`  
Expected: PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add app/api/pubg/match/route.ts lib/pubg/apiErrorContext.ts tests/pubg-ingest-boundary.test.ts tests/pubg-api-error-context.test.ts
git commit -m "fix: 캐시 저장 실패를 매치 분석 응답에서 격리"
```

## Task 4: SQL 잠금 축소와 alert reservation 충돌 억제

**Files:**
- Create: `supabase/migrations/20260727000000_telemetry_cache_lock_resilience.sql`
- Modify: `tests/telemetry-cleanup.test.ts`
- Modify: `lib/pubg/apiHelper.ts`
- Modify: `tests/pubg-api-helper.test.ts`

**Interfaces:**
- Replaces: `public.finalize_telemetry_cache_write(...)` with the same 14-argument signature.
- Replaces: `public.cleanup_expired_telemetry_matches(text[], timestamptz, numeric, timestamptz)` with the same return signature.
- Produces: `public.reserve_pubg_api_alert_delivery(text, timestamptz) returns boolean` and a `reserveDiscordAlertWindow` caller that receives an atomic inserted/not-inserted result.

- [ ] **Step 1: migration contract 실패 테스트를 작성한다**

`tests/telemetry-cleanup.test.ts`의 migration source assertion을 새 migration 파일로 변경하고 다음을 검증한다.

```ts
expect(migration).not.toContain("lock table public.telemetry_map_cache_entries");
expect(migration).toContain("for update skip locked");
expect(migration).toContain("order by cache.match_id");
expect(migration).toContain("cache.lease_expires_at < p_now");
expect(migration).toContain("telemetry-cleanup-postcondition-failed");
```

`tests/pubg-api-helper.test.ts`에는 alert reservation이 `reserve_pubg_api_alert_delivery` RPC를 호출하고, RPC가 `false`를 반환할 때 Discord 전송을 건너뛰며 console error를 남기지 않는 테스트를 추가한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npm run test:unit -- tests/telemetry-cleanup.test.ts tests/pubg-api-helper.test.ts`  
Expected: 새 migration과 upsert conflict suppression이 없어 FAIL.

- [ ] **Step 3: 새 migration을 작성한다**

`finalize_telemetry_cache_write`를 동일한 입력·권한 설정으로 `CREATE OR REPLACE FUNCTION` 한다. 기존 `lock table` 문은 넣지 않고, 세 upsert의 unique constraint로 per-key atomicity를 유지한다.

`cleanup_expired_telemetry_matches`에서는 다음 순서를 사용한다.

```sql
WITH requested AS (
  SELECT match_id
  FROM unnest(p_match_ids) AS input(match_id)
  ORDER BY match_id
), locked_cache AS (
  SELECT cache.id, cache.match_id
  FROM public.telemetry_map_cache_entries AS cache
  JOIN requested ON requested.match_id = cache.match_id
  ORDER BY cache.match_id, cache.id
  FOR UPDATE OF cache SKIP LOCKED
)
SELECT array_agg(match_id ORDER BY match_id)
INTO eligible_match_ids
FROM locked_cache;
```

`eligible_match_ids`에 없는 requested row는 이번 실행에서 건너뛴다. 이후 기존 cutoff, active lease, postcondition 재검증 및 순차 delete를 `eligible_match_ids`만 대상으로 수행한다. master row도 같은 match_id 정렬 순서와 `FOR UPDATE SKIP LOCKED`를 사용한다. 함수 끝의 revoke/grant는 기존 service_role 계약을 유지한다.

- [ ] **Step 4: alert dedupe 저장을 변경한다**

`lib/pubg/apiHelper.ts`에서 alert key를 `${route}:${status}:${context?.errorCode ?? "unknown"}`으로 만들고, migration이 제공하는 atomic RPC를 사용한다.

```ts
const { data, error } = await supabaseAdmin.rpc(
  "reserve_pubg_api_alert_delivery",
  { p_alert_key: alertKey, p_window_started_at: windowStartedAt },
);

return !error && data === true;
```

새 migration은 `INSERT ... ON CONFLICT DO NOTHING RETURNING true` 결과를 `coalesce(..., false)`로 반환하고 service_role에만 execute 권한을 부여한다. `ApiErrorRecord`에 `errorCode`를 저장해 alert key 생성 시 원인별 dedupe를 사용한다. `reportPubgApiError`의 기존 route/status 집계는 유지한다.

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `npm run test:unit -- tests/telemetry-cleanup.test.ts tests/pubg-api-helper.test.ts`  
Expected: PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add supabase/migrations/20260727000000_telemetry_cache_lock_resilience.sql tests/telemetry-cleanup.test.ts lib/pubg/apiHelper.ts tests/pubg-api-helper.test.ts
git commit -m "fix: 텔레메트리 캐시 잠금 범위 축소"
```

## Task 5: 전체 검증과 운영 배포 준비

**Files:**
- Modify: `docs-private/.project_context.md`
- Test: `tests/pubg-ingest-boundary.test.ts`, `tests/telemetry-map-cache.test.ts`, `tests/telemetry-cleanup.test.ts`, `tests/pubg-api-helper.test.ts`

**Interfaces:**
- Documents: cache persistence failure is best-effort for `/api/pubg/match`; direct replay route still requires a finalized cache object to return a signed URL.

- [ ] **Step 1: 운영 계약 테스트를 추가한다**

`tests/pubg-ingest-boundary.test.ts`에 retry exhaustion, cache persistence observation, successful `persistMatchAnalysis`, and sanitized 200 response를 하나의 test로 확인한다. `tests/telemetry-map-cache.test.ts`에 retryable code 목록 밖의 `42501`이 한 번만 호출되는 test를 추가한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npm run test:unit -- tests/pubg-ingest-boundary.test.ts tests/telemetry-map-cache.test.ts`  
Expected: Task 1~4 구현 전에는 cache failure가 500이거나 retry behavior가 없어 FAIL.

- [ ] **Step 3: 프로젝트 문서를 갱신한다**

`docs-private/.project_context.md`에 다음 사실만 추가한다.

```md
- `/api/pubg/match`의 telemetry cache persistence는 best-effort다. cache reserve/finalize transient failure는 분석 응답을 500으로 만들지 않으며, `pubg_api_errors`의 `analysis:telemetry_cache_persistence`로 관측한다.
- telemetry cleanup은 대상 행만 `FOR UPDATE SKIP LOCKED`로 잠그며 active writer가 있는 match는 다음 cleanup run으로 미룬다.
```

- [ ] **Step 4: 전체 검증을 실행한다**

Run: `npm run test:unit -- tests/pubg-ingest-boundary.test.ts tests/telemetry-map-cache.test.ts tests/telemetry-cleanup.test.ts tests/pubg-api-helper.test.ts tests/pubg-api-error-context.test.ts`  
Expected: PASS.

Run: `npm run verify:analysis`  
Expected: PASS.

Run: `npm run verify:core`  
Expected: PASS; 기존 경고만 존재할 수 있으나 새로운 lint/type error는 없어야 함.

- [ ] **Step 5: migration dry-run과 production 적용 전 점검을 수행한다**

Supabase SQL editor 또는 migration tool에서 새 migration을 production에 적용하기 전 다음 read-only query를 실행한다.

```sql
SELECT
  count(*) FILTER (WHERE status = 'pending') AS pending_count,
  count(*) FILTER (WHERE status = 'pending' AND lease_expires_at < now()) AS expired_pending_count,
  max(updated_at) AS latest_cache_update
FROM public.telemetry_map_cache_entries;
```

적용 후 동일 query와 `SELECT pg_get_functiondef(...)`로 table lock 문이 없는 새 함수 정의를 확인한다. 삭제·cleanup 실행은 하지 않는다.

- [ ] **Step 6: 커밋하고 검토를 요청한다**

```bash
git add docs-private/.project_context.md tests/pubg-ingest-boundary.test.ts tests/telemetry-map-cache.test.ts
git commit -m "docs: 텔레메트리 캐시 장애 격리 운영 계약 반영"
```

코드 리뷰 후 migration 적용, develop 반영, main 반영 순서로 배포한다. 배포 후 30분 동안 `PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE` 수, cache reserve/finalize p95 duration, 500 비율, Discord alert count를 확인한다.

## 계획 자체 검토

- 장애 원인인 중복 reservation, table-level lock, cache failure 전파, 관측 부족을 각각 Task 2~4가 다룬다.
- SQL 함수 signature와 service_role 권한은 유지해 caller compatibility를 보장한다.
- retry 대상과 제외 대상을 명시해 잘못된 입력을 반복 호출하지 않는다.
- cleanup이 잠긴 행을 건너뛰는 경우는 다음 실행에서 재시도하므로 데이터 삭제 범위를 넓히지 않는다.
- 사용자 응답 격리는 `/api/pubg/match`에 한정하고, signed URL을 만들어야 하는 `/api/pubg/telemetry`의 성공 계약은 유지한다.
