import { beforeEach, describe, expect, it, vi } from "vitest";

const { isPlayerPrivate } = vi.hoisted(() => ({
  isPlayerPrivate: vi.fn(),
}));

vi.mock("@/lib/pubg/privatePlayers", () => ({ isPlayerPrivate }));

import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";

describe("private player public-route guard", () => {
  beforeEach(() => vi.resetAllMocks());

  it("blocks private players without a cacheable response", async () => {
    isPlayerPrivate.mockResolvedValue(true);
    const response = await blockPrivatePlayer("steam", "HiddenPlayer");
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    await expect(response?.json()).resolves.toMatchObject({ code: "private_player" });
  });

  it("fails closed when the registry is unavailable", async () => {
    isPlayerPrivate.mockRejectedValue(new Error("database unavailable"));
    const response = await blockPrivatePlayer("steam", "HiddenPlayer");
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ errorCode: "PRIVATE_PLAYER_CHECK_UNAVAILABLE" });
  });

  it("returns no response for a public player", async () => {
    isPlayerPrivate.mockResolvedValue(false);
    await expect(blockPrivatePlayer("steam", "PublicPlayer")).resolves.toBeNull();
  });
});
