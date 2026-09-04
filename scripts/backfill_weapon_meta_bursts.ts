import dotenv from "dotenv";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { decodeMaybeGzip } from "../lib/pubg-analysis/r2Service";
import { calculateWeaponBurstStats } from "../lib/pubg-analysis/weaponMetaBurst";
import { TELEMETRY_VERSION } from "../lib/pubg-analysis/constants";
import {
  buildTelemetryAnalyzeCacheKey,
  parseTelemetryAnalyzeCacheEnvelope,
} from "../lib/pubg-analysis/telemetryCacheKey";
import {
  createTelemetryIdentity,
  parseTelemetryPlatform,
  type TelemetryIdentity,
} from "../lib/pubg-analysis/telemetryIdentity";
import {
  BENCHMARK_FILTER_VERSION,
  BENCHMARK_POPULATION_EVIDENCE_VERSION,
} from "../lib/pubg-analysis/benchmarkLookup";
import { projectTelemetryEvent } from "../lib/pubg-analysis/telemetryContract";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

export const R2_BURST_BACKFILL_BATCH_SIZE = 20;
export const R2_BURST_BACKFILL_CONCURRENCY = 2;
export const R2_BURST_POPULATION_MARKERS = {
  filter_version: BENCHMARK_FILTER_VERSION,
  population_evidence_version: BENCHMARK_POPULATION_EVIDENCE_VERSION,
} as const;

type Candidate = {
  match_id: string;
  platform: string;
  player_id: string;
  played_at: string;
};

export function buildR2BurstUpdate(input: {
  matchId: string;
  platform: string;
  playerId: string;
  playerAccountId: string;
  events: any[];
  sampleWeaponNames?: string[];
}) {
  const stats = calculateWeaponBurstStats(input.events, input.playerAccountId);
  const names = input.sampleWeaponNames ?? Array.from(stats.keys());
  return names.map((weaponName) => {
    const stat = stats.get(weaponName);
    return {
    match_id: input.matchId,
    platform: input.platform,
    player_id: input.playerId,
    weapon_name: weaponName,
    first_sec_hits: stat?.firstSecHits ?? 0,
    sustained_hits: stat?.sustainedHits ?? 0,
    sustained_burst_count: stat?.sustainedBurstCount ?? 0,
  };
  });
}

function parseLimit(args: readonly string[]): number {
  const value = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), 100)) : R2_BURST_BACKFILL_BATCH_SIZE;
}

async function loadJson(client: S3Client, bucket: string, key: string): Promise<unknown | null> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) return null;
    return JSON.parse(decodeMaybeGzip(Buffer.from(await response.Body.transformToByteArray())));
  } catch {
    return null;
  }
}

/**
 * The burst backfill may consume only the canonical analyzed-event envelope.
 * Legacy flat arrays and envelopes for another account/platform/version are
 * deliberately treated as cache misses.
 */
export function parseCanonicalBurstEvents(
  value: unknown,
  identity: TelemetryIdentity,
): any[] | null {
  const events = parseTelemetryAnalyzeCacheEnvelope(value, identity);
  if (!events || events.length === 0) return null;

  // A matching envelope is still untrusted until every element satisfies the
  // shared projected-event contract. Reject the whole payload on one malformed
  // or unknown event so backfill never turns an invalid cache into zero-valued
  // trusted updates.
  const projected = events.map((event) => projectTelemetryEvent(event));
  if (projected.some((event) => event === null)) return null;
  return projected as any[];
}

export function buildBurstTelemetryIdentity(candidate: Pick<Candidate, "match_id" | "platform">, playerAccountId: string): TelemetryIdentity | null {
  try {
    return createTelemetryIdentity({
      matchId: candidate.match_id,
      platform: parseTelemetryPlatform(candidate.platform),
      playerId: playerAccountId,
      mode: "lite",
      telemetryVersion: TELEMETRY_VERSION,
    });
  } catch {
    return null;
  }
}

async function resolvePlayerAccountId(supabase: any, candidate: Candidate): Promise<string | null> {
  const { data, error } = await supabase
    .from("pubg_player_cache")
    .select("id,platform,lower_nickname")
    .eq("lower_nickname", candidate.player_id)
    .eq("platform", candidate.platform)
    .maybeSingle();
  if (error || !data || typeof data.id !== "string" || !data.id.trim()) return null;
  if (typeof data.platform !== "string" || data.platform.trim().toLowerCase() !== candidate.platform.trim().toLowerCase()) return null;
  if (typeof data.lower_nickname !== "string" || data.lower_nickname.trim().toLowerCase() !== candidate.player_id.trim().toLowerCase()) return null;
  return data.id.trim();
}

export async function runR2BurstBackfill(options: { limit?: number; write?: (message: string) => void } = {}) {
  const write = options.write ?? console.log;
  const limit = options.limit ?? parseLimit(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME;
  if (!url || !key || !endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("weapon-meta-r2-backfill-credentials-missing");
  }

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const r2 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true });
  const patchStartedAt = process.env.PUBG_META_PATCH_STARTED_AT;
  if (!patchStartedAt) throw new Error("weapon-meta-r2-backfill-patch-boundary-missing");
  const baselineStartAt = new Date(Date.parse(patchStartedAt) - 14 * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("weapon_meta_match_samples")
    .select("match_id,platform,player_id,played_at,weapon_name")
    .is("sustained_hits", null)
    .eq("filter_version", R2_BURST_POPULATION_MARKERS.filter_version)
    .eq("population_evidence_version", R2_BURST_POPULATION_MARKERS.population_evidence_version)
    .gte("played_at", baselineStartAt)
    .lt("played_at", patchStartedAt)
    .order("played_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`weapon-meta-r2-backfill-candidates-failed: ${error.message}`);

  const candidates = (data || []) as Candidate[];
  const groupedCandidates = new Map<string, Candidate & { weaponNames: string[] }>();
  for (const row of candidates as Array<Candidate & { weapon_name: string }>) {
    const identity = `${row.match_id}:${row.platform}:${row.player_id}`;
    const current = groupedCandidates.get(identity) || { ...row, weaponNames: [] };
    current.weaponNames.push(row.weapon_name);
    groupedCandidates.set(identity, current);
  }
  const uniqueCandidates = [...groupedCandidates.values()];
  let updated = 0;
  let missing = 0;
  const noBurst = 0;

  for (let index = 0; index < uniqueCandidates.length; index += R2_BURST_BACKFILL_CONCURRENCY) {
    const batch = uniqueCandidates.slice(index, index + R2_BURST_BACKFILL_CONCURRENCY);
    await Promise.all(batch.map(async (candidate) => {
      const playerAccountId = await resolvePlayerAccountId(supabase, candidate);
      if (!playerAccountId) { missing += 1; return; }
      const telemetryIdentity = buildBurstTelemetryIdentity(candidate, playerAccountId);
      if (!telemetryIdentity) { missing += 1; return; }
      const r2Key = buildTelemetryAnalyzeCacheKey(telemetryIdentity);
      const envelope = await loadJson(r2, bucket, r2Key);
      const events = parseCanonicalBurstEvents(envelope, telemetryIdentity);
      if (!events) { missing += 1; return; }
      const updates = buildR2BurstUpdate({
        matchId: candidate.match_id,
        platform: candidate.platform,
        playerId: candidate.player_id,
        playerAccountId,
        events,
        sampleWeaponNames: candidate.weaponNames,
      });
      for (const update of updates) {
        const { error: updateError } = await supabase
          .from("weapon_meta_match_samples")
          .update({ first_sec_hits: update.first_sec_hits, sustained_hits: update.sustained_hits, sustained_burst_count: update.sustained_burst_count })
          .eq("match_id", update.match_id)
          .eq("platform", update.platform)
          .eq("player_id", update.player_id)
          .eq("weapon_name", update.weapon_name)
          .eq("filter_version", R2_BURST_POPULATION_MARKERS.filter_version)
          .eq("population_evidence_version", R2_BURST_POPULATION_MARKERS.population_evidence_version);
        if (updateError) throw updateError;
        updated += 1;
      }
    }));
    write(`[R2 burst] ${Math.min(index + batch.length, uniqueCandidates.length)}/${uniqueCandidates.length} matches processed`);
  }

  return { candidates: uniqueCandidates.length, updated, missing, noBurst, remainingHint: "Run again to continue." };
}

if (process.argv[1]?.endsWith("backfill_weapon_meta_bursts.ts")) {
  runR2BurstBackfill().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
