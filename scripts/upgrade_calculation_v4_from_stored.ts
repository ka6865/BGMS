/**
 * 저장된 계산 2·3 경기 결과를 텔레메트리 없이 계산 4로 올린다(docs/specs/2026-10-17-tactical-score-v4.md 5절).
 *
 * 기본 실행은 읽기 전용이다. 플레이어별 최근 경기를 골라 계산 4 점수를 계산하고 계획 파일만 쓴다.
 *   npx tsx scripts/upgrade_calculation_v4_from_stored.ts --plan tmp/calc4-plan.json [--per-player 10]
 * 적용은 검토한 계획 파일과 --apply가 모두 있어야 한다. 한 경기씩 CAS RPC로 쓰고 진행 상황을 체크포인트에 남긴다.
 *   npx tsx scripts/upgrade_calculation_v4_from_stored.ts --plan tmp/calc4-plan.json --apply [--max-writes 50]
 *
 * PUBG API, 텔레메트리 다운로드, Gemini는 호출하지 않는다. 쓰기는 upgrade_analysis_calculation_stored_v4 RPC만 쓴다.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { ANALYSIS_CALCULATION_VERSION } from "../lib/pubg-analysis/constants";
import { upgradeStoredResultToCalculation4 } from "../lib/pubg-analysis/calculation4StoredUpgrade";
import { withCalculationUpgradeWriteLock } from "./calculation_upgrade_write_lock";

type Decision = {
  match_id: string; platform: string; player_id: string;
  expectedVersion: 2 | 3; expectedScore: number; delta: number; reasons: string[];
  benchmark: { score: number; tier: string | null; breakdown: { combat: number; tactical: number; survival: number }; impactScore: number; impactGrade: string };
};
type Plan = {
  kind: "calculation-v4-stored-upgrade"; generatedAt: string; project: string; calculationVersion: 4;
  perPlayer: number; scannedRows: number; players: number; targetRows: number;
  skipped: Record<string, number>; unchanged: number; decisions: Decision[]; hash: string;
};

const { values } = parseArgs({ options: {
  plan: { type: "string" }, apply: { type: "boolean" }, "per-player": { type: "string" }, "max-writes": { type: "string" },
} });
if (!values.plan) throw new Error("use --plan <path>");
const planPath = resolve(values.plan);
const checkpointPath = `${planPath}.checkpoint.json`;
const perPlayer = Number(values["per-player"] ?? 10);
const maxWrites = Number(values["max-writes"] ?? 50);
if (!Number.isInteger(perPlayer) || perPlayer < 1 || perPlayer > 50) throw new Error("--per-player must be 1..50");
if (!Number.isInteger(maxWrites) || maxWrites < 1 || maxWrites > 20_000) throw new Error("--max-writes must be 1..20000");
if (ANALYSIS_CALCULATION_VERSION !== 4) throw new Error("calculation_v4_required");

dotenv.config({ path: ".env.local", quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Supabase server environment required");
const project = new URL(url).hostname;
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const planHash = (plan: Omit<Plan, "hash">) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

async function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`);
  await rename(temporary, path);
}

async function withRetry<T>(operation: () => Promise<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await operation();
    if (!error && data !== null) return data;
    if (attempt >= 3) throw new Error(error?.message ?? "empty_response");
    await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
  }
}

async function buildPlan(client: SupabaseClient): Promise<Plan> {
  // 1단계: 가벼운 목록으로 플레이어별 최근 경기(분석 저장 시각 기준)를 고른다.
  const light: Array<{ match_id: string; player_id: string; platform: string }> = [];
  for (let from = 0; ; from += 1000) {
    const page = await withRetry(async () => await client.from("processed_match_telemetry")
      .select("match_id,player_id,platform").order("created_at", { ascending: false }).range(from, from + 999)
      .abortSignal(AbortSignal.timeout(30_000)));
    light.push(...page);
    if (page.length < 1000) break;
  }
  const byPlayer = new Map<string, typeof light>();
  for (const row of light) {
    const key = `${row.platform}:${row.player_id}`;
    const list = byPlayer.get(key) ?? [];
    if (list.length < perPlayer) list.push(row);
    byPlayer.set(key, list);
  }
  const wanted = new Set([...byPlayer.values()].flat().map((row) => `${row.match_id}|${row.platform}|${row.player_id}`));
  const matchIds = [...new Set([...byPlayer.values()].flat().map((row) => row.match_id))];

  // 2단계: 대상 경기의 점수 입력 필드만 읽는다. 원본 전체(data)는 읽지 않는다.
  const fields = [
    "match_id", "player_id", "platform", "v:data->fullResult->v", "calculationVersion:data->fullResult->calculationVersion",
    "gameMode:data->fullResult->gameMode", "deathPhase:data->fullResult->deathPhase", "stats:data->fullResult->stats",
    "tradeStats:data->fullResult->tradeStats", "duelStats:data->fullResult->duelStats", "benchmark:data->fullResult->benchmark",
  ].join(",");
  const skipped: Record<string, number> = {};
  const decisions: Decision[] = [];
  let unchanged = 0;
  let targetRows = 0;
  for (let index = 0; index < matchIds.length; index += 40) {
    const ids = matchIds.slice(index, index + 40);
    const rows = await withRetry(async () => await client.from("processed_match_telemetry").select(fields).in("match_id", ids)
      .abortSignal(AbortSignal.timeout(30_000)));
    for (const row of rows as unknown as Array<Record<string, any>>) {
      if (!wanted.has(`${row.match_id}|${row.platform}|${row.player_id}`)) continue;
      targetRows++;
      if (row.v !== 73) { skipped.not_v73 = (skipped.not_v73 ?? 0) + 1; continue; }
      const result = upgradeStoredResultToCalculation4({
        calculationVersion: row.calculationVersion, gameMode: row.gameMode, deathPhase: row.deathPhase,
        stats: row.stats, tradeStats: row.tradeStats, duelStats: row.duelStats, benchmark: row.benchmark,
      });
      if (!result.ok) { skipped[result.reason] = (skipped[result.reason] ?? 0) + 1; continue; }
      if (result.delta === 0 && result.benchmark.score === row.benchmark.score) unchanged++;
      decisions.push({
        match_id: row.match_id, platform: row.platform, player_id: row.player_id,
        expectedVersion: row.calculationVersion, expectedScore: row.benchmark.score, delta: result.delta, reasons: result.reasons,
        benchmark: {
          score: result.benchmark.score, tier: result.benchmark.tier, breakdown: result.benchmark.breakdown,
          impactScore: result.benchmark.impactScore, impactGrade: result.benchmark.impactGrade,
        },
      });
    }
  }
  decisions.sort((a, b) => a.match_id.localeCompare(b.match_id) || a.player_id.localeCompare(b.player_id));
  const body = {
    kind: "calculation-v4-stored-upgrade" as const, generatedAt: new Date().toISOString(), project, calculationVersion: 4 as const,
    perPlayer, scannedRows: light.length, players: byPlayer.size, targetRows, skipped, unchanged, decisions,
  };
  return { ...body, hash: planHash(body) };
}

function summarize(plan: Plan) {
  const changed = plan.decisions.filter((decision) => decision.delta !== 0);
  return {
    project: plan.project, generatedAt: plan.generatedAt, hash: plan.hash, perPlayer: plan.perPlayer,
    scannedRows: plan.scannedRows, players: plan.players, targetRows: plan.targetRows, skipped: plan.skipped,
    upgrades: plan.decisions.length, scoreUnchanged: plan.unchanged, scoreChanged: changed.length,
    averageDelta: changed.length ? Number((changed.reduce((sum, decision) => sum + decision.delta, 0) / changed.length).toFixed(2)) : 0,
    minDelta: changed.length ? Math.min(...changed.map((decision) => decision.delta)) : 0,
    maxDelta: changed.length ? Math.max(...changed.map((decision) => decision.delta)) : 0,
  };
}

if (!values.apply) {
  const plan = await buildPlan(db);
  await writeJsonAtomic(planPath, plan);
  console.log(JSON.stringify({ dryRun: true, plan: planPath, ...summarize(plan), databaseWrites: 0, providerCalls: 0 }, null, 2));
  process.exit(0);
}

const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
const { hash, ...body } = plan;
if (plan.kind !== "calculation-v4-stored-upgrade" || planHash(body) !== hash) throw new Error("calculation_v4_plan_hash_mismatch");
if (plan.project !== project || plan.calculationVersion !== ANALYSIS_CALCULATION_VERSION) throw new Error("calculation_v4_plan_project_or_version_mismatch");
let checkpoint: { hash: string; applied: string[]; rejected: string[] } = { hash, applied: [], rejected: [] };
try {
  checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  if (checkpoint.hash !== hash) throw new Error("calculation_v4_checkpoint_plan_mismatch");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const done = new Set([...checkpoint.applied, ...checkpoint.rejected]);
let writes = 0;
for (const decision of plan.decisions) {
  const key = `${decision.match_id}|${decision.platform}|${decision.player_id}`;
  if (done.has(key)) continue;
  if (writes >= maxWrites) break;
  const { data, error } = await withCalculationUpgradeWriteLock(project, async () => await db.rpc("upgrade_analysis_calculation_stored_v4", {
    p_match_id: decision.match_id, p_platform: decision.platform, p_player_id: decision.player_id,
    p_expected_version: decision.expectedVersion, p_expected_score: decision.expectedScore, p_benchmark: decision.benchmark,
  }).abortSignal(AbortSignal.timeout(15_000)));
  writes++;
  if (error) {
    // 응답을 잃은 쓰기는 다음 실행에서 CAS가 다시 판정한다. 같은 실행에서 이어 쓰지 않는다.
    await writeJsonAtomic(checkpointPath, checkpoint);
    throw new Error(`calculation_v4_rpc_failed:${key}:${error.message}`);
  }
  // false는 읽은 뒤 행이 바뀌었거나 이미 올라간 경우다. 덮어쓰지 않고 기록만 한다.
  (data === true ? checkpoint.applied : checkpoint.rejected).push(key);
  if (writes % 25 === 0) await writeJsonAtomic(checkpointPath, checkpoint);
}
await writeJsonAtomic(checkpointPath, checkpoint);
console.log(JSON.stringify({
  apply: true, plan: planPath, checkpoint: checkpointPath, rpcWriteAttempts: writes,
  applied: checkpoint.applied.length, rejectedByCas: checkpoint.rejected.length,
  remaining: plan.decisions.length - checkpoint.applied.length - checkpoint.rejected.length, providerCalls: 0,
}, null, 2));
