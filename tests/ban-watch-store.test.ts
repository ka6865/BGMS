import { describe, expect, it, vi } from "vitest";
import {
  BanWatchError,
  createBanWatchItem,
  listBanWatchItems,
  readPlayerBanStatus,
  recordBanObservation,
} from "@/lib/pubg/banWatch.server";

function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit", "maybeSingle", "delete", "update"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const watchRow = {
  id: "watch-1",
  user_id: "user-a",
  platform: "steam",
  subject_account_id: "account.subject",
  target_account_id: "account.target",
  match_id: "match-1",
  event_at: "2026-09-11T00:00:00.000Z",
  role: "killer",
  nickname_at_match: "Target",
  map_name: "Erangel",
  weapon: "AKM",
  note: null,
  created_at: "2026-09-11T00:00:00.000Z",
  active_until: "2026-10-11T00:00:00.000Z",
  baseline_status: null,
  baseline_checked_at: null,
  last_viewed_at: null,
};

function dbFor(options: {
  itemData?: unknown[];
  statusData?: unknown;
  eventData?: unknown[];
  rpcData?: unknown;
  rpcError?: unknown;
}) {
  const calls: string[] = [];
  const db = {
    calls,
    from: vi.fn((table: string) => {
      calls.push(table);
      if (table === "pubg_ban_watch_items") return query({ data: options.itemData ?? [watchRow], error: null });
      if (table === "pubg_ban_status") return query({ data: options.statusData ?? null, error: null });
      return query({ data: options.eventData ?? [], error: null });
    }),
    rpc: vi.fn(async () => ({ data: options.rpcData, error: options.rpcError ?? null })),
  };
  return db;
}

describe("ban-watch server store", () => {
  it("filters shared statuses and events to the user's followed platform/account pairs", async () => {
    const db = dbFor({
      itemData: [watchRow],
      statusData: undefined,
      eventData: [
        {
          id: 1,
          platform: "steam",
          account_id: "account.target",
          previous_status: null,
          observed_status: "none",
          raw_ban_type: "Innocent",
          observed_at: "2026-09-11T00:00:00.000Z",
          observation_id: "obs-1",
        },
        {
          id: 2,
          platform: "kakao",
          account_id: "account.target",
          previous_status: null,
          observed_status: "permanent",
          raw_ban_type: "PermanentBan",
          observed_at: "2026-09-11T00:00:00.000Z",
          observation_id: "obs-2",
        },
      ],
    });
    const result = await listBanWatchItems("user-a", db as never);
    expect(result.items).toHaveLength(1);
    expect(result.statuses).toHaveLength(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.platform).toBe("steam");
  });

  it("reads a status by platform and account and never exposes lease credentials", async () => {
    const db = dbFor({
      statusData: {
        platform: "steam",
        account_id: "account.target",
        raw_ban_type: "TemporaryBan",
        normalized_status: "temporary",
        checked_at: "2026-09-11T00:00:00.000Z",
        last_attempt_at: "2026-09-11T00:00:00.000Z",
        last_error: null,
        next_check_at: "2026-09-11T06:00:00.000Z",
        lease_token: "secret-token",
        lease_expires_at: "2026-09-11T00:15:00.000Z",
        updated_at: "2026-09-11T00:00:00.000Z",
      },
    });
    const result = await readPlayerBanStatus("steam", "account.target", db as never);
    expect(result?.status).toBe("temporary");
    expect(result).not.toHaveProperty("leaseToken");
    expect(result).not.toHaveProperty("leaseExpiresAt");
  });

  it("records only explicit RPC outcomes and rejects malformed responses", async () => {
    const recordedDb = dbFor({ rpcData: { code: "recorded", observation_id: "obs-1" } });
    const recorded = await recordBanObservation({
      platform: "steam",
      accountId: "account.target",
      rawType: "Innocent",
      checkedAt: "2026-09-11T00:00:00.000Z",
    }, recordedDb as never);
    expect(recorded.code).toBe("recorded");
    expect(recordedDb.rpc).toHaveBeenCalledWith("record_pubg_ban_observation", expect.objectContaining({ p_normalized_status: "none" }));

    const malformedDb = dbFor({ rpcData: { code: "unexpected" } });
    await expect(recordBanObservation({ platform: "steam", accountId: "account.target", rawType: "PermanentBan" }, malformedDb as never))
      .rejects.toMatchObject({ code: "store_failed" });
  });

  it("maps duplicate and cap RPC outcomes to stable API errors", async () => {
    for (const [code, expected] of [["user_target_limit", "target_limit"], ["target_match_limit", "match_limit"]] as const) {
      const db = dbFor({ rpcData: { code, id: "watch-1" } });
      await expect(createBanWatchItem("user-a", {
        platform: "steam",
        subjectAccountId: "account.subject",
        targetAccountId: "account.target",
        matchId: "match-1",
        eventAt: "2026-09-11T00:00:00.000Z",
        role: "killer",
        nicknameAtMatch: "Target",
      }, db as never)).rejects.toMatchObject({ code: expected, status: 429 });
    }
  });

  it("requires an owner id for personal list reads", async () => {
    await expect(listBanWatchItems("", dbFor({}) as never)).rejects.toBeInstanceOf(BanWatchError);
  });
});
