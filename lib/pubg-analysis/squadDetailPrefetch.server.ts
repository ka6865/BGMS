import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { MATCH_DETAIL_RETENTION_DAYS } from "@/lib/pubg-analysis/matchRetention";
import { normalizeName } from "@/lib/pubg-analysis/utils";

// 스쿼드 분석은 상세 분석 결과(processed_match_telemetry)만 읽는다. 상세 분석은 경기 카드를 펼칠 때만
// 만들어지므로, 펼쳐 보지 않은 최근 팀 경기는 스쿼드 그룹에 나타나지 않는다. 목록을 열 때 일부를 채운다.
export const SQUAD_DETAIL_PREFETCH_MAX_MATCHES = 4;
export const SQUAD_DETAIL_PREFETCH_CONCURRENCY = 2;
export const SQUAD_DETAIL_PREFETCH_TOTAL_MS = 16_000;
export const SQUAD_DETAIL_PREFETCH_MATCH_MS = 8_000;
const SQUAD_DETAIL_PREFETCH_COOLDOWN_MS = 10 * 60_000;
// 만료 직전 경기는 분석해도 곧 쓸 수 없으므로 보관 기간보다 하루 짧게 본다.
const PREFETCH_WINDOW_DAYS = MATCH_DETAIL_RETENTION_DAYS - 1;
const TEAM_MODES = ["duo", "duo-fpp", "squad", "squad-fpp"];

const recentPrefetches = new Map<string, number>();

export interface SquadDetailPrefetchResult {
  status: "skipped" | "done";
  reason?: "cooldown" | "no_candidates" | "read_failed";
  attempted: number;
  analyzed: number;
}

export interface SquadDetailPrefetchInput {
  supabase: SupabaseClient;
  nickname: string;
  platform: string;
  /** 상세 분석 한 경기를 요청한다. 성공하면 true. */
  analyzeMatch(matchId: string, signal: AbortSignal): Promise<boolean>;
  now?: number;
}

/** 최근 14일 안의 듀오·스쿼드 경기 중 상세 분석이 없는 것을 최신순으로 몇 경기 분석한다. */
export async function prefetchRecentTeamMatchDetails(input: SquadDetailPrefetchInput): Promise<SquadDetailPrefetchResult> {
  const now = input.now ?? Date.now();
  const playerId = normalizeName(input.nickname);
  const platform = normalizePlatform(input.platform);
  const key = `${platform}:${playerId}`;
  const last = recentPrefetches.get(key);
  if (last !== undefined && now - last < SQUAD_DETAIL_PREFETCH_COOLDOWN_MS) {
    return { status: "skipped", reason: "cooldown", attempted: 0, analyzed: 0 };
  }
  recentPrefetches.set(key, now);

  const since = new Date(now - PREFETCH_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: recent, error: recentError } = await input.supabase
    .from("pubg_player_matches")
    .select("match_id, played_at")
    .eq("platform", platform)
    .eq("player_id", playerId)
    .in("game_mode", TEAM_MODES)
    .gte("played_at", since)
    .order("played_at", { ascending: false })
    .limit(20);
  if (recentError) return { status: "skipped", reason: "read_failed", attempted: 0, analyzed: 0 };
  const recentIds = (recent ?? []).map(row => row.match_id).filter((id): id is string => typeof id === "string" && Boolean(id));
  if (!recentIds.length) return { status: "skipped", reason: "no_candidates", attempted: 0, analyzed: 0 };

  const { data: analyzed, error: analyzedError } = await input.supabase
    .from("processed_match_telemetry")
    .select("match_id")
    .eq("platform", platform)
    .eq("player_id", playerId)
    .in("match_id", recentIds);
  if (analyzedError) return { status: "skipped", reason: "read_failed", attempted: 0, analyzed: 0 };
  const analyzedIds = new Set((analyzed ?? []).map(row => row.match_id));
  const targets = recentIds.filter(id => !analyzedIds.has(id)).slice(0, SQUAD_DETAIL_PREFETCH_MAX_MATCHES);
  if (!targets.length) return { status: "skipped", reason: "no_candidates", attempted: 0, analyzed: 0 };

  const deadline = Date.now() + SQUAD_DETAIL_PREFETCH_TOTAL_MS;
  const queue = [...targets];
  let attempted = 0;
  let succeeded = 0;
  const worker = async () => {
    while (queue.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const matchId = queue.shift()!;
      attempted += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(SQUAD_DETAIL_PREFETCH_MATCH_MS, remaining));
      try {
        if (await input.analyzeMatch(matchId, controller.signal)) succeeded += 1;
      } catch {
        // 한 경기 실패는 다른 경기와 목록 응답을 막지 않는다.
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SQUAD_DETAIL_PREFETCH_CONCURRENCY, targets.length) }, worker));
  return { status: "done", attempted, analyzed: succeeded };
}

/** 테스트에서 쿨다운 상태를 비운다. */
export function resetSquadDetailPrefetchCooldown(): void {
  recentPrefetches.clear();
}
