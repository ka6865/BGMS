import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AnalysisEngine } from "../lib/pubg-analysis/AnalysisEngine";
import { buildSharedTelemetrySourceKey, createSharedTelemetrySource, parseSharedTelemetrySource, type SharedTelemetrySource } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { buildTelemetryAnalyzeCacheKey, buildTelemetryCacheKey, buildTelemetryPlayerKey, buildTelemetryPublicIdentity, pseudonymizeTelemetryAccountIds, pseudonymizeTelemetryTeammates } from "../lib/pubg-analysis/telemetryCacheKey";
import { filterTelemetryEvents, sampleReplayPositions } from "../lib/pubg-analysis/telemetryContract";
import { hasMatchingTelemetryDefinition, parseOrdinaryTelemetryUrl, relationshipBoundTelemetryAsset } from "../lib/pubg-analysis/telemetrySource";
import { createTelemetryPayload, parseTelemetryPayload, type TelemetryPayload } from "../lib/pubg-analysis/telemetryPayload";
import { readObjectForVerification, uploadRecoveryObjectToR2 } from "../lib/pubg-analysis/r2Service";
import type { TelemetryPlatform } from "../lib/pubg-analysis/telemetryIdentity";
import { TELEMETRY_VERSION } from "../lib/pubg-analysis/constants";
import { normalizeName } from "../lib/pubg-analysis/utils";

type Candidate = { match_id: string; platform: string; account_id: string | null; player_id: string; played_at: string };
type PrivatePlayer = { platform?: string; lower_nickname?: string; nickname?: string; account_id?: string };

export function selectArchivePair(candidates: Candidate[], privatePlayers: PrivatePlayer[], now = Date.now()): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const row of candidates) {
    if (!["steam", "kakao"].includes(row.platform) || !/^account\.[\w-]+$/.test(row.account_id ?? "")
      || !row.player_id || !Number.isFinite(Date.parse(row.played_at)) || now - Date.parse(row.played_at) > 14 * 86400000
      || Date.parse(row.played_at) > now) continue;
    if (privatePlayers.some(p => (p.platform === "all" || p.platform === row.platform)
      && (p.account_id === row.account_id || (p.lower_nickname || p.nickname?.toLowerCase()) === row.player_id.toLowerCase()))) continue;
    const key = `${row.platform}:${row.match_id}`;
    const group = groups.get(key) ?? [];
    if (!group.some(other => other.account_id === row.account_id)) group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].find(group => group.length >= 2)?.slice(0, 2) ?? [];
}

function decode(body: Buffer): unknown {
  if (body.length > 33554432) throw new Error("archive-verification-source-too-large");
  return JSON.parse((body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body, { maxOutputLength: 134217728 }) : body).toString("utf8"));
}

export function recalculateArchive(source: SharedTelemetrySource, accountId: string) {
  const participants = source.matchData.included.filter((x: any) => x.type === "participant");
  const rosters = source.matchData.included.filter((x: any) => x.type === "roster");
  const participant = participants.find((x: any) => (x.attributes.stats.playerId || x.attributes.accountId) === accountId);
  const roster = participant && rosters.find((x: any) => x.relationships.participants.data.some((r: any) => r.id === participant.id));
  if (!participant || !roster) throw new Error("archive-verification-participant-missing");
  const team = participants.filter((x: any) => roster.relationships.participants.data.some((r: any) => r.id === x.id));
  const teamNames = new Set<string>(team.map((x: any) => normalizeName(x.attributes.stats.name)).filter(Boolean));
  const teamAccountIds = new Set<string>(team.map((x: any) => x.attributes.stats.playerId || x.attributes.accountId));
  const engine = new AnalysisEngine(participant.attributes.stats.name, accountId,
    teamNames, teamAccountIds, new Set(), new Set(), roster.id, "lite");
  const events = filterTelemetryEvents(source.events, { mode: "full", teamNames, teamAccountIds });
  const result = engine.run(events, source.matchData.data.attributes, rosters, participants, participant.attributes.stats, [], { avg_damage: 200 });
  if (!result.mapData || !result.mapData.events?.length) throw new Error("archive-verification-recalculation-empty");
  return result;
}

export function recalculateReplayPayload(source: SharedTelemetrySource, accountId: string): TelemetryPayload {
  const result = recalculateArchive(source, accountId);
  return createTelemetryPayload({
    identity: buildTelemetryPublicIdentity({ matchId: source.matchId, platform: source.platform, playerId: accountId, mode: "lite", telemetryVersion: TELEMETRY_VERSION }),
    startTime: source.matchData.data.attributes.createdAt,
    teammates: pseudonymizeTelemetryTeammates(result.mapData!.teammates),
    teamNames: result.mapData!.teamNames,
    events: pseudonymizeTelemetryAccountIds(sampleReplayPositions(result.mapData!.events, "lite")),
    zoneEvents: pseudonymizeTelemetryAccountIds(result.mapData!.zoneEvents),
    mapName: result.mapName || source.matchData.data.attributes.mapName || "Erangel",
  });
}

export function assertReplayMatchesRecalculation(expected: TelemetryPayload, actual: TelemetryPayload): void {
  // Compare the JSON representation actually sent by the route (undefined fields are omitted).
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), actual)) throw new Error("archive-verification-replay-content-mismatch");
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== "--prime-shared") || args.length > 1) throw new Error("archive-verification-invalid-options");
  dotenv.config({ path: process.env.BGMS_ENV_FILE || ".env.local", quiet: true });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("archive-verification-db-credentials-missing");
  const db = createClient(url, key, { auth: { persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }) } });
  const [recent, privateList] = await Promise.all([
    db.from("pubg_player_matches").select("match_id,platform,account_id,player_id,played_at").order("played_at", { ascending: false }).limit(120),
    db.from("system_settings").select("value").eq("key", "private_players_list").maybeSingle(),
  ]);
  if (recent.error || privateList.error) throw new Error("archive-verification-candidate-read-failed");
  const privatePlayers: unknown = privateList.data?.value ? JSON.parse(privateList.data.value) : [];
  if (!Array.isArray(privatePlayers)) throw new Error("archive-verification-privacy-read-failed");
  const pair = selectArchivePair(recent.data ?? [], privatePlayers);
  if (pair.length !== 2) throw new Error("archive-verification-pair-unavailable");
  const { match_id: matchId } = pair[0], platform = pair[0].platform as TelemetryPlatform;
  const identities = pair.map(row => ({ matchId, platform, playerId: row.account_id!, mode: "lite" as const, telemetryVersion: TELEMETRY_VERSION }));
  const sourceKey = buildSharedTelemetrySourceKey(matchId, platform);
  const objectKeys = [sourceKey, ...identities.flatMap(id => [buildTelemetryCacheKey(id), buildTelemetryAnalyzeCacheKey(id)])];
  const before = await Promise.all(objectKeys.map(objectKey => readObjectForVerification(objectKey)));
  let source = before[0] ? parseSharedTelemetrySource(decode(before[0].body), matchId, platform) : null;
  let createdSource = false;
  if (before[0] && !source) throw new Error("archive-verification-existing-source-invalid");
  if (!source && args.includes("--prime-shared")) {
    const apiKey = (process.env.PUBG_API_KEY ?? "").split(" ")[0];
    if (!apiKey) throw new Error("archive-verification-pubg-key-missing");
    const match = await fetch(`https://api.pubg.com/shards/${platform}/matches/${matchId}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" }, signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!match.ok) throw new Error("archive-verification-official-match-unavailable");
    const matchData = await match.json();
    const bound = relationshipBoundTelemetryAsset(matchData);
    if (!bound) throw new Error("archive-verification-official-asset-missing");
    const asset = bound.asset as { attributes?: { URL?: unknown } };
    const telemetry = await fetch(parseOrdinaryTelemetryUrl(asset.attributes?.URL, bound.id), { signal: AbortSignal.timeout(25000), redirect: "error" });
    if (!telemetry.ok) throw new Error("archive-verification-official-events-unavailable");
    const events = await telemetry.json();
    if (!hasMatchingTelemetryDefinition(events, matchId, platform)) throw new Error("archive-verification-official-identity-mismatch");
    source = createSharedTelemetrySource(matchData, platform, events);
    if (pair.some(row => !source!.matchData.included.some((p: any) => p.type === "participant" && p.attributes.stats.playerId === row.account_id))) throw new Error("archive-verification-official-account-mismatch");
    try { await uploadRecoveryObjectToR2(sourceKey, JSON.stringify(source)); createdSource = true; }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw new Error("archive-verification-create-failed");
    }
    const stored = await readObjectForVerification(sourceKey);
    source = stored ? parseSharedTelemetrySource(decode(stored.body), matchId, platform) : null;
    if (!source) throw new Error("archive-verification-created-source-readback-failed");
  }
  if (!source) return { readOnly: true, verified: false, reason: "shared_source_missing", candidates: pair.length };
  const canonical = await readObjectForVerification(sourceKey);
  if (!canonical) throw new Error("archive-verification-source-disappeared");
  const sha = createHash("sha256").update(canonical.body).digest("hex");
  const checks = [];
  for (let i = 0; i < pair.length; i++) {
    const expected = recalculateReplayPayload(source, pair[i].account_id!);
    const query = new URLSearchParams({ matchId, platform, nickname: pair[i].player_id, mode: "lite" });
    const api = await fetch(`https://bgms.kr/api/pubg/telemetry?${query}`, { signal: AbortSignal.timeout(45000), redirect: "error" });
    if (!api.ok) throw new Error("archive-verification-replay-api-failed");
    const response = await api.json();
    const signed = new URL(response.downloadUrl);
    if (signed.protocol !== "https:" || !signed.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("archive-verification-replay-url-invalid");
    const mapResponse = await fetch(signed, { signal: AbortSignal.timeout(25000), redirect: "error" });
    if (!mapResponse.ok) throw new Error("archive-verification-map-download-failed");
    const payload = parseTelemetryPayload(await mapResponse.json(), { matchId, platform, playerKey: buildTelemetryPlayerKey(pair[i].account_id!), mode: "lite", telemetryVersion: TELEMETRY_VERSION });
    assertReplayMatchesRecalculation(expected, payload);
    const sourceAgain = await readObjectForVerification(sourceKey);
    if (!sourceAgain || createHash("sha256").update(sourceAgain.body).digest("hex") !== sha) throw new Error("archive-verification-source-changed");
    checks.push({ participant: i === 0 ? "A" : "B", recalculated: true, replayRead: true, replayContentMatches: true, replayEvents: payload.events.length, recalculatedEvents: expected.events.length, sharedBodyUnchanged: true });
  }
  const after = await Promise.all(objectKeys.map(objectKey => readObjectForVerification(objectKey)));
  const bytes = (objects: typeof before) => objects.reduce((sum, object) => sum + (object?.body.length ?? 0), 0);
  return { measuredAt: new Date().toISOString(), verified: true, createdSource, createdCommonObjects: createdSource ? 1 : 0, checks,
    bytesBefore: bytes(before), bytesAfter: bytes(after), storedByteIncrease: bytes(after) - bytes(before), commonSourceBytes: after[0]?.body.length ?? 0,
    personalAnalyzeObjectsBefore: before.filter((value, i) => i > 0 && i % 2 === 0 && value).length,
    personalAnalyzeObjectsAfter: after.filter((value, i) => i > 0 && i % 2 === 0 && value).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().then(result => console.log(JSON.stringify(result))).catch(error => {
    const code = error instanceof Error && /^archive-verification-[a-z-]+$/.test(error.message) ? error.message : "archive-verification-failed";
    console.error(JSON.stringify({ verified: false, errorCode: code })); process.exitCode = 1;
  });
}
