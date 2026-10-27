// 챔피언 통계 수집기가 경기 하나에서 뽑는 익명 기여분과 화면 계산. 서버·스크립트·테스트가 함께 쓴다.

export const LOL_STAT_TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"] as const;
export type LolStatTier = (typeof LOL_STAT_TIERS)[number];
export const LOL_STAT_POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
export type LolStatPosition = (typeof LOL_STAT_POSITIONS)[number];
export const LOL_STAT_QUEUE = 420;
export type LolStatBuildKind = "keystone" | "runes" | "spells" | "item" | "boots" | "start_items" | "core_items" | "skill_order";

export const LOL_STAT_POSITION_LABELS: Record<LolStatPosition, string> = {
  TOP: "탑", JUNGLE: "정글", MIDDLE: "미드", BOTTOM: "원딜", UTILITY: "서폿",
};
export const LOL_STAT_TIER_LABELS: Record<LolStatTier, string> = {
  IRON: "아이언", BRONZE: "브론즈", SILVER: "실버", GOLD: "골드", PLATINUM: "플래티넘", EMERALD: "에메랄드",
  DIAMOND: "다이아몬드", MASTER: "마스터", GRANDMASTER: "그랜드마스터", CHALLENGER: "챌린저",
};

// 화면의 티어 필터. "+"는 해당 티어 이상을 합친다.
export const LOL_STAT_TIER_FILTERS = [
  { id: "all", label: "모든 티어", tiers: [...LOL_STAT_TIERS] },
  { id: "emerald_plus", label: "에메랄드+", tiers: ["EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"] },
  { id: "diamond_plus", label: "다이아몬드+", tiers: ["DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"] },
  { id: "master_plus", label: "마스터+", tiers: ["MASTER", "GRANDMASTER", "CHALLENGER"] },
  ...LOL_STAT_TIERS.map(tier => ({ id: tier.toLowerCase(), label: LOL_STAT_TIER_LABELS[tier], tiers: [tier] })),
] as const satisfies ReadonlyArray<{ id: string; label: string; tiers: readonly LolStatTier[] }>;
export type LolStatTierFilterId = (typeof LOL_STAT_TIER_FILTERS)[number]["id"];
export const LOL_STAT_DEFAULT_TIER_FILTER: LolStatTierFilterId = "emerald_plus";
export function lolStatTierFilter(id: unknown) {
  return LOL_STAT_TIER_FILTERS.find(filter => filter.id === id) ?? LOL_STAT_TIER_FILTERS.find(filter => filter.id === LOL_STAT_DEFAULT_TIER_FILTER)!;
}

export type LolItemMeta = { final: boolean; boots: boolean; trinket: boolean };
export type LolItemCatalog = Record<number, LolItemMeta>;

// Data Dragon item.json으로 완성 아이템·신발을 구분한다. 상위 아이템이 상점에서 살 수 없는 강화형뿐이면 완성품으로 본다.
export function classifyLolItems(json: unknown): LolItemCatalog {
  const data = (json as { data?: Record<string, any> } | null)?.data;
  const catalog: LolItemCatalog = {};
  if (!data || typeof data !== "object") return catalog;
  const purchasable = (id: string) => data[id]?.gold?.purchasable !== false && data[id]?.inStore !== false;
  for (const [key, item] of Object.entries(data)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0 || !item || typeof item !== "object") continue;
    const tags: string[] = Array.isArray(item.tags) ? item.tags : [];
    const total = Number(item.gold?.total) || 0;
    const into: string[] = Array.isArray(item.into) ? item.into : [];
    const boots = tags.includes("Boots") && total >= 900;
    const trinket = tags.includes("Trinket");
    const final = !tags.includes("Boots") && !trinket && !tags.includes("Consumable") && purchasable(key)
      && total >= 2200 && into.every(next => !purchasable(next));
    catalog[id] = { final, boots, trinket };
  }
  return catalog;
}

export type LolStatPayload = {
  champions: Array<{ position: LolStatPosition; champion: number; win: boolean; kills: number; deaths: number; assists: number;
    cs: number; gold: number; damage: number; duration: number; gd15: number | null }>;
  bans: number[];
  builds: Array<{ position: LolStatPosition; champion: number; kind: LolStatBuildKind; value: string; win: boolean }>;
  matchups: Array<{ position: LolStatPosition; champion: number; opponent: number; win: boolean; gd15: number | null }>;
};
export type LolStatExtract =
  | { skipped: null; patch: string; queueId: number; hasTimeline: boolean; payload: LolStatPayload }
  | { skipped: "custom" | "remake" | "short" | "queue" | "invalid"; patch: null; queueId: number; hasTimeline: false; payload: null };

const int = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
const posInt = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const SKILL = ["", "Q", "W", "E", "R"];

function runePage(perks: any): { keystone: string; runes: string } | null {
  const [primary, sub] = Array.isArray(perks?.styles) ? perks.styles : [];
  const primaryPerks = Array.isArray(primary?.selections) ? primary.selections.map((item: any) => posInt(item?.perk)) : [];
  const subPerks = Array.isArray(sub?.selections) ? sub.selections.map((item: any) => posInt(item?.perk)) : [];
  const shards = [perks?.statPerks?.offense, perks?.statPerks?.flex, perks?.statPerks?.defense].map(posInt);
  if (!posInt(primary?.style) || !posInt(sub?.style) || primaryPerks.length !== 4 || subPerks.length !== 2
    || [...primaryPerks, ...subPerks, ...shards].some(value => value === null)) return null;
  return {
    keystone: String(primaryPerks[0]),
    runes: `${primary.style}:${primaryPerks.join(",")}|${sub.style}:${subPerks.join(",")}|${shards.join(",")}`,
  };
}

// timeline 이벤트에서 참가자별 구매 순서(되돌리기 반영)와 스킬 레벨업 순서를 만든다.
function timelineByParticipant(timeline: any) {
  const purchases = new Map<number, Array<{ id: number; at: number }>>();
  const skills = new Map<number, number[]>();
  const frames: any[] = Array.isArray(timeline?.info?.frames) ? timeline.info.frames : [];
  for (const frame of frames) {
    for (const event of Array.isArray(frame?.events) ? frame.events : []) {
      const participant = posInt(event?.participantId);
      if (!participant || participant > 10) continue;
      if (event.type === "ITEM_PURCHASED" && posInt(event.itemId)) {
        const list = purchases.get(participant) ?? [];
        list.push({ id: event.itemId, at: int(event.timestamp) });
        purchases.set(participant, list);
      } else if (event.type === "ITEM_UNDO" && posInt(event.beforeId)) {
        const list = purchases.get(participant) ?? [];
        const index = list.map(item => item.id).lastIndexOf(event.beforeId);
        if (index >= 0) list.splice(index, 1);
      } else if (event.type === "SKILL_LEVEL_UP" && event.levelUpType === "NORMAL" && [1, 2, 3, 4].includes(event.skillSlot)) {
        const list = skills.get(participant) ?? [];
        list.push(event.skillSlot);
        skills.set(participant, list);
      }
    }
  }
  const gold15 = new Map<number, number>();
  const frame15 = frames[15]?.participantFrames;
  if (frame15 && typeof frame15 === "object") {
    for (const [key, value] of Object.entries(frame15)) {
      const participant = Number(key);
      const gold = (value as any)?.totalGold;
      if (posInt(participant) && typeof gold === "number" && Number.isFinite(gold)) gold15.set(participant, gold);
    }
  }
  return { purchases, skills, gold15 };
}

// 마스터 순서: Q·W·E 중 5레벨을 먼저 찍은 순. 끝까지 못 찍은 스킬은 찍은 횟수가 많은 순으로 잇는다.
export function lolSkillOrder(slots: number[]): string | null {
  const counts = [0, 0, 0, 0, 0];
  const maxedAt: number[] = [];
  slots.forEach((slot, index) => {
    counts[slot] += 1;
    if (slot <= 3 && counts[slot] === 5) maxedAt[slot] = index;
  });
  if (slots.length < 9) return null;
  const order = [1, 2, 3].sort((a, b) => (maxedAt[a] ?? Infinity) - (maxedAt[b] ?? Infinity) || counts[b] - counts[a] || a - b);
  return order.map(slot => SKILL[slot]).join(">");
}

export function extractLolStatMatch(match: any, timeline: any | null, items: LolItemCatalog): LolStatExtract {
  const info = match?.info;
  const queueId = int(info?.queueId);
  const skip = (reason: Exclude<LolStatExtract["skipped"], null>): LolStatExtract => ({ skipped: reason, patch: null, queueId, hasTimeline: false, payload: null });
  if (!info || queueId === 0 || info.gameType === "CUSTOM_GAME") return skip("custom");
  if (queueId !== LOL_STAT_QUEUE) return skip("queue");
  const participants: any[] = Array.isArray(info.participants) ? info.participants : [];
  const patch = typeof info.gameVersion === "string" ? info.gameVersion.match(/^(\d{1,3}\.\d{1,3})(?:\.|$)/)?.[1] ?? null : null;
  const duration = int(info.gameDuration);
  if (participants.length !== 10 || !patch || participants.filter(p => p?.teamId === 100).length !== 5
    || participants.filter(p => p?.teamId === 200).length !== 5 || participants.some(p => !posInt(p?.championId) || typeof p?.win !== "boolean")) return skip("invalid");
  if (participants.some(p => p.gameEndedInEarlySurrender === true || p.teamEarlySurrendered === true)) return skip("remake");
  if (duration < 300) return skip("short");

  const hasTimeline = Array.isArray(timeline?.info?.frames) && timeline.info.frames.length > 0;
  const lines = hasTimeline ? timelineByParticipant(timeline) : null;
  const payload: LolStatPayload = { champions: [], bans: [], builds: [], matchups: [] };
  const bans = new Set<number>();
  for (const team of Array.isArray(info.teams) ? info.teams : []) {
    for (const ban of Array.isArray(team?.bans) ? team.bans : []) if (posInt(ban?.championId)) bans.add(ban.championId);
  }
  payload.bans = [...bans].sort((a, b) => a - b);

  // 라인 상대는 상대 팀에서 같은 포지션을 맡은 한 명이다. 포지션이 겹치거나 비면 상대 지표를 만들지 않는다.
  const byLane = new Map<string, any[]>();
  for (const p of participants) {
    if (!LOL_STAT_POSITIONS.includes(p.teamPosition)) continue;
    const key = `${p.teamId}:${p.teamPosition}`;
    byLane.set(key, [...(byLane.get(key) ?? []), p]);
  }
  const opponentOf = (p: any) => {
    const mine = byLane.get(`${p.teamId}:${p.teamPosition}`) ?? [];
    const theirs = byLane.get(`${p.teamId === 100 ? 200 : 100}:${p.teamPosition}`) ?? [];
    return mine.length === 1 && theirs.length === 1 ? theirs[0] : null;
  };

  for (const p of participants) {
    const position = p.teamPosition as LolStatPosition;
    if (!LOL_STAT_POSITIONS.includes(position)) continue;
    const champion: number = p.championId;
    const win: boolean = p.win;
    const opponent = opponentOf(p);
    const myGold = lines?.gold15.get(p.participantId);
    const theirGold = opponent ? lines?.gold15.get(opponent.participantId) : undefined;
    const gd15 = myGold !== undefined && theirGold !== undefined ? Math.round(myGold - theirGold) : null;
    payload.champions.push({
      position, champion, win, kills: int(p.kills), deaths: int(p.deaths), assists: int(p.assists),
      cs: int(p.totalMinionsKilled) + int(p.neutralMinionsKilled), gold: int(p.goldEarned), damage: int(p.totalDamageDealtToChampions),
      duration, gd15,
    });
    if (opponent) payload.matchups.push({ position, champion, opponent: opponent.championId, win, gd15 });
    const build = (kind: LolStatBuildKind, value: string | null) => { if (value) payload.builds.push({ position, champion, kind, value, win }); };
    const page = runePage(p.perks);
    build("keystone", page?.keystone ?? null);
    build("runes", page?.runes ?? null);
    const spells = [posInt(p.summoner1Id), posInt(p.summoner2Id)];
    build("spells", spells.every(Boolean) ? spells.sort((a, b) => a! - b!).join(",") : null);
    const inventory = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map(posInt).filter((id): id is number => id !== null);
    for (const id of new Set(inventory.filter(id => items[id]?.final))) build("item", String(id));
    build("boots", inventory.find(id => items[id]?.boots)?.toString() ?? null);
    if (lines) {
      const bought = lines.purchases.get(p.participantId) ?? [];
      const start = bought.filter(item => item.at <= 90_000 && !items[item.id]?.trinket).map(item => item.id).sort((a, b) => a - b);
      build("start_items", start.length && start.length <= 6 ? start.join("+") : null);
      const core = [...new Set(bought.map(item => item.id).filter(id => items[id]?.final))].slice(0, 3);
      build("core_items", core.length === 3 ? core.join(">") : null);
      build("skill_order", lolSkillOrder(lines.skills.get(p.participantId) ?? []));
    }
  }
  return { skipped: null, patch, queueId, hasTimeline, payload };
}

// 같은 경기 ID는 항상 같은 결정이 나오도록 해시로 timeline 호출 여부를 정한다.
export function lolStatWantsTimeline(matchId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  let hash = 2166136261;
  for (const char of matchId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % 10_000 < ratio * 10_000;
}

export type LolChampionStatRow = { team_position: LolStatPosition; champion_id: number; games: number; wins: number; bans: number; matches: number };
// 표본이 적은 칸은 수치 대신 "표본 부족"으로 보여 준다.
export const LOL_STAT_MIN_GAMES = 20;
export const lolRate = (part: number, whole: number) => whole > 0 ? part / whole : null;
