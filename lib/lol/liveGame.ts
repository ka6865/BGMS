// 진행 중 경기(Spectator-V5) 조회의 순수 파서와 표시용 계산. 서버 서비스와 테스트가 함께 쓴다.
// 원문 필드를 그대로 저장하거나 공개하지 않는다. 호출 결과는 이 모듈이 만든 DTO만 화면으로 나간다.
import { LOL_STAT_MIN_GAMES, type LolChampionStatRow } from "./championStats";

export const LOL_LIVE_NOTICE = "진행 중 경기 정보는 Riot Spectator API 기준이며 지연될 수 있습니다.";
export const LOL_LIVE_CLASSIC_QUEUE = 420;
export const LOL_LIVE_QUEUE_LABELS: Readonly<Record<number, string>> = {
  400: "일반 드래프트", 420: "솔로 랭크", 430: "일반 블라인드", 440: "자유 랭크", 450: "칼바람", 490: "빠른 대전", 1700: "아레나", 2400: "아수라장",
};

export type LolLiveFailureKind = "rate_limited" | "key_or_permission" | "congested" | "timeout" | "upstream";
export type LolLiveTeamId = 100 | 200;

// 참가자 신원. puuid와 Riot ID가 모두 있고 형식이 맞을 때만 visible이다.
export type LolLiveIdentity =
  | { status: "visible"; riotId: string; puuid: string }
  | { status: "private" }
  | { status: "bot" };

export type LolLiveCurrentParticipant = {
  teamId: number;
  championId: number;
  spell1Id: number | null;
  spell2Id: number | null;
  perkIds: number[];
  perkStyle: number | null;
  perkSubStyle: number | null;
  identity: LolLiveIdentity;
};

export type LolLiveCurrentGame = {
  gameId: number | null;
  gameType: string;
  queueId: number;
  gameLengthSeconds: number | null;
  bans: Array<{ teamId: number; championId: number }>;
  participants: LolLiveCurrentParticipant[];
};

export type LolLiveSoloEntry = { tier: string; rank: string; leaguePoints: number; wins: number; losses: number };
export type LolLiveRank =
  | { status: "ranked"; tier: string; rank: string; leaguePoints: number; wins: number; losses: number; winRate: number | null }
  | { status: "unranked" }
  | { status: "hidden" }
  | { status: "failed"; reason: LolLiveFailureKind };

export type LolLiveChampionStat =
  | { status: "ok"; games: number; winRate: number | null; pickRate: number | null; banRate: number | null }
  | { status: "small_sample"; games: number; pickRate: number | null; banRate: number | null }
  | { status: "none" }
  | { status: "unavailable" }
  | { status: "not_applicable" };

export class LolLiveParseError extends Error {
  constructor() { super("live_game_contract"); }
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const positiveInt = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const nonNegativeInt = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Riot ID 입력 검증. 이름 1~64자, 태그 1~16자, 제어 문자와 추가 '#'을 허용하지 않는다.
export function parseLiveRiotIdText(value: unknown): { gameName: string; tagLine: string } | null {
  if (typeof value !== "string" || value.length > 140 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const separator = value.lastIndexOf("#");
  if (separator < 1) return null;
  const gameName = value.slice(0, separator).trim();
  const tagLine = value.slice(separator + 1).trim();
  if (!gameName || !tagLine || gameName.length > 64 || tagLine.length > 16 || gameName.includes("#")) return null;
  return { gameName, tagLine };
}

// 방어적 파서: 명세에 없거나 형식이 다른 필드는 익명 처리하고, 큰 구조가 깨졌을 때만 실패한다.
export function parseLiveCurrentGame(raw: unknown): LolLiveCurrentGame {
  if (!isRecord(raw) || !Array.isArray(raw.participants) || raw.participants.length > 20) throw new LolLiveParseError();
  const queueId = nonNegativeInt(raw.gameQueueConfigId);
  if (queueId === null) throw new LolLiveParseError();
  const length = nonNegativeInt(raw.gameLength);
  const bans = (Array.isArray(raw.bannedChampions) ? raw.bannedChampions : [])
    .map((ban: unknown) => isRecord(ban) ? { teamId: Number(ban.teamId), championId: positiveInt(ban.championId) } : null)
    .filter((ban): ban is { teamId: number; championId: number } => !!ban && ban.championId !== null && Number.isSafeInteger(ban.teamId))
    .map(ban => ({ teamId: ban.teamId, championId: ban.championId }));
  const participants = raw.participants.map((item: unknown): LolLiveCurrentParticipant | null => {
    if (!isRecord(item)) return null;
    const championId = positiveInt(item.championId);
    const teamId = Number(item.teamId);
    if (championId === null || !Number.isSafeInteger(teamId)) return null;
    const perk = isRecord(item.perks) ? item.perks : {};
    return {
      teamId,
      championId,
      spell1Id: positiveInt(item.spell1Id),
      spell2Id: positiveInt(item.spell2Id),
      perkIds: (Array.isArray(perk.perkIds) ? perk.perkIds : []).map(positiveInt).filter((id): id is number => id !== null),
      perkStyle: positiveInt(perk.perkStyle),
      perkSubStyle: positiveInt(perk.perkSubStyle),
      identity: liveIdentity(item),
    };
  });
  if (participants.some(item => item === null)) throw new LolLiveParseError();
  return {
    gameId: nonNegativeInt(raw.gameId),
    gameType: typeof raw.gameType === "string" ? raw.gameType.slice(0, 40) : "",
    queueId,
    gameLengthSeconds: length,
    bans,
    participants: participants as LolLiveCurrentParticipant[],
  };
}

// puuid가 null이거나 형식이 다르면 익명이다. Riot ID도 있어야 표시하며, 그 밖의 경로로 신원을 복원하지 않는다.
export function liveIdentity(item: Record<string, any>): LolLiveIdentity {
  if (item.bot === true) return { status: "bot" };
  const puuid = typeof item.puuid === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(item.puuid) ? item.puuid : null;
  const riotId = parseLiveRiotIdText(item.riotId);
  if (!puuid || !riotId) return { status: "private" };
  return { status: "visible", puuid, riotId: `${riotId.gameName}#${riotId.tagLine}` };
}

// 커스텀 게임(gameType CUSTOM_GAME 또는 queue 0)은 표시하지 않는다.
export function isUnsupportedLiveGame(game: Pick<LolLiveCurrentGame, "gameType" | "queueId">): boolean {
  return game.gameType === "CUSTOM_GAME" || game.queueId === 0;
}

// 솔로 랭크 항목만 고른다. 항목이 없으면 언랭크다.
export function pickLiveSoloEntry(raw: unknown): LolLiveSoloEntry | null | "invalid" {
  if (!Array.isArray(raw)) return "invalid";
  const entry = raw.find((item: any) => isRecord(item) && item.queueType === "RANKED_SOLO_5x5");
  if (!entry) return null;
  const leaguePoints = nonNegativeInt(entry.leaguePoints);
  const wins = nonNegativeInt(entry.wins);
  const losses = nonNegativeInt(entry.losses);
  if (leaguePoints === null || wins === null || losses === null || typeof entry.tier !== "string" || typeof entry.rank !== "string") return "invalid";
  return { tier: entry.tier.slice(0, 20), rank: entry.rank.slice(0, 4), leaguePoints, wins, losses };
}

export function liveWinRate(wins: number, losses: number): number | null {
  return wins + losses > 0 ? wins / (wins + losses) : null;
}

const rate = (part: number, whole: number) => whole > 0 ? part / whole : null;

// 챔피언 통계는 기존 lol_stat 집계를 그대로 쓴다. 포지션별 행을 합치고, 표본이 기준보다 적으면 승률을 감춘다.
export function liveChampionStat(championId: number, rows: readonly LolChampionStatRow[], matches: number): LolLiveChampionStat {
  const own = rows.filter(row => row.champion_id === championId);
  if (!own.length) return { status: "none" };
  const games = own.reduce((sum, row) => sum + row.games, 0);
  const wins = own.reduce((sum, row) => sum + row.wins, 0);
  const bans = Math.max(...own.map(row => row.bans));
  const pickRate = rate(games, matches);
  const banRate = rate(bans, matches);
  if (games < LOL_STAT_MIN_GAMES) return { status: "small_sample", games, pickRate, banRate };
  return { status: "ok", games, winRate: rate(wins, games), pickRate, banRate };
}

// 화면에 나가는 DTO. puuid와 원문 식별자는 포함하지 않는다.
export type LolLiveNamedImage = { name: string | null; iconUrl: string | null };
export type LolLiveParticipantView = {
  teamId: number;
  championId: number;
  championName: string | null;
  championIconUrl: string | null;
  spells: LolLiveNamedImage[];
  keystone: LolLiveNamedImage | null;
  primaryPath: LolLiveNamedImage | null;
  secondaryPath: LolLiveNamedImage | null;
  identity: { status: "visible"; riotId: string } | { status: "private" } | { status: "bot" };
  rank: LolLiveRank;
  champion: LolLiveChampionStat;
};
export type LolLiveGameView =
  | { status: "not_in_game"; riotId: string; lookedUpAt: string }
  | { status: "unsupported_mode"; riotId: string; lookedUpAt: string; queue: { id: number; label: string | null } }
  | {
    status: "ready";
    riotId: string;
    lookedUpAt: string;
    queue: { id: number; label: string | null };
    gameLengthSeconds: number | null;
    bans: Array<{ teamId: number; championId: number; championName: string | null; championIconUrl: string | null }>;
    participants: LolLiveParticipantView[];
    rankFailureCount: number;
    championStats: { status: "ok" | "unavailable" | "not_applicable"; patch: string | null; matches: number; tierFilter: string; tierLabel: string };
    notice: string;
  };

// 진행 중 경기 기능은 기본 비공개다. LOL_LIVE_ENABLED가 "true"일 때만 공개 경로와 진입점을 연다.
export function isLolLiveEnabled(): boolean {
  return process.env.LOL_LIVE_ENABLED === "true";
}
