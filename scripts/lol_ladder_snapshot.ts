import { pathToFileURL } from "node:url";
import { LOL_LADDER_QUEUES, LOL_LADDER_TIERS, aggregateLolLadder, type LolLadderAggregate } from "../lib/lol/ladder";

type Dependencies = {
  request: (path: string) => Promise<unknown>;
  save: (rows: LolLadderAggregate[], observedAt: string) => Promise<void>;
};
export async function runLolLadderSnapshot(deps: Dependencies, args = process.argv.slice(2), enabled = process.env.LOL_LADDER_ENABLED === "true") {
  if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
    throw new Error("--dry-run 또는 --apply 중 하나만 지정해 주세요.");
  }
  const apply = args.includes("--apply");
  if (apply && !enabled) throw new Error("쓰기에는 LOL_LADDER_ENABLED=true가 필요합니다.");
  const rows: LolLadderAggregate[] = [];
  const observedAt = new Date().toISOString();
  for (const queue of LOL_LADDER_QUEUES) {
    for (const tier of LOL_LADDER_TIERS) {
      const raw = await deps.request(`/lol/league/v4/${tier.toLowerCase()}leagues/by-queue/${queue}`);
      rows.push(aggregateLolLadder(raw, queue, tier));
    }
  }
  // 6개 응답이 모두 유효할 때만 한 번에 저장하며 원본 명단은 남기지 않는다.
  if (apply) await deps.save(rows, observedAt);
  return { dryRun: !apply, observedAt, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Next 빌드의 서버 표시만 CLI에서 해석하며 실제 호출 가드는 그대로 사용한다.
    const { register } = await import("node:module");
    register("data:text/javascript," + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : nextResolve(specifier, context);
      }
    `), import.meta.url);
    if (process.env.LOL_PERSISTENCE_ENABLED !== "true") throw new Error("공유 호출 제한이 필요합니다.");
    const { requestJson } = await import("../lib/lol/riotSearch.server");
    const { createServiceRoleSupabase } = await import("../lib/server/serviceRoleSupabase.server");
    const result = await runLolLadderSnapshot({
      request: path => requestJson("kr", path, 0, true),
      save: async (rows, observedAt) => {
        const { error } = await createServiceRoleSupabase().rpc("save_lol_ladder_daily", { p_rows: rows, p_observed_at: observedAt })
          .abortSignal(AbortSignal.timeout(5000));
        if (error) throw new Error("스냅샷 저장 실패");
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error("[lol-ladder] 수집 실패: 키·공유 호출 제한·저장 설정을 확인해 주세요.");
    process.exitCode = 1;
  }
}
