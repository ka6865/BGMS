import { pathToFileURL } from "node:url";
import {
  RANKING_HMAC_MIN_KEY_LENGTH, RANKING_QUEUE, RANKING_TIERS, RankingValidationError, type RankingStore,
  accountHmac, buildMasterBoard, evaluateRankingPublish, excludeResolved, extractMatchForAccount, formatRiotId,
  parseRankingLeague, parseSeasonEnd, parseSeasonStart, planAccountUpdate, riotIdHmac, selectRankingCandidates, toRankingRows,
  type MasterEntryInput, type RankingEntry, type ResolvedRankingEntry,
  type MatchCore, type ChampionCount,
} from "../lib/lol/ranking";

// 랭킹·장인 수집기(시즌 누적). 경기 원문과 다른 참가자 정보는 저장하지 않는다.
// PUUID는 메모리에서만 쓰고, 저장과 출력에는 HMAC만 남긴다. 기본은 dry-run이며 --apply는 LOL_RANKING_ENABLED=true일 때만 쓴다.
// 한 실행은 호출 상한(LOL_RANKING_MAX_CALLS)까지만 하고 커서를 저장한 뒤 끝난다. 다음 실행이 커서부터 이어받는다.

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const RIOT_ID_TTL_MS = 7 * 24 * 3600_000;
const IDS_PAGE_SIZE = 100;
const MAX_IDS_PER_ACCOUNT = 500;
const MAX_MATCHES_PER_ACCOUNT = 200;
export const DEFAULT_MAX_CALLS = 600;
export const DEFAULT_CHECK_INTERVAL_HOURS = 12;
// 키가 없는 dry-run에서만 쓰는 자리표시자다. 이 값으로 만든 HMAC은 저장되지 않는다.
const DRY_RUN_PLACEHOLDER_SECRET = "dry-run-placeholder-secret-not-stored-0000";

export type RankingDependencies = {
  request: (host: "kr" | "asia", path: string) => Promise<unknown>;
  store: RankingStore;
  secret?: string;
  seasonStart: string | undefined;
  seasonEnd?: string;
  maxCalls: number;
  checkIntervalHours?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type RankingRunResult = {
  dryRun: boolean;
  observedAt: string;
  season: string;
  published: { ranking: boolean; master: boolean };
  reasons: string[];
  exclusionChecked: boolean;
  budget: { maxCalls: number; calls: number; exhausted: boolean };
  counts: {
    candidates: number; resolved: number; unresolvedRiotId: number; excluded: number;
    due: number; processed: number; staleSkipped: number; incomplete: number;
    countedMatches: number; skippedMatches: number; coverage: number; championsPublished: number;
  };
};

// 키 오류는 저장된 커서를 건드리지 않고 실행을 멈춘다. 운영자가 키를 바꾼 뒤 다시 실행하면 이어받는다.
export class LolRankingKeyError extends Error {
  constructor() { super("Riot 키 오류"); }
}

class BudgetExhaustedError extends Error {
  constructor() { super("호출 상한에 도달했습니다."); }
}

function errorKind(error: unknown): string | undefined {
  return error && typeof error === "object" && "kind" in error ? String((error as { kind: unknown }).kind) : undefined;
}

function isKeyError(error: unknown): boolean {
  const kind = errorKind(error);
  return kind === "key_or_permission" || kind === "unconfigured";
}

function parseAccount(raw: unknown): { gameName: string; tagLine: string } {
  const account = raw as { gameName?: unknown; tagLine?: unknown } | null;
  if (!account || typeof account.gameName !== "string" || typeof account.tagLine !== "string"
    || !account.gameName.trim() || account.gameName.length > 64 || !/^[^\s#]{1,16}$/.test(account.tagLine.trim())) {
    throw new RankingValidationError("Riot ID 응답을 확인할 수 없습니다.");
  }
  return { gameName: account.gameName.trim(), tagLine: account.tagLine.trim() };
}

function parseMatchIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== "string" || !/^[A-Z0-9_]{3,40}$/.test(id))) {
    throw new RankingValidationError("경기 ID 목록 응답을 확인할 수 없습니다.");
  }
  return raw as string[];
}

// 혼잡과 한도 초과만 짧게 기다렸다가 다시 보낸다. 그 밖의 오류는 바로 호출자에게 돌려준다.
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
  const season = parseSeasonStart(deps.seasonStart);
  // 종료 시각은 쓰기에 필요하다. 없으면 30일 삭제가 동작하지 않으므로 쓰기를 거절한다. 읽기 dry-run은 허용한다.
  const seasonEnd = apply ? parseSeasonEnd(deps.seasonEnd, season.startMs).iso : (deps.seasonEnd ? parseSeasonEnd(deps.seasonEnd, season.startMs).iso : null);
  if (!Number.isSafeInteger(deps.maxCalls) || deps.maxCalls < 1 || deps.maxCalls > 100_000) {
    throw new Error("LOL_RANKING_MAX_CALLS는 1 이상 100000 이하의 정수여야 합니다.");
  }
  const secret = deps.secret;
  const secretOk = Boolean(secret && secret.length >= RANKING_HMAC_MIN_KEY_LENGTH);
  if (apply && !secretOk) throw new Error("쓰기에는 제외 목록 키(LOL_RANKING_HMAC_KEY, 32자 이상)가 필요합니다.");
  const keySecret = secretOk ? secret as string : DRY_RUN_PLACEHOLDER_SECRET;
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now?.() ?? new Date();
  const observedAt = now.toISOString();
  const intervalMs = (deps.checkIntervalHours ?? DEFAULT_CHECK_INTERVAL_HOURS) * 3600_000;

  let calls = 0;
  let exhausted = false;
  const once = async (host: "kr" | "asia", path: string): Promise<unknown> => {
    if (calls >= deps.maxCalls) {
      exhausted = true;
      throw new BudgetExhaustedError();
    }
    calls += 1;
    return deps.request(host, path);
  };
  const attempt = (host: "kr" | "asia", path: string) => withRetry(() => once(host, path), sleep);

  // 1) 명단 두 개(챌린저, 그랜드마스터). 형식이 다르면 실패해 아무것도 바꾸지 않는다.
  const entries: RankingEntry[] = [];
  for (const tier of RANKING_TIERS) {
    let raw: unknown;
    try {
      raw = await attempt("kr", `/lol/league/v4/${tier.toLowerCase()}leagues/by-queue/${RANKING_QUEUE}`);
    } catch (error) {
      if (isKeyError(error)) throw new LolRankingKeyError();
      throw error;
    }
    entries.push(...parseRankingLeague(raw, tier));
  }
  const candidates = selectRankingCandidates(entries);
  const keyOf = (puuid: string) => accountHmac(puuid, keySecret);
  const candidateKeys = candidates.map(entry => keyOf(entry.puuid));
  const excluded = new Set(secretOk ? await deps.store.excludedKeys() : []);
  const states = new Map((await deps.store.getAccountStates(season.key, candidateKeys)).map(state => [state.accountHmac, state]));

  // 2) Riot ID 해석. 7일 안에 확인한 값은 다시 부르지 않는다.
  type Listed = { entry: RankingEntry; key: string; gameName: string; tagLine: string; riotIdHmac: string; resolvedAt: string | null };
  const listed: Listed[] = [];
  let unresolvedRiotId = 0;
  let excludedCount = 0;
  for (const entry of candidates) {
    const key = keyOf(entry.puuid);
    const state = states.get(key);
    let gameName: string;
    let tagLine: string;
    let resolvedAt: string | null = state?.resolvedAt ?? null;
    if (state && state.resolvedAt && now.getTime() - Date.parse(state.resolvedAt) < RIOT_ID_TTL_MS) {
      const cut = state.riotId.lastIndexOf("#");
      gameName = state.riotId.slice(0, cut);
      tagLine = state.riotId.slice(cut + 1);
    } else {
      try {
        ({ gameName, tagLine } = parseAccount(await attempt("asia", `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(entry.puuid)}`)));
        resolvedAt = observedAt;
      } catch (error) {
        if (error instanceof BudgetExhaustedError) break;
        if (isKeyError(error)) throw new LolRankingKeyError();
        unresolvedRiotId += 1;
        continue;
      }
    }
    const hmac = riotIdHmac(gameName, tagLine, keySecret);
    if (excluded.has(hmac)) {
      excludedCount += 1;
      continue;
    }
    if (apply) {
      await deps.store.upsertAccount({ seasonKey: season.key, accountHmac: key, riotIdHmac: hmac, riotId: formatRiotId(gameName, tagLine),
        tier: entry.tier, leaguePoints: entry.leaguePoints, resolvedAt, listedAt: observedAt, seasonEnd: seasonEnd as string });
    }
    listed.push({ entry, key, gameName, tagLine, riotIdHmac: hmac, resolvedAt });
  }

  // 3) 경기 누적. 확인한 지 interval이 지난 계정만 처리하고, 같은 실행에서 경기 상세는 한 번만 받는다.
  const dueAccounts = listed
    .filter(item => {
      const state = states.get(item.key);
      return !state?.checkedAt || now.getTime() - Date.parse(state.checkedAt) >= intervalMs;
    })
    .sort((a, b) => (Date.parse(states.get(a.key)?.checkedAt ?? "1970-01-01T00:00:00Z")) - (Date.parse(states.get(b.key)?.checkedAt ?? "1970-01-01T00:00:00Z")));
  const detailCache = new Map<string, Map<string, MatchCore | null>>();
  const checkedNow = new Set<string>();
  let processed = 0;
  let staleSkipped = 0;
  let incomplete = 0;
  let countedMatches = 0;
  let skippedMatches = 0;
  for (const item of listed) {
    const state = states.get(item.key);
    if (state?.checkedAt && now.getTime() - Date.parse(state.checkedAt) < intervalMs) checkedNow.add(item.key);
  }

  for (const account of dueAccounts) {
    if (calls >= deps.maxCalls) {
      exhausted = true;
      break;
    }
    const state = states.get(account.key);
    const cursor = state?.cursor ?? null;
    // 경기 ID 목록은 커서 이후만 받는다. 목록은 최신순이라 뒤집어 오래된 순서로 처리한다.
    const startSec = Math.max(Math.floor(season.startMs / 1000), cursor ? Math.floor(cursor.ms / 1000) : 0);
    const ids: string[] = [];
    let listComplete = true;
    for (let start = 0; start < MAX_IDS_PER_ACCOUNT; start += IDS_PAGE_SIZE) {
      try {
        const page = parseMatchIds(await attempt("asia", `/lol/match/v5/matches/by-puuid/${encodeURIComponent(account.entry.puuid)}/ids`
          + `?queue=420&type=ranked&startTime=${startSec}&start=${start}&count=${IDS_PAGE_SIZE}`));
        ids.push(...page);
        if (page.length < IDS_PAGE_SIZE) break;
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          exhausted = true;
        } else if (isKeyError(error)) {
          throw new LolRankingKeyError();
        }
        listComplete = false;
        break;
      }
    }
    if (!listComplete) {
      incomplete += 1;
      continue;
    }
    const chronological = [...ids].reverse().slice(0, MAX_MATCHES_PER_ACCOUNT);
    const matches: MatchCore[] = [];
    let stopped = false;
    for (const matchId of chronological) {
      let perAccount = detailCache.get(matchId);
      if (!perAccount) {
        if (calls >= deps.maxCalls) {
          exhausted = true;
          stopped = true;
          break;
        }
        let detail: unknown;
        try {
          detail = await attempt("asia", `/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
        } catch (error) {
          if (error instanceof BudgetExhaustedError) {
            exhausted = true;
            stopped = true;
            break;
          }
          if (isKeyError(error)) throw new LolRankingKeyError();
          skippedMatches += 1;
          continue;
        }
        perAccount = new Map();
        for (const target of dueAccounts) {
          try {
            perAccount.set(target.key, extractMatchForAccount(detail, target.entry.puuid, season.startMs));
          } catch {
            perAccount.set(target.key, null);
          }
        }
        detailCache.set(matchId, perAccount);
      }
      const core = perAccount.get(account.key);
      if (core) matches.push(core);
      else skippedMatches += 1;
    }
    if (stopped && matches.length === 0 && chronological.length > 0) {
      incomplete += 1;
      continue;
    }

    const plan = planAccountUpdate(cursor, matches, MAX_MATCHES_PER_ACCOUNT);
    countedMatches += plan.accepted.filter(match => match.counted).length;
    if (apply) {
      const outcome = await deps.store.commitProgress({
        seasonKey: season.key, accountHmac: account.key, expectedCursorMs: cursor?.ms ?? null, cursor: plan.newCursor,
        deltas: [...plan.deltas].map(([championId, count]) => ({ championId, games: count.games, wins: count.wins })),
        checkedAt: observedAt,
      });
      if (outcome === "stale") {
        staleSkipped += 1;
        continue;
      }
    }
    processed += 1;
    checkedNow.add(account.key);
    if (stopped) {
      exhausted = true;
      break;
    }
  }

  // 4) 명단 게시. 명단은 해석률 조건을 넘을 때만 바꾸고, 장인은 현재 누적으로 매번 바꾼다.
  const kept = excludeResolved(listed.map(item => ({ ...item, gameName: item.gameName, tagLine: item.tagLine })), keySecret, excluded);
  const resolvedEntries: ResolvedRankingEntry[] = kept.kept.map(item => ({ ...item.entry, gameName: item.gameName, tagLine: item.tagLine }));
  const rows = toRankingRows(resolvedEntries);
  const payloadBytes = Buffer.byteLength(JSON.stringify(rows));
  // 제외된 계정은 실패가 아니므로 해석된 것으로 센다.
  const rankingGate = evaluateRankingPublish({ candidates: candidates.length, resolved: listed.length + excludedCount, payloadBytes });
  const publishRanking = apply && rankingGate.publish;
  if (publishRanking) await deps.store.saveRankingPublication({ rows, playerCount: rows.length, observedAt });

  const keptKeys = kept.kept.map(item => item.key);
  const countRows = await deps.store.listChampionCounts(season.key, keptKeys);
  const countsByAccount = new Map<string, Map<number, ChampionCount>>();
  for (const row of countRows) {
    const map = countsByAccount.get(row.accountHmac) ?? new Map<number, ChampionCount>();
    map.set(row.championId, { games: row.games, wins: row.wins });
    countsByAccount.set(row.accountHmac, map);
  }
  const masterInput: MasterEntryInput[] = kept.kept.map(item => ({
    gameName: item.gameName, tagLine: item.tagLine, tier: item.entry.tier, leaguePoints: item.entry.leaguePoints,
    champions: countsByAccount.get(item.key) ?? new Map<number, ChampionCount>(),
  }));
  const champions = buildMasterBoard(masterInput);
  const coverage = kept.kept.length ? Math.floor(100 * kept.kept.filter(item => checkedNow.has(item.key)).length / kept.kept.length) : 0;
  if (apply) {
    await deps.store.saveMasterPublication({ seasonKey: season.key, coverage, playerCount: kept.kept.length, champions, observedAt });
    await deps.store.purgeExpiredSeasons(observedAt);
  }

  const reasons = rankingGate.reasons;
  return {
    dryRun: !apply,
    observedAt,
    season: season.key,
    published: { ranking: publishRanking, master: apply },
    reasons,
    exclusionChecked: secretOk,
    budget: { maxCalls: deps.maxCalls, calls, exhausted },
    counts: {
      candidates: candidates.length,
      resolved: listed.length,
      unresolvedRiotId,
      excluded: excludedCount + kept.removed,
      due: dueAccounts.length,
      processed,
      staleSkipped,
      incomplete,
      countedMatches,
      skippedMatches,
      coverage,
      championsPublished: champions.length,
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
    const maxCalls = process.env.LOL_RANKING_MAX_CALLS ? Number(process.env.LOL_RANKING_MAX_CALLS) : DEFAULT_MAX_CALLS;
    const checkHours = process.env.LOL_RANKING_CHECK_HOURS ? Number(process.env.LOL_RANKING_CHECK_HOURS) : DEFAULT_CHECK_INTERVAL_HOURS;
    const result = await runLolRankingSnapshot({
      request: (host, path) => requestJson(host, path, 0, true),
      store: persistence.createLolRankingStore(),
      secret: process.env.LOL_RANKING_HMAC_KEY?.trim(),
      seasonStart: process.env.LOL_SEASON_START,
      seasonEnd: process.env.LOL_SEASON_END,
      maxCalls,
      checkIntervalHours: checkHours,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.published.ranking && process.argv.includes("--apply")) {
      console.log(`::warning::명단 게시 조건을 넘지 못해 이전 명단 게시본을 유지합니다. ${result.reasons.join(" ")}`);
    }
    if (result.budget.exhausted) console.log("[lol-ranking] 호출 상한에 도달했습니다. 다음 실행이 저장된 커서부터 이어받습니다.");
  } catch (error) {
    if (error instanceof LolRankingKeyError) {
      console.error("[lol-ranking] Riot 키 오류(401/403)입니다. 키를 갱신한 뒤 워크플로를 다시 실행하면 저장된 커서부터 이어받습니다.");
    } else {
      const message = error instanceof RankingValidationError ? " 명단 또는 설정 형식을 확인해 주세요." : "";
      console.error(`[lol-ranking] 수집 실패: 키·공유 호출 제한·시즌·저장 설정을 확인해 주세요.${message}`);
    }
    process.exitCode = 1;
  }
}
