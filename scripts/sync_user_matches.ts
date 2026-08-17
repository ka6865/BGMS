import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";
import dotenv from "dotenv";
import path from "path";
import { fetchSyncCandidateUsers } from "../lib/pubg/userSyncHelper";
import { fetchAndIngestBasicMatchSummary } from "../lib/pubg/playerMatchesIngest";
import { normalizeName } from "../lib/pubg-analysis/utils";
import { normalizePlatform } from "../lib/pubg-analysis/cacheIdentity";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
 
 export function parseSyncScriptArgs(args: string[]): { limit: number } {
   const limitIdx = args.indexOf("--limit");
   if (limitIdx !== -1 && args[limitIdx + 1]) {
     const val = Number(args[limitIdx + 1]);
     if (Number.isInteger(val) && val > 0) return { limit: val };
   }
   return { limit: 15 };
 }

export function shouldStopSyncAfterStatus(status: number): boolean {
  return status === 429;
}

export function writeRateLimitOutput(
  rateLimited: boolean,
  outputPath = process.env.GITHUB_OUTPUT,
): void {
  if (!outputPath) return;
  appendFileSync(outputPath, `rate_limited=${rateLimited}\n`);
}
 
export async function main() {
  let rateLimited = false;
  try {
    const { limit } = parseSyncScriptArgs(process.argv.slice(2));
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];

    if (!supabaseUrl || !serviceKey) {
      throw new Error("Supabase credentials missing");
    }

    if (!apiKey) {
      throw new Error("PUBG_API_KEY missing");
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    console.log(`\nStarting User Matches Cron Sync (Max Limit: ${limit})...`);
    const candidates = await fetchSyncCandidateUsers(supabase, limit);
    console.log(`Found ${candidates.length} candidate user(s) to sync.`);

    for (const user of candidates) {
      const platform = normalizePlatform(user.platform);
      const playerId = normalizeName(user.nickname);
      console.log(`  [P${user.priority}] ${user.nickname} (${platform})`);

      try {
        // PUBG API에서 최근 매치 ID 목록 가져오기
        const playerRes = await fetch(
          `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${user.nickname}`,
          {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
            signal: AbortSignal.timeout(8000),
          }
        );

        if (!playerRes.ok) {
          console.warn(`    PUBG API ${playerRes.status} for ${user.nickname}`);
          if (shouldStopSyncAfterStatus(playerRes.status)) {
            rateLimited = true;
            console.warn("    API rate limit reached. Stopping lower-priority user match sync.");
            break;
          }
          continue;
        }

        const playerData = await playerRes.json();
        const apiMatchIds: string[] = (
          playerData?.data?.[0]?.relationships?.matches?.data || []
        ).map((m: any) => m.id);

        if (apiMatchIds.length === 0) {
          console.log(`    no recent matches`);
          continue;
        }

        // 이미 DB에 있는 매치 확인
        const { data: existing } = await supabase
          .from("pubg_player_matches")
          .select("match_id")
          .eq("player_id", playerId)
          .eq("platform", platform)
          .in("match_id", apiMatchIds);

        const existingSet = new Set((existing || []).map((r: any) => r.match_id));
        const newMatchIds = apiMatchIds.filter((id) => !existingSet.has(id)).slice(0, 10);

        if (newMatchIds.length === 0) {
          console.log(`    all ${apiMatchIds.length} matches already in DB`);
          continue;
        }

        console.log(`    ${newMatchIds.length} new match(es) to ingest (of ${apiMatchIds.length})`);

        // 일일 벤치마커 수집 뒤에 실행되는 저우선 작업이다. PUBG API 한도를 보호하기 위해 한 번에 한 매치만 요청한다.
        let ingested = 0;
        let matchRateLimited = false;
        for (const matchId of newMatchIds) {
          const record = await fetchAndIngestBasicMatchSummary(
            supabase,
            matchId,
            user.nickname,
            platform,
            apiKey,
            (status) => { matchRateLimited = shouldStopSyncAfterStatus(status); },
          );
          if (record) ingested += 1;
          if (matchRateLimited) {
            rateLimited = true;
            console.warn("    API rate limit reached while ingesting matches. Stopping lower-priority user match sync.");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }

        console.log(`    ingested ${ingested}/${newMatchIds.length}`);
        if (matchRateLimited) break;
      } catch (err: any) {
        console.warn(`    error: ${err.message}`);
      }
    }
    console.log("User Matches Cron Sync complete.\n");
  } finally {
    writeRateLimitOutput(rateLimited);
  }
}
 
 if (process.argv[1]?.includes("sync_user_matches")) {
   main().catch((err) => {
     console.error("❌ Error running sync_user_matches:", err);
     process.exit(1);
   });
 }
