import { createHash } from "node:crypto";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { decodeMaybeGzip, readObjectForVerification } from "../lib/pubg-analysis/r2Service";
import { normalizeBasicMatchStat, hasObservedPlayerMatchValues, upsertPlayerMatches, type PlayerMatchRecord } from "../lib/pubg/playerMatches";
import { runRestoreLegacyPlayerMatches } from "./restore_legacy_player_matches";
import { parseLegacyCopyManifest, readLegacyCopyRecords } from "../lib/pubg-analysis/legacyCopyManifest";

dotenv.config({ path: process.env.BGMS_ENV_FILE || path.resolve(process.cwd(), ".env.local"), quiet: true });
if (process.env.BGMS_RECOVERY_ENV_FILE) dotenv.config({ path: process.env.BGMS_RECOVERY_ENV_FILE, quiet: true });
 
 const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
 const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
 const r2Endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
 const r2AccessKey = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
 const r2SecretKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
 const r2BucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || "bgms";
 
 const supabase = createClient(supabaseUrl, serviceKey);
 const s3 = new S3Client({
   region: "auto",
   endpoint: r2Endpoint,
   credentials: {
     accessKeyId: r2AccessKey || "",
     secretAccessKey: r2SecretKey || "",
   },
   forcePathStyle: true,
 });
 
 async function downloadObjectBuffer(key: string): Promise<Buffer | null> {
   try {
     const { GetObjectCommand } = await import("@aws-sdk/client-s3");
     const response = await s3.send(new GetObjectCommand({ Bucket: r2BucketName, Key: key }));
     if (!response.Body) return null;
     const byteArray = await response.Body.transformToByteArray();
     return Buffer.from(byteArray);
   } catch {
     return null;
   }
 }
 
export async function runBackfillFromR2(args = process.argv.slice(2)) {
  const aliasIndex = args.indexOf("--legacy-alias-key");
  if (aliasIndex >= 0) {
    const apply = args.includes("--apply");
    const filtered = args.filter((arg) => arg !== "--apply");
    if (filtered.length !== 2 || filtered[0] !== "--legacy-alias-key") {
      throw new Error("legacy-copy-arguments-invalid");
    }
    const result = await runRestoreLegacyPlayerMatches({ aliasKey: filtered[1], apply });
    console.log(JSON.stringify(result));
    return result;
  }
  if (args.length > 0) throw new Error("legacy-copy-arguments-invalid");
  console.log("\n🚀 Starting R2 -> pubg_player_matches Backfill Restoration...\n");
 
   let continuationToken: string | undefined = undefined;
   let totalScannedKeys = 0;
   let matchedKeys = 0;
  let restoredRecordsCount = 0;
  const recordBuffer: PlayerMatchRecord[] = [];
  const consumedAliases = new Set<string>();
 
   do {
     const command: ListObjectsV2Command = new ListObjectsV2Command({
       Bucket: r2BucketName,
       ContinuationToken: continuationToken,
       MaxKeys: 500,
     });
 
     const response = await s3.send(command);
     const contents = response.Contents || [];
     totalScannedKeys += contents.length;
 
     for (const item of contents) {
       const key = item.Key || "";
       if (!key.endsWith("_analyze.json")) continue;
 
       matchedKeys += 1;
       const buf = await downloadObjectBuffer(key);
       if (!buf) continue;

       // Compacted root keys keep serving as recoverable aliases for backfill.
       if (buf.subarray(0, 8).toString("ascii") === "BGMSR2v1") {
         try {
           const secret = process.env.R2_RECOVERY_ARCHIVE_KEY || "";
           const manifest = parseLegacyCopyManifest(buf, secret);
           if (!manifest.originalKeys.includes(key)) continue;
           const canonicalAliasKey = `telemetry-source/legacy-aliases/v1/${createHash("sha256").update(manifest.originalKeys.join("\n")).digest("hex")}.enc`;
           if (consumedAliases.has(canonicalAliasKey)) continue;
           const [canonicalAlias, source] = await Promise.all([
             readObjectForVerification(canonicalAliasKey),
             readObjectForVerification(manifest.sourceKey),
           ]);
           if (!canonicalAlias || !source
             || parseLegacyCopyManifest(canonicalAlias.body, secret).checksum !== manifest.checksum) continue;
           readLegacyCopyRecords(buf, source.body, secret);
           readLegacyCopyRecords(canonicalAlias.body, source.body, secret);
           const result = await runRestoreLegacyPlayerMatches({ aliasKey: canonicalAliasKey, apply: true });
           restoredRecordsCount += result.restoredRecords;
           consumedAliases.add(canonicalAliasKey);
         } catch {
           // Invalid or unverifiable compacted bytes are never a restore source.
         }
         continue;
       }

       try {
        const jsonText = decodeMaybeGzip(buf);
        const parsed = JSON.parse(jsonText);
        // Raw event arrays do not contain a canonical basic-result record.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

        let matchId = parsed.matchId;
        let playerId = parsed.player_id || parsed.playerId;
        const platform = parsed.platform;
        const playedAt = parsed.matchInfo?.date || parsed.createdAt;
        const gameMode = parsed.matchInfo?.mode || parsed.gameMode;
        const mapName = parsed.matchInfo?.map || parsed.mapName;
        const kills = parsed.stats?.kills ?? parsed.kills;
        const damage = parsed.stats?.damageDealt ?? parsed.damageDealt;
        const winPlace = parsed.stats?.winPlace ?? parsed.winPlace;
        const matchType = parsed.matchType || parsed.matchInfo?.matchType;
 
         if (!matchId || !playerId) {
           // Fallback to key pattern: {matchId}_{playerId}_v{version}_analyze.json
           const match = key.match(/^([a-f0-9-]+)_([a-zA-Z0-9_-]+)_v\d+.*_analyze\.json$/);
           if (match) {
             matchId = matchId || match[1];
             playerId = playerId || match[2];
           }
         }
 
        if (matchId && playerId && (platform === "steam" || platform === "kakao")
          && typeof playedAt === "string" && Number.isFinite(Date.parse(playedAt))
          && typeof gameMode === "string" && typeof mapName === "string"
          && typeof matchType === "string" && matchType.trim()
          && Number.isSafeInteger(kills) && Number(kills) >= 0
          && Number.isSafeInteger(damage) && Number(damage) >= 0
          && Number.isSafeInteger(winPlace) && Number(winPlace) >= 1) {
          const record: PlayerMatchRecord = {
            player_id: String(playerId).toLowerCase(),
            platform,
            match_id: String(matchId),
            played_at: playedAt,
            game_mode: gameMode,
            map_name: mapName,
            kills: Number(kills),
            damage: Number(damage),
            win_place: Number(winPlace),
            knocks: normalizeBasicMatchStat(parsed.stats?.DBNOs),
            survival_time: normalizeBasicMatchStat(parsed.stats?.timeSurvived),
            match_type: matchType.toLowerCase(),
          };
          if (hasObservedPlayerMatchValues(record)) recordBuffer.push(record);
        }
       } catch {
         // Skip invalid JSON
       }
 
       if (recordBuffer.length >= 200) {
        if (!await upsertPlayerMatches(supabase, recordBuffer, { ignoreDuplicates: true })) {
          throw new Error("legacy-backfill-upsert-failed");
        }
         restoredRecordsCount += recordBuffer.length;
         console.log(`  - Restored ${restoredRecordsCount} records into pubg_player_matches...`);
         recordBuffer.length = 0;
       }
     }
 
     continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
   } while (continuationToken);
 
   if (recordBuffer.length > 0) {
    if (!await upsertPlayerMatches(supabase, recordBuffer, { ignoreDuplicates: true })) {
      throw new Error("legacy-backfill-upsert-failed");
    }
     restoredRecordsCount += recordBuffer.length;
     recordBuffer.length = 0;
   }
 
   console.log("\n==================================================");
   console.log(`✅ Backfill Restoration Finished!`);
   console.log(`  - Total R2 Keys Scanned : ${totalScannedKeys}`);
   console.log(`  - Analyze JSON Objects : ${matchedKeys}`);
   console.log(`  - Restored DB Records   : ${restoredRecordsCount}`);
   console.log("==================================================\n");
 }
 
if (process.argv[1]?.includes("backfill_pubg_player_matches_from_r2")) {
   runBackfillFromR2().catch((err) => {
     console.error("❌ Backfill failed:", err);
     process.exit(1);
   });
 }
