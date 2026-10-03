/** Publish one evidence-backed ranker win from the previous KST calendar day. */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildDailyEvidence, DAILY_EVIDENCE_VERSION, type DailyEvidence } from "../lib/learn/dailyEvidence";
import { DAILY_STORY_PROMPT_VERSION, generateDailyAiStory, type DailyAiStory } from "../lib/learn/dailyAi";
import type { DailyMode } from "../lib/learn/dailyStories";
import { buildDailySceneCandidates, type DailyScene } from "../lib/learn/dailyScenes";
import { relationshipBoundTelemetryAsset, parseOrdinaryTelemetryUrl } from "../lib/pubg-analysis/telemetrySource";

type Candidate = { accountId: string; nickname: string; rank: number };
type VerifiedCandidate = { evidence: DailyEvidence; scenes: DailyScene[]; observedAt: string; season: string; source: string };
const PUBG_BASE = "https://api.pubg.com/shards/steam";
const PUBG_RANKED_REGION = "pc-as";
const DEFAULT_PUBLISH_MODES = ["duo", "squad"] as const;
const MAX_PLAYERS_PER_MODE = 20;
const MAX_MATCHES_PER_PLAYER = 32;
const MAX_SEARCH_MS = 12 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function kstDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export function previousKstDay(instant = new Date()): string {
  return kstDate(new Date(instant.getTime() - 86_400_000));
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && kstDate(new Date(`${value}T00:00:00+09:00`)) === value;
}

async function readJson(url: string, headers: Record<string, string>, maxBytes: number, timeoutMs = 30_000, onResponse?: () => void): Promise<unknown> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  onResponse?.();
  if (!response.ok) throw new Error(`upstream_${response.status}:${new URL(url).pathname.slice(0, 90)}`);
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) throw new Error("payload_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw new Error("payload_too_large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pubgHeaders(key: string) {
  return { Authorization: `Bearer ${key}`, Accept: "application/vnd.api+json" };
}

export function fallbackLeaderboardMode(mode: DailyMode): DailyMode {
  return mode === "duo" ? "squad" : "duo";
}

function parseLeaderboard(value: unknown): Candidate[] {
  const data = record(value);
  const board = record(data?.data);
  const boardAttributes = record(board?.attributes);
  if (board?.type !== "leaderboard" || boardAttributes?.shardId !== "pc-as") throw new Error("leaderboard_invalid");
  const included = Array.isArray(data?.included) ? data.included : [];
  return included.flatMap((raw) => {
    const player = record(raw);
    const attributes = record(player?.attributes);
    const rank = Number(attributes?.rank);
    const name = attributes?.name;
    if (player?.type !== "player" || typeof player.id !== "string" || !/^account\.[A-Za-z0-9_-]+$/.test(player.id)
      || typeof name !== "string" || !Number.isInteger(rank) || rank < 1) return [];
    return [{ accountId: player.id, nickname: name, rank }];
  }).sort((a, b) => a.rank - b.rank).slice(0, MAX_PLAYERS_PER_MODE);
}

export function isWinningMatch(value: unknown, candidate: Candidate, day: string, mode: DailyMode): boolean {
  const match = record(value);
  const data = record(match?.data);
  const attributes = record(data?.attributes);
  if (!attributes || attributes.shardId !== "steam" || attributes.gameMode !== mode
    || attributes.matchType !== "competitive" || attributes.isCustomMatch !== false
    || typeof attributes.createdAt !== "string" || !Number.isFinite(Date.parse(attributes.createdAt))
    || kstDate(new Date(attributes.createdAt)) !== day) return false;
  const included = Array.isArray(match?.included) ? match.included : [];
  return included.some((raw) => {
    const player = record(raw);
    const stats = record(record(player?.attributes)?.stats);
    return player?.type === "participant" && stats?.playerId === candidate.accountId && stats?.winPlace === 1;
  });
}

export function rankPublicationCandidates<T extends { evidence: { matchId: string; playedAt: string }; scenes: { kind: string }[]; repeatCount: number }>(candidates: T[]): T[] {
  return candidates.filter(({ scenes }) => scenes.length >= 3 && scenes.some((scene) => scene.kind === "finish")).sort((a, b) =>
    new Set(b.scenes.map((scene) => scene.kind)).size - new Set(a.scenes.map((scene) => scene.kind)).size
    || a.repeatCount - b.repeatCount
    || a.evidence.playedAt.localeCompare(b.evidence.playedAt)
    || a.evidence.matchId.localeCompare(b.evidence.matchId));
}

export function isRateLimited(error: unknown): boolean {
  const value = record(error);
  const response = record(value?.response);
  return Number(value?.status) === 429 || Number(response?.status) === 429
    || (error instanceof Error && /(?:upstream_)?429\b/.test(error.message));
}

function isMissingMatch(error: unknown): boolean {
  return error instanceof Error && /^upstream_404:/.test(error.message);
}

function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/^upstream_\d{3}:/.test(error.message)) return !isMissingMatch(error);
  return error.name === "AbortError" || error.name === "TimeoutError"
    || (error instanceof TypeError && /fetch failed|network|socket|timed? ?out/i.test(error.message));
}

function isExpectedStoryRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return new Set([
    "ai_json_invalid", "ai_scene_shape", "ai_story_shape", "ai_point_shape",
    "ai_point_evidence", "daily_story_insufficient_scenes",
  ]).has(error.message) || error.message.startsWith("ai_incomplete:");
}

export function recentKstStart(day: string): string {
  return kstDate(new Date(Date.parse(`${day}T00:00:00+09:00`) - 7 * 86_400_000));
}

export function publicationRepeatCount(history: { account_id?: string; map_name?: string }[], evidence: DailyEvidence): number {
  return history.filter((row) => row.account_id === evidence.accountId || row.map_name === evidence.mapName).length;
}

export function buildStoredStory(aiStory: DailyAiStory, evidence: DailyEvidence, provenance: {
  leaderboardObservedAt: string; leaderboardSeason: string; leaderboardSource: string;
}) {
  return { ...aiStory, ...provenance, sceneCount: aiStory.scenes?.length ?? 0,
    facts: evidence.facts, weapons: evidence.weapons, killEvents: evidence.killEvents,
    teamKillEvents: evidence.teamKillEvents, roster: evidence.roster, encounters: evidence.encounters,
    weaponFinds: evidence.weaponFinds, route: evidence.route, aircraft: evidence.aircraft,
    zones: evidence.zones, blueZoneSamples: evidence.blueZoneSamples, limitations: evidence.limitations };
}

function createRun(day: string, key: string) {
  const deadline = Date.now() + MAX_SEARCH_MS;
  const requestCache = new Map<string, Promise<unknown>>();
  const requestTimes = new Map<string, string>();
  const matchCache = new Map<string, Promise<unknown>>();
  const headers = pubgHeaders(key);
  const checkBudget = () => { if (Date.now() >= deadline) throw new Error("daily_story_search_budget_exhausted"); };
  const readCached = (url: string, requestHeaders: Record<string, string>, maxBytes: number, timeout?: number) => {
    let pending = requestCache.get(url);
    if (!pending) {
      pending = readJson(url, requestHeaders, maxBytes, timeout, () => requestTimes.set(url, new Date().toISOString()));
      requestCache.set(url, pending);
    }
    return pending;
  };
  return { day, headers, checkBudget, readCached, observedAt: (url: string) => requestTimes.get(url), matchCache };
}

async function selectEvidence(mode: DailyMode, run: ReturnType<typeof createRun>, seasonId: string): Promise<VerifiedCandidate[]> {
  const { day, headers, checkBudget, readCached, matchCache } = run;
  checkBudget();
  let boardMode = mode;
  let boardUrl = `https://api.pubg.com/shards/${PUBG_RANKED_REGION}/leaderboards/${encodeURIComponent(seasonId)}/${boardMode}`;
  let source = `PUBG AS leaderboard (${mode})`;
  let board: unknown;
  let players: Candidate[];
  try {
    board = await readCached(boardUrl, headers, 5_000_000);
    players = parseLeaderboard(board);
  } catch (error) {
    const absent = error instanceof Error && (/upstream_(?:400|404):/.test(error.message) || error.message === "leaderboard_invalid");
    if (isRateLimited(error) || !absent) throw error;
    boardMode = fallbackLeaderboardMode(mode);
    boardUrl = `https://api.pubg.com/shards/${PUBG_RANKED_REGION}/leaderboards/${encodeURIComponent(seasonId)}/${boardMode}`;
    board = await readCached(boardUrl, headers, 5_000_000);
    players = parseLeaderboard(board);
    source = `PUBG AS leaderboard (${boardMode} fallback)`;
  }
  const found: VerifiedCandidate[] = [];
  const seenMatchIds = new Set<string>();
  for (let offset = 0; offset < players.length && found.length < 3; offset += 10) {
    checkBudget();
    const batch = players.slice(offset, offset + 10);
    const ids = batch.map((player) => player.accountId).join(",");
    const playerResponse = record(await readCached(`${PUBG_BASE}/players?filter[playerIds]=${encodeURIComponent(ids)}`, headers, 6_000_000));
    const byId = new Map((Array.isArray(playerResponse?.data) ? playerResponse.data : [])
      .map(record).filter((player): player is Record<string, unknown> => !!player && typeof player.id === "string")
      .map((player) => [player.id as string, player]));
    for (const candidate of batch) {
      const player = byId.get(candidate.accountId);
      const refs = Array.isArray(record(record(player?.relationships)?.matches)?.data)
        ? record(record(player?.relationships)?.matches)?.data as unknown[] : [];
      for (const rawRef of refs.slice(0, MAX_MATCHES_PER_PLAYER)) {
        checkBudget();
        const id = record(rawRef)?.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(id)) continue;
        if (seenMatchIds.has(id)) continue;
        let pending = matchCache.get(id);
        if (!pending) {
          pending = readCached(`${PUBG_BASE}/matches/${encodeURIComponent(id)}`, headers, 8_000_000, 10_000);
          matchCache.set(id, pending);
        }
        let match: unknown;
        try { match = await pending; }
        catch (error) {
          if (isRateLimited(error)) throw error;
          if (!isMissingMatch(error)) throw error;
          console.warn(`DAILY_STORY_MATCH_SKIPPED:${id}:match_unavailable`);
          continue;
        }
        if (!isWinningMatch(match, candidate, day, mode)) continue;
        const participant = (Array.isArray(record(match)?.included) ? record(match)?.included as unknown[] : [])
          .map(record).find((item) => item?.type === "participant" && record(record(item.attributes)?.stats)?.playerId === candidate.accountId);
        const name = record(record(participant?.attributes)?.stats)?.name;
        if (typeof name !== "string") continue;
        let assetUrl: string;
        try {
          const binding = relationshipBoundTelemetryAsset(match);
          if (!binding) throw new Error("match_telemetry_asset_missing");
          assetUrl = parseOrdinaryTelemetryUrl(record(binding.asset.attributes)?.URL, binding.id);
        } catch {
          console.warn(`DAILY_STORY_CANDIDATE_SKIPPED:${id}:telemetry_reference_invalid`);
          continue;
        }

        // Download and decode telemetry outside the candidate-quality catch: any HTTP,
        // network, timeout, or JSON parse error is an upstream failure for this mode.
        const events = await readCached(assetUrl, {}, 64 * 1024 * 1024);
        try {
          const evidence = buildDailyEvidence({ match, events, candidate: { ...candidate, nickname: name }, dayKst: day });
          seenMatchIds.add(id);
          const scenes = buildDailySceneCandidates(evidence);
          const evidenceIds = new Set<string>();
          const sourceIndices = new Set<number>();
          const distinctScenes = scenes.filter((scene) => {
            if (scene.evidenceIds.some((evidenceId) => evidenceIds.has(evidenceId))
              || scene.sourceIndices?.some((sourceIndex) => sourceIndices.has(sourceIndex))) return false;
            scene.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId));
            scene.sourceIndices?.forEach((sourceIndex) => sourceIndices.add(sourceIndex));
            return true;
          });
          found.push({ evidence, scenes: distinctScenes, observedAt: run.observedAt(boardUrl) ?? new Date().toISOString(), season: seasonId, source });
          if (found.length === 3) break;
        } catch (error) {
          if (isRateLimited(error) || isProviderFailure(error)) throw error;
          console.warn(`DAILY_STORY_CANDIDATE_SKIPPED:${id}:evidence_unavailable`);
        }
      }
      if (found.length === 3) break;
    }
  }
  return found;
}

async function currentSeason(run: ReturnType<typeof createRun>): Promise<string> {
  const seasons = record(await run.readCached(`${PUBG_BASE}/seasons`, run.headers, 2_000_000));
  const season = (Array.isArray(seasons?.data) ? seasons.data : []).map(record)
    .find((item) => record(item?.attributes)?.isCurrentSeason === true);
  if (typeof season?.id !== "string") throw new Error("current_season_missing");
  return season.id;
}

async function publishMode(day: string, mode: DailyMode, apply: boolean, db: any, run: ReturnType<typeof createRun>, seasonId: string, aiKey: string) {
  const existing = await db.from("daily_ranker_stories").select("match_id").eq("day_kst", day).eq("mode", mode).maybeSingle();
  if (existing.error) throw new Error(`daily_story_existing_read:${existing.error.code}`);
  if (existing.data) return { state: "already_published", dayKst: day, mode, matchId: existing.data.match_id };
  const discovered = await selectEvidence(mode, run, seasonId);
  if (!discovered.length) return { state: "no_verified_candidate", dayKst: day, mode };
  const history = await db.from("daily_ranker_stories").select("account_id,map_name")
    .gte("day_kst", recentKstStart(day))
    .lt("day_kst", day);
  if (history.error) throw new Error(`daily_story_history_read:${history.error.code}`);
  const ranked = rankPublicationCandidates(discovered.map((item) => ({ ...item,
    repeatCount: publicationRepeatCount(history.data ?? [], item.evidence) })));
  if (!ranked.length) return { state: "no_complete_story", dayKst: day, mode };
  let chosen: { item: typeof ranked[number]; story: Awaited<ReturnType<typeof generateDailyAiStory>>["story"]; model: string } | undefined;
  for (const item of ranked) {
    try {
      run.checkBudget();
      const result = await generateDailyAiStory(item.evidence, aiKey);
      run.checkBudget();
      if (result.story.scenes?.length && result.story.scenes.length >= 3
        && result.story.scenes.some((scene) => scene.kind === "finish")) {
        chosen = { item, story: result.story, model: result.model };
        break;
      }
    } catch (error) {
      if (isRateLimited(error) || !isExpectedStoryRejection(error)) throw error;
      console.warn(`DAILY_STORY_GENERATION_SKIPPED:${item.evidence.matchId}:story_rejected`);
    }
  }
  if (!chosen) return { state: "no_complete_story", dayKst: day, mode };
  const evidence = { ...chosen.item.evidence, leaderboardObservedAt: chosen.item.observedAt,
    leaderboardSeason: chosen.item.season, leaderboardSource: chosen.item.source };
  const aiStory = chosen.story;
  const provenance = { leaderboardObservedAt: evidence.leaderboardObservedAt,
    leaderboardSeason: evidence.leaderboardSeason, leaderboardSource: evidence.leaderboardSource };
  const story = buildStoredStory(aiStory, evidence, provenance);
  if (!apply) return { state: "preview", dayKst: day, mode, matchId: evidence.matchId, story };
  const result = await db.from("daily_ranker_stories").insert({
    day_kst: day, platform: "steam", match_id: evidence.matchId, account_id: evidence.accountId,
    nickname: evidence.nickname, mode: evidence.mode, map_name: evidence.mapName,
    leaderboard_rank: evidence.leaderboardRank, played_at: evidence.playedAt,
    kills: evidence.kills, damage: evidence.damage, team_kills: evidence.teamKills,
    story, evidence: { source: "PUBG API", version: DAILY_EVIDENCE_VERSION, facts: evidence.facts, killEvents: evidence.killEvents,
      teamKillEvents: evidence.teamKillEvents, roster: evidence.roster, encounters: evidence.encounters,
      weaponFinds: evidence.weaponFinds, ...provenance },
    model: chosen.model, prompt_version: DAILY_STORY_PROMPT_VERSION,
  });
  if (result.error) {
    if (result.error.code === "23505") {
      const concurrent = await db.from("daily_ranker_stories").select("match_id").eq("day_kst", day).eq("mode", mode).maybeSingle();
      if (!concurrent.error && concurrent.data) return { state: "already_published", dayKst: day, mode, matchId: concurrent.data.match_id };
      throw new Error(`daily_story_match_collision:${evidence.matchId}`);
    }
    throw new Error(`daily_story_insert:${result.error.code}`);
  }
  return { state: "published", dayKst: day, mode, matchId: evidence.matchId };
}

export async function publishDailyRankerStory(options: { day: string; mode?: DailyMode; apply: boolean; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env;
  if (!validDay(options.day)) throw new Error("invalid_kst_day");
  if (options.mode === "solo") {
    return { state: "unsupported", dayKst: options.day, mode: options.mode, region: PUBG_RANKED_REGION,
      reason: "ranked_queue_unavailable_in_region" };
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const pubgKey = env.PUBG_API_KEY?.split(" ")[0];
  const aiKey = env.GOOGLE_GEMINI_API_KEY;
  if (!url || !serviceKey) throw new Error("daily_story_required_environment_missing");
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) as any;
  const modes = options.mode ? [options.mode] : DEFAULT_PUBLISH_MODES;
  const results: unknown[] = [];
  let run: ReturnType<typeof createRun> | null = null;
  let seasonId: string | null = null;
  for (const mode of modes) {
    try {
      const existing = await db.from("daily_ranker_stories").select("match_id").eq("day_kst", options.day).eq("mode", mode).maybeSingle();
      if (existing.error) throw new Error(`daily_story_existing_read:${existing.error.code}`);
      if (existing.data) { results.push({ state: "already_published", dayKst: options.day, mode, matchId: existing.data.match_id }); continue; }
      if (!pubgKey || !aiKey) throw new Error("daily_story_required_environment_missing");
      run ??= createRun(options.day, pubgKey);
      seasonId ??= await currentSeason(run);
      results.push(await publishMode(options.day, mode, options.apply, db, run, seasonId, aiKey));
    } catch (error) {
      results.push({ state: "failed", dayKst: options.day, mode, error: error instanceof Error ? error.message : String(error) });
      if (isRateLimited(error)) break;
    }
  }
  return options.mode ? results[0] : results;
}

export function publicationExitCode(result: unknown): number {
  const results = Array.isArray(result) ? result : [result];
  return results.some((item) => {
    const state = record(item)?.state;
    return !["published", "already_published", "preview", "unsupported", "no_verified_candidate", "no_complete_story"].includes(String(state));
  }) ? 1 : 0;
}

export function formatPublicationSummary(result: unknown): string {
  const results = Array.isArray(result) ? result : [result];
  const labels: Record<string, string> = {
    published: "발행 완료",
    already_published: "이미 발행되어 건너뜀",
    preview: "미리보기 생성",
    unsupported: "지원되지 않는 모드",
    no_verified_candidate: "검증된 우승 후보 없음 · 미발행",
    no_complete_story: "완성된 근거 기반 스토리 없음 · 미발행",
    failed: "처리 실패",
  };
  return [
    "## 랭커 스토리 발행 결과",
    "",
    "| 날짜(KST) | 모드 | 결과 |",
    "| --- | --- | --- |",
    ...results.map((item) => {
      const row = record(item) ?? {};
      const state = typeof row.state === "string" ? row.state : "unknown";
      const day = typeof row.dayKst === "string" ? row.dayKst : "확인 불가";
      const mode = typeof row.mode === "string" ? row.mode : "확인 불가";
      return `| ${day} | ${mode} | ${labels[state] ?? "알 수 없는 결과 · 확인 필요"} |`;
    }),
    "",
    "후보나 완성된 스토리가 없으면 정상적으로 미발행 처리됩니다. API·AI·DB 처리 실패는 Actions 실패로 표시됩니다.",
  ].join("\n");
}

async function main() {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: ".env.local", quiet: true });
  const dayArg = process.argv.find((arg) => arg.startsWith("--day="));
  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) as DailyMode | undefined;
  const day = dayArg?.slice(6) ?? previousKstDay();
  if (modeArg && !["solo", "duo", "squad"].includes(modeArg)) throw new Error("invalid_mode");
  const result = await publishDailyRankerStory({ day, mode: modeArg, apply: process.argv.includes("--apply") });
  console.log(JSON.stringify(result));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `${formatPublicationSummary(result)}\n`);
  }
  process.exitCode = publicationExitCode(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DAILY_STORY_ERROR:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
