import "server-only";
import { after } from "next/server";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import type { LolCleanupBatch, LolCleanupCounts, LolOpsStatus } from "./types";

export const LOL_OPS_METRICS = [
  "riot_success", "riot_429", "riot_5xx", "riot_network", "riot_timeout", "riot_key_error", "riot_4xx",
  "search_cache_hit", "search_cache_miss", "detail_cache_hit", "detail_cache_miss", "raw_reuse", "db_error", "db_timeout",
] as const;
export type LolOpsMetric = typeof LOL_OPS_METRICS[number];

export function recordLolOpsMetric(metric: LolOpsMetric) {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true" || !LOL_OPS_METRICS.includes(metric)) return;
  const write = async () => {
    const signal = AbortSignal.timeout(1000);
    try {
      const { error } = await createServiceRoleSupabase().rpc("increment_lol_ops_metric", { p_metric: metric, p_by: 1 }).abortSignal(signal);
      if (error) throw error;
    } catch {
      console.error("[lol-ops] metric_failed", JSON.stringify({ metric, reasonCode: signal.aborted ? "timeout" : "db_error" }));
    }
  };
  try { after(write); } catch { void write(); }
}

async function opsRpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const signal = AbortSignal.timeout(10_000);
  try {
    const { data, error } = await createServiceRoleSupabase().rpc(name, args).abortSignal(signal);
    if (error) throw error;
    return data as T;
  } catch {
    recordLolOpsMetric(signal.aborted ? "db_timeout" : "db_error");
    console.error("[lol-ops] request_failed", JSON.stringify({ operation: name, reasonCode: signal.aborted ? "timeout" : "db_error" }));
    throw new Error("LoL 운영 저장소를 사용할 수 없습니다.");
  }
}

function counts(value: LolCleanupCounts): LolCleanupCounts {
  return { cache_rows: value.cache_rows, match_rows: value.match_rows, account_rows: value.account_rows, lease_rows: value.lease_rows };
}

export async function getLolOpsStatus(): Promise<LolOpsStatus> {
  const enabled = process.env.LOL_PERSISTENCE_ENABLED === "true";
  const empty: LolOpsStatus = {
    enabled, today: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date()),
    todayRiotCalls: 0, cooldownActive: false, keyNeedsAttention: !process.env.RIOT_API_KEY?.trim(),
    metrics: [], rateLimits: [], tables: [], pending: { cache_rows: 0, match_rows: 0, account_rows: 0, lease_rows: 0 },
  };
  if (!enabled) return empty;
  const status = await opsRpc<LolOpsStatus>("get_lol_ops_status");
  const metrics = status.metrics.filter((row) => LOL_OPS_METRICS.includes(row.metric as LolOpsMetric))
    .map(({ day, metric, value }) => ({ day, metric, value }));
  return {
    ...empty, today: status.today, todayRiotCalls: status.todayRiotCalls, cooldownActive: status.cooldownActive,
    keyNeedsAttention: empty.keyNeedsAttention || metrics.some((row) => row.day === status.today && row.metric === "riot_key_error" && row.value > 0),
    metrics, rateLimits: status.rateLimits.map(({ host, budgetDay, usedCount, blockedUntil }) => ({ host, budgetDay, usedCount, blockedUntil })),
    benchmarks: status.benchmarks ? { processed: status.benchmarks.processed, skipped: status.benchmarks.skipped } : undefined,
    tables: status.tables.map(({ table, rows, totalBytes }) => ({ table, rows, totalBytes })), pending: counts(status.pending),
  };
}

export async function previewLolExpiredData(): Promise<LolCleanupCounts> {
  return counts(await opsRpc<LolCleanupCounts>("preview_lol_expired_data"));
}

export async function cleanupLolExpiredBatch(limit: number): Promise<LolCleanupBatch> {
  const result = await opsRpc<LolCleanupBatch>("cleanup_lol_expired_batch", { p_limit: limit });
  return { deleted: counts(result.deleted), remaining: counts(result.remaining) };
}
