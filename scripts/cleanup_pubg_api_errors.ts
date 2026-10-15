import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 개인정보처리방침의 오류 로그 보유 기간과 같다. 관리자 화면과 알림 집계는 최근 7일 이내만 읽는다.
export const PUBG_API_ERROR_RETENTION_DAYS = 30;

export async function cleanupPubgApiErrors(
  supabaseAdmin: Pick<SupabaseClient, "from">,
  now = new Date(),
): Promise<{ cutoff: string; deletedRows: number }> {
  const cutoff = new Date(
    now.getTime() - PUBG_API_ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { count, error } = await supabaseAdmin
    .from("pubg_api_errors")
    .delete({ count: "exact" })
    .lt("created_at", cutoff);

  if (error || typeof count !== "number") {
    throw new Error("pubg-api-errors-cleanup-failed");
  }
  return { cutoff, deletedRows: count };
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("PUBG API error cleanup failed: credentials missing");
    process.exitCode = 1;
  } else {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    cleanupPubgApiErrors(supabaseAdmin)
      .then((result) => {
        console.info(`PUBG API error cleanup deleted ${result.deletedRows} rows before ${result.cutoff}.`);
      })
      .catch((error: unknown) => {
        console.error(`PUBG API error cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
  }
}
