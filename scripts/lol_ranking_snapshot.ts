import { pathToFileURL } from "node:url";
import {
  RANKING_HMAC_MIN_KEY_LENGTH, RANKING_QUEUE, RANKING_TIERS, RankingValidationError,
  buildMasteryBoard, evaluateRankingPublish, excludeRankingRows, parseMasteryTop, parseRankingLeague,
  riotIdHmac, selectRankingCandidates, toRankingRows,
  type MasteryPlayer, type RankingEntry, type RankingRow, type ResolvedRankingEntry, type MasteryBoardChampion,
} from "../lib/lol/ranking";

// 랭킹·장인 게시 수집기. 경기 원문은 받지 않는다. PUUID는 메모리에서만 쓰고 출력과 저장에 넣지 않는다.
// 기본은 dry-run이며, --apply는 LOL_RANKING_ENABLED=true와 제외 목록 키가 있을 때만 게시한다.

const RETRY_DELAYS_MS = [1000, 2000, 4000];
// 키가 없는 dry-run에서만 쓰는 자리표시자다. 이 값으로 만든 HMAC은 저장되지 않는다.
const DRY_RUN_PLACEHOLDER_SECRET = "dry-run-placeholder-secret-not-stored-0000";

export type RankingDependencies = {
  request: (host: "kr" | "asia", path: string) => Promise<unknown>;
  save: (input: { rows: RankingRow[]; playerCount: number; masteries: MasteryBoardChampion[]; observedAt: string }) => Promise<void>;
  excludedKeys: () => Promise<string[]>;
  hmacSecret?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type RankingRunResult = {
  dryRun: boolean;
  observedAt: string;
  published: boolean;
  reasons: string[];
  exclusionChecked: boolean;
  counts: {
    candidates: number; resolved: number; unresolved: number; masteryCompleted: number;
    excluded: number; rows: number; champions: number; payloadBytes: number;
  };
};

function errorKind(error: unknown): string | undefined {
  return error && typeof error === "object" && "kind" in error ? String((error as { kind: unknown }).kind) : undefined;
}

// 혼잡과 한도 초과만 짧게 기다렸다가 다시 보낸다. 그 밖의 오류는 바로 실패로 센다.
async function withRetry<T>(task: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const kind = errorKind(error);
      if ((kind === "congested" || kind === "rate_limited") && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw error;
    }
  }
}

function parseAccount(raw: unknown): { gameName: string; tagLine: string } {
  const account = raw as { gameName?: unknown; tagLine?: unknown } | null;
  if (!account || typeof account.gameName !== "string" || typeof account.tagLine !== "string"
    || !account.gameName.trim() || account.gameName.length > 64 || !/^[^\s#]{1,16}$/.test(account.tagLine.trim())) {
    throw new RankingValidationError("Riot ID 응답을 확인할 수 없습니다.");
  }
  return { gameName: account.gameName.trim(), tagLine: account.tagLine.trim() };
}

export async function runLolRankingSnapshot(
  deps: RankingDependencies,
  args = process.argv.slice(2),
  enabled = process.env.LOL_RANKING_ENABLED === "true",
): Promise<RankingRunResult> {
  if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
    throw new Error("--dry-run 또는 --apply 중 하나만 지정해 주세요.");
  }
  const apply = args.includes("--apply");
  if (apply && !enabled) throw new Error("쓰기에는 LOL_RANKING_ENABLED=true가 필요합니다.");
  const secret = deps.hmacSecret;
  if (apply && (!secret || secret.length < RANKING_HMAC_MIN_KEY_LENGTH)) {
    throw new Error("쓰기에는 제외 목록 키(LOL_RANKING_HMAC_KEY, 32자 이상)가 필요합니다.");
  }
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const observedAt = (deps.now?.() ?? new Date()).toISOString();
  const keySecret = secret && secret.length >= RANKING_HMAC_MIN_KEY_LENGTH ? secret : DRY_RUN_PLACEHOLDER_SECRET;

  // 1) 명단 두 개를 받는다. 하나라도 형식이 다르면 여기서 실패해 게시하지 않는다.
  const leagues: RankingEntry[] = [];
  for (const tier of RANKING_TIERS) {
    const raw = await deps.request("kr", `/lol/league/v4/${tier.toLowerCase()}leagues/by-queue/${RANKING_QUEUE}`);
    leagues.push(...parseRankingLeague(raw, tier));
  }
  // 2) 게시 대상 상한만 해석한다(호출 수 상한).
  const candidates = selectRankingCandidates(leagues);

  // 3) Riot ID와 숙련도를 순서대로 받는다. 한 명의 실패가 전체를 멈추지 않고 해석률로 센다.
  const resolved: ResolvedRankingEntry[] = [];
  const masteryPlayers: MasteryPlayer[] = [];
  let unresolved = 0;
  let masteryCompleted = 0;
  for (const candidate of candidates) {
    try {
      const account = parseAccount(await withRetry(() => deps.request("asia", `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(candidate.puuid)}`), sleep));
      resolved.push({ ...candidate, gameName: account.gameName, tagLine: account.tagLine });
    } catch {
      unresolved += 1;
      continue;
    }
    const current = resolved[resolved.length - 1];
    try {
      const masteries = parseMasteryTop(await withRetry(() => deps.request("kr",
        `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(candidate.puuid)}/top?count=10`), sleep));
      masteryCompleted += 1;
      masteryPlayers.push({ gameName: current.gameName, tagLine: current.tagLine, riotIdHmac: riotIdHmac(current.gameName, current.tagLine, keySecret), masteries });
    } catch {
      // 숙련도 실패는 장인 표본에서만 뺀다. 완료율 게이트가 과도한 누락을 막는다.
    }
  }

  // 4) 게시 직전에 제외 목록을 대조한다(삭제 요청 계정은 다음 게시부터 빠진다).
  const excludedSet = new Set(secret ? await deps.excludedKeys() : []);
  const allRows = toRankingRows(resolved, entry => riotIdHmac(entry.gameName, entry.tagLine, keySecret));
  const ranking = excludeRankingRows(allRows, excludedSet);
  const masteryKept = masteryPlayers.filter(player => !excludedSet.has(player.riotIdHmac));
  const masteries = buildMasteryBoard(masteryKept);
  const payloadBytes = Buffer.byteLength(JSON.stringify({ rows: ranking.rows, masteries }));

  const gate = evaluateRankingPublish({ candidates: candidates.length, resolved: resolved.length, masteryCompleted, payloadBytes });
  const publish = apply && gate.publish;
  if (publish) {
    await deps.save({ rows: ranking.rows, playerCount: ranking.rows.length, masteries, observedAt });
  }
  return {
    dryRun: !apply,
    observedAt,
    published: publish,
    reasons: gate.reasons,
    exclusionChecked: Boolean(secret),
    counts: {
      candidates: candidates.length,
      resolved: resolved.length,
      unresolved,
      masteryCompleted,
      excluded: ranking.removed,
      rows: ranking.rows.length,
      champions: masteries.length,
      payloadBytes,
    },
  };
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
    const persistence = await import("../lib/lol/persistence.server");
    const secret = process.env.LOL_RANKING_HMAC_KEY?.trim();
    const result = await runLolRankingSnapshot({
      request: (host, path) => requestJson(host, path, 0, true),
      save: input => persistence.saveLolRankingPublication(input),
      excludedKeys: () => persistence.listLolRankingExclusionKeys(),
      hmacSecret: secret,
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes("--apply") && !result.published) {
      console.error("[lol-ranking] 게시 조건을 넘지 못해 이전 게시본을 그대로 둡니다.");
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof RankingValidationError ? "랭크 명단 응답 형식이 달라 게시하지 않습니다." : "";
    console.error(`[lol-ranking] 수집 실패: 키·공유 호출 제한·저장 설정을 확인해 주세요.${message ? ` ${message}` : ""}`);
    process.exitCode = 1;
  }
}

