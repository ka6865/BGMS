import { describe, expect, it, vi } from "vitest";
import { BanApiError, type BanApiBatchResult } from "@/lib/pubg/banApiClient";
import {
  runBanWatchWorker,
  type BanStatusLease,
} from "@/scripts/refresh_pubg_bans";

const start = Date.parse("2026-09-11T00:00:00.000Z");

function lease(accountId: string, platform: "steam" | "kakao" = "steam"): BanStatusLease {
  return {
    platform,
    accountId,
    leaseToken: `lease-${platform}-${accountId}`,
    leaseExpiresAt: new Date(start + 15 * 60_000).toISOString(),
  };
}

function success(platform: "steam" | "kakao", ids: string[]): BanApiBatchResult {
  return {
    platform,
    requestedAccountIds: ids,
    statuses: ids.map((accountId) => ({ platform, accountId, rawType: "Innocent", status: "none" })),
    missingAccountIds: [],
  };
}

describe("PUBG ban watch worker", () => {
  it("claims up to six API batches, chunks at ten IDs, and waits between calls", async () => {
    let now = start;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const claims: BanStatusLease[][] = [
      Array.from({ length: 10 }, (_, index) => lease(`account.a${index}`)),
      [lease("account.a10")],
      [],
    ];
    const claim = vi.fn(async () => claims.shift() ?? []);
    const fetchBatch = vi.fn(async (platform: "steam" | "kakao", ids: string[]) => success(platform, ids));
    const observe = vi.fn(async () => "recorded" as const);

    const result = await runBanWatchWorker({
      claim,
      fetchBatch,
      observe,
      recordError: vi.fn(async () => true),
      now: () => now,
      sleep,
      batchIntervalMs: 65_000,
      maxDurationMs: 8 * 60_000,
    });

    expect(result.claimed).toBe(11);
    expect(result.uniqueClaimed).toBe(11);
    expect(result.batches).toBe(2);
    expect(result.observed).toBe(11);
    expect(fetchBatch).toHaveBeenNthCalledWith(1, "steam", Array.from({ length: 10 }, (_, index) => `account.a${index}`));
    expect(fetchBatch).toHaveBeenNthCalledWith(2, "steam", ["account.a10"]);
    expect(sleep).toHaveBeenCalledWith(65_000);
  });

  it("stops after a rate-limit response and records a retry for every lease", async () => {
    let now = start;
    const claimed = [lease("account.rate1"), lease("account.rate2")];
    const recordError = vi.fn<(lease: BanStatusLease, code: string, nextCheckAt: string) => Promise<boolean>>(async () => true);
    const result = await runBanWatchWorker({
      claim: vi.fn(async () => claimed),
      fetchBatch: vi.fn(async (): Promise<BanApiBatchResult> => {
        throw new BanApiError("rate_limited", { platform: "steam", status: 429, retryAfterSeconds: 120 });
      }),
      recordError,
      now: () => now,
      sleep: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
    });

    expect(result.rateLimited).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.batches).toBe(1);
    expect(result.errors).toBe(2);
    expect(recordError).toHaveBeenCalledTimes(2);
    expect(recordError.mock.calls[0]?.[1]).toBe("rate_limited");
    expect(Date.parse(recordError.mock.calls[0]?.[2] as string)).toBe(start + 120_000);
  });

  it("keeps prior status on a missing account and schedules a delayed retry", async () => {
    let now = start;
    const target = lease("account.missing");
    const recordError = vi.fn<(lease: BanStatusLease, code: string, nextCheckAt: string) => Promise<boolean>>(async () => true);
    const result = await runBanWatchWorker({
      claim: vi.fn().mockResolvedValueOnce([target]).mockResolvedValueOnce([]),
      fetchBatch: vi.fn(async (): Promise<BanApiBatchResult> => ({
        platform: "steam" as const,
        requestedAccountIds: [target.accountId],
        statuses: [],
        missingAccountIds: [target.accountId],
      })),
      observe: vi.fn(async () => "recorded" as const),
      recordError,
      now: () => now,
      sleep: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
    });

    expect(result.missing).toBe(1);
    expect(result.observed).toBe(0);
    expect(recordError).toHaveBeenCalledWith(target, "missing_account", new Date(start + 6 * 60 * 60_000).toISOString());
  });

  it("does not spin when a claim adapter returns duplicate keys", async () => {
    let now = start;
    const target = lease("account.duplicate");
    const claim = vi.fn().mockResolvedValue([target]);
    const result = await runBanWatchWorker({
      claim,
      fetchBatch: vi.fn(async () => success("steam", [target.accountId])),
      observe: vi.fn(async () => "recorded" as const),
      recordError: vi.fn(async () => true),
      now: () => now,
      sleep: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
    });

    expect(claim).toHaveBeenCalledTimes(2);
    expect(result.observed).toBe(1);
    expect(result.batches).toBe(1);
  });

  it("surfaces settlement failures in the summary", async () => {
    let now = start;
    const target = lease("account.write-failure");
    const result = await runBanWatchWorker({
      claim: vi.fn().mockResolvedValueOnce([target]).mockResolvedValueOnce([]),
      fetchBatch: vi.fn(async () => success("steam", [target.accountId])),
      observe: vi.fn(async () => { throw new Error("db write failed"); }),
      recordError: vi.fn(async () => false),
      now: () => now,
      sleep: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
    });

    expect(result.settlementFailures).toBeGreaterThan(0);
    expect(result.observed).toBe(0);
  });
});
