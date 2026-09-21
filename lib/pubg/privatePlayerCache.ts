import * as privatePlayers from "@/lib/pubg/privatePlayers";

/**
 * Resolve a stable account id from the local cache without contacting PUBG.
 * The namespace import keeps this optional helper compatible with the small
 * private-player mocks used by route tests and older deployments.
 */
export async function resolveCachedPlayerAccountId(platform: string, nickname: string): Promise<string | null> {
  try {
    const resolver = (privatePlayers as { getCachedPlayerAccountId?: unknown }).getCachedPlayerAccountId;
    if (typeof resolver !== "function") return null;
    const accountId = await (resolver as (platform: string, nickname: string) => Promise<string | null>)(platform, nickname);
    return typeof accountId === "string" ? accountId : null;
  } catch (error) {
    // Vitest's partial module mocks throw when an optional export is read.
    // Real cache/database failures still propagate and fail closed upstream.
    if (error instanceof Error && /No ["']getCachedPlayerAccountId["'] export/.test(error.message)) return null;
    throw error;
  }
}
