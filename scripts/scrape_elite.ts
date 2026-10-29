// scripts/scrape_elite.ts
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';
import { BENCHMARK_FILTER_VERSION, BENCHMARK_POPULATION_EVIDENCE_VERSION } from '../lib/pubg-analysis/benchmarkLookup';
import { getValidFullResult } from '../lib/pubg-analysis/cacheIdentity';
import { normalizeName } from '../lib/pubg-analysis/utils';
import { describeScraperRequestFailure, scraperRequestRequiresAttention, type ScraperRequestFailure, type ScraperRequestStage } from '../lib/pubg-analysis/scraperDiagnostics';
import { getPrivatePlayersList, matchesPrivatePlayer, type PrivatePlayer } from '../lib/pubg/privatePlayers';
import { appendFileSync } from 'node:fs';

// .env 및 .env.local 파일의 환경변수 로드
dotenv.config({ path: '.env.local' });
dotenv.config();

const PUBG_API_KEY = process.env.PUBG_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBG_SCRAPER_INTERNAL_TOKEN = process.env.PUBG_SCRAPER_INTERNAL_TOKEN;
const ADMIN_REVALIDATE_TOKEN = process.env.ADMIN_REVALIDATE_TOKEN;

const BASE_URL = "https://api.pubg.com/shards/steam";
const LEADERBOARD_SHARD = "pc-as";
const PLATFORM = "steam";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const MATCH_API_URL = `${APP_URL}/api/pubg/match`;
const GAME_MODES = ["squad", "squad-fpp", "solo", "solo-fpp", "duo", "duo-fpp"] as const;

/** PUBG `/players?filter[playerIds]=` 한 번에 조회할 수 있는 최대 계정 수 */
export const PUBG_PLAYER_BATCH_SIZE = 10;
/**
 * 호출 한도 대상(seasons·leaderboards·players) 사이 간격. 기본 키 한도는 분당 10회이므로
 * 60초 / 10회 = 6초 간격이면 연속 호출해도 한도를 넘지 않는다.
 */
export const PUBG_RATE_LIMITED_INTERVAL_MS = 6_000;
/**
 * `/api/pubg/match` 호출 사이 간격. 이 route는 PUBG `/matches`와 텔레메트리 파일만 받으며
 * 둘은 PUBG 호출 한도(분당 10회)에 포함되지 않는다. 한도 대상 호출은 위 6초 간격으로만 나가므로
 * 이 간격은 앱·DB 부하만 고려해 1초로 둔다(호출마다 분석 시간이 더해져 실제 간격은 더 길다).
 */
export const MATCH_API_INTERVAL_MS = 1_000;
/** 429 응답이 대기 시간을 알려주지 않거나 비정상적으로 길 때 쓰는 대기 상한 */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** 리더보드에 이 기간 동안 나오지 않은 벤치마커는 은퇴로 표시하고 수집 대상에서 뺀다. */
export const COHORT_RETIRE_AFTER_DAYS = 30;

export function hasTrustedScraperCache(fullResult: unknown): boolean {
  if (!fullResult || typeof fullResult !== "object" || Array.isArray(fullResult)) return false;
  const candidate = fullResult as Record<string, unknown>;
  return typeof candidate.v === "number"
    && Number.isFinite(candidate.v)
    && candidate.v >= RESULT_VERSION
    && candidate.populationEvidenceVersion === POPULATION_EVIDENCE_VERSION;
}

export function hasTrustedScraperBenchmark(benchmark: unknown): boolean {
  if (!benchmark || typeof benchmark !== "object" || Array.isArray(benchmark)) return false;
  const candidate = benchmark as Record<string, unknown>;
  const matchType = typeof candidate.match_type === "string"
    ? candidate.match_type.trim().toLowerCase()
    : "";
  return Number(candidate.filter_version) === BENCHMARK_FILTER_VERSION
    && Number(candidate.population_evidence_version) === BENCHMARK_POPULATION_EVIDENCE_VERSION
    && (matchType === "official" || matchType === "competitive");
}

export function shouldSkipScraperMatch(input: {
  fullResult: unknown;
  benchmark: unknown;
}): boolean {
  return hasTrustedScraperCache(input.fullResult) && hasTrustedScraperBenchmark(input.benchmark);
}

export type CohortMember = {
  account_id: string;
  nickname: string;
  collected_player_ids: string[];
  last_ranked_at: string;
  last_collected_at: string | null;
  retired_at: string | null;
};

export type RankedEntry = {
  accountId: string;
  nickname: string;
  rank: number | null;
  gameMode: string;
};

export type ScraperCounters = {
  succeeded: number;
  skipped: number;
  failed: number;
  rateLimited: number;
};

type FailureRecord = { stage: ScraperRequestStage | "cohort"; status: number | null; code: string };

function emptyResult(): EliteScraperResult {
  return {
    counters: { succeeded: 0, skipped: 0, failed: 0, rateLimited: 0 },
    failures: [],
    cohortUpserted: 0,
    cohortRetired: 0,
    privateExcluded: 0,
    targets: 0,
    attentionRequired: false,
  };
}

/** DB 접근을 한곳에 모아 실행 흐름을 메모리 대역으로 검증할 수 있게 한다. */
export interface EliteScraperStore {
  readPrivatePlayers(): Promise<PrivatePlayer[]>;
  upsertRanked(entries: RankedEntry[], seasonId: string, nowIso: string): Promise<void>;
  retireStale(cutoffIso: string, nowIso: string): Promise<number>;
  removeMembers(accountIds: string[]): Promise<void>;
  listActive(limit: number): Promise<CohortMember[]>;
  markCollected(accountId: string, update: { nickname: string; collectedPlayerIds: string[]; collectedAt: string }): Promise<void>;
  readExistingAnalysis(matchId: string, playerId: string): Promise<{ fullResult: unknown; benchmark: unknown }>;
}

export type HttpResponse = { status: number; data: any; headers?: Record<string, unknown> };

export interface EliteScraperDeps {
  store: EliteScraperStore;
  /** 호출 한도 대상 PUBG API GET */
  pubgGet(url: string): Promise<HttpResponse>;
  /** 운영 앱 `/api/pubg/match` GET */
  matchGet(url: string, headers: Record<string, string>): Promise<HttpResponse>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type EliteScraperConfig = {
  leaderboardDepth: number;
  dailyLimit: number;
  matchLimit: number;
  matchApiHeaders: Record<string, string>;
  forceApiHeaders: Record<string, string>;
};

export type EliteScraperResult = {
  counters: ScraperCounters;
  failures: FailureRecord[];
  cohortUpserted: number;
  cohortRetired: number;
  privateExcluded: number;
  targets: number;
  attentionRequired: boolean;
};

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 429 응답의 Retry-After(초 또는 HTTP 날짜)나 X-RateLimit-Reset(epoch 초)을 대기 시간으로 바꾼다. */
export function rateLimitWaitMs(headers: Record<string, unknown> | undefined, nowMs: number): number {
  const read = (name: string): string | null => {
    if (!headers) return null;
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return entry && entry[1] !== undefined && entry[1] !== null ? String(entry[1]).trim() : null;
  };
  const clamp = (ms: number) => Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, Math.ceil(ms)));
  const retryAfter = read("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return clamp(seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return clamp(date - nowMs);
  }
  const reset = Number(read("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return clamp(reset * 1_000 - nowMs);
  return MAX_RATE_LIMIT_WAIT_MS;
}

/** 리더보드 응답의 player 항목을 상위 depth명까지 순위와 함께 읽는다. */
export function readLeaderboardEntries(payload: any, gameMode: string, depth: number): RankedEntry[] {
  const included: any[] = Array.isArray(payload?.included) ? payload.included : [];
  return included
    .filter((item) => item?.type === "player" && typeof item.id === "string" && /^account\.[A-Za-z0-9_-]+$/.test(item.id))
    .map((item) => ({
      accountId: item.id as string,
      nickname: typeof item.attributes?.name === "string" ? item.attributes.name.trim() : "",
      rank: Number.isInteger(item.attributes?.rank) && item.attributes.rank > 0 ? item.attributes.rank as number : null,
      gameMode,
    }))
    .filter((entry) => entry.nickname !== "")
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, depth);
}

/** 여러 모드에 오른 계정은 가장 높은 순위의 모드 하나로 합친다. */
export function mergeRankedEntries(entries: RankedEntry[]): RankedEntry[] {
  const byAccount = new Map<string, RankedEntry>();
  for (const entry of entries) {
    const prior = byAccount.get(entry.accountId);
    if (!prior || (entry.rank ?? Number.MAX_SAFE_INTEGER) < (prior.rank ?? Number.MAX_SAFE_INTEGER)) {
      byAccount.set(entry.accountId, entry);
    }
  }
  return [...byAccount.values()];
}

/** 현역 명단에서 비공개 요청자를 빼고 가장 오래 수집하지 않은 순으로 하루 대상을 고른다. */
export function selectCollectionTargets(
  members: CohortMember[],
  privatePlayers: readonly PrivatePlayer[],
  limit: number,
): CohortMember[] {
  const collectedAt = (member: CohortMember) => member.last_collected_at ? Date.parse(member.last_collected_at) : Number.NEGATIVE_INFINITY;
  return members
    .filter((member) => !member.retired_at)
    .filter((member) => !matchesPrivatePlayer(privatePlayers, PLATFORM, member.nickname, member.account_id))
    .sort((left, right) => collectedAt(left) - collectedAt(right)
      || Date.parse(right.last_ranked_at) - Date.parse(left.last_ranked_at)
      || left.account_id.localeCompare(right.account_id))
    .slice(0, limit);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** 호출 한도 대상 PUBG 호출만 고정 간격으로 내보내고, 429를 받으면 알려준 시간까지 다음 호출을 늦춘다. */
class PubgRateLimiter {
  private nextAllowedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: Pick<EliteScraperDeps, "pubgGet" | "sleep" | "now">) {}

  async get(url: string): Promise<HttpResponse> {
    const wait = this.nextAllowedAt - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait);
    try {
      return await this.deps.pubgGet(url);
    } catch (error) {
      const response = (error as { response?: { status?: unknown; headers?: Record<string, unknown> } }).response;
      if (Number(response?.status) === 429) {
        this.nextAllowedAt = this.deps.now() + Math.max(PUBG_RATE_LIMITED_INTERVAL_MS, rateLimitWaitMs(response?.headers, this.deps.now()));
      }
      throw error;
    } finally {
      this.nextAllowedAt = Math.max(this.nextAllowedAt, this.deps.now() + PUBG_RATE_LIMITED_INTERVAL_MS);
    }
  }
}

export async function runEliteScraper(deps: EliteScraperDeps, config: EliteScraperConfig): Promise<EliteScraperResult> {
  const result = emptyResult();
  const { counters, failures } = result;
  const limiter = new PubgRateLimiter(deps);

  // 실패 1건은 failed 또는 skipped 중 하나로만 센다. 미존재·진행 중 경기(404/409)는 정상 건너뜀이다.
  const recordRequestFailure = (stage: ScraperRequestStage, error: unknown, weight = 1): ScraperRequestFailure => {
    const failure = describeScraperRequestFailure(stage, error);
    console.error("스크래퍼 요청 실패", JSON.stringify(failure));
    failures.push(failure);
    if (failure.status === 429) counters.rateLimited += 1;
    if (scraperRequestRequiresAttention(failure)) {
      counters.failed += weight;
      result.attentionRequired = true;
    } else {
      counters.skipped += weight;
    }
    return failure;
  };
  const recordLocalFailure = (code: string, stage: FailureRecord["stage"] = "cohort") => {
    console.error("스크래퍼 처리 실패", JSON.stringify({ stage, code }));
    failures.push({ stage, status: null, code });
    counters.failed += 1;
    result.attentionRequired = true;
  };

  // 비공개 목록을 읽지 못하면 비공개 요청자를 거를 수 없으므로 수집하지 않는다.
  let privatePlayers: PrivatePlayer[];
  try {
    privatePlayers = await deps.store.readPrivatePlayers();
  } catch {
    recordLocalFailure("private-players-unavailable");
    return result;
  }
  const isPrivate = (nickname: string, accountId: string) => matchesPrivatePlayer(privatePlayers, PLATFORM, nickname, accountId);

  // 1. 리더보드 → 명단 갱신. 이 단계가 실패해도 기존 명단으로 수집은 계속한다.
  let leaderboardComplete = false;
  let seasonId: string | null = null;
  try {
    const seasons = await limiter.get(`${BASE_URL}/seasons`);
    const current = (seasons.data?.data ?? []).find((season: any) => season?.attributes?.isCurrentSeason);
    if (typeof current?.id === "string") seasonId = current.id;
    else recordLocalFailure("current-season-missing", "season");
  } catch (error) {
    recordRequestFailure("season", error);
  }

  if (seasonId) {
    leaderboardComplete = true;
    const entries: RankedEntry[] = [];
    for (const mode of GAME_MODES) {
      try {
        const response = await limiter.get(`https://api.pubg.com/shards/${LEADERBOARD_SHARD}/leaderboards/${seasonId}/${mode}`);
        entries.push(...readLeaderboardEntries(response.data, mode, config.leaderboardDepth));
      } catch (error) {
        const failure = recordRequestFailure("leaderboard", error);
        // 지원하지 않는 모드(404)가 아닌 실패가 있으면 은퇴 판정에 쓰지 않는다.
        if (scraperRequestRequiresAttention(failure)) leaderboardComplete = false;
      }
    }

    const merged = mergeRankedEntries(entries);
    const privateAccounts = merged.filter((entry) => isPrivate(entry.nickname, entry.accountId)).map((entry) => entry.accountId);
    const ranked = merged.filter((entry) => !privateAccounts.includes(entry.accountId));
    result.privateExcluded += privateAccounts.length;
    const nowIso = new Date(deps.now()).toISOString();
    try {
      if (privateAccounts.length > 0) await deps.store.removeMembers(privateAccounts);
      if (ranked.length > 0) await deps.store.upsertRanked(ranked, seasonId, nowIso);
      result.cohortUpserted = ranked.length;
    } catch {
      leaderboardComplete = false;
      recordLocalFailure("cohort-upsert-failed");
    }
  }

  // 2. 리더보드를 빠짐없이 확인한 날에만 오래 안 보인 벤치마커를 은퇴 처리한다.
  if (leaderboardComplete) {
    const now = deps.now();
    try {
      result.cohortRetired = await deps.store.retireStale(
        new Date(now - COHORT_RETIRE_AFTER_DAYS * 86_400_000).toISOString(),
        new Date(now).toISOString(),
      );
    } catch {
      recordLocalFailure("cohort-retire-failed");
    }
  }

  // 3. 명단에서 오늘 수집할 대상을 고른다.
  let targets: CohortMember[];
  try {
    targets = selectCollectionTargets(await deps.store.listActive(config.dailyLimit * 2), privatePlayers, config.dailyLimit);
  } catch {
    recordLocalFailure("cohort-read-failed");
    return result;
  }
  result.targets = targets.length;
  console.log(`오늘 수집 대상 ${targets.length}명 (명단 갱신 ${result.cohortUpserted}명, 은퇴 ${result.cohortRetired}명)`);

  let firstMatchCall = true;
  for (const batch of chunk(targets, PUBG_PLAYER_BATCH_SIZE)) {
    let players: any[];
    try {
      const response = await limiter.get(`${BASE_URL}/players?filter[playerIds]=${batch.map((member) => member.account_id).join(",")}`);
      players = Array.isArray(response.data?.data) ? response.data.data : [];
    } catch (error) {
      recordRequestFailure("player", error, batch.length);
      continue;
    }

    const byAccount = new Map(players.filter((player) => typeof player?.id === "string").map((player) => [player.id as string, player]));
    for (const member of batch) {
      const player = byAccount.get(member.account_id);
      const collectedAt = new Date(deps.now()).toISOString();
      if (!player) {
        // 계정이 조회되지 않으면 오늘은 건너뛰고 순서만 뒤로 보낸다.
        counters.skipped += 1;
        await deps.store.markCollected(member.account_id, {
          nickname: member.nickname,
          collectedPlayerIds: member.collected_player_ids,
          collectedAt,
        }).catch(() => recordLocalFailure("cohort-mark-failed"));
        continue;
      }

      // 리더보드 이름은 옛 이름일 수 있으므로 플레이어 응답의 현재 이름으로 분석한다.
      const currentName = typeof player.attributes?.name === "string" ? player.attributes.name.trim() : "";
      if (!currentName) {
        counters.skipped += 1;
        continue;
      }
      if (isPrivate(currentName, member.account_id)) {
        result.privateExcluded += 1;
        await deps.store.removeMembers([member.account_id]).catch(() => recordLocalFailure("cohort-remove-failed"));
        continue;
      }

      const playerId = normalizeName(currentName);
      // 분석 행보다 먼저 이름을 남겨, 중간에 중단돼도 정리 대상에서 빠지지 않게 한다.
      try {
        await deps.store.markCollected(member.account_id, {
          nickname: currentName,
          collectedPlayerIds: [...new Set([...member.collected_player_ids, playerId])],
          collectedAt,
        });
      } catch {
        recordLocalFailure("cohort-mark-failed");
        continue;
      }

      const matchIds: string[] = (player.relationships?.matches?.data ?? [])
        .slice(0, config.matchLimit)
        .map((match: any) => match?.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);

      for (const matchId of matchIds) {
        let existing: { fullResult: unknown; benchmark: unknown };
        try {
          existing = await deps.store.readExistingAnalysis(matchId, playerId);
        } catch {
          recordLocalFailure("analysis-read-failed");
          continue;
        }
        if (shouldSkipScraperMatch(existing)) {
          counters.skipped += 1;
          continue;
        }
        // 저장된 분석이 있는데 건너뛸 조건이 아니면(구버전·벤치마크 누락) 강제 재분석한다.
        const forceReanalysis = Boolean(existing.fullResult);

        if (!firstMatchCall) await deps.sleep(MATCH_API_INTERVAL_MS);
        firstMatchCall = false;
        try {
          const response = await deps.matchGet(
            `${MATCH_API_URL}?matchId=${matchId}&nickname=${encodeURIComponent(currentName)}&platform=steam&source=scraper${forceReanalysis ? "&force=true" : ""}`,
            forceReanalysis ? config.forceApiHeaders : config.matchApiHeaders,
          );
          if (response.status === 200) counters.succeeded += 1;
          else counters.skipped += 1;
        } catch (error) {
          recordRequestFailure("match", error);
        }
      }
    }
  }

  return result;
}

function createSupabaseStore(supabase: SupabaseClient): EliteScraperStore {
  const table = () => supabase.from("pubg_benchmark_cohort");
  const assertOk = ({ error }: { error: unknown }) => {
    if (error) throw new Error("benchmark-cohort-query-failed");
  };
  return {
    readPrivatePlayers: () => getPrivatePlayersList(supabase),
    async upsertRanked(entries, seasonId, nowIso) {
      // first_ranked_at·last_collected_at·collected_player_ids는 넣지 않아 기존 값을 유지한다.
      assertOk(await table().upsert(entries.map((entry) => ({
        platform: PLATFORM,
        account_id: entry.accountId,
        nickname: entry.nickname,
        source_shard: LEADERBOARD_SHARD,
        source_season_id: seasonId,
        source_game_mode: entry.gameMode,
        last_rank: entry.rank,
        last_ranked_at: nowIso,
        retired_at: null,
        updated_at: nowIso,
      })), { onConflict: "platform,account_id" }));
    },
    async retireStale(cutoffIso, nowIso) {
      const { data, error } = await table()
        .update({ retired_at: nowIso, updated_at: nowIso })
        .eq("platform", PLATFORM)
        .is("retired_at", null)
        .lt("last_ranked_at", cutoffIso)
        .select("account_id");
      assertOk({ error });
      return Array.isArray(data) ? data.length : 0;
    },
    async removeMembers(accountIds) {
      assertOk(await table().delete().eq("platform", PLATFORM).in("account_id", accountIds));
    },
    async listActive(limit) {
      const { data, error } = await table()
        .select("account_id, nickname, collected_player_ids, last_ranked_at, last_collected_at, retired_at")
        .eq("platform", PLATFORM)
        .is("retired_at", null)
        .order("last_collected_at", { ascending: true, nullsFirst: true })
        .order("last_ranked_at", { ascending: false })
        .limit(limit);
      assertOk({ error });
      return (data ?? []) as CohortMember[];
    },
    async markCollected(accountId, update) {
      assertOk(await table()
        .update({
          nickname: update.nickname,
          collected_player_ids: update.collectedPlayerIds,
          last_collected_at: update.collectedAt,
          updated_at: update.collectedAt,
        })
        .eq("platform", PLATFORM)
        .eq("account_id", accountId));
    },
    async readExistingAnalysis(matchId, playerId) {
      const processed = await supabase
        .from("processed_match_telemetry")
        .select("data")
        .eq("match_id", matchId)
        .eq("platform", PLATFORM)
        .eq("player_id", playerId)
        .maybeSingle();
      assertOk(processed);
      const fullResult = getValidFullResult(processed.data, playerId, PLATFORM);
      if (!hasTrustedScraperCache(fullResult)) return { fullResult, benchmark: null };
      const benchmark = await supabase
        .from("global_benchmarks")
        .select("id, filter_version, population_evidence_version, match_type")
        .eq("match_id", matchId)
        .eq("platform", PLATFORM)
        .eq("player_id", playerId)
        .maybeSingle();
      assertOk(benchmark);
      return { fullResult, benchmark: benchmark.data };
    },
  };
}

function writeGithubReport(result: EliteScraperResult) {
  const { counters } = result;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, [
      `succeeded=${counters.succeeded}`,
      `skipped=${counters.skipped}`,
      `failed=${counters.failed}`,
      `rate_limited=${counters.rateLimited}`,
    ].join("\n") + "\n");
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const failureLines = result.failures.map((failure) => `| ${failure.stage} | ${failure.status ?? "-"} | ${failure.code} |`);
    appendFileSync(summaryPath, [
      "### 벤치마크 표본 수집",
      `- 수집 대상 ${result.targets}명 · 명단 갱신 ${result.cohortUpserted}명 · 은퇴 ${result.cohortRetired}명 · 비공개 제외 ${result.privateExcluded}명`,
      `- 성공 ${counters.succeeded} · 건너뜀 ${counters.skipped} · 실패 ${counters.failed} · PUBG 429 ${counters.rateLimited}`,
      ...(failureLines.length > 0 ? ["", "| 단계 | 상태 | 코드 |", "| --- | --- | --- |", ...failureLines] : []),
    ].join("\n") + "\n");
  }
}

export async function scrapeEliteData() {
  console.log("🚀 [BGMS Smart Scraper] 작업을 시작합니다...");

  if (
    !PUBG_API_KEY?.trim()
    || !SUPABASE_URL?.trim()
    || !SUPABASE_KEY?.trim()
    || !PUBG_SCRAPER_INTERNAL_TOKEN?.trim()
    || !ADMIN_REVALIDATE_TOKEN?.trim()
  ) {
    console.error("필수 환경변수가 설정되어 있지 않습니다.");
    process.exitCode = 1;
    const missing = emptyResult();
    missing.counters.failed = 1;
    writeGithubReport(missing);
    return;
  }

  // ELITE_PLAYER_LIMIT: 모드별 리더보드에서 명단에 올릴 상위 인원
  // ELITE_COHORT_DAILY_LIMIT: 하루에 경기를 수집할 명단 인원
  const config: EliteScraperConfig = {
    leaderboardDepth: parsePositiveInteger(process.env.ELITE_PLAYER_LIMIT, 10),
    dailyLimit: parsePositiveInteger(process.env.ELITE_COHORT_DAILY_LIMIT, 30),
    matchLimit: parsePositiveInteger(process.env.ELITE_MATCH_LIMIT, 3),
    matchApiHeaders: { Authorization: `Bearer ${PUBG_SCRAPER_INTERNAL_TOKEN}` },
    forceApiHeaders: {
      Authorization: `Bearer ${PUBG_SCRAPER_INTERNAL_TOKEN}`,
      'X-BGMS-Admin-Token': ADMIN_REVALIDATE_TOKEN,
    },
  };
  console.log(`리더보드 상위 ${config.leaderboardDepth}명/모드, 하루 ${config.dailyLimit}명, 매치 ${config.matchLimit}개`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const pubgHeaders = { Authorization: `Bearer ${PUBG_API_KEY}`, Accept: "application/vnd.api+json" };
  let result: EliteScraperResult | null = null;
  try {
    result = await runEliteScraper({
      store: createSupabaseStore(supabase),
      pubgGet: async (url) => {
        const response = await axios.get(url, { headers: pubgHeaders, timeout: 10_000 });
        return { status: response.status, data: response.data, headers: response.headers as Record<string, unknown> };
      },
      matchGet: async (url, headers) => {
        const response = await axios.get(url, { headers, timeout: 120_000 });
        return { status: response.status, data: response.data };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    }, config);
    if (result.attentionRequired) process.exitCode = 1;
  } catch {
    console.error("스크래퍼 작업 실패: 예상하지 못한 오류");
    process.exitCode = 1;
  } finally {
    const report = result ?? emptyResult();
    if (!result) report.counters.failed = 1;
    console.log("📊 스크래퍼 실행 요약", JSON.stringify({ ...report.counters, targets: report.targets, cohortUpserted: report.cohortUpserted, cohortRetired: report.cohortRetired }));
    writeGithubReport(report);
    console.log(process.exitCode ? "스크래퍼 일부 또는 전체 수집 실패 · 실행 로그 확인 필요" : "스크래퍼 실행 종료 · 성공/건너뜀 건수는 위 요약 참조");
  }
}

if (process.argv[1]?.endsWith("scrape_elite.ts")) {
  scrapeEliteData();
}
