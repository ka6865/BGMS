// 경기 참가자 중 봇(AI) 비율 계산. PUBG는 봇 참가자의 playerId를 "ai."로 시작하게 기록한다.
import { normalizeName } from "./utils";

export type BotShareLevel = "none" | "few" | "some" | "many" | "mostly";

export type BotShare = {
  botCount: number;
  humanCount: number;
  /** 봇 비율 0~100(반올림). */
  percent: number;
  level: BotShareLevel;
};

type ParticipantLike = {
  attributes?: { accountId?: unknown; stats?: { playerId?: unknown } | null } | null;
} | null | undefined;

/** 참가자가 봇인지 판정한다. stats.playerId를 우선하고 없으면 accountId를 본다. */
export function isBotParticipant(participant: ParticipantLike): boolean {
  const id = participant?.attributes?.stats?.playerId ?? participant?.attributes?.accountId;
  return typeof id === "string" && id.startsWith("ai.");
}

type DamageParticipant = ParticipantLike & { attributes?: { stats?: { name?: unknown; damageDealt?: unknown } | null } | null };

/**
 * 봇을 뺀 참가자 중 내 딜량 순위 비율(1/사람 수 ~ 1). 경기 등급과 "딜량 상위 %"에 쓴다.
 * 내 기록을 찾지 못하면 가장 낮은 비율(1)로 둔다.
 */
export function humanDamageRankPct(participants: readonly DamageParticipant[] | null | undefined, lowerNickname: string): number {
  const humans = (Array.isArray(participants) ? participants : []).filter((participant) => !isBotParticipant(participant));
  if (humans.length === 0) return 1;
  const damage = (participant: DamageParticipant) => {
    const value = participant?.attributes?.stats?.damageDealt;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const sorted = [...humans].sort((a, b) => damage(b) - damage(a));
  const rank = sorted.findIndex((participant) => {
    const name = participant?.attributes?.stats?.name;
    return typeof name === "string" && normalizeName(name) === lowerNickname;
  }) + 1;
  return rank > 0 ? rank / humans.length : 1;
}

export function countBotParticipants(participants: readonly ParticipantLike[] | null | undefined): number {
  return Array.isArray(participants) ? participants.filter(isBotParticipant).length : 0;
}

function levelOf(percent: number): BotShareLevel {
  if (percent < 5) return "none";
  if (percent < 25) return "few";
  if (percent < 50) return "some";
  if (percent < 75) return "many";
  return "mostly";
}

export const BOT_SHARE_LEVEL_LABELS: Record<BotShareLevel, string> = {
  none: "봇 거의 없음",
  few: "봇 적음",
  some: "봇 보통",
  many: "봇 많음",
  mostly: "봇 대부분",
};

/** 전체 인원과 봇 수로 비율을 만든다. 값이 없거나 맞지 않으면 null. */
export function buildBotShare(totalPlayers: unknown, botCount: unknown): BotShare | null {
  if (!Number.isInteger(totalPlayers) || !Number.isInteger(botCount)) return null;
  const total = totalPlayers as number;
  const bots = botCount as number;
  if (total < 1 || bots < 0 || bots > total) return null;
  const percent = Math.round((bots / total) * 100);
  return { botCount: bots, humanCount: total - bots, percent, level: levelOf(percent) };
}
