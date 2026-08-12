import dotenv from "dotenv";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { decodeMaybeGzip } from "../lib/pubg-analysis/r2Service";
import { calculateWeaponBurstStats } from "../lib/pubg-analysis/weaponMetaBurst";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

export const R2_BURST_BACKFILL_BATCH_SIZE = 20;
export const R2_BURST_BACKFILL_CONCURRENCY = 2;

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

async function loadJson(client: S3Client, bucket: string, key: string): Promise<any[] | null> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) return null;
    return JSON.parse(decodeMaybeGzip(Buffer.from(await response.Body.transformToByteArray())));
  } catch {
    return null;
  }
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
  let noBurst = 0;

  for (let index = 0; index < uniqueCandidates.length; index += R2_BURST_BACKFILL_CONCURRENCY) {
    const batch = uniqueCandidates.slice(index, index + R2_BURST_BACKFILL_CONCURRENCY);
    await Promise.all(batch.map(async (candidate) => {
      const r2Key = `${candidate.match_id}_${candidate.player_id}_v60_analyze.json`;
      const events = await loadJson(r2, bucket, r2Key);
      if (!events) { missing += 1; return; }
      const playerAccountId = events.find((event: any) => event.attacker?.name?.toLowerCase() === candidate.player_id)?.attacker?.accountId
        || events.find((event: any) => event.victim?.name?.toLowerCase() === candidate.player_id)?.victim?.accountId;
      if (!playerAccountId) { missing += 1; return; }
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
          .eq("weapon_name", update.weapon_name);
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
