import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { LOL_STAT_POSITIONS, LOL_STAT_QUEUE, type LolChampionStatRow, type LolStatBuildKind, type LolStatPosition } from "./championStats";

export type LolStatPatch = { patch: string; matches: number; timelineMatches: number };
export type LolChampionStatsResult = { patch: string | null; patches: LolStatPatch[]; matches: number; rows: LolChampionStatRow[] };
export type LolChampionPositionStat = {
  team_position: LolStatPosition; games: number; wins: number; kills: number; deaths: number; assists: number;
  cs: number; gold: number; damage: number; duration_seconds: number; gd15_sum: number; gd15_count: number;
};
export type LolChampionDetailStats = {
  patch: string | null; patches: LolStatPatch[]; matches: number; timelineMatches: number; bans: number;
  positions: LolChampionPositionStat[];
  builds: Array<{ position: LolStatPosition; kind: LolStatBuildKind; value: string; games: number; wins: number }>;
  matchups: Array<{ position: LolStatPosition; opponent: number; games: number; wins: number; gd15Sum: number; gd15Count: number }>;
};

const timeout = () => AbortSignal.timeout(5000);
const num = (value: unknown) => typeof value === "number" ? value : Number(value) || 0;

async function getPatches(): Promise<LolStatPatch[]> {
  const { data, error } = await createServiceRoleSupabase().rpc("get_lol_stat_patches", { p_queue_id: LOL_STAT_QUEUE }).abortSignal(timeout());
  if (error) throw new Error("챔피언 통계를 불러오지 못했습니다.");
  return (data ?? []).map((row: { patch: string; matches: unknown; timeline_matches: unknown }) => ({
    patch: row.patch, matches: num(row.matches), timelineMatches: num(row.timeline_matches),
  }));
}

// 요청한 패치가 없으면 표본이 있는 가장 최신 패치를 쓴다.
function pickPatch(patches: LolStatPatch[], requested?: string) {
  return patches.find(item => item.patch === requested)?.patch ?? patches[0]?.patch ?? null;
}

export async function getLolChampionStats(tiers: readonly string[], requestedPatch?: string): Promise<LolChampionStatsResult> {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return { patch: null, patches: [], matches: 0, rows: [] };
  const patches = await getPatches();
  const patch = pickPatch(patches, requestedPatch);
  if (!patch) return { patch: null, patches, matches: 0, rows: [] };
  const { data, error } = await createServiceRoleSupabase().rpc("get_lol_champion_stats", {
    p_patch: patch, p_queue_id: LOL_STAT_QUEUE, p_tiers: [...tiers],
  }).abortSignal(timeout());
  if (error) throw new Error("챔피언 통계를 불러오지 못했습니다.");
  const rows: LolChampionStatRow[] = (data ?? []).filter((row: { team_position: string }) => LOL_STAT_POSITIONS.includes(row.team_position as LolStatPosition))
    .map((row: Record<string, unknown>) => ({
      team_position: row.team_position as LolStatPosition, champion_id: num(row.champion_id), games: num(row.games),
      wins: num(row.wins), bans: num(row.bans), matches: num(row.matches),
    }));
  return { patch, patches, matches: rows[0]?.matches ?? 0, rows };
}

export async function getLolChampionDetailStats(championId: number, tiers: readonly string[], requestedPatch?: string): Promise<LolChampionDetailStats> {
  const empty: LolChampionDetailStats = { patch: null, patches: [], matches: 0, timelineMatches: 0, bans: 0, positions: [], builds: [], matchups: [] };
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return empty;
  const patches = await getPatches();
  const patch = pickPatch(patches, requestedPatch);
  if (!patch) return { ...empty, patches };
  const { data, error } = await createServiceRoleSupabase().rpc("get_lol_champion_detail", {
    p_patch: patch, p_queue_id: LOL_STAT_QUEUE, p_tiers: [...tiers], p_champion_id: championId,
  }).abortSignal(timeout());
  if (error || !data || typeof data !== "object") throw new Error("챔피언 통계를 불러오지 못했습니다.");
  const raw = data as Record<string, any>;
  return {
    patch, patches, matches: num(raw.matches), timelineMatches: num(raw.timelineMatches), bans: num(raw.bans),
    positions: (Array.isArray(raw.positions) ? raw.positions : []).filter((row: any) => LOL_STAT_POSITIONS.includes(row?.team_position))
      .map((row: any) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === "team_position" ? value : num(value)])) as LolChampionPositionStat),
    builds: (Array.isArray(raw.builds) ? raw.builds : []).map((row: any) => ({ position: row.position, kind: row.kind, value: String(row.value), games: num(row.games), wins: num(row.wins) })),
    matchups: (Array.isArray(raw.matchups) ? raw.matchups : []).map((row: any) => ({
      position: row.position, opponent: num(row.opponent), games: num(row.games), wins: num(row.wins), gd15Sum: num(row.gd15Sum), gd15Count: num(row.gd15Count),
    })),
  };
}
