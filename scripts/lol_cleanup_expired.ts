import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createServiceRoleSupabase } from "../lib/server/serviceRoleSupabase.server";
import type { LolCleanupBatch, LolCleanupCounts } from "../lib/lol/types";

type Rpc = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
const total = (counts: LolCleanupCounts) => Object.values(counts).reduce((sum, value) => sum + value, 0);

export async function runLolCleanup(rpc: Rpc, args = process.argv.slice(2), enabled = process.env.LOL_CLEANUP_ENABLED === "true") {
  if (args.some((arg) => arg !== "--apply" && arg !== "--dry-run") || (args.includes("--apply") && args.includes("--dry-run"))) {
    throw new Error("--dry-run 또는 --apply 중 하나만 지정해 주세요.");
  }
  const startedAt = Date.now();
  const preview = await rpc<LolCleanupCounts>("preview_lol_expired_data");
  const deleted: LolCleanupCounts = { cache_rows: 0, match_rows: 0, account_rows: 0, lease_rows: 0, public_rate_limit_rows: 0 };
  let remaining = preview;
  let batches = 0;
  const apply = args.includes("--apply");
  if (apply && !enabled) throw new Error("쓰기에는 LOL_CLEANUP_ENABLED=true가 필요합니다.");
  if (apply && total(preview) > 0) {
    const key = "ops:expired-cleanup";
    const rows = await rpc<Array<{ lease_token: string }>>("acquire_lol_collection_lease", { p_key: key, p_ttl_seconds: 120 });
    if (!rows[0]?.lease_token) throw new Error("다른 정리 실행이 진행 중입니다.");
    const leaseStartedAt = Date.now();
    try {
      // 120초 lease보다 먼저 멈추며 배치당 각 부모 테이블 최대 100행을 지운다.
      while (batches < 10 && Date.now() - leaseStartedAt < 80_000 && total(remaining) > 0) {
        const batch = await rpc<LolCleanupBatch>("cleanup_lol_expired_batch", { p_limit: 100 });
        for (const key of Object.keys(deleted) as Array<keyof LolCleanupCounts>) deleted[key] = (deleted[key] ?? 0) + (batch.deleted[key] ?? 0);
        remaining = batch.remaining;
        batches += 1;
        if (total(batch.deleted) === 0 || total(remaining) === 0 || batches === 10) break;
        await sleep(250);
      }
    } finally {
      await rpc("release_lol_collection_lease", { p_key: key, p_token: rows[0].lease_token });
    }
  }
  return { dryRun: !apply, preview, deleted, remaining, deletedCount: total(deleted), remainingCount: total(remaining), batches, durationMs: Date.now() - startedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const db = createServiceRoleSupabase();
    const rpc: Rpc = async <T>(name: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(5000));
      if (error) throw new Error(`정리 RPC 실패: ${name}`);
      return data as T;
    };
    console.log(JSON.stringify(await runLolCleanup(rpc), null, 2));
  } catch {
    console.error("[lol-cleanup] 실행 실패: 설정, 쓰기 플래그 또는 정리 RPC를 확인해 주세요.");
    process.exitCode = 1;
  }
}
