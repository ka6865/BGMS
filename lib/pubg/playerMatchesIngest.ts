import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { upsertPlayerMatches, type PlayerMatchRecord } from "./playerMatches";

export interface IngestParticipantInput {
  matchId: string;
  nickname: string;
  platform: string;
  createdAt: string;
  gameMode: string;
  mapName: string;
  kills: number;
  damage: number;
  winPlace: number;
}

export function buildPlayerMatchRecordFromParticipant(input: IngestParticipantInput): PlayerMatchRecord {
  return {
    player_id: normalizeName(input.nickname),
    platform: normalizePlatform(input.platform),
    match_id: input.matchId,
    played_at: input.createdAt,
    game_mode: input.gameMode,
    map_name: input.mapName,
    kills: input.kills,
    damage: Math.floor(input.damage),
    win_place: input.winPlace
  };
}

export async function fetchAndIngestBasicMatchSummary(
  supabase: SupabaseClient,
  matchId: string,
  nickname: string,
  platform: string,
  apiKey: string
): Promise<PlayerMatchRecord | null> {
  const normPlatform = normalizePlatform(platform);
  const playerId = normalizeName(nickname);

  try {
    const res = await fetch(
      `https://api.pubg.com/shards/${normPlatform}/matches/${matchId}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const matchAttr = data.data?.attributes || {};
    const participants = (data.included || []).filter((it: any) => it.type === "participant");

    const myParticipant = participants.find((p: any) => normalizeName(p.attributes?.stats?.name) === playerId);
    if (!myParticipant?.attributes?.stats) return null;

    const stats = myParticipant.attributes.stats;
    const record: PlayerMatchRecord = {
      player_id: playerId,
      platform: normPlatform,
      match_id: matchId,
      played_at: matchAttr.createdAt || new Date().toISOString(),
      game_mode: matchAttr.gameMode || "unknown",
      map_name: matchAttr.mapName || "unknown",
      kills: stats.kills || 0,
      damage: Math.floor(stats.damageDealt || 0),
      win_place: stats.winPlace || 99,
    };

    await upsertPlayerMatches(supabase, [record]);
    return record;
  } catch {
    return null;
  }
}
