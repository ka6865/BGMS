import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimLinkedPlayerSync,
  completeLinkedPlayerSync,
  fetchLinkedPlayerSyncCandidates,
  type LinkedPlayerSyncRpcClient,
} from "@/lib/pubg/linkedPlayerSync.server";

function createClient(result: { data: unknown; error: unknown }): LinkedPlayerSyncRpcClient & {
  rpc: ReturnType<typeof vi.fn>;
} {
  return { rpc: vi.fn().mockResolvedValue(result) };
}

describe("linked player sync server wrappers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a validated candidate row and forwards list arguments", async () => {
    const supabaseAdmin = createClient({
      data: [{
        platform: "steam",
        normalized_nickname: "fixture_player",
        display_nickname: "Fixture_Player",
        last_active_at: "2026-08-18T00:00:00.000Z",
        last_success_at: null,
        consecutive_failures: 0,
      }],
      error: null,
    });

    await expect(fetchLinkedPlayerSyncCandidates({
      supabaseAdmin,
      limit: 15,
      activeSince: "2026-07-19T00:00:00.000Z",
    })).resolves.toEqual([{
      platform: "steam",
      normalizedNickname: "fixture_player",
      displayNickname: "Fixture_Player",
      lastActiveAt: "2026-08-18T00:00:00.000Z",
      lastSuccessAt: null,
      consecutiveFailures: 0,
    }]);

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith("list_pubg_linked_sync_candidates", {
      p_limit: 15,
      p_active_since: "2026-07-19T00:00:00.000Z",
    });
  });

  it("returns a boolean claim result with canonical RPC arguments", async () => {
    const supabaseAdmin = createClient({ data: true, error: null });
    const leaseToken = "11111111-1111-4111-8111-111111111111";

    await expect(claimLinkedPlayerSync({
      supabaseAdmin,
      platform: "steam",
      normalizedNickname: "fixture_player",
      displayNickname: "Fixture_Player",
      leaseToken,
      leaseExpiresAt: "2026-08-19T01:00:00.000Z",
    })).resolves.toBe(true);

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith("claim_pubg_linked_sync", {
      p_platform: "steam",
      p_normalized_nickname: "fixture_player",
      p_display_nickname: "Fixture_Player",
      p_lease_token: leaseToken,
      p_lease_expires_at: "2026-08-19T01:00:00.000Z",
    });
  });

  it("forwards completion and rejects malformed RPC data", async () => {
    const supabaseAdmin = createClient({ data: true, error: null });
    const leaseToken = "22222222-2222-4222-8222-222222222222";

    await expect(completeLinkedPlayerSync({
      supabaseAdmin,
      platform: "kakao",
      normalizedNickname: "fixture_player",
      leaseToken,
      status: "success",
      lastSuccessAt: "2026-08-19T00:00:00.000Z",
      nextEligibleAt: "2026-08-20T00:00:00.000Z",
      consecutiveFailures: 0,
      lastErrorCode: null,
    })).resolves.toBe(true);

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith("complete_pubg_linked_sync", {
      p_platform: "kakao",
      p_normalized_nickname: "fixture_player",
      p_lease_token: leaseToken,
      p_status: "success",
      p_last_success_at: "2026-08-19T00:00:00.000Z",
      p_next_eligible_at: "2026-08-20T00:00:00.000Z",
      p_consecutive_failures: 0,
      p_last_error_code: null,
    });

    const malformed = createClient({
      data: [{
        platform: "xbox",
        normalized_nickname: "fixture_player",
        display_nickname: "Fixture_Player",
        last_active_at: "not-a-date",
        last_success_at: null,
        consecutive_failures: -1,
      }],
      error: null,
    });

    await expect(fetchLinkedPlayerSyncCandidates({ supabaseAdmin: malformed }))
      .rejects.toThrow("linked-player-sync-invalid-candidate-row");
  });

  it("fails closed on RPC errors and non-boolean claim data", async () => {
    const rpcError = createClient({ data: null, error: { message: "permission denied" } });
    await expect(fetchLinkedPlayerSyncCandidates({ supabaseAdmin: rpcError }))
      .rejects.toThrow("linked-player-sync-list-failed");

    const malformedClaim = createClient({ data: "true", error: null });
    await expect(claimLinkedPlayerSync({
      supabaseAdmin: malformedClaim,
      platform: "steam",
      normalizedNickname: "fixture_player",
      displayNickname: "Fixture_Player",
      leaseToken: "33333333-3333-4333-8333-333333333333",
      leaseExpiresAt: "2026-08-19T01:00:00.000Z",
    })).rejects.toThrow("linked-player-sync-invalid-claim-result");
  });

  it("requires service-role credentials when no client is injected", async () => {
    await expect(fetchLinkedPlayerSyncCandidates()).rejects.toThrow(
      "linked-player-sync-service-role-credentials-missing",
    );
  });
});
