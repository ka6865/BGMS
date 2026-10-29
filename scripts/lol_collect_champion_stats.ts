import { pathToFileURL } from "node:url";
import {
  LOL_STAT_QUEUE, extractLolStatMatch, lolStatWantsTimeline,
  type LolItemCatalog, type LolStatExtract, type LolStatTier,
} from "../lib/lol/championStats";

// 챔피언 통계 장기 수집기. 티어 구간을 번갈아 돌며 출발 계정의 최근 솔로 랭크 경기를 받아 익명 집계만 저장한다.
// 계정 식별자와 경기 원문은 메모리에서만 쓰고 DB에 남기지 않는다.

const DIVISION_TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"] as const;
const DIVISIONS = ["I", "II", "III", "IV"] as const;
const APEX_TIERS = ["MASTER", "GRANDMASTER", "CHALLENGER"] as const;
// 티어마다 같은 비율로 표본을 받도록 한 바퀴에 모든 티어를 한 번씩 돈다. 4개 단계(I~IV)가 있는 티어와 균형을 맞추려고
// 단일 명단인 최상위 티어도 바퀴마다 한 번씩 넣는다(같은 구간 ID라 진행 위치는 이어진다).
export const LOL_STAT_BUCKETS: Array<{ id: string; tier: LolStatTier; division?: string }> = DIVISIONS.flatMap(division => [
  ...DIVISION_TIERS.map(tier => ({ id: `${tier}_${division}`, tier, division })),
  ...APEX_TIERS.map(tier => ({ id: tier, tier })),
]);

export type CollectorCursor = { next: number; buckets: Record<string, { page: number; index: number }> };
export type CollectorOptions = {
  apply: boolean; per2Min: number; timelineRatio: number; idsPerSeed: number; days: number;
  maxMinutes: number; maxMatches: number;
};
export type RiotFailureKind = "rate_limited" | "congested" | "busy" | "key_or_permission" | "unconfigured" | "not_found" | "timeout" | "upstream" | "persistence" | string;
export class CollectorRiotError extends Error {
  constructor(readonly kind: RiotFailureKind, readonly retryAfterSeconds?: number) { super(kind); }
}
export type CollectorDeps = {
  riot: (host: "kr" | "asia", path: string, responseLimitBytes?: number) => Promise<unknown>;
  loadCursor: () => Promise<CollectorCursor | null>;
  saveCursor: (cursor: CollectorCursor) => Promise<void>;
  filterNew: (matchIds: string[]) => Promise<string[]>;
  ingest: (matchId: string, tier: LolStatTier, extract: LolStatExtract) => Promise<boolean>;
  items: () => Promise<LolItemCatalog>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  stopped: () => boolean;
};
export type CollectorSummary = {
  dryRun: boolean; stopReason: string; riotCalls: number; seeds: number; matches: number; skipped: number;
  timelines: number; duplicates: number; failures: number; byTier: Record<string, number>;
};

export function parseCollectorArgs(args: string[], env: Record<string, string | undefined> = process.env): CollectorOptions {
  const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const known = ["--apply", "--dry-run"];
  const named = ["per-2min", "timeline-ratio", "ids-per-seed", "days", "max-minutes", "max-matches"];
  if (args.some(arg => !known.includes(arg) && !named.some(name => arg.startsWith(`--${name}=`)))) throw new Error("알 수 없는 옵션이 있습니다.");
  if (args.includes("--apply") === args.includes("--dry-run")) throw new Error("--dry-run 또는 --apply 중 하나만 지정해 주세요.");
  const apply = args.includes("--apply");
  if (apply && env.LOL_COLLECT_ENABLED !== "true") throw new Error("쓰기에는 LOL_COLLECT_ENABLED=true가 필요합니다.");
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = value(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`--${name}는 ${min}~${max} 범위여야 합니다.`);
    return parsed;
  };
  return {
    apply,
    // 개발 키는 2분 100회다. 운영 검색과 같은 호출 제한을 쓰므로 기본은 그 20%만 쓴다.
    per2Min: number("per-2min", 20, 1, 80),
    timelineRatio: number("timeline-ratio", 0.5, 0, 1),
    idsPerSeed: Math.round(number("ids-per-seed", 10, 1, 100)),
    days: number("days", 7, 1, 30),
    maxMinutes: number("max-minutes", 0, 0, 7 * 24 * 60),
    maxMatches: Math.round(number("max-matches", apply ? 0 : 3, 0, 1_000_000)),
  };
}

const isMatchId = (value: unknown): value is string => typeof value === "string" && /^KR_\d{1,20}$/.test(value);
const isPuuid = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128;

export async function runLolStatCollector(deps: CollectorDeps, options: CollectorOptions): Promise<CollectorSummary> {
  const summary: CollectorSummary = { dryRun: !options.apply, stopReason: "done", riotCalls: 0, seeds: 0, matches: 0, skipped: 0,
    timelines: 0, duplicates: 0, failures: 0, byTier: {} };
  const startedAt = deps.now();
  const interval = Math.ceil(120_000 / options.per2Min);
  let lastCall = -Infinity;
  const loaded = await deps.loadCursor();
  const cursor: CollectorCursor = loaded && typeof loaded.next === "number" && loaded.buckets && typeof loaded.buckets === "object"
    ? loaded : { next: 0, buckets: {} };
  const pages = new Map<string, string[]>();
  const items = await deps.items();

  const timeUp = () => (options.maxMinutes > 0 && deps.now() - startedAt >= options.maxMinutes * 60_000)
    || (options.maxMatches > 0 && summary.matches + summary.skipped >= options.maxMatches);
  // 운영 검색과 함께 쓰는 공유 제한 위에 수집기 자체 간격을 둔다. 제한·혼잡은 기다렸다가 같은 요청을 다시 보낸다.
  const call = async (host: "kr" | "asia", path: string, limit?: number): Promise<unknown | null> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (deps.stopped()) throw new CollectorRiotError("stopped");
      const wait = lastCall + interval - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastCall = deps.now();
      summary.riotCalls += 1;
      try {
        return await deps.riot(host, path, limit);
      } catch (error) {
        const kind = error instanceof CollectorRiotError ? error.kind : "upstream";
        const retry = error instanceof CollectorRiotError ? error.retryAfterSeconds : undefined;
        if (kind === "key_or_permission" || kind === "unconfigured") throw new CollectorRiotError(kind);
        if (kind === "not_found") return null;
        if (kind === "rate_limited" || kind === "congested" || kind === "busy") {
          deps.log(`[lol-stats] ${kind} ${retry ?? 5}초 대기`);
          await deps.sleep(((retry ?? 5) + 1) * 1000);
          continue;
        }
        if (kind === "persistence") { await deps.sleep(30_000); continue; }
        return null;
      }
    }
    return null;
  };

  const nextSeed = async (bucket: (typeof LOL_STAT_BUCKETS)[number]): Promise<string | null> => {
    const state = cursor.buckets[bucket.id] ?? { page: 1, index: 0 };
    for (let tries = 0; tries < 2; tries += 1) {
      const key = `${bucket.id}:${state.page}`;
      let list = pages.get(key);
      if (!list) {
        const path = bucket.division
          ? `/lol/league/v4/entries/RANKED_SOLO_5x5/${bucket.tier}/${bucket.division}?page=${state.page}`
          : `/lol/league/v4/${bucket.tier.toLowerCase()}leagues/by-queue/RANKED_SOLO_5x5`;
        const raw = await call("kr", path);
        const entries = bucket.division ? raw : (raw as { entries?: unknown } | null)?.entries;
        list = Array.isArray(entries) ? entries.map(entry => (entry as { puuid?: unknown })?.puuid).filter(isPuuid) : [];
        pages.set(key, list);
      }
      if (state.index < list.length) {
        const seed = list[state.index];
        state.index += 1;
        cursor.buckets[bucket.id] = state;
        return seed;
      }
      pages.delete(key);
      // 마지막 페이지를 지나면 처음 페이지로 돌아간다. 최상위 티어 명단은 한 페이지다.
      if (bucket.division && list.length > 0) { state.page += 1; state.index = 0; }
      else { state.page = 1; state.index = 0; }
      cursor.buckets[bucket.id] = state;
    }
    return null;
  };

  try {
    while (!deps.stopped() && !timeUp()) {
      const bucket = LOL_STAT_BUCKETS[cursor.next % LOL_STAT_BUCKETS.length];
      cursor.next = (cursor.next + 1) % LOL_STAT_BUCKETS.length;
      const seed = await nextSeed(bucket);
      if (!seed) continue;
      summary.seeds += 1;
      const startTime = Math.floor((deps.now() - options.days * 86_400_000) / 1000);
      const ids = await call("asia", `/lol/match/v5/matches/by-puuid/${encodeURIComponent(seed)}/ids?queue=${LOL_STAT_QUEUE}&type=ranked&startTime=${startTime}&count=${options.idsPerSeed}`);
      const matchIds = Array.isArray(ids) ? ids.filter(isMatchId) : [];
      const fresh = matchIds.length ? await deps.filterNew(matchIds) : [];
      summary.duplicates += matchIds.length - fresh.length;
      for (const matchId of fresh) {
        if (deps.stopped() || timeUp()) break;
        const match = await call("asia", `/lol/match/v5/matches/${matchId}`);
        if ((match as { metadata?: { matchId?: unknown } } | null)?.metadata?.matchId !== matchId) { summary.failures += 1; continue; }
        const preview = extractLolStatMatch(match, null, items);
        let timeline: unknown = null;
        if (!preview.skipped && lolStatWantsTimeline(matchId, options.timelineRatio)) {
          timeline = await call("asia", `/lol/match/v5/matches/${matchId}/timeline`, 4 * 1024 * 1024);
        }
        const extract = timeline ? extractLolStatMatch(match, timeline, items) : preview;
        if (options.apply && !(await deps.ingest(matchId, bucket.tier, extract))) { summary.duplicates += 1; continue; }
        if (extract.skipped) summary.skipped += 1;
        else {
          summary.matches += 1;
          if (extract.hasTimeline) summary.timelines += 1;
          summary.byTier[bucket.tier] = (summary.byTier[bucket.tier] ?? 0) + 1;
        }
        if (!options.apply) deps.log(`[lol-stats] dry-run ${bucket.tier} ${extract.skipped ?? `${extract.patch} 참가 ${extract.payload.champions.length} 빌드 ${extract.payload.builds.length} timeline ${extract.hasTimeline}`}`);
      }
      if (options.apply) await deps.saveCursor(cursor);
      if (summary.seeds % 20 === 0) {
        const minutes = Math.max(1, (deps.now() - startedAt) / 60_000);
        deps.log(`[lol-stats] 출발 계정 ${summary.seeds} · 경기 ${summary.matches} (timeline ${summary.timelines}) · 제외 ${summary.skipped} · 중복 ${summary.duplicates} · 분당 ${(summary.matches / minutes).toFixed(1)}경기`);
      }
    }
    summary.stopReason = deps.stopped() ? "stopped" : "limit";
  } catch (error) {
    if (!(error instanceof CollectorRiotError)) throw error;
    summary.stopReason = error.kind === "stopped" ? "stopped" : error.kind;
  }
  if (options.apply) await deps.saveCursor(cursor);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stop = false;
  process.on("SIGINT", () => { if (stop) process.exit(130); stop = true; console.log("[lol-stats] 현재 경기까지 저장하고 멈춥니다."); });
  process.on("SIGTERM", () => { stop = true; });
  try {
    const options = parseCollectorArgs(process.argv.slice(2));
    const { register } = await import("node:module");
    register("data:text/javascript," + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : nextResolve(specifier, context);
      }
    `), import.meta.url);
    if (process.env.LOL_PERSISTENCE_ENABLED !== "true") throw new Error("공유 호출 제한(LOL_PERSISTENCE_ENABLED=true)이 필요합니다.");
    // 사용자 검색보다 적은 몫(이동 구간 한도의 50%)만 쓰도록 백그라운드 우선순위로 예약한다.
    process.env.LOL_RIOT_PRIORITY ??= "background";
    const { requestJson, RiotSearchError } = await import("../lib/lol/riotSearch.server");
    const { getLolDataDragonVersion } = await import("../lib/lol/dataDragon.server");
    const { classifyLolItems } = await import("../lib/lol/championStats");
    const { createServiceRoleSupabase } = await import("../lib/server/serviceRoleSupabase.server");
    const db = createServiceRoleSupabase();
    const timeout = () => AbortSignal.timeout(10_000);
    const leaseKey = "ops:lol-stat-collector";
    let lease: { token: string; at: number } | null = null;
    const holdLease = async () => {
      if (!options.apply) return;
      if (lease && Date.now() - lease.at < 60_000) return;
      if (lease) await db.rpc("release_lol_collection_lease", { p_key: leaseKey, p_token: lease.token }).abortSignal(timeout());
      const { data, error } = await db.rpc("acquire_lol_collection_lease", { p_key: leaseKey, p_ttl_seconds: 120 }).abortSignal(timeout());
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.lease_token) throw new Error("다른 수집기가 실행 중입니다.");
      lease = { token: row.lease_token, at: Date.now() };
    };
    await holdLease();
    const summary = await runLolStatCollector({
      riot: async (host, path, limit) => {
        await holdLease();
        try { return await requestJson(host, path, 0, true, undefined, limit); }
        catch (error) {
          if (error instanceof RiotSearchError) throw new CollectorRiotError(error.kind, error.retryAfterSeconds);
          throw error;
        }
      },
      loadCursor: async () => {
        const { data, error } = await db.from("lol_stat_collector_state").select("cursor").eq("singleton", true).abortSignal(timeout()).maybeSingle();
        if (error) throw new Error("수집 위치를 읽지 못했습니다.");
        return (data?.cursor as CollectorCursor | undefined) ?? null;
      },
      saveCursor: async cursor => {
        const { error } = await db.from("lol_stat_collector_state").upsert({ singleton: true, cursor, updated_at: new Date().toISOString() }).abortSignal(timeout());
        if (error) throw new Error("수집 위치를 저장하지 못했습니다.");
      },
      filterNew: async ids => {
        const { data, error } = await db.from("lol_stat_processed_matches").select("match_id").in("match_id", ids).abortSignal(timeout());
        if (error) throw new CollectorRiotError("persistence");
        const seen = new Set((data ?? []).map(row => row.match_id));
        return ids.filter(id => !seen.has(id));
      },
      ingest: async (matchId, tier, extract) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const { data, error } = await db.rpc("ingest_lol_stat_match", {
            p_match_id: matchId, p_patch: extract.patch, p_queue_id: extract.queueId, p_tier: tier,
            p_has_timeline: extract.hasTimeline, p_skipped_reason: extract.skipped, p_payload: extract.payload ?? {},
          }).abortSignal(timeout());
          if (!error) return data === true;
          await new Promise(resolve => setTimeout(resolve, 5_000));
        }
        throw new Error("집계 저장에 실패했습니다.");
      },
      items: async () => {
        const version = await getLolDataDragonVersion();
        const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/item.json`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("아이템 정보를 받지 못했습니다.");
        return classifyLolItems(await response.json());
      },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => Date.now(),
      log: line => console.log(line),
      stopped: () => stop,
    }, options);
    if (lease) await db.rpc("release_lol_collection_lease", { p_key: leaseKey, p_token: (lease as { token: string }).token }).abortSignal(timeout());
    console.log(JSON.stringify(summary, null, 2));
    if (summary.stopReason === "key_or_permission" || summary.stopReason === "unconfigured") {
      console.error("[lol-stats] Riot 키가 만료됐거나 권한이 없습니다. .env.local의 RIOT_API_KEY를 갱신한 뒤 다시 실행하면 이어서 수집합니다.");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`[lol-stats] 수집 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    process.exitCode = 1;
  }
}
