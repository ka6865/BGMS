 import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
 import { createClient } from "@supabase/supabase-js";
 import dotenv from "dotenv";
 import path from "path";
 import { decodeMaybeGzip } from "../lib/pubg-analysis/r2Service";
 import { upsertPlayerMatches, type PlayerMatchRecord } from "../lib/pubg/playerMatches";
 
 dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
 
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
 
 export async function runBackfillFromR2() {
   console.log("\n🚀 Starting R2 -> pubg_player_matches Backfill Restoration...\n");
 
   let continuationToken: string | undefined = undefined;
   let totalScannedKeys = 0;
   let matchedKeys = 0;
   let restoredRecordsCount = 0;
   const recordBuffer: PlayerMatchRecord[] = [];
 
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
 
       try {
         const jsonText = decodeMaybeGzip(buf);
         const parsed = JSON.parse(jsonText);
 
         // Check if analyze.json format or full result format
         let matchId = parsed.matchId;
         let playerId = parsed.player_id || parsed.playerId;
         let platform = parsed.platform || "steam";
         let playedAt = parsed.matchInfo?.date || parsed.createdAt;
         let gameMode = parsed.matchInfo?.mode || parsed.gameMode || "unknown";
         let mapName = parsed.matchInfo?.map || parsed.mapName || "unknown";
         let kills = parsed.stats?.kills ?? parsed.kills ?? 0;
         let damage = Math.floor(parsed.stats?.damageDealt ?? parsed.damageDealt ?? 0);
         let winPlace = parsed.stats?.winPlace ?? parsed.winPlace ?? 99;
 
         if (!matchId || !playerId) {
           // Fallback to key pattern: {matchId}_{playerId}_v{version}_analyze.json
           const match = key.match(/^([a-f0-9-]+)_([a-zA-Z0-9_-]+)_v\d+.*_analyze\.json$/);
           if (match) {
             matchId = matchId || match[1];
             playerId = playerId || match[2];
           }
         }
 
         if (matchId && playerId) {
           recordBuffer.push({
             player_id: String(playerId).toLowerCase(),
             platform,
             match_id: String(matchId),
             played_at: playedAt || new Date().toISOString(),
             game_mode: String(gameMode),
             map_name: String(mapName),
             kills: Number(kills) || 0,
             damage: Number(damage) || 0,
             win_place: Number(winPlace) || 99,
           });
         }
       } catch {
         // Skip invalid JSON
       }
 
       if (recordBuffer.length >= 200) {
         await upsertPlayerMatches(supabase, recordBuffer);
         restoredRecordsCount += recordBuffer.length;
         console.log(`  - Restored ${restoredRecordsCount} records into pubg_player_matches...`);
         recordBuffer.length = 0;
       }
     }
 
     continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
   } while (continuationToken);
 
   if (recordBuffer.length > 0) {
     await upsertPlayerMatches(supabase, recordBuffer);
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
