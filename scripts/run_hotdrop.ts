import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  isPubgRateLimitError,
  parseHotdropConfig,
  runHotdropCollection,
  type HotdropJobResult,
  type HotdropSupabaseAdapter,
} from "../lib/hotdrop/runHotdropCollection";

export interface HotdropScriptDependencies {
  createSupabase(
    url: string,
    serviceRoleKey: string,
  ): Parameters<typeof runHotdropCollection>[2]["supabase"];
  runJob: typeof runHotdropCollection;
  writeInfo(message: string): void;
  writeError(message: string): void;
  /** GitHub Actions 단계 요약에 남길 Markdown. 로컬 실행에서는 생략된다. */
  appendSummary?(markdown: string): void;
  sleep?(milliseconds: number): Promise<void>;
}

const MAX_START_COOLDOWN_MS = 120_000;

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

/**
 * 직전 단계가 같은 PUBG 키의 분당 한도를 소진했을 수 있어 첫 호출 전 쉬는 시간이다.
 * 기본값 0은 로컬·수동 실행을 늦추지 않기 위한 값이고, 일일 작업이 값을 지정한다.
 */
export function parseHotdropStartCooldownMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.HOTDROP_START_COOLDOWN_MS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_START_COOLDOWN_MS) {
    throw new Error(`HOTDROP_START_COOLDOWN_MS는 0~${MAX_START_COOLDOWN_MS} 범위의 정수여야 합니다.`);
  }
  return value;
}

/**
 * 운영 알림에 넣을 수 있는 Hotdrop 오류 요약을 만든다.
 *
 * 원본 예외에는 API 키가 포함된 URL, 서비스 롤 키, 매치 ID가 섞일 수
 * 있으므로 상세 원인을 보존하되 운영 채널로 그대로 내보내지 않는다.
 */
export function formatHotdropError(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length >= 4) message = message.split(value).join("[redacted]");
  }
  message = message
    .replace(/https?:\/\/\S+/gi, "[url redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bmatch-[a-z0-9_-]+\b/gi, "match-[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return message ? message.slice(0, 240) : "알 수 없는 오류";
}

function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key}-missing`);
  return value;
}

export async function runHotdropScript(
  env: Record<string, string | undefined>,
  dependencies: HotdropScriptDependencies,
): Promise<number> {
  try {
    const apiKey = requireEnv(env, "PUBG_API_KEY").split(" ")[0];
    const supabaseUrl = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    const serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
    const config = parseHotdropConfig(env);
    const startCooldownMs = parseHotdropStartCooldownMs(env);
    const sleep = dependencies.sleep ?? waitFor;
    const supabase = dependencies.createSupabase(supabaseUrl, serviceRoleKey);
    if (startCooldownMs > 0) await sleep(startCooldownMs);
    const result: HotdropJobResult = await dependencies.runJob(apiKey, config, {
      fetchFn: fetch,
      supabase,
      sleep,
      now: () => new Date().toISOString(),
    });
    dependencies.writeInfo(JSON.stringify(result));
    return 0;
  } catch (error) {
    // 호출 한도는 일시적이고 다음 실행에서 이어서 수집하므로 경고로 남기고 성공 처리한다.
    if (isPubgRateLimitError(error)) {
      dependencies.writeInfo("::warning title=PUBG API 한도 보호::Hotdrop 수집이 429를 받아 이번 실행을 건너뜁니다. 다음 실행에서 재시도합니다.");
      dependencies.appendSummary?.([
        "## Hotdrop Collection",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Result | skipped (PUBG API 429) |",
        "",
      ].join("\n"));
      return 0;
    }
    dependencies.writeError(`Hotdrop 수집 실패: ${formatHotdropError(error, [
      env.PUBG_API_KEY ?? "",
      env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    ])}`);
    return 1;
  }
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runHotdropScript(process.env, {
    createSupabase: (url, serviceRoleKey) => (
      createClient(url, serviceRoleKey) as unknown as HotdropSupabaseAdapter
    ),
    runJob: runHotdropCollection,
    writeInfo: (message) => console.info(message),
    writeError: (message) => console.error(message),
    appendSummary: (markdown) => {
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
    },
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
