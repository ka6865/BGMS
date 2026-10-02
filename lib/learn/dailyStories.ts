import { createClient } from "@supabase/supabase-js";
import { cache } from "react";
import type { DailyEncounter, DailyWeaponFind } from "./dailyCombatStory";
import type { DailyEvidence, DailyEvidenceFact } from "./dailyEvidence";
import type { DailyScene } from "./dailyScenes";

export type DailyMode = "solo" | "duo" | "squad";

export type DailyRankerStory = {
  dayKst: string;
  matchId: string;
  nickname: string;
  mode: DailyMode;
  mapName: string;
  leaderboardRank: number;
  playedAt: string;
  publishedAt: string;
  kills: number;
  damage: number;
  teamKills: number;
  roster?: { name: string; kills: number; isRanker: boolean }[];
  encounters?: DailyEncounter[];
  weaponFinds?: DailyWeaponFind[];
  headline: string;
  conclusion: string;
  points: { text: string; evidenceIds: string[] }[];
  facts: DailyEvidenceFact[];
  weapons: { name: string; kills: number }[];
  killEvents: { timeSeconds: number; victim: string; weapon: string; distanceMeters?: number }[];
  teamKillEvents?: { timeSeconds: number; killer: string; victim: string; weapon: string; attackId?: number | null; distanceMeters?: number }[];
  route?: { timeSeconds: number; x: number; y: number; place: string | null; spreadMeters: number; players: { name: string; x: number; y: number }[] }[];
  aircraft?: { timeSeconds: number; x: number; y: number }[];
  zones: DailyEvidence["zones"];
  blueZoneSamples?: DailyEvidence["blueZoneSamples"];
  limitations: string[];
  scenes?: DailyScene[];
  sceneCount?: number;
  schemaVersion?: number;
  evidenceVersion?: number;
  promptVersion?: string;
  selection?: { usedFallback: boolean; rejectedReasons: string[] };
  leaderboardObservedAt?: string;
  leaderboardSeason?: string;
  leaderboardSource?: string;
};

type StoryRow = {
  day_kst: string;
  match_id: string;
  nickname: string;
  mode: DailyMode;
  map_name: string;
  leaderboard_rank: number;
  played_at: string;
  published_at: string;
  kills: number;
  damage: number;
  team_kills: number;
  story: Pick<DailyRankerStory, "headline" | "conclusion" | "points" | "facts" | "weapons" | "killEvents" | "teamKillEvents" | "roster" | "encounters" | "weaponFinds" | "route" | "aircraft" | "zones" | "blueZoneSamples" | "limitations" | "scenes" | "sceneCount" | "schemaVersion" | "evidenceVersion" | "promptVersion" | "selection" | "leaderboardObservedAt" | "leaderboardSeason" | "leaderboardSource">;
};

const FIELDS = "day_kst,match_id,nickname,mode,map_name,leaderboard_rank,played_at,published_at,kills,damage,team_kills,story";
const LIST_FIELDS = "day_kst,nickname,mode,map_name,leaderboard_rank,published_at,kills,damage,headline:story->>headline,conclusion:story->>conclusion,sceneCount:story->sceneCount,leaderboardObservedAt:story->>leaderboardObservedAt,leaderboardSeason:story->>leaderboardSeason,leaderboardSource:story->>leaderboardSource";

export type DailyStorySummary = Pick<DailyRankerStory,
  "dayKst" | "nickname" | "mode" | "mapName" | "leaderboardRank" | "publishedAt" | "kills" | "damage" | "headline" | "conclusion"> & Pick<DailyRankerStory,
  "leaderboardObservedAt" | "leaderboardSeason" | "leaderboardSource"> & { sceneCount?: number };

type StoryListRow = Pick<StoryRow, "day_kst" | "nickname" | "mode" | "map_name" | "leaderboard_rank" | "published_at" | "kills" | "damage"> & {
  headline: string;
  conclusion: string;
  sceneCount?: number | null;
  leaderboardObservedAt?: string | null;
  leaderboardSeason?: string | null;
  leaderboardSource?: string | null;
};

function storyClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function isDailyMode(mode: string): mode is DailyMode {
  return mode === "solo" || mode === "duo" || mode === "squad";
}

function toStory(row: StoryRow): DailyRankerStory {
  return {
    ...row.story,
    dayKst: row.day_kst,
    matchId: row.match_id,
    nickname: row.nickname,
    mode: row.mode,
    mapName: row.map_name,
    leaderboardRank: row.leaderboard_rank,
    playedAt: row.played_at,
    publishedAt: row.published_at,
    kills: row.kills,
    damage: row.damage,
    teamKills: row.team_kills,
  };
}

function toSummary(row: StoryListRow): DailyStorySummary {
  const sceneCount = typeof row.sceneCount === "number" && Number.isSafeInteger(row.sceneCount) && row.sceneCount >= 0
    ? { sceneCount: row.sceneCount }
    : {};
  return {
    dayKst: row.day_kst,
    nickname: row.nickname,
    mode: row.mode,
    mapName: row.map_name,
    leaderboardRank: row.leaderboard_rank,
    publishedAt: row.published_at,
    kills: row.kills,
    damage: row.damage,
    headline: row.headline,
    conclusion: row.conclusion,
    ...sceneCount,
    ...(row.leaderboardObservedAt ? { leaderboardObservedAt: row.leaderboardObservedAt } : {}),
    ...(row.leaderboardSeason ? { leaderboardSeason: row.leaderboardSeason } : {}),
    ...(row.leaderboardSource ? { leaderboardSource: row.leaderboardSource } : {}),
  };
}

async function listStories(query: { day?: string; limit?: number }): Promise<DailyStorySummary[]> {
  const db = storyClient();
  if (!db) return [];
  let request = db.from("daily_ranker_stories").select(LIST_FIELDS);
  if (query.day) request = request.eq("day_kst", query.day);
  request = request.order("day_kst", { ascending: false });
  if (query.day) request = request.order("mode", { ascending: true });
  const { data, error } = await request.limit(Math.max(1, Math.min(query.limit ?? 100, 100)));
  if (error) throw new Error(`daily-story-list:${error.code}`);
  return ((data ?? []) as unknown as StoryListRow[]).map(toSummary);
}

export async function listDailyRankerStories(limit = 30): Promise<DailyStorySummary[]> {
  return listStories({ limit });
}

export async function listDailyRankerStoriesForDay(day: string): Promise<DailyStorySummary[]> {
  if (!isValidDay(day)) return [];
  return listStories({ day });
}

export const getDailyRankerStory = cache(async (day: string, mode: DailyMode): Promise<DailyRankerStory | null> => {
  if (!isValidDay(day) || !isDailyMode(mode)) return null;
  const db = storyClient();
  if (!db) return null;
  const { data, error } = await db.from("daily_ranker_stories")
    .select(FIELDS).eq("day_kst", day).eq("mode", mode).maybeSingle();
  if (error) throw new Error(`daily-story-read:${error.code}`);
  return data ? toStory(data as unknown as StoryRow) : null;
});
