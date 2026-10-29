import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createServiceRoleSupabase } from "../lib/server/serviceRoleSupabase.server";

// Riot 키를 바꾼 뒤(예: 개발 키 → 프로덕션 키) 저장된 PUUID가 그대로 쓰이는지 확인하는 읽기 전용 점검이다.
// 저장 계정 몇 개를 현재 RIOT_API_KEY로 Riot ID 조회해 PUUID가 같은지 센다. DB와 Riot 모두 읽기만 하고, PUUID·키는 출력하지 않는다.
// 결과가 하나라도 different면 PUUID를 쓰는 저장 데이터(계정·요약·랭크 이력·보관본·참가자 ref)를 정리하기 전까지 새 키로 운영하지 않는다.

type StoredAccount = { puuid: string; game_name: string; tag_line: string };
type Lookup = (gameName: string, tagLine: string) => Promise<{ status: number; puuid?: string }>;
export type LolKeyPuuidCheck = {
  checked: number; same: number; different: number; notFound: number; failed: number;
  verdict: "same" | "different" | "inconclusive";
};

export async function checkLolKeyPuuid(accounts: StoredAccount[], lookup: Lookup, delayMs = 1_300): Promise<LolKeyPuuidCheck> {
  const result: LolKeyPuuidCheck = { checked: 0, same: 0, different: 0, notFound: 0, failed: 0, verdict: "inconclusive" };
  for (const [index, account] of accounts.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const found = await lookup(account.game_name, account.tag_line);
    result.checked += 1;
    if (found.status === 404) result.notFound += 1;
    else if (found.status !== 200 || !found.puuid) result.failed += 1;
    else if (found.puuid === account.puuid) result.same += 1;
    else result.different += 1;
  }
  // 이름을 바꾼 계정(404)이나 일시 실패는 판정에서 뺀다. 같은 계정이 하나도 없으면 판단하지 않는다.
  result.verdict = result.different > 0 ? "different" : result.same > 0 ? "same" : "inconclusive";
  return result;
}

function parseLimit(args: string[]): number {
  const raw = args.find((arg) => arg.startsWith("--limit="));
  if (args.some((arg) => !arg.startsWith("--limit="))) throw new Error("사용법: lol_check_key_puuid.ts [--limit=1..20]");
  const value = raw ? Number(raw.slice("--limit=".length)) : 3;
  if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error("--limit은 1~20입니다.");
  return value;
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  const key = process.env.RIOT_API_KEY?.trim();
  if (!key) throw new Error("RIOT_API_KEY가 필요합니다.");
  const { data, error } = await createServiceRoleSupabase().from("lol_accounts")
    .select("puuid,game_name,tag_line").eq("platform_id", "kr").eq("regional_route", "asia")
    .order("account_fetched_at", { ascending: false }).limit(limit);
  if (error) throw new Error("저장 계정을 읽지 못했습니다.");
  const lookup: Lookup = async (gameName, tagLine) => {
    const response = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, {
      headers: { "X-Riot-Token": key, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    const body = await response.json() as { puuid?: unknown };
    return { status: 200, puuid: typeof body.puuid === "string" ? body.puuid : undefined };
  };
  const result = await checkLolKeyPuuid((data ?? []) as StoredAccount[], lookup);
  console.log(JSON.stringify(result));
  if (result.verdict !== "same") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "점검에 실패했습니다.");
    process.exitCode = 1;
  });
}
