import { createClient } from "@supabase/supabase-js";

export type DailyRankerStory = {
  dayKst: string;
  matchId: string;
  nickname: string;
  mode: "solo" | "squad";
  mapName: string;
  leaderboardRank: number;
  playedAt: string;
  publishedAt: string;
  kills: number;
  damage: number;
  teamKills: number;
  headline: string;
  conclusion: string;
  points: { text: string; evidenceIds: string[] }[];
  facts: { id: string; timeSeconds: number; kind: string; text: string }[];
  weapons: { name: string; kills: number }[];
  killEvents: { timeSeconds: number; victim: string; weapon: string }[];
  zones: { phase: number; observedSeconds: number; outsideMeters: number | null; firstInsideSeconds: number | null }[];
  limitations: string[];
};

type StoryRow = {
  day_kst: string;
  match_id: string;
  nickname: string;
  mode: "solo" | "squad";
  map_name: string;
  leaderboard_rank: number;
  played_at: string;
  published_at: string;
  kills: number;
  damage: number;
  team_kills: number;
  story: Pick<DailyRankerStory, "headline" | "conclusion" | "points" | "facts" | "weapons" | "killEvents" | "zones" | "limitations">;
};

const FIELDS = "day_kst,match_id,nickname,mode,map_name,leaderboard_rank,played_at,published_at,kills,damage,team_kills,story";

function storyClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function toStory(row: StoryRow): DailyRankerStory {
  return {
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
    ...row.story,
  };
}

export async function listDailyRankerStories(limit = 30): Promise<DailyRankerStory[]> {
  const db = storyClient();
  if (!db) return [];
  const { data, error } = await db.from("daily_ranker_stories")
    .select(FIELDS).order("day_kst", { ascending: false }).limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw new Error(`daily-story-list:${error.code}`);
  return ((data ?? []) as unknown as StoryRow[]).map(toStory);
}

export async function getDailyRankerStory(day: string): Promise<DailyRankerStory | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const db = storyClient();
  if (!db) return null;
  const { data, error } = await db.from("daily_ranker_stories")
    .select(FIELDS).eq("day_kst", day).maybeSingle();
  if (error) throw new Error(`daily-story-read:${error.code}`);
  return data ? toStory(data as unknown as StoryRow) : null;
}
