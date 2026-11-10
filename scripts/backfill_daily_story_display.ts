/** 발행된 랭커 해설의 목록 제목·요약을 상세 페이지 해설(buildDailyWalkthrough)과 맞춘다. 기본은 dry-run, --apply일 때만 갱신한다. */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { DailyRankerStory } from "../lib/learn/dailyStories";
import { buildDailyWalkthrough } from "../lib/learn/dailyWalkthrough";

type Row = {
  day_kst: string; mode: DailyRankerStory["mode"]; match_id: string; nickname: string; map_name: string;
  leaderboard_rank: number; played_at: string; published_at: string; kills: number; damage: number; team_kills: number;
  story: Record<string, unknown>;
};

export function displayFields(row: Row): { headline: string; conclusion: string } | null {
  if (!Array.isArray(row.story.scenes) || row.story.scenes.length === 0) return null;
  const walkthrough = buildDailyWalkthrough({
    ...(row.story as unknown as DailyRankerStory), dayKst: row.day_kst, matchId: row.match_id, nickname: row.nickname,
    mode: row.mode, mapName: row.map_name, leaderboardRank: row.leaderboard_rank, playedAt: row.played_at,
    publishedAt: row.published_at, kills: row.kills, damage: row.damage, teamKills: row.team_kills,
  });
  return { headline: walkthrough.headline, conclusion: walkthrough.summary };
}

async function main() {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: ".env.local", quiet: true });
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("daily_story_required_environment_missing");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.from("daily_ranker_stories")
    .select("day_kst,mode,match_id,nickname,map_name,leaderboard_rank,played_at,published_at,kills,damage,team_kills,story")
    .order("day_kst", { ascending: true });
  if (error) throw new Error(`daily_story_backfill_read:${error.code}`);
  let changed = 0;
  for (const row of (data ?? []) as Row[]) {
    const next = displayFields(row);
    if (!next || (next.headline === row.story.headline && next.conclusion === row.story.conclusion)) continue;
    changed++;
    console.log(`${row.day_kst} ${row.mode}: ${String(row.story.headline)} -> ${next.headline}`);
    if (!apply) continue;
    const result = await db.from("daily_ranker_stories").update({ story: { ...row.story, ...next } })
      .eq("day_kst", row.day_kst).eq("mode", row.mode).eq("match_id", row.match_id);
    if (result.error) throw new Error(`daily_story_backfill_update:${row.day_kst}:${row.mode}:${result.error.code}`);
  }
  console.log(`${apply ? "갱신" : "dry-run"}: ${changed}/${data?.length ?? 0}건`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DAILY_STORY_BACKFILL_ERROR:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
