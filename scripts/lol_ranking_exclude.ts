import { pathToFileURL } from "node:url";
import { RANKING_HMAC_MIN_KEY_LENGTH, riotIdHmac } from "../lib/lol/ranking";

// 삭제 요청 계정을 랭킹·장인 제외 목록에 넣는다. Riot API를 호출하지 않고 Riot ID의 HMAC만 계산한다.
// 사용법: tsx scripts/lol_ranking_exclude.ts "게임이름#태그" [--dry-run|--apply]
export type ExcludeDependencies = {
  add: (hmac: string) => Promise<number>;
  secret?: string;
};

export async function runLolRankingExclude(deps: ExcludeDependencies, args: string[]): Promise<{ dryRun: boolean; removed: number | null }> {
  const riotId = args.find(arg => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  if (args.some(arg => arg.startsWith("--") && !["--apply", "--dry-run"].includes(arg)) || (apply && args.includes("--dry-run"))) {
    throw new Error("--dry-run 또는 --apply 중 하나만 지정해 주세요.");
  }
  const separator = riotId?.lastIndexOf("#") ?? -1;
  if (!riotId || separator < 1 || separator === riotId.length - 1) throw new Error("게임이름#태그 형식으로 입력해 주세요.");
  if (!deps.secret || deps.secret.length < RANKING_HMAC_MIN_KEY_LENGTH) throw new Error("제외 목록 키(LOL_RANKING_HMAC_KEY, 32자 이상)가 필요합니다.");
  const hmac = riotIdHmac(riotId.slice(0, separator).trim(), riotId.slice(separator + 1).trim(), deps.secret);
  if (!apply) return { dryRun: true, removed: null };
  return { dryRun: false, removed: await deps.add(hmac) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { register } = await import("node:module");
    register("data:text/javascript," + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : nextResolve(specifier, context);
      }
    `), import.meta.url);
    const persistence = await import("../lib/lol/persistence.server");
    if (process.env.LOL_PERSISTENCE_ENABLED !== "true") throw new Error("LOL_PERSISTENCE_ENABLED=true가 필요합니다.");
    const result = await runLolRankingExclude({
      add: hmac => persistence.addLolRankingExclusion(hmac),
      secret: process.env.LOL_RANKING_HMAC_KEY?.trim(),
    }, process.argv.slice(2));
    // Riot ID 원문은 출력하지 않는다. 제거된 행 수만 보여 준다.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[lol-ranking-exclude] ${error instanceof Error ? error.message : "실패"}`);
    process.exitCode = 1;
  }
}
