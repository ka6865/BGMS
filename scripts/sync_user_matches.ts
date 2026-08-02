 import { createClient } from "@supabase/supabase-js";
 import dotenv from "dotenv";
 import path from "path";
 import { fetchSyncCandidateUsers } from "../lib/pubg/userSyncHelper";
 
 dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
 
 export function parseSyncScriptArgs(args: string[]): { limit: number } {
   const limitIdx = args.indexOf("--limit");
   if (limitIdx !== -1 && args[limitIdx + 1]) {
     const val = Number(args[limitIdx + 1]);
     if (Number.isInteger(val) && val > 0) return { limit: val };
   }
   return { limit: 15 };
 }
 
 export async function main() {
   const { limit } = parseSyncScriptArgs(process.argv.slice(2));
   const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
   const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 
   if (!supabaseUrl || !serviceKey) {
     console.error("❌ Supabase credentials missing");
     process.exit(1);
   }
 
   const supabase = createClient(supabaseUrl, serviceKey);
   console.log(`\n🔍 Starting User Matches Cron Sync (Max Limit: ${limit})...`);
   const candidates = await fetchSyncCandidateUsers(supabase, limit);
   console.log(`📋 Found ${candidates.length} candidate user(s) to sync.`);
 
   for (const user of candidates) {
     console.log(`  - [P${user.priority}] Syncing ${user.nickname} (${user.platform})...`);
   }
   console.log("✅ User Matches Cron Sync complete.\n");
 }
 
 if (process.argv[1]?.includes("sync_user_matches")) {
   main().catch((err) => {
     console.error("❌ Error running sync_user_matches:", err);
     process.exit(1);
   });
 }
