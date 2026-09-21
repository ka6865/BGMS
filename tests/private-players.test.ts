import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  playerRead: vi.fn(),
  playerDispose: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/pubg/playerApiClient", () => ({
  createPlayerApiClient: () => ({ read: mocks.playerRead, dispose: mocks.playerDispose }),
  PlayerApiError: class PlayerApiError extends Error {},
}));

import { isPlayerPrivate, resolvePrivatePlayerAccountId } from "@/lib/pubg/privatePlayers";

function valueQuery(result: unknown) {
  const query: any = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: result, error: null }),
  };
  return query;
}

describe("private player stable identity matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubEnv("PUBG_API_KEY", "pubg-key");
    mocks.playerRead.mockResolvedValue({ data: [] });
    mocks.createClient.mockReturnValue({
      from(table: string) {
        if (table === "system_settings") {
          return valueQuery({
            value: JSON.stringify([{
              platform: "steam",
              nickname: "OldName",
              lower_nickname: "oldname",
              account_id: "account.hidden",
              created_at: "2026-09-21T00:00:00.000Z",
            }]),
          });
        }
        if (table === "pubg_player_cache") {
          const query: any = {
            nickname: "",
            select: () => query,
            eq: (column: string, value: string) => {
              if (column === "lower_nickname") query.nickname = value;
              return query;
            },
            maybeSingle: () => Promise.resolve({
              data: query.nickname === "renamedplayer" ? { id: "account.hidden" } : null,
              error: null,
            }),
          };
          return query;
        }
        throw new Error(`unexpected table: ${table}`);
      },
    });
  });

  it("blocks the current nickname after the account is renamed", async () => {
    await expect(isPlayerPrivate("steam", "RenamedPlayer")).resolves.toBe(true);
    await expect(isPlayerPrivate("steam", "OtherPlayer")).resolves.toBe(false);
    expect(mocks.playerRead).not.toHaveBeenCalled();
  });

  it("keeps the former nickname conservative when the cache has no current row", async () => {
    await expect(isPlayerPrivate("steam", "OldName")).resolves.toBe(true);
  });

  it("can resolve an uncached renamed nickname for strict routes", async () => {
    mocks.playerRead.mockResolvedValue({ data: [{
      id: "account.hidden",
      attributes: { name: "ApiPlayer" },
      relationships: { matches: { data: [] } },
    }] });
    await expect(resolvePrivatePlayerAccountId("steam", "ApiPlayer")).resolves.toBe("account.hidden");
    await expect(isPlayerPrivate("steam", "ApiPlayer", "account.hidden")).resolves.toBe(true);
    expect(mocks.playerRead).toHaveBeenCalledWith(
      expect.stringContaining("filter[playerNames]=ApiPlayer"),
      expect.objectContaining({ stage: "private-player-identity" }),
    );
  });
});
