import { createHmac } from "node:crypto";

// 랭킹·장인 게시의 순수 로직. 네트워크와 DB를 쓰지 않으므로 수집기와 페이지가 함께 쓴다.
// 명단 응답의 puuid·wins·losses와 숙련도 필드는 공식 문서 확인 전이라 방어적으로 검사하고, 없으면 실패시킨다.

export const RANKING_QUEUE = "RANKED_SOLO_5x5" as const;
export const RANKING_TIERS = ["CHALLENGER", "GRANDMASTER"] as const;
export type RankingTier = (typeof RANKING_TIERS)[number];
export const RANKING_BOARD = "solo_apex" as const;
export const RANKING_MAX_ROWS = 1000;
export const MASTERY_TOP_COUNT = 10;
export const MASTERY_CHAMPION_LIMIT = 10;
export const MASTERY_SAMPLE_MIN = 3;
export const PUBLISH_MIN_RATIO = 0.95;
export const RANKING_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 - 1;
export const RANKING_HMAC_MIN_KEY_LENGTH = 32;

const TIER_ORDER: Record<RankingTier, number> = { CHALLENGER: 0, GRANDMASTER: 1 };
const puuidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hexHmacPattern = /^[0-9a-f]{64}$/;

export class RankingValidationError extends Error {
  constructor(message: string) { super(message); }
}

export type RankingEntry = { puuid: string; tier: RankingTier; leaguePoints: number; wins: number; losses: number };
export type ResolvedRankingEntry = RankingEntry & { gameName: string; tagLine: string };

export type RankingRow = {
  rank: number;
  riot_id: string;
  tier: RankingTier;
  league_points: number;
  wins: number;
  losses: number;
  riot_id_hmac: string;
};

export type MasteryEntry = { championId: number; championPoints: number; championLevel: number };
export type MasteryPlayer = { gameName: string; tagLine: string; riotIdHmac: string; masteries: MasteryEntry[] };
export type MasteryBoardEntry = { rank: number; riot_id: string; champion_points: number; champion_level: number; riot_id_hmac: string };
export type MasteryBoardChampion = {
  champion_id: number;
  status: "ok" | "insufficient";
  sample_size: number;
  entries: MasteryBoardEntry[];
};

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

// 명단 응답 한 티어를 검증한다. 형식이 하나라도 다르면 전체를 실패시켜 부분 게시를 막는다.
export function parseRankingLeague(raw: unknown, tier: RankingTier): RankingEntry[] {
  const league = raw as { queue?: unknown; tier?: unknown; entries?: unknown } | null;
  if (!league || typeof league !== "object" || league.queue !== RANKING_QUEUE || league.tier !== tier || !Array.isArray(league.entries)) {
    throw new RankingValidationError("랭크 명단 응답을 확인할 수 없습니다.");
  }
  if (league.entries.length > 150_000) throw new RankingValidationError("랭크 명단이 허용 크기를 넘었습니다.");
  return league.entries.map((entry: unknown) => {
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item !== "object") throw new RankingValidationError("랭크 명단 항목이 올바르지 않습니다.");
    if (typeof item.puuid !== "string" || !puuidPattern.test(item.puuid)) {
      throw new RankingValidationError("랭크 명단의 식별자 형식을 확인할 수 없습니다.");
    }
    if (!isCount(item.leaguePoints, 100_000) || !isCount(item.wins) || !isCount(item.losses)) {
      throw new RankingValidationError("랭크 명단의 LP 또는 승패 값이 올바르지 않습니다.");
    }
    return { puuid: item.puuid, tier, leaguePoints: item.leaguePoints, wins: item.wins, losses: item.losses };
  });
}

// 게시 대상 상한을 고른다. 챌린저를 먼저 두고 그랜드마스터는 LP가 높은 순서로 채운다.
export function selectRankingCandidates(entries: RankingEntry[], limit = RANKING_MAX_ROWS): RankingEntry[] {
  return [...entries]
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.leaguePoints - a.leaguePoints)
    .slice(0, limit);
}

export function formatRiotId(gameName: string, tagLine: string): string {
  return `${gameName}#${tagLine}`;
}

// 같은 LP는 Riot ID(소문자)로 정렬해 게시마다 순서가 바뀌지 않게 한다.
function compareResolved(a: ResolvedRankingEntry, b: ResolvedRankingEntry): number {
  const riotA = formatRiotId(a.gameName, a.tagLine).toLocaleLowerCase("ko-KR");
  const riotB = formatRiotId(b.gameName, b.tagLine).toLocaleLowerCase("ko-KR");
  return TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.leaguePoints - a.leaguePoints || (riotA < riotB ? -1 : riotA > riotB ? 1 : 0);
}

export function normalizeRiotIdForKey(gameName: string, tagLine: string): string {
  return `${gameName.normalize("NFC").trim().toLocaleLowerCase("ko-KR")}#${tagLine.normalize("NFC").trim().toLocaleLowerCase("ko-KR")}`;
}

// 삭제 요청 제외 목록의 키. PUUID는 키 교체 때 바뀔 수 있으므로 Riot ID의 HMAC을 쓴다.
export function riotIdHmac(gameName: string, tagLine: string, secret: string): string {
  if (secret.length < RANKING_HMAC_MIN_KEY_LENGTH) throw new RankingValidationError("제외 목록 키가 너무 짧습니다.");
  return createHmac("sha256", secret).update(normalizeRiotIdForKey(gameName, tagLine)).digest("hex");
}

// 해석된 명단을 정렬하고 공개 행으로 바꾼다. PUUID는 행에 넣지 않는다.
export function toRankingRows(entries: ResolvedRankingEntry[], keyFor: (entry: ResolvedRankingEntry) => string): RankingRow[] {
  return [...entries].sort(compareResolved).map((entry, index) => ({
    rank: index + 1,
    riot_id: formatRiotId(entry.gameName, entry.tagLine),
    tier: entry.tier,
    league_points: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
    riot_id_hmac: keyFor(entry),
  }));
}

// 제외 목록에 있는 계정을 빼고 순위를 다시 매긴다. 빠진 수를 함께 돌려준다.
export function excludeRankingRows(rows: RankingRow[], excluded: ReadonlySet<string>): { rows: RankingRow[]; removed: number } {
  const kept = rows.filter(row => !excluded.has(row.riot_id_hmac));
  return { rows: kept.map((row, index) => ({ ...row, rank: index + 1 })), removed: rows.length - kept.length };
}

// 상위 N개 챔피언 숙련도 응답을 검증한다. 필드가 없으면 0으로 채우지 않고 실패시킨다.
export function parseMasteryTop(raw: unknown): MasteryEntry[] {
  if (!Array.isArray(raw) || raw.length > MASTERY_TOP_COUNT) throw new RankingValidationError("숙련도 응답을 확인할 수 없습니다.");
  const seen = new Set<number>();
  return raw.map((item: unknown) => {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || !isCount(row.championId) || row.championId === 0 || seen.has(row.championId)
      || !isCount(row.championPoints) || !isCount(row.championLevel, 1000)) {
      throw new RankingValidationError("숙련도 항목 값이 올바르지 않습니다.");
    }
    seen.add(row.championId);
    return { championId: row.championId, championPoints: row.championPoints, championLevel: row.championLevel };
  });
}

// 챔피언별 상위 10명을 만든다. 상위 10개 챔피언 안에 든 사람만 같은 챔피언 안에서 비교된다.
export function buildMasteryBoard(players: MasteryPlayer[]): MasteryBoardChampion[] {
  const byChampion = new Map<number, Array<{ player: MasteryPlayer; entry: MasteryEntry }>>();
  for (const player of players) {
    for (const entry of player.masteries.slice(0, MASTERY_CHAMPION_LIMIT)) {
      const list = byChampion.get(entry.championId) ?? [];
      list.push({ player, entry });
      byChampion.set(entry.championId, list);
    }
  }
  return [...byChampion.entries()].sort(([a], [b]) => a - b).map(([championId, list]) => {
    const sorted = [...list].sort((a, b) => b.entry.championPoints - a.entry.championPoints
      || normalizeRiotIdForKey(a.player.gameName, a.player.tagLine).localeCompare(normalizeRiotIdForKey(b.player.gameName, b.player.tagLine)));
    const top = sorted.slice(0, MASTERY_CHAMPION_LIMIT).map(({ player, entry }, index) => ({
      rank: index + 1,
      riot_id: formatRiotId(player.gameName, player.tagLine),
      champion_points: entry.championPoints,
      champion_level: entry.championLevel,
      riot_id_hmac: player.riotIdHmac,
    }));
    return {
      champion_id: championId,
      status: list.length >= MASTERY_SAMPLE_MIN ? "ok" : "insufficient",
      sample_size: list.length,
      entries: list.length >= MASTERY_SAMPLE_MIN ? top : [],
    };
  });
}

export type PublishCounts = {
  candidates: number;
  resolved: number;
  masteryCompleted: number;
  payloadBytes: number;
};

// 게시 조건. 하나라도 넘지 못하면 이전 게시본을 유지한다.
export function evaluateRankingPublish(counts: PublishCounts): { publish: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (counts.candidates === 0) reasons.push("명단이 비어 있습니다.");
  if (counts.candidates > 0 && counts.resolved / counts.candidates < PUBLISH_MIN_RATIO) reasons.push("Riot ID 해석률이 기준(95%) 미만입니다.");
  if (counts.resolved > 0 && counts.masteryCompleted / counts.resolved < PUBLISH_MIN_RATIO) reasons.push("숙련도 수집 완료율이 기준(95%) 미만입니다.");
  if (counts.payloadBytes > RANKING_MAX_PAYLOAD_BYTES) reasons.push("게시본 크기가 상한을 넘습니다.");
  return { publish: reasons.length === 0, reasons };
}

export function lolMastersPublic(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOL_MASTERS_PUBLIC === "true";
}

export function isRankingHmac(value: unknown): value is string {
  return typeof value === "string" && hexHmacPattern.test(value);
}

export type LolRankingBoardRow = { rank: number; riotId: string; tier: RankingTier; leaguePoints: number; wins: number; losses: number };
export type LolRankingBoard = { rows: LolRankingBoardRow[]; playerCount: number; observedAt: string };
export type LolMasteryBoardEntryView = { rank: number; riotId: string; points: number; level: number };
export type LolMasteryBoardView = {
  observedAt: string;
  playerCount: number;
  champions: Array<{ championId: number; status: "ok" | "insufficient"; sampleSize: number; entries: LolMasteryBoardEntryView[] }>;
};

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

// 게시본을 화면용 DTO로 바꾼다. riot_id_hmac은 여기서 떼어 화면과 응답에 나가지 않게 한다.
export function toPublicRankingBoard(raw: unknown): LolRankingBoard | null {
  if (raw === null || raw === undefined) return null;
  const board = raw as { payload?: unknown; playerCount?: unknown; observedAt?: unknown };
  if (!Array.isArray(board.payload) || !isCount(board.playerCount, 1000) || !isText(board.observedAt, 10, 40)) {
    throw new RankingValidationError("랭킹 게시본 형식을 확인할 수 없습니다.");
  }
  return {
    observedAt: board.observedAt,
    playerCount: board.playerCount,
    rows: board.payload.map((item: unknown) => {
      const row = item as Record<string, unknown>;
      if (!row || !isCount(row.rank, 1000) || !isText(row.riot_id, 3, 60)
        || (row.tier !== "CHALLENGER" && row.tier !== "GRANDMASTER") || !isCount(row.league_points, 100_000)
        || !isCount(row.wins) || !isCount(row.losses)) {
        throw new RankingValidationError("랭킹 게시 행 형식을 확인할 수 없습니다.");
      }
      return { rank: row.rank, riotId: row.riot_id, tier: row.tier, leaguePoints: row.league_points, wins: row.wins, losses: row.losses };
    }),
  };
}

export function toPublicMasteryBoard(raw: unknown): LolMasteryBoardView | null {
  if (raw === null || raw === undefined) return null;
  const board = raw as { observedAt?: unknown; playerCount?: unknown; champions?: unknown };
  if (!isText(board.observedAt, 10, 40) || !isCount(board.playerCount, 1000) || !Array.isArray(board.champions)) {
    throw new RankingValidationError("장인 게시본 형식을 확인할 수 없습니다.");
  }
  return {
    observedAt: board.observedAt,
    playerCount: board.playerCount,
    champions: board.champions.map((item: unknown) => {
      const champion = item as Record<string, unknown>;
      if (!champion || !isCount(champion.championId, 100_000) || (champion.status !== "ok" && champion.status !== "insufficient")
        || !isCount(champion.sampleSize, 1000) || !Array.isArray(champion.entries)) {
        throw new RankingValidationError("장인 챔피언 형식을 확인할 수 없습니다.");
      }
      return {
        championId: champion.championId,
        status: champion.status,
        sampleSize: champion.sampleSize,
        entries: champion.entries.map((entry: unknown) => {
          const row = entry as Record<string, unknown>;
          if (!row || !isCount(row.rank, 10) || !isText(row.riot_id, 3, 60) || !isCount(row.champion_points) || !isCount(row.champion_level, 1000)) {
            throw new RankingValidationError("장인 항목 형식을 확인할 수 없습니다.");
          }
          return { rank: row.rank, riotId: row.riot_id, points: row.champion_points, level: row.champion_level };
        }),
      };
    }),
  };
}
