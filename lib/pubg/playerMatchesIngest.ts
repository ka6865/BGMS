 import { normalizeName } from "@/lib/pubg-analysis/utils";
 import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
 import type { PlayerMatchRecord } from "./playerMatches";
 
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
