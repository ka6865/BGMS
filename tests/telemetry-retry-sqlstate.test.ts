import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TelemetryRegistryError,
  finalizeRecoveryAtomically,
} from "../lib/pubg-analysis/telemetryRegistry.server";

vi.mock("server-only", () => ({}));

const MIGRATION = resolve("supabase/migrations/20261013185213_telemetry_lease_errors_without_postgrest_retry.sql");
const MAP_CACHE_SOURCE = resolve("lib/pubg-analysis/telemetryMapCache.ts");

const input = {
  lease: {
    match_id: "match-1",
    platform: "steam",
    player_id: "account.1",
    mode: "lite",
    telemetry_version: 61,
    storage_path: "telemetry-map/v61/steam/match-1.json",
    lease_token: "11111111-1111-4111-8111-111111111111",
  },
  processedGuard: {},
  benchmarkGuard: {},
  rows: {},
} as unknown as Parameters<typeof finalizeRecoveryAtomically>[1];

function rpcReturning(...responses: Array<{ data?: unknown; error?: { code: string } | null; status?: number }>) {
  const rpc = vi.fn(() => {
    const response = responses.shift() ?? { data: null, error: null };
    return { abortSignal: () => Promise.resolve({ data: null, status: 200, ...response }) };
  });
  return { rpc, client: { rpc } as never };
}

describe("텔레메트리 lease 오류의 SQLSTATE", () => {
  it("migration 은 두 finalize 함수의 의도적 40001 만 개수를 확인하고 P0001 로 바꾼다", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("using errcode = ''40001''");
    expect(sql).toContain("using errcode = ''P0001''");
    expect(sql).toMatch(/finalize_telemetry_cache_write\([^)]*\)'::regprocedure,\s*2\s*\)/);
    expect(sql).toMatch(/finalize_telemetry_cache_recovery\([^)]*\)'::regprocedure,\s*3\s*\)/);
    // 이미 적용된 정의는 건너뛰고, 예상과 다른 정의는 치환하지 않는다.
    expect(sql).toContain("if v_old_count = 0 then");
    expect(sql).toContain("telemetry-retry-sqlstate-unexpected-count");
    expect(sql).toContain("telemetry-retry-sqlstate-still-present");
  });

  it("복구 finalize 가 P0001 을 받으면 롤백이 확실한 오류로 보고 다시 호출하지 않는다", async () => {
    const { rpc, client } = rpcReturning({ error: { code: "P0001" }, status: 400 });

    await expect(finalizeRecoveryAtomically(client, input)).rejects.toMatchObject({
      name: "TelemetryRegistryError",
      code: "P0001",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("실제 직렬화 충돌(40001)도 기존처럼 롤백 확정 오류로 한 번만 호출한다", async () => {
    const { rpc, client } = rpcReturning({ error: { code: "40001" }, status: 409 });

    await expect(finalizeRecoveryAtomically(client, input)).rejects.toBeInstanceOf(TelemetryRegistryError);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("응답이 모호한 오류는 기존처럼 한 번 다시 확인한다", async () => {
    const { rpc, client } = rpcReturning(
      { error: { code: "PGRST000" }, status: 503 },
      { data: { ok: true, code: "already_finalized" } },
    );

    await expect(finalizeRecoveryAtomically(client, input)).resolves.toMatchObject({ ok: true, code: "already_finalized" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("일반 캐시 저장은 lease 유실(P0001)을 일시적 오류로 보고 재시도하지 않는다", () => {
    const source = readFileSync(MAP_CACHE_SOURCE, "utf8");
    const classifier = source.slice(source.indexOf("function isTransientTelemetryRegistryError"));
    const body = classifier.slice(0, classifier.indexOf("\n}\n"));
    expect(body).not.toContain("P0001");
  });
});
