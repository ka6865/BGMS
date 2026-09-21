const ACCOUNT_ID_PATTERN = /^account\.[A-Za-z0-9_-]+$/;
const VALID_PLATFORMS = new Set(["steam", "kakao"]);

/**
 * Resolve a nickname to PUBG's stable account ID for a route that is about to
 * expose private-player data. This is deliberately opt-in; ordinary cache and
 * autocomplete requests must not turn every nickname into an upstream call.
 */
export async function resolvePrivatePlayerAccountId(platform: string, nickname: string): Promise<string | null> {
  const targetPlatform = platform.trim().toLowerCase();
  const targetNickname = nickname.trim();
  if (!VALID_PLATFORMS.has(targetPlatform)) throw new Error("private_player_identity_platform_invalid");
  if (!targetNickname) return null;
  const apiKey = (process.env.PUBG_API_KEY ?? "").trim().split(/\s+/, 1)[0] ?? "";
  if (!apiKey) throw new Error("private_player_identity_credentials_missing");
  const [{ createPlayerApiClient, PlayerApiError }, { isPlayerPayload }] = await Promise.all([
    import("@/lib/pubg/playerApiClient"),
    import("@/lib/pubg/playerPayload"),
  ]);
  const controller = new AbortController();
  const api = createPlayerApiClient({
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
    },
    signal: controller.signal,
    totalTimeoutMs: 8_000,
  });
  try {
    const payload = await api.read(
      `https://api.pubg.com/shards/${targetPlatform}/players?filter[playerNames]=${encodeURIComponent(targetNickname)}`,
      { stage: "private-player-identity", timeoutMs: 5_000, validate: isPlayerPayload },
    );
    const player = payload.data.find((candidate) => (
      candidate.attributes.name.trim().toLowerCase() === targetNickname.toLowerCase()
    ));
    return player && ACCOUNT_ID_PATTERN.test(player.id.trim()) ? player.id.trim() : null;
  } catch (error) {
    // A missing player is a valid negative lookup. Network, rate-limit, and
    // malformed responses must propagate so strict routes fail closed.
    if (error instanceof PlayerApiError && error.upstreamStatus === 404) return null;
    throw error;
  } finally {
    api.dispose();
  }
}
