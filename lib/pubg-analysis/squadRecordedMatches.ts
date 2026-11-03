import type { SupabaseClient } from "@supabase/supabase-js";
import { MATCH_DETAIL_RETENTION_DAYS } from "./matchRetention";
import { normalizeName } from "./utils";

// 전적 기록(pubg_player_matches)은 상세 분석 여부와 상관없이 남는다. 이 조합으로 최근에 몇 판을 했는지 세는 데 쓴다.
const RECORDED_LIMIT = 60;

export type RecordedSquadSummary = {
  windowDays: number;
  // 최근 windowDays일 안에 이 팀원 조합으로 기록된 경기 수
  total: number;
  // 그중 상세 분석이 있어 팀 지표 계산에 쓰인 경기 수
  analyzed: number;
  wins: number;
  matches: Array<{ matchId: string; playedAt: string; winPlace: number }>;
};

const teamModeFamily = (teamMode: "duo" | "squad") => (teamMode === "duo" ? ["duo", "duo-fpp"] : ["squad", "squad-fpp"]);

/**
 * 같은 팀원 조합의 최근 전적 기록을 읽는다. 팀원 목록이 기록되지 않은 오래된 행은 조합을 알 수 없어 세지 않는다.
 * 조회가 실패하면 null이며, 호출한 쪽은 상세 분석 경기만으로 계속한다.
 */
export async function readRecordedSquadMatches(input: {
  supabase: SupabaseClient;
  playerId: string;
  platform: string;
  teamMode: "duo" | "squad";
  teammateNames: readonly string[];
  analyzedMatchIds: ReadonlySet<string>;
  now?: number;
}): Promise<RecordedSquadSummary | null> {
  const now = input.now ?? Date.now();
  const since = new Date(now - MATCH_DETAIL_RETENTION_DAYS * 86_400_000).toISOString();
  const expected = [...new Set(input.teammateNames.map(normalizeName).filter(Boolean))].sort();
  if (expected.length === 0) return null;
  try {
    const { data, error } = await input.supabase
      .from("pubg_player_matches")
      .select("match_id, played_at, win_place, teammates")
      .eq("platform", input.platform)
      .eq("player_id", input.playerId)
      .in("game_mode", teamModeFamily(input.teamMode))
      .gte("played_at", since)
      .order("played_at", { ascending: false })
      .limit(RECORDED_LIMIT);
    if (error || !Array.isArray(data)) return null;
    const matches: RecordedSquadSummary["matches"] = [];
    for (const row of data as Array<Record<string, unknown>>) {
      if (!Array.isArray(row.teammates) || typeof row.match_id !== "string" || typeof row.played_at !== "string") continue;
      const names = [...new Set(row.teammates.map((member: any) => normalizeName(String(member?.name ?? ""))).filter(Boolean))].sort();
      if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) continue;
      const place = Number(row.win_place);
      matches.push({ matchId: row.match_id, playedAt: row.played_at, winPlace: Number.isFinite(place) && place >= 1 ? place : 0 });
    }
    return {
      windowDays: MATCH_DETAIL_RETENTION_DAYS,
      total: matches.length,
      analyzed: matches.filter(match => input.analyzedMatchIds.has(match.matchId)).length,
      wins: matches.filter(match => match.winPlace === 1).length,
      matches,
    };
  } catch {
    return null;
  }
}
