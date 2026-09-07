import type { TelemetryPlatform } from "./telemetryIdentity";
const TELEMETRY_HOST = "telemetry-cdn.pubg.com";
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseOrdinaryTelemetryUrl(value: unknown, expectedAssetId: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("telemetry URL missing");
  const raw = value.trim();
  if (!/^https:\/\//i.test(raw) || raw.includes("\\")) throw new Error("telemetry URL invalid");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("telemetry URL invalid");
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== TELEMETRY_HOST
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash) {
    throw new Error("telemetry URL invalid");
  }
  const path = parsed.pathname;
  if (!path.startsWith("/")
    || path.endsWith("/")
    || path.includes("//")
    || path.includes("%")
    || path.slice(1).split("/").some((segment) => segment === "." || segment === ".." || !segment)
    || !path.endsWith(`/${expectedAssetId}-telemetry.json`)) {
    throw new Error("telemetry URL invalid");
  }
  return parsed.href;
}

export function relationshipBoundTelemetryAsset(matchData: unknown): { asset: Record<string, unknown>; id: string } | null {
  if (!isRecord(matchData) || !isRecord(matchData.data)) return null;
  const relationships = isRecord(matchData.data.relationships) ? matchData.data.relationships : null;
  const assets = relationships && isRecord(relationships.assets) ? relationships.assets : null;
  const refs = assets && Array.isArray(assets.data) ? assets.data : [];
  if (refs.length !== 1 || !isRecord(refs[0]) || typeof refs[0].id !== "string" || refs[0].type !== "asset") return null;
  const assetId = refs[0].id.trim();
  if (!assetId) return null;
  const included = Array.isArray(matchData.included) ? matchData.included : [];
  const assetsById = included.filter((item): item is Record<string, unknown> => (
    isRecord(item) && item.type === "asset" && item.id === assetId
  ));
  return assetsById.length === 1 ? { asset: assetsById[0], id: assetId } : null;
}

/** Preserve non-ranked map replay modes while binding the unique match suffix/platform. */
export function hasMatchingTelemetryDefinition(events: unknown, matchId: string, platform: TelemetryPlatform): boolean {
  if (!Array.isArray(events)) return false;
  const definitions = events.filter((event) => isRecord(event) && event._T === "LogMatchDefinition");
  if (definitions.length !== 1) return false;
  const value = definitions[0].MatchId ?? definitions[0].matchId ?? definitions[0].match_id;
  return typeof value === "string" && value.startsWith("match.")
    && value.includes(`.${platform}.`) && value.endsWith(`.${matchId}`);
}

/** An account identifier is required; a display name alone is not proof. */
export function containsTelemetryAccountEvidence(value: unknown, accountId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsTelemetryAccountEvidence(item, accountId));
  if (!isRecord(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if ((key === "accountId" || key === "playerId")
      && typeof nested === "string"
      && nested === accountId) {
      return true;
    }
    if (containsTelemetryAccountEvidence(nested, accountId)) return true;
  }
  return false;
}
