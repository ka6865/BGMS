import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { getPrivatePlayersList, matchesPrivatePlayer } from "./privatePlayers";

const MAX_TEAMMATES = 4;
const MAX_TEAM_LOOKUPS = 40;

interface TeamLookupRow {
  match_id?: unknown;
  team_id?: unknown;
  player_id?: unknown;
  account_id?: unknown;
}

/**
 * 같은 경기·같은 team_id 로 저장된 참가자에서 팀원 닉네임을 찾는다.
 * 팀원 이름은 행마다 저장하지 않으므로 조회 시점의 비공개 목록으로 다시 거른다.
 * 조회에 실패하면 팀원 표시만 생략하고 전적 응답은 그대로 둔다.
 */
export async function readTeammateNames(
  supabase: SupabaseClient,
  platform: string,
  rows: readonly { match_id: string; team_id?: number | null; player_id: string; account_id?: string | null }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const teams = new Map<string, { teamId: number; playerId: string; accountId: string | null }>();
  for (const row of rows) {
    if (typeof row.team_id !== "number" || !Number.isSafeInteger(row.team_id)
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(row.match_id) || teams.size >= MAX_TEAM_LOOKUPS) continue;
    teams.set(row.match_id, {
      teamId: row.team_id,
      playerId: row.player_id,
      accountId: typeof row.account_id === "string" ? row.account_id : null,
    });
  }
  if (!teams.size) return result;

  const normPlatform = normalizePlatform(platform);
  const filter = [...teams].map(([matchId, team]) => `and(match_id.eq.${matchId},team_id.eq.${team.teamId})`).join(",");
  const [{ data, error }, privatePlayers] = await Promise.all([
    supabase.from("pubg_player_matches").select("match_id, team_id, player_id, account_id")
      .eq("platform", normPlatform).or(filter).limit(teams.size * 8),
    getPrivatePlayersList(supabase).catch(() => null),
  ]);
  if (error || !data || !privatePlayers) {
    if (error) console.error("[playerMatchTeammates] read failed:", error.message);
    return result;
  }

  for (const row of data as TeamLookupRow[]) {
    if (typeof row.match_id !== "string" || typeof row.player_id !== "string") continue;
    const team = teams.get(row.match_id);
    if (!team || row.team_id !== team.teamId) continue;
    const accountId = typeof row.account_id === "string" ? row.account_id : undefined;
    if (row.player_id === team.playerId || (accountId && accountId === team.accountId)) continue;
    if (matchesPrivatePlayer(privatePlayers, normPlatform, row.player_id, accountId)) continue;
    const names = result.get(row.match_id) ?? [];
    if (names.length < MAX_TEAMMATES && !names.includes(row.player_id)) names.push(row.player_id);
    result.set(row.match_id, names);
  }
  for (const names of result.values()) names.sort();
  return result;
}
