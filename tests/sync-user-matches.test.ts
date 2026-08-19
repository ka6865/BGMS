import { describe, it, expect, vi } from "vitest";
import { isSyncEligible, fetchSyncCandidateUsers } from "../lib/pubg/userSyncHelper";
import {
  fetchAndIngestBasicMatchSummaryOutcome,
  type BasicMatchIngestOutcome,
} from "../lib/pubg/playerMatchesIngest";
import {
  runSyncUserMatches,
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
      ingestMatch: vi.fn().mockResolvedValue({ status: "saved", record: { match_id: "match-1" } }),
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
});
