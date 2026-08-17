import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
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
    const supabase = dependencies.createSupabase(supabaseUrl, serviceRoleKey);
    const result: HotdropJobResult = await dependencies.runJob(apiKey, config, {
      fetchFn: fetch,
      supabase,
      sleep: (milliseconds) => new Promise((resolveSleep) => {
        setTimeout(resolveSleep, milliseconds);
      }),
      now: () => new Date().toISOString(),
    });
    dependencies.writeInfo(JSON.stringify(result));
    return 0;
  } catch (error) {
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
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
