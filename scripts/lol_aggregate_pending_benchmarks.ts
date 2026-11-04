import { pathToFileURL } from "node:url";
import { createServiceRoleSupabase } from "../lib/server/serviceRoleSupabase.server";

type Rpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

export async function runLolPendingBenchmarks(rpc: Rpc, args = process.argv.slice(2), enabled = process.env.LOL_CHAMPION_STATS_ENABLED === "true", now = Date.now) {
  if (args.some(arg => arg !== "--apply" && arg !== "--dry-run") || (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("invalid_arguments");
  const apply = args.includes("--apply");
  if (apply && !enabled) throw new Error("benchmark_apply_disabled");
  const pending = await rpc<{ match_id: string }[]>("get_lol_pending_benchmark_matches", { p_limit: 100 });
  let processed = 0;
  const deadline = now() + 60_000;
  if (apply) for (const row of pending) {
    if (now() >= deadline) break;
    await rpc("aggregate_lol_match_benchmarks", { p_match_id: row.match_id });
    processed += 1;
  }
  return { dryRun: !apply, pending: pending.length, processed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const db = createServiceRoleSupabase();
    const rpc: Rpc = async <T>(name: string, args: Record<string, unknown>) => {
      const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(10_000));
      if (error) throw new Error("benchmark_rpc_failed");
      return data as T;
    };
    console.log(JSON.stringify(await runLolPendingBenchmarks(rpc)));
  } catch {
    console.error("[lol-benchmarks] pending_processing_failed");
    process.exitCode = 1;
  }
}
