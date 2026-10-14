import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 중복 집계 창은 1시간이라 하루 지난 기록은 쓰이지 않는다.
export const BOARD_VIEW_TRACKING_RETENTION_HOURS = 24;

export async function cleanupBoardPostViewTracking(
  supabaseAdmin: Pick<SupabaseClient, "from">,
  now = new Date(),
): Promise<{ cutoff: string; deletedRows: number }> {
  const cutoff = new Date(
    now.getTime() - BOARD_VIEW_TRACKING_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { count, error } = await supabaseAdmin
    .from("board_post_view_tracking")
    .delete({ count: "exact" })
    .lt("last_viewed_at", cutoff);

  if (error || typeof count !== "number") {
    throw new Error("board-view-tracking-cleanup-failed");
  }
  return { cutoff, deletedRows: count };
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Board view tracking cleanup failed: credentials missing");
    process.exitCode = 1;
  } else {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    cleanupBoardPostViewTracking(supabaseAdmin)
      .then((result) => {
        console.info(`Board view tracking cleanup deleted ${result.deletedRows} rows before ${result.cutoff}.`);
      })
      .catch((error: unknown) => {
        console.error(`Board view tracking cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
  }
}
