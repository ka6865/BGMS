import dotenv from "dotenv";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readDiscoveryHealth, type DiscoveryHealthSnapshot } from "../lib/pubg/discoveryHealth";

export function discoveryHealthMarkdown(snapshot: DiscoveryHealthSnapshot, phase: string): string {
  const phaseLabel = phase === "before" ? "수집 전" : phase === "after" ? "수집 후" : "현재";
  return `\n### 전적 수집 상태 (${phaseLabel})\n\n측정: ${snapshot.measuredAt} · 순차 조회\n\n` +
    `| 항목 | 값 |\n| --- | ---: |\n` + Object.entries(snapshot.states).map(([state, count]) => `| ${state} | ${count} |`).join("\n") +
    `\n| 지금 처리 가능한 작업 | ${snapshot.readyCount} |\n| 가장 오래된 대기 시간(분) | ${snapshot.oldestReadyAgeMinutes ?? "확인 불가"} |\n| 마지막 처리 후 경과(분) | ${snapshot.minutesSinceLastSaved ?? "확인 불가"} |\n| 만료된 점유 | ${snapshot.expiredLeaseCount} |\n\n` +
    `경고: ${snapshot.warnings.length ? snapshot.warnings.join(", ") : "없음"}\n`;
}

export async function main(args = process.argv.slice(2)) {
  dotenv.config({ path: process.env.BGMS_ENV_FILE || ".env.local", quiet: true });
  const phase = args[0] ?? "current";
  if (!["before", "after", "current"].includes(phase) || args.length > 1) throw new Error("discovery-health-invalid-options");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("discovery-health-credentials-missing");
  const db = createClient(url, key, { auth: { persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }) } });
  const snapshot = await readDiscoveryHealth(db);
  console.log(JSON.stringify(snapshot));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, discoveryHealthMarkdown(snapshot, phase));
  for (const warning of snapshot.warnings) console.log(`::warning title=PUBG collection health::${warning}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error("discovery-health-check-failed"); process.exitCode = 1; });
}
