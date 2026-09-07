import { AnalysisEngine } from "../lib/pubg-analysis/AnalysisEngine";
import { getValidFullResultForMatch } from "../lib/pubg-analysis/cacheIdentity";
import { filterTelemetryEvents } from "../lib/pubg-analysis/telemetryContract";
import { containsTelemetryAccountEvidence, hasMatchingTelemetryDefinition } from "../lib/pubg-analysis/telemetrySource";
import { normalizeName } from "../lib/pubg-analysis/utils";
import { stableHash, type CalculationUpgradeIdentity } from "./calculation_upgrade_batch";
export function calculateUpgradeFromOfficialRaw(identity: CalculationUpgradeIdentity, processed: any, source: {match:any;telemetry:any[]}, acceptedVersions: readonly number[] = [73]) {
  const previousVersion = Number(processed?.data?.fullResult?.v);
  if (!acceptedVersions.includes(previousVersion)) throw new Error("unsupported_previous_version");
  const { match, telemetry: raw } = source;
  if (match?.data?.id !== identity.matchId
    || !hasMatchingTelemetryDefinition(raw, identity.matchId, identity.platform)
    || !raw.some((event: any) => event?._T === "LogMatchStart")
    || !raw.some((event: any) => event?._T === "LogMatchEnd")) throw new Error("raw_source_identity_or_boundary_invalid");
  const participants = match.included?.filter((item: any) => item?.type === "participant") ?? [];
  const rosters = match.included?.filter((item: any) => item?.type === "roster") ?? [];
  const requester = participants.find((item: any) => normalizeName(item.attributes?.stats?.name) === identity.playerId);
  const roster = requester && rosters.find((item: any) => item.relationships?.participants?.data?.some((member: any) => member.id === requester.id));
  if (!requester || !roster) throw new Error("raw_source_canonical_roster_missing");
  const members = participants.filter((item: any) => roster.relationships.participants.data.some((member: any) => member.id === item.id));
  const stats = requester.attributes?.stats;
  if (!stats?.playerId || !containsTelemetryAccountEvidence(raw, stats.playerId)) throw new Error("raw_source_account_evidence_missing");
  const old = getValidFullResultForMatch(processed, { matchId: identity.matchId, platform: identity.platform, playerId: identity.playerId, minResultVersion: previousVersion, requireExactResultVersion: true });
  if (!old || ((old.stats as any)?.playerId !== stats.playerId && (old.stats as any)?.accountId !== stats.playerId)) throw new Error("raw_source_previous_player_binding_mismatch");
  const ids = new Set<string>(members.map((item: any) => item.attributes?.stats?.playerId).filter(Boolean));
  const names = new Set<string>(members.map((item: any) => normalizeName(item.attributes?.stats?.name)).filter(Boolean));
  const run = (events: any[]) => {
    const result: any = new AnalysisEngine(stats.name, stats.playerId, names, ids, new Set(), new Set(), roster.id).run(
      events, { ...match.data.attributes, id: identity.matchId }, rosters, participants, stats,
      members.map((item: any) => item.attributes.stats), {},
    );
    delete result.processedAt;
    delete result.mapData;
    return { ...result, platform: identity.platform, player_id: identity.playerId };
  };
  const full = run(raw);
  const filtered = run(filterTelemetryEvents(raw, { mode: "full", teamAccountIds: ids, teamNames: names }));
  if (stableHash(full) !== stableHash(filtered)) throw new Error("raw_source_full_projection_arithmetic_mismatch");
  return { full, matchAttr: match.data.attributes };
}
