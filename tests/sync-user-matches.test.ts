import { describe, it, expect, vi } from "vitest";
import { isSyncEligible, fetchSyncCandidateUsers } from "../lib/pubg/userSyncHelper";
import {
  fetchAndIngestBasicMatchSummaryOutcome,
  type BasicMatchIngestOutcome,
} from "../lib/pubg/playerMatchesIngest";
import {
  runSyncUserMatches,
  main,
  writeRateLimitOutput,
  type SyncRunnerDependencies,
} from "../scripts/sync_user_matches";
 
 describe("userSyncHelper", () => {
   it("returns true if updated_at is older than 10 days", () => {
     const tenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString();
     expect(isSyncEligible(tenDaysAgo, 10)).toBe(true);
   });
 
   it("returns false if updated_at is within 10 days", () => {
     const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
     expect(isSyncEligible(recent, 10)).toBe(false);
   });
 
  it("returns true if updated_at is null or undefined", () => {
    expect(isSyncEligible(null)).toBe(true);
    expect(isSyncEligible(undefined)).toBe(true);
  });

  it("429 상태를 GitHub step output으로 기록한다", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "bgms-sync-output-"));
    const outputPath = join(directory, "github-output");

    writeRateLimitOutput(true, outputPath);

    await expect(readFile(outputPath, "utf8")).resolves.toBe("rate_limited=true\n");
  });

  it("uses the linked-player RPC and never falls back to pubg_player_cache", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        platform: "steam",
        normalized_nickname: "linked_player",
        display_nickname: "Linked_Player",
        last_active_at: "2026-08-18T00:00:00.000Z",
        last_success_at: null,
        consecutive_failures: 0,
      }],
      error: null,
    });
    const from = vi.fn(() => {
      throw new Error("cache fallback must not be queried");
    });
    const supabase = { rpc, from } as never;

    await expect(fetchSyncCandidateUsers(supabase, 15)).resolves.toEqual([{
      nickname: "Linked_Player",
      platform: "steam",
      priority: 1,
      normalizedNickname: "linked_player",
      displayNickname: "Linked_Player",
      lastActiveAt: "2026-08-18T00:00:00.000Z",
      lastSuccessAt: null,
      consecutiveFailures: 0,
    }]);
    expect(rpc).toHaveBeenCalledWith("list_pubg_linked_sync_candidates", expect.objectContaining({
      p_limit: 15,
    }));
    expect(from).not.toHaveBeenCalled();
  });

  it.each<BasicMatchIngestOutcome["status"]>([
    "saved",
    "not_found",
    "rate_limited",
    "upstream_error",
    "network_error",
  ])("exports a structured basic-match outcome for %s", async (status) => {
    const response = status === "network_error"
      ? Promise.reject(new Error("socket closed"))
      : Promise.resolve(new Response(
        status === "saved"
          ? JSON.stringify({
            data: { attributes: { createdAt: "2026-08-19T00:00:00.000Z", gameMode: "squad-fpp", mapName: "Erangel" } },
            included: [{ type: "participant", attributes: { stats: { name: "Linked_Player", kills: 1, damageDealt: 20, winPlace: 3 } } }],
          })
          : "{}",
        {
          status: status === "rate_limited" ? 429 : status === "not_found" ? 404 : status === "upstream_error" ? 503 : 200,
          headers: { "x-ratelimit-remaining": "9", "x-ratelimit-reset": "1787100000" },
        },
      ));
    const fetchImpl = vi.fn(() => response);
    const supabase = {
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: null }),
      })),
    } as never;

    const outcome = await fetchAndIngestBasicMatchSummaryOutcome(
      supabase,
      "match-structured",
      "Linked_Player",
      "steam",
      "api-key",
      { fetchImpl },
    );

    expect(outcome.status).toBe(status);
    if (status === "rate_limited") {
      expect(outcome.rateLimitHeaders?.remaining).toBe(9);
    }
  });

  function candidate(overrides: Record<string, unknown> = {}) {
    return {
      platform: "steam" as const,
      normalizedNickname: "linked_player",
      displayNickname: "Linked_Player",
      lastActiveAt: "2026-08-18T00:00:00.000Z",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      ...overrides,
    };
  }

  function runnerDependencies(overrides: Partial<SyncRunnerDependencies> = {}) {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const dependencies: SyncRunnerDependencies = {
      apiKey: "api-key",
      fetchCandidates: vi.fn().mockResolvedValue([candidate()]),
      claimSyncLease: vi.fn().mockResolvedValue(true),
      claimRefreshLock: vi.fn().mockResolvedValue(true),
      completeSync: vi.fn().mockResolvedValue(true),
      readQuota: vi.fn().mockResolvedValue({ remaining: 100, resetAt: null }),
      fetchRecentMatchIds: vi.fn().mockResolvedValue({ status: 200, matchIds: [], rateLimitHeaders: null }),
      readExistingMatchIds: vi.fn().mockResolvedValue([]),
      ingestMatch: vi.fn().mockResolvedValue({ status: "saved", record: { match_id: "match-1" } }),
      trackRateLimit: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => now,
      createLeaseToken: () => "11111111-1111-4111-8111-111111111111",
      writeOutput: vi.fn(),
      ...overrides,
    };
    return { dependencies, now };
  }

  it("records a successful zero-match sync with a 24-hour next eligible time", async () => {
    const { dependencies } = runnerDependencies();
    const summary = await runSyncUserMatches({ limit: 15, dependencies });

    expect(summary.syncedIdentities).toBe(1);
    expect(summary.newMatches).toBe(0);
    expect(dependencies.completeSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      nextEligibleAt: "2026-08-20T00:00:00.000Z",
    }));
  });

  it("skips a refresh-lock collision and clears the owned lease without failing it", async () => {
    const { dependencies } = runnerDependencies({
      claimRefreshLock: vi.fn().mockResolvedValue(false),
    });

    const summary = await runSyncUserMatches({ dependencies });

    expect(summary.lockCollisions).toBe(1);
    expect(dependencies.completeSync).toHaveBeenCalledWith(expect.objectContaining({ status: "idle" }));
    expect(dependencies.completeSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("marks a player 404 invalid and applies the seven-day backoff", async () => {
    const { dependencies } = runnerDependencies({
      fetchRecentMatchIds: vi.fn().mockResolvedValue({
        status: 404,
        matchIds: [],
        rateLimitHeaders: null,
      }),
    });

    await runSyncUserMatches({ dependencies });

    expect(dependencies.completeSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "invalid_nickname",
      nextEligibleAt: "2026-08-26T00:00:00.000Z",
    }));
  });

  it("stops all remaining candidates after a 429 and writes rate_limited output", async () => {
    const { dependencies } = runnerDependencies({
      fetchCandidates: vi.fn().mockResolvedValue([candidate(), candidate({ normalizedNickname: "second_player", displayNickname: "Second_Player" })]),
      fetchRecentMatchIds: vi.fn().mockResolvedValue({
        status: 429,
        matchIds: [],
        rateLimitHeaders: { remaining: 0, resetAt: "2026-08-19T01:00:00.000Z" },
      }),
    });

    const summary = await runSyncUserMatches({ dependencies });

    expect(summary.rateLimited).toBe(true);
    expect(summary.stoppedReason).toBe("rate_limited");
    expect(dependencies.claimSyncLease).toHaveBeenCalledTimes(1);
    expect(dependencies.writeOutput).toHaveBeenCalledWith(expect.objectContaining({ rateLimited: true }));
    expect(dependencies.completeSync).toHaveBeenCalledWith(expect.objectContaining({ status: "rate_limited" }));
  });

  it("uses the next exponential backoff slot after a transient failure", async () => {
    const { dependencies } = runnerDependencies({
      fetchRecentMatchIds: vi.fn().mockRejectedValue(new Error("network down")),
      fetchCandidates: vi.fn().mockResolvedValue([candidate({ consecutiveFailures: 1 })]),
    });

    await runSyncUserMatches({ dependencies });

    expect(dependencies.completeSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      consecutiveFailures: 2,
      nextEligibleAt: "2026-08-19T06:00:00.000Z",
    }));
  });

  it("uses a fresh current clock for each lease and completion timestamp", async () => {
    let clockMs = Date.parse("2026-08-19T00:00:00.000Z");
    const first = candidate();
    const second = candidate({
      normalizedNickname: "second_player",
      displayNickname: "Second_Player",
    });
    const { dependencies } = runnerDependencies({
      fetchCandidates: vi.fn().mockResolvedValue([first, second]),
      now: () => new Date(clockMs),
      claimSyncLease: vi.fn().mockImplementation(async ({ normalizedNickname }) => {
        expect(normalizedNickname).toBe(clockMs === Date.parse("2026-08-19T00:00:00.000Z")
          ? "linked_player"
          : "second_player");
        return true;
      }),
      fetchRecentMatchIds: vi.fn().mockImplementation(async ({ normalizedNickname }) => {
        clockMs += normalizedNickname === "linked_player" ? 5 * 60 * 1000 : 5 * 60 * 1000;
        return { status: 200, matchIds: [], rateLimitHeaders: null };
      }),
    });

    await runSyncUserMatches({ dependencies, leaseDurationMs: 15 * 60 * 1000 });

    expect(dependencies.claimSyncLease).toHaveBeenNthCalledWith(1, expect.objectContaining({
      leaseExpiresAt: "2026-08-19T00:15:00.000Z",
    }));
    expect(dependencies.claimSyncLease).toHaveBeenNthCalledWith(2, expect.objectContaining({
      leaseExpiresAt: "2026-08-19T00:20:00.000Z",
    }));
    expect(dependencies.completeSync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      nextEligibleAt: "2026-08-20T00:05:00.000Z",
    }));
  });

  it("ignores an expired exhausted quota and settles an active exhausted quota until reset", async () => {
    const expired = runnerDependencies({
      readQuota: vi.fn().mockResolvedValue({ remaining: 0, resetAt: "2026-08-18T23:00:00.000Z" }),
      fetchRecentMatchIds: vi.fn().mockResolvedValue({ status: 200, matchIds: [], rateLimitHeaders: null }),
    });
    const expiredSummary = await runSyncUserMatches({ dependencies: expired.dependencies });
    expect(expiredSummary.stoppedReason).toBeNull();
    expect(expired.dependencies.fetchRecentMatchIds).toHaveBeenCalledTimes(1);

    const active = runnerDependencies({
      readQuota: vi.fn().mockResolvedValue({ remaining: 0, resetAt: "2026-08-19T01:00:00.000Z" }),
      fetchRecentMatchIds: vi.fn(),
    });
    const activeSummary = await runSyncUserMatches({ dependencies: active.dependencies });
    expect(activeSummary.stoppedReason).toBe("quota_exhausted");
    expect(active.dependencies.fetchRecentMatchIds).not.toHaveBeenCalled();
    expect(active.dependencies.completeSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "idle",
      nextEligibleAt: "2026-08-19T01:00:00.000Z",
    }));
  });

  it("keeps 429 handling when rate-limit persistence fails and persists both response sources by default", async () => {
    const trackRateLimit = vi.fn(() => {
      throw new Error("tracker unavailable");
    });
    const { dependencies } = runnerDependencies({
      fetchRecentMatchIds: vi.fn().mockResolvedValue({
        status: 429,
        matchIds: [],
        rateLimitHeaders: { limit: 10, remaining: 0, reset: 1787100000, resetAt: "2026-08-19T01:00:00.000Z", retryAfter: null, retryAfterMs: null },
      }),
      trackRateLimit,
    });

    const summary = await runSyncUserMatches({ dependencies });

    expect(summary.rateLimited).toBe(true);
    expect(summary.stoppedReason).toBe("rate_limited");
    expect(trackRateLimit).toHaveBeenCalledWith(expect.objectContaining({ remaining: 0 }), "player");
  });

  it("persists player and match rate-limit snapshots through the production Supabase boundary", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        expect(table).toBe("pubg_api_status");
        return { insert };
      }),
    } as never;
    const { dependencies } = runnerDependencies({
      supabase,
      fetchRecentMatchIds: vi.fn().mockResolvedValue({
        status: 200,
        matchIds: ["new-match"],
        rateLimitHeaders: {
          limit: 10,
          remaining: 8,
          reset: 1787100000,
          resetAt: "2026-08-19T01:00:00.000Z",
          retryAfter: null,
          retryAfterMs: null,
        },
      }),
      ingestMatch: vi.fn().mockResolvedValue({
        status: "saved",
        record: { match_id: "new-match" },
        httpStatus: 200,
        rateLimitHeaders: {
          limit: 10,
          remaining: 7,
          reset: 1787100000,
          resetAt: "2026-08-19T01:00:00.000Z",
          retryAfter: null,
          retryAfterMs: null,
        },
      }),
    });

    await runSyncUserMatches({ dependencies: { ...dependencies, trackRateLimit: undefined } });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenNthCalledWith(1, expect.objectContaining({ api_limit: 10, remaining: 8 }));
    expect(insert).toHaveBeenNthCalledWith(2, expect.objectContaining({ api_limit: 10, remaining: 7 }));
  });

  it("requires credentials or explicit substitutes for every default API/DB boundary", async () => {
    const { dependencies } = runnerDependencies({
      apiKey: undefined,
      fetchRecentMatchIds: vi.fn().mockResolvedValue({ status: 200, matchIds: ["missing-match"], rateLimitHeaders: null }),
      readExistingMatchIds: vi.fn().mockResolvedValue([]),
      ingestMatch: undefined,
    });

    await expect(runSyncUserMatches({ dependencies })).rejects.toThrow("PUBG_API_KEY missing");

    const output = vi.fn();
    const complete = runnerDependencies({
      apiKey: "api-key",
      writeOutput: output,
    });
    await expect(main({ ...complete.dependencies, limit: 1 })).resolves.toEqual(expect.objectContaining({
      candidateCount: 1,
    }));
    expect(output).toHaveBeenCalled();
  });

  it("surfaces lease-claim control-plane failures instead of reporting an empty success", async () => {
    const { dependencies } = runnerDependencies({
      claimSyncLease: vi.fn().mockRejectedValue(new Error("claim rpc down")),
    });

    await expect(runSyncUserMatches({ dependencies })).rejects.toThrow("linked-player-sync-claim-failed");
  });

  it.each([
    ["false", vi.fn().mockResolvedValue(false)],
    ["throw", vi.fn().mockRejectedValue(new Error("completion rpc down"))],
  ])("surfaces completion %s and does not count success", async (_label, completeSync) => {
    const output = vi.fn();
    const { dependencies } = runnerDependencies({ completeSync, writeOutput: output });

    await expect(runSyncUserMatches({ dependencies })).rejects.toThrow();
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      syncedIdentities: 0,
    }));
  });

  it("preserves the primary runner error when the output writer also fails", async () => {
    const { dependencies } = runnerDependencies({
      fetchCandidates: vi.fn().mockRejectedValue(new Error("primary runner failure")),
      writeOutput: vi.fn(() => {
        throw new Error("output writer failure");
      }),
    });

    await expect(runSyncUserMatches({ dependencies })).rejects.toThrow("primary runner failure");
    expect(dependencies.writeOutput).toHaveBeenCalledTimes(1);
  });

  it("surfaces an output-writer error when the primary run succeeds", async () => {
    const { dependencies } = runnerDependencies({
      writeOutput: vi.fn(() => {
        throw new Error("output writer failure");
      }),
    });

    await expect(runSyncUserMatches({ dependencies })).rejects.toThrow("output writer failure");
  });
});
