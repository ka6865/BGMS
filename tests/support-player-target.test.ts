import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportDb } from "@/lib/support/contracts";
import { PlayerApiError, createPlayerApiClient } from "@/lib/pubg/playerApiClient";
import { resolveSupportPlayerTarget } from "@/lib/support/playerTarget.server";

vi.mock("@/lib/pubg/playerApiClient", () => {
  class MockPlayerApiError extends Error {
    readonly upstreamStatus: number | null;
    readonly errorCode: string;

    constructor(fields: { upstreamStatus: number | null; errorCode: string }) {
      super("PUBG player API request failed");
      this.name = "PlayerApiError";
      this.upstreamStatus = fields.upstreamStatus;
      this.errorCode = fields.errorCode;
    }
  }

  return {
    PlayerApiError: MockPlayerApiError,
    createPlayerApiClient: vi.fn(),
  };
});

const mockedCreatePlayerApiClient = vi.mocked(createPlayerApiClient);

function cacheDb(row: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  };
  return { from: vi.fn(() => query) } as unknown as SupportDb;
}

function playerPayload(id: string, name: string) {
  return {
    data: [{ id, attributes: { name }, relationships: { matches: { data: [] } } }],
  };
}

describe("resolveSupportPlayerTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBG_API_KEY;
  });

  it("returns the immutable cached account id without an upstream call", async () => {
    const db = cacheDb({ id: "account.cached", nickname: "CachedName" });
    const result = await resolveSupportPlayerTarget({
      platform: "steam",
      nickname: "cachedname",
      supabaseAdmin: db,
    });

    expect(result).toEqual({
      platform: "steam",
      requestedNickname: "cachedname",
      canonicalNickname: "CachedName",
      accountId: "account.cached",
    });
    expect(mockedCreatePlayerApiClient).not.toHaveBeenCalled();
  });

  it("rejects an upstream player whose name does not match the request", async () => {
    const db = cacheDb(null);
    const read = vi.fn().mockResolvedValue(playerPayload("account.other", "OtherName"));
    const dispose = vi.fn();
    mockedCreatePlayerApiClient.mockReturnValue({
      read,
      dispose,
      signal: new AbortController().signal,
    });

    await expect(resolveSupportPlayerTarget({
      platform: "steam",
      nickname: "RequestedName",
      supabaseAdmin: db,
    })).rejects.toMatchObject({ code: "not_found" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects an unsupported platform before constructing the API client", async () => {
    const db = cacheDb(null);

    await expect(resolveSupportPlayerTarget({
      platform: "xbox" as "steam",
      nickname: "player",
      supabaseAdmin: db,
    })).rejects.toMatchObject({ code: "not_found" });
    expect(mockedCreatePlayerApiClient).not.toHaveBeenCalled();
  });

  it("maps a 429 player API failure to rate_limited", async () => {
    const db = cacheDb(null);
    mockedCreatePlayerApiClient.mockReturnValue({
      read: vi.fn().mockRejectedValue(new PlayerApiError({
        stage: "player",
        upstreamStatus: 429,
        errorCode: "upstream_http",
        contentType: null,
        responseBytes: null,
        durationMs: 0,
        retryAfterSeconds: null,
      })),
      dispose: vi.fn(),
      signal: new AbortController().signal,
    });

    await expect(resolveSupportPlayerTarget({
      platform: "steam",
      nickname: "player",
      supabaseAdmin: db,
    })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("maps other player API failures to unavailable", async () => {
    const db = cacheDb(null);
    mockedCreatePlayerApiClient.mockReturnValue({
      read: vi.fn().mockRejectedValue(new PlayerApiError({
        stage: "player",
        upstreamStatus: 503,
        errorCode: "upstream_5xx",
        contentType: null,
        responseBytes: null,
        durationMs: 0,
        retryAfterSeconds: null,
      })),
      dispose: vi.fn(),
      signal: new AbortController().signal,
    });

    await expect(resolveSupportPlayerTarget({
      platform: "steam",
      nickname: "player",
      supabaseAdmin: db,
    })).rejects.toMatchObject({ code: "unavailable" });
  });
});
