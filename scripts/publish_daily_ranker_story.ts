/** Publish one evidence-backed ranker win from the previous KST calendar day. */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildDailyEvidence, type DailyEvidence } from "../lib/learn/dailyEvidence";
import { DAILY_STORY_PROMPT_VERSION, generateDailyAiStory } from "../lib/learn/dailyAi";
import { relationshipBoundTelemetryAsset, parseOrdinaryTelemetryUrl } from "../lib/pubg-analysis/telemetrySource";

type Candidate = { accountId: string; nickname: string; rank: number };

const PUBG_BASE = "https://api.pubg.com/shards/steam";
const MAX_PLAYERS_PER_MODE = 20;
const MAX_MATCHES_PER_PLAYER = 14;

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

async function readJson(url: string, headers: Record<string, string>, maxBytes: number): Promise<unknown> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
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

export function isWinningMatch(value: unknown, candidate: Candidate, day: string, mode: "solo" | "squad"): boolean {
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

async function selectEvidence(day: string, key: string): Promise<DailyEvidence | null> {
  const headers = pubgHeaders(key);
  const seasons = record(await readJson(`${PUBG_BASE}/seasons`, headers, 2_000_000));
  const season = (Array.isArray(seasons?.data) ? seasons.data : []).map(record)
    .find((item) => record(item?.attributes)?.isCurrentSeason === true);
  if (typeof season?.id !== "string") throw new Error("current_season_missing");
  const modes: ("solo" | "squad")[] = Number(day.slice(-2)) % 2 === 0 ? ["solo", "squad"] : ["squad", "solo"];
  for (const mode of modes) {
    const board = await readJson(`https://api.pubg.com/shards/pc-as/leaderboards/${encodeURIComponent(season.id)}/${mode}`, headers, 5_000_000);
    const players = parseLeaderboard(board);
    // The players batch endpoint costs one rate-limited call for up to ten IDs.
    for (let offset = 0; offset < players.length; offset += 10) {
      const batch = players.slice(offset, offset + 10);
      const ids = batch.map((player) => player.accountId).join(",");
      const playerResponse = record(await readJson(`${PUBG_BASE}/players?filter[playerIds]=${encodeURIComponent(ids)}`, headers, 6_000_000));
      const byId = new Map((Array.isArray(playerResponse?.data) ? playerResponse.data : [])
        .map(record).filter((player): player is Record<string, unknown> => !!player && typeof player.id === "string")
        .map((player) => [player.id as string, player]));
      for (const candidate of batch) {
        const player = byId.get(candidate.accountId);
        const refs = Array.isArray(record(record(player?.relationships)?.matches)?.data)
          ? record(record(player?.relationships)?.matches)?.data as unknown[] : [];
        for (const rawRef of refs.slice(0, MAX_MATCHES_PER_PLAYER)) {
          const id = record(rawRef)?.id;
          if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(id)) continue;
          const match = await readJson(`${PUBG_BASE}/matches/${encodeURIComponent(id)}`, headers, 8_000_000);
          if (isWinningMatch(match, candidate, day, mode)) {
            const matchData = record(record(match)?.data);
            const attributes = record(matchData?.attributes);
            const participant = (Array.isArray(record(match)?.included) ? record(match)?.included as unknown[] : [])
              .map(record).find((item) => item?.type === "participant"
                && record(record(item.attributes)?.stats)?.playerId === candidate.accountId);
            const stats = record(record(participant?.attributes)?.stats);
            if (typeof stats?.name !== "string") continue;
            if (!attributes || attributes.gameMode !== mode) continue;
            try {
              const binding = relationshipBoundTelemetryAsset(match);
              if (!binding) throw new Error("match_telemetry_asset_missing");
              const assetUrl = parseOrdinaryTelemetryUrl(record(binding.asset.attributes)?.URL, binding.id);
              const events = await readJson(assetUrl, {}, 64 * 1024 * 1024);
              return buildDailyEvidence({ match, events, candidate: { ...candidate, nickname: stats.name }, dayKst: day });
            } catch (error) {
              console.warn(`DAILY_STORY_CANDIDATE_SKIPPED:${id}:${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    }
  }
  return null;
}

export async function publishDailyRankerStory(options: { day: string; apply: boolean; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env;
  if (!validDay(options.day)) throw new Error("invalid_kst_day");
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const pubgKey = env.PUBG_API_KEY?.split(" ")[0];
  const aiKey = env.GOOGLE_GEMINI_API_KEY;
  if (!url || !serviceKey || !pubgKey || !aiKey) throw new Error("daily_story_required_environment_missing");
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const existing = await db.from("daily_ranker_stories").select("match_id").eq("day_kst", options.day).maybeSingle();
  if (existing.error) throw new Error(`daily_story_existing_read:${existing.error.code}`);
  if (existing.data) return { state: "already_published", dayKst: options.day, matchId: existing.data.match_id };
  const evidence = await selectEvidence(options.day, pubgKey);
  if (!evidence) throw new Error("no_verified_yesterday_winner");
  const { story: aiStory, model } = await generateDailyAiStory(evidence, aiKey);
  const story = { ...aiStory, facts: evidence.facts, weapons: evidence.weapons, killEvents: evidence.killEvents,
    zones: evidence.zones, limitations: evidence.limitations };
  if (!options.apply) return { state: "preview", dayKst: options.day, matchId: evidence.matchId, story };
  const result = await db.from("daily_ranker_stories").insert({
    day_kst: options.day, platform: "steam", match_id: evidence.matchId, account_id: evidence.accountId,
    nickname: evidence.nickname, mode: evidence.mode, map_name: evidence.mapName,
    leaderboard_rank: evidence.leaderboardRank, played_at: evidence.playedAt,
    kills: evidence.kills, damage: evidence.damage, team_kills: evidence.teamKills,
    story, evidence: { source: "PUBG API", version: 1, facts: evidence.facts, killEvents: evidence.killEvents },
    model, prompt_version: DAILY_STORY_PROMPT_VERSION,
  });
  if (result.error) {
    if (result.error.code === "23505") {
      const concurrent = await db.from("daily_ranker_stories").select("match_id").eq("day_kst", options.day).maybeSingle();
      if (!concurrent.error && concurrent.data) return { state: "already_published", dayKst: options.day, matchId: concurrent.data.match_id };
    }
    throw new Error(`daily_story_insert:${result.error.code}`);
  }
  return { state: "published", dayKst: options.day, matchId: evidence.matchId };
}

async function main() {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: ".env.local", quiet: true });
  const dayArg = process.argv.find((arg) => arg.startsWith("--day="));
  const day = dayArg?.slice(6) ?? previousKstDay();
  const result = await publishDailyRankerStory({ day, apply: process.argv.includes("--apply") });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DAILY_STORY_ERROR:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
