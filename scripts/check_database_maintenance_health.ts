import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "node:path";
import { fetchDatabaseMaintenanceHealth } from "../lib/admin-agent/storage-health";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase maintenance health credentials are missing");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const assessment = await fetchDatabaseMaintenanceHealth(supabase);

  if (!assessment.healthy) {
    console.error("[DB HEALTH GATE] Maintenance blocked:");
    for (const reason of assessment.reasons) {
      console.error(`- ${reason}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[DB HEALTH GATE] Maintenance allowed");
}

main().catch(() => {
  console.error("[DB HEALTH GATE] Health check unavailable; maintenance blocked");
  process.exitCode = 1;
});
