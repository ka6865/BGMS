import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { isPlayerMatchTeammateList } from "./playerMatchTeammateList";
import { getPrivatePlayersList, matchesPrivatePlayer } from "./privatePlayers";

const MAX_VISIBLE_TEAMMATES = 4;

/**
 * 검색한 플레이어 행에 저장된 팀원 목록에서 화면에 보여 줄 닉네임을 고른다.
 * 저장 이후 비공개를 신청한 팀원은 조회 시점의 비공개 목록(닉네임·계정 ID)으로 다시 거른다.
 * 비공개 목록을 읽지 못하면 팀원 표시만 생략하고 전적 응답은 그대로 둔다.
 */
export async function readTeammateNames(
  supabase: SupabaseClient,
  platform: string,
  rows: readonly { match_id: string; teammates?: unknown }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  try {
    const withTeammates = rows.filter(row => isPlayerMatchTeammateList(row.teammates) && row.teammates.length > 0);
    if (!withTeammates.length) return result;

    const privatePlayers = await getPrivatePlayersList(supabase).catch(() => null);
    if (!privatePlayers) return result;
    const normPlatform = normalizePlatform(platform);

    for (const row of withTeammates) {
      const names = (row.teammates as { name: string; account_id: string }[])
        .filter(teammate => !matchesPrivatePlayer(privatePlayers, normPlatform, teammate.name, teammate.account_id))
        .map(teammate => teammate.name)
        .slice(0, MAX_VISIBLE_TEAMMATES);
      if (names.length) result.set(row.match_id, names);
    }
  } catch (error) {
    // 팀원 표시는 부가 정보라 실패해도 전적 응답을 막지 않는다.
    console.error("[playerMatchTeammates] teammate filtering failed:", error instanceof Error ? error.message : error);
    result.clear();
  }
  return result;
}
