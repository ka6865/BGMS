// Match-V5 timeline에서 아이템 구매 순서와 스킬 레벨업 순서만 뽑는다. PUUID 등 식별자는 결과에 담지 않는다.
export type LolBuildStep = { minute: number; items: number[] };
export type LolPlayerBuild = { teamId: number; championId: number; items: LolBuildStep[]; skills: number[] };
export type LolMatchBuild = { matchId: string; players: LolPlayerBuild[] };

const MAX_PURCHASES = 80;
const MAX_SKILL_LEVELS = 18;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseLolMatchBuild(timeline: unknown, match: unknown, matchId: string): LolMatchBuild {
  const info = object(object(timeline).info);
  const matchInfo = object(object(match).info);
  if (String(object(object(timeline).metadata).matchId ?? "") !== matchId || !Array.isArray(info.frames)
    || !Array.isArray(matchInfo.participants)) throw new Error("invalid timeline");
  const players = new Map<number, { teamId: number; championId: number; purchases: Array<{ itemId: number; at: number }>; skills: number[] }>();
  for (const value of matchInfo.participants) {
    const participant = object(value);
    const id = integer(participant.participantId);
    if (id !== null) players.set(id, { teamId: integer(participant.teamId) ?? 0, championId: integer(participant.championId) ?? 0, purchases: [], skills: [] });
  }
  const events = info.frames.flatMap((frame) => Array.isArray(object(frame).events) ? object(frame).events as unknown[] : [])
    .map(object).sort((a, b) => (integer(a.timestamp) ?? 0) - (integer(b.timestamp) ?? 0));
  for (const event of events) {
    const player = players.get(integer(event.participantId) ?? -1);
    if (!player) continue;
    const at = integer(event.timestamp) ?? 0;
    if (event.type === "ITEM_PURCHASED" && integer(event.itemId) && player.purchases.length < MAX_PURCHASES) {
      player.purchases.push({ itemId: integer(event.itemId)!, at });
    } else if (event.type === "ITEM_UNDO" && integer(event.beforeId) && !integer(event.afterId)) {
      // 구매 되돌리기는 같은 아이템의 마지막 구매를 지운다. 판매 되돌리기(beforeId 0)는 구매 순서에 영향이 없다.
      const index = player.purchases.map((purchase) => purchase.itemId).lastIndexOf(integer(event.beforeId)!);
      if (index >= 0) player.purchases.splice(index, 1);
    } else if (event.type === "SKILL_LEVEL_UP" && event.levelUpType === "NORMAL" && player.skills.length < MAX_SKILL_LEVELS) {
      const slot = integer(event.skillSlot);
      if (slot !== null && slot >= 1 && slot <= 4) player.skills.push(slot);
    }
  }
  return {
    matchId,
    players: [...players.values()].map((player) => {
      const items: LolBuildStep[] = [];
      for (const purchase of player.purchases) {
        const minute = Math.floor(purchase.at / 60_000);
        const last = items.at(-1);
        if (last?.minute === minute) last.items.push(purchase.itemId);
        else items.push({ minute, items: [purchase.itemId] });
      }
      return { teamId: player.teamId, championId: player.championId, items, skills: player.skills };
    }),
  };
}
