export type EncounterProfile = {
  retryAt?: string | null;
  seasonId: string | null; tier: string | null; averageDamage: number | null; rounds: number | null;
  checkedAt: string | null; rankedCheckedAt: string | null; pending: boolean; gameMode:string; matchType:string;
};
const TIERS:Record<string,string>={Bronze:'브론즈',Silver:'실버',Gold:'골드',Platinum:'플래티넘',Diamond:'다이아몬드',Master:'마스터',Survivor:'서바이버'};
export function summarizeEncounterProfile(seasonId:string|null,gameMode:string,matchType:string,normal:any,ranked:any):EncounterProfile {
  const source=matchType==='competitive'?ranked:normal;
  const mode=source?.stats?.[gameMode];
  const rounds=typeof mode?.roundsPlayed==='number' && Number.isFinite(mode.roundsPlayed) && mode.roundsPlayed>=0?mode.roundsPlayed:null;
  const damage=typeof mode?.damageDealt==='number' && Number.isFinite(mode.damageDealt) && mode.damageDealt>=0?mode.damageDealt:null;
  const tier=ranked?.stats?.[gameMode]?.currentTier;
  return {seasonId,gameMode,matchType,rounds,
    averageDamage:rounds!==null && rounds>0 && damage!==null?Math.round(damage/rounds):null,
    tier:typeof tier?.tier==='string' && tier.tier && tier.tier!=='Unranked'?`${TIERS[tier.tier]||tier.tier}${tier.subTier?` ${tier.subTier}`:''}`:null,
    checkedAt:source?.checked_at||null,rankedCheckedAt:ranked?.checked_at||null,
    pending:!source?.checked_at || !ranked?.checked_at};
}
