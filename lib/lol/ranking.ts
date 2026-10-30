import { createHmac } from "node:crypto";

// 랭킹·장인 게시의 순수 로직. 네트워크와 DB를 쓰지 않으므로 수집기와 화면이 함께 쓴다.
// 장인은 D안이다: 이번 시즌 솔로 랭크에서 챔피언 15판 이상, 승률 50% 이상인 명단 대상자만 올리고 판수 내림차순으로 정렬한다.
// 공개 게시본에는 PUUID와 HMAC 같은 키를 넣지 않는다.

export const RANKING_QUEUE = "RANKED_SOLO_5x5" as const;
export const RANKING_TIERS = ["CHALLENGER", "GRANDMASTER"] as const;
export type RankingTier = (typeof RANKING_TIERS)[number];
export const RANKING_BOARD = "solo_apex" as const;
export const RANKING_MAX_ROWS = 1000;
export const PUBLISH_MIN_RATIO = 0.95;
export const RANKING_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 - 1;
export const RANKING_HMAC_MIN_KEY_LENGTH = 32;
export const MASTER_MIN_GAMES = 15;
export const MASTER_MIN_WIN_RATE = 50;
export const MASTER_ROW_LIMIT = 50;
export const MATCH_QUEUE_ID = 420;
export const MATCH_MIN_DURATION_SECONDS = 300;

const TIER_ORDER: Record<RankingTier, number> = { CHALLENGER: 0, GRANDMASTER: 1 };
const puuidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hexHmacPattern = /^[0-9a-f]{64}$/;
const seasonKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

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
};

export type SeasonCursor = { ms: number; ids: string[] };
// 경기 하나에서 대상 계정 한 명에 대해 뽑은 결과. counted가 false면 판수에 세지 않지만 커서 진행에는 쓴다.
export type MatchCore = { matchId: string; startMs: number; counted: boolean; championId: number; win: boolean };
export type ChampionCount = { games: number; wins: number };

export type MasterEntryInput = {
  gameName: string; tagLine: string; tier: RankingTier; leaguePoints: number;
  champions: Map<number, ChampionCount>;
};
export type MasterRow = { rank: number; riot_id: string; tier: RankingTier; league_points: number; games: number; wins: number };
export type MasterBoardChampion = { champion_id: number; eligible_count: number; rows: MasterRow[] };

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

export function normalizeRiotIdForKey(gameName: string, tagLine: string): string {
  return `${gameName.normalize("NFC").trim().toLocaleLowerCase("ko-KR")}#${tagLine.normalize("NFC").trim().toLocaleLowerCase("ko-KR")}`;
}

function assertSecret(secret: string): void {
  if (secret.length < RANKING_HMAC_MIN_KEY_LENGTH) throw new RankingValidationError("제외 목록 키가 너무 짧습니다.");
}

// 삭제 요청 제외 목록의 키. Riot ID 기준이라 PUUID가 바뀌어도 제외가 유지된다.
export function riotIdHmac(gameName: string, tagLine: string, secret: string): string {
  assertSecret(secret);
  return createHmac("sha256", secret).update(normalizeRiotIdForKey(gameName, tagLine)).digest("hex");
}

// 시즌 누적 작업 테이블의 계정 키. PUUID 원문 대신 서버 비밀로 만든 값을 저장한다.
export function accountHmac(puuid: string, secret: string): string {
  assertSecret(secret);
  return createHmac("sha256", secret).update(`puuid:${puuid}`).digest("hex");
}

export function isRankingHmac(value: unknown): value is string {
  return typeof value === "string" && hexHmacPattern.test(value);
}

// 삭제 요청 계정을 뺀다. 제외 키를 계산할 수 없는 값은 빼지 않고 그대로 둔다.
export function excludeResolved<T extends { gameName: string; tagLine: string }>(
  entries: T[], secret: string, excluded: ReadonlySet<string>,
): { kept: T[]; removed: number } {
  const kept = entries.filter(entry => !excluded.has(riotIdHmac(entry.gameName, entry.tagLine, secret)));
  return { kept, removed: entries.length - kept.length };
}

// 해석된 명단을 공식 순서(티어, LP 내림차순, 같은 LP는 Riot ID)로 정렬해 공개 행을 만든다.
export function toRankingRows(entries: ResolvedRankingEntry[]): RankingRow[] {
  const sorted = [...entries].sort((a, b) => {
    const riotA = normalizeRiotIdForKey(a.gameName, a.tagLine);
    const riotB = normalizeRiotIdForKey(b.gameName, b.tagLine);
    return TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.leaguePoints - a.leaguePoints || (riotA < riotB ? -1 : riotA > riotB ? 1 : 0);
  });
  return sorted.map((entry, index) => ({
    rank: index + 1,
    riot_id: formatRiotId(entry.gameName, entry.tagLine),
    tier: entry.tier,
    league_points: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
  }));
}

// 시즌 시작 시각(ISO)을 검증해 시즌 키와 밀리초를 돌려준다. 값이 없거나 형식이 다르면 실패한다.
export function parseSeasonStart(value: string | undefined): { iso: string; key: string; startMs: number } {
  if (!value || !value.trim()) throw new RankingValidationError("LOL_SEASON_START(시즌 시작 시각)가 필요합니다.");
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new RankingValidationError("LOL_SEASON_START는 ISO 8601 시각이어야 합니다.");
  }
  const startMs = Date.parse(trimmed);
  if (!Number.isFinite(startMs)) throw new RankingValidationError("LOL_SEASON_START를 해석할 수 없습니다.");
  // 시즌 키는 시작 시각을 KST 날짜로 바꾼 값이다. 같은 날짜에 시작하는 시즌은 같은 키로 본다.
  const kst = new Date(startMs + 9 * 3600_000).toISOString().slice(0, 10);
  if (!seasonKeyPattern.test(kst)) throw new RankingValidationError("시즌 키를 만들 수 없습니다.");
  return { iso: new Date(startMs).toISOString(), key: kst, startMs };
}

// 시즌 종료 시각(ISO). 장인 작업 데이터는 종료 후 30일에 지운다. 시작보다 늦어야 한다.
export function parseSeasonEnd(value: string | undefined, startMs: number): { iso: string } {
  if (!value || !value.trim()) throw new RankingValidationError("LOL_SEASON_END(시즌 종료 시각)가 필요합니다.");
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new RankingValidationError("LOL_SEASON_END는 ISO 8601 시각이어야 합니다.");
  }
  const endMs = Date.parse(trimmed);
  if (!Number.isFinite(endMs) || endMs <= startMs) throw new RankingValidationError("LOL_SEASON_END는 시즌 시작보다 늦어야 합니다.");
  return { iso: new Date(endMs).toISOString() };
}

// 경기 상세에서 대상 계정 한 명의 챔피언·승패를 뽑는다. 다른 참가자 정보는 결과에 넣지 않는다.
// 큐 420과 5분 이상 경기만 센다. 다시하기나 다른 큐는 커서만 넘기고 판수에서 뺀다.
export function extractMatchForAccount(detail: unknown, puuid: string, seasonStartMs: number): MatchCore | null {
  const match = detail as { metadata?: { matchId?: unknown }; info?: Record<string, unknown> } | null;
  const info = match?.info;
  if (!match || typeof match.metadata?.matchId !== "string" || !info) throw new RankingValidationError("경기 상세 형식을 확인할 수 없습니다.");
  const matchId = match.metadata.matchId;
  if (!isCount(info.gameStartTimestamp) || !isCount(info.queueId) || !isCount(info.gameDuration)) {
    throw new RankingValidationError("경기 상세의 시각, 큐, 길이 값이 올바르지 않습니다.");
  }
  const startMs = info.gameStartTimestamp;
  const participants = Array.isArray(info.participants) ? info.participants as Array<Record<string, unknown>> : [];
  const participant = participants.find(item => item && item.puuid === puuid);
  const qualifies = info.queueId === MATCH_QUEUE_ID && info.gameDuration >= MATCH_MIN_DURATION_SECONDS && startMs >= seasonStartMs;
  if (!participant) return { matchId, startMs, counted: false, championId: 0, win: false };
  if (!isCount(participant.championId, 100_000) || typeof participant.win !== "boolean") {
    throw new RankingValidationError("경기 참가자의 챔피언이나 승패 값이 올바르지 않습니다.");
  }
  return { matchId, startMs, counted: qualifies, championId: participant.championId, win: participant.win };
}

// 계정 한 명의 새 경기만 골라 판수를 더한다. 커서 이전이나 같은 시각의 이미 본 경기는 다시 세지 않는다.
// maxMatches만큼만 오래된 순서로 받아들여, 중간에 멈춰도 다음 실행이 빠진 경기부터 이어받는다.
export function planAccountUpdate(cursor: SeasonCursor | null, matches: MatchCore[], maxMatches: number): {
  accepted: MatchCore[]; deltas: Map<number, ChampionCount>; newCursor: SeasonCursor | null; remaining: number;
} {
  const seen = new Set<string>();
  const fresh = matches.filter(match => {
    if (seen.has(match.matchId)) return false;
    seen.add(match.matchId);
    if (!cursor) return true;
    if (match.startMs > cursor.ms) return true;
    return match.startMs === cursor.ms && !cursor.ids.includes(match.matchId);
  }).sort((a, b) => a.startMs - b.startMs || (a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0));
  const accepted = fresh.slice(0, Math.max(0, maxMatches));
  const deltas = new Map<number, ChampionCount>();
  for (const match of accepted) {
    if (!match.counted) continue;
    const current = deltas.get(match.championId) ?? { games: 0, wins: 0 };
    current.games += 1;
    if (match.win) current.wins += 1;
    deltas.set(match.championId, current);
  }
  let newCursor = cursor;
  if (accepted.length) {
    const lastMs = accepted[accepted.length - 1].startMs;
    const atLast = accepted.filter(match => match.startMs === lastMs).map(match => match.matchId);
    const previous = cursor && cursor.ms === lastMs ? cursor.ids : [];
    newCursor = { ms: lastMs, ids: [...new Set([...previous, ...atLast])] };
  }
  return { accepted, deltas, newCursor, remaining: fresh.length - accepted.length };
}

// 장인 자격과 정렬(D안). 판수 15 이상, 승률 50% 이상만 올리고, 판수 내림차순, 같으면 공식 티어·LP, 그다음 Riot ID.
export function isMasterEligible(count: ChampionCount): boolean {
  return count.games >= MASTER_MIN_GAMES && count.wins * 100 >= MASTER_MIN_WIN_RATE * count.games;
}

export function buildMasterBoard(players: MasterEntryInput[]): MasterBoardChampion[] {
  const byChampion = new Map<number, Array<{ entry: MasterEntryInput; count: ChampionCount }>>();
  for (const player of players) {
    for (const [championId, count] of player.champions) {
      if (!isMasterEligible(count)) continue;
      const list = byChampion.get(championId) ?? [];
      list.push({ entry: player, count });
      byChampion.set(championId, list);
    }
  }
  return [...byChampion.entries()].sort(([a], [b]) => a - b).map(([championId, list]) => {
    const sorted = [...list].sort((a, b) => b.count.games - a.count.games
      || TIER_ORDER[a.entry.tier] - TIER_ORDER[b.entry.tier]
      || b.entry.leaguePoints - a.entry.leaguePoints
      || (normalizeRiotIdForKey(a.entry.gameName, a.entry.tagLine) < normalizeRiotIdForKey(b.entry.gameName, b.entry.tagLine) ? -1 : 1));
    return {
      champion_id: championId,
      eligible_count: list.length,
      rows: sorted.slice(0, MASTER_ROW_LIMIT).map(({ entry, count }, index) => ({
        rank: index + 1,
        riot_id: formatRiotId(entry.gameName, entry.tagLine),
        tier: entry.tier,
        league_points: entry.leaguePoints,
        games: count.games,
        wins: count.wins,
      })),
    };
  });
}

export type PublishCounts = { candidates: number; resolved: number; payloadBytes: number };

// 명단 게시 조건. 하나라도 넘지 못하면 이전 명단 게시본을 유지한다.
export function evaluateRankingPublish(counts: PublishCounts): { publish: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (counts.candidates === 0) reasons.push("명단이 비어 있습니다.");
  if (counts.candidates > 0 && counts.resolved / counts.candidates < PUBLISH_MIN_RATIO) reasons.push("Riot ID 해석률이 기준(95%) 미만입니다.");
  if (counts.payloadBytes > RANKING_MAX_PAYLOAD_BYTES) reasons.push("게시본 크기가 상한을 넘습니다.");
  return { publish: reasons.length === 0, reasons };
}

export function lolMastersPublic(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOL_MASTERS_PUBLIC === "true";
}

// 공개 DTO. 명단 게시본에는 키가 없으므로 Riot ID와 공식 값만 남긴다.
export type LolRankingBoardRow = { rank: number; riotId: string; tier: RankingTier; leaguePoints: number; wins: number; losses: number };
export type LolRankingBoard = { rows: LolRankingBoardRow[]; playerCount: number; observedAt: string };
export type LolMasterRowView = { rank: number; riotId: string; tier: RankingTier; leaguePoints: number; games: number; wins: number };
export type LolMasterBoardView = {
  observedAt: string;
  season: string;
  coverage: number;
  playerCount: number;
  champions: Array<{ championId: number; eligibleCount: number; rows: LolMasterRowView[] }>;
};

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isTier(value: unknown): value is RankingTier {
  return value === "CHALLENGER" || value === "GRANDMASTER";
}

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
      if (!row || typeof row !== "object" || !isCount(row.rank, 1000) || !isText(row.riot_id, 3, 60) || !isTier(row.tier)
        || !isCount(row.league_points, 100_000) || !isCount(row.wins) || !isCount(row.losses)) {
        throw new RankingValidationError("랭킹 게시 행 형식을 확인할 수 없습니다.");
      }
      return { rank: row.rank, riotId: row.riot_id, tier: row.tier, leaguePoints: row.league_points, wins: row.wins, losses: row.losses };
    }),
  };
}

export function toPublicMasterBoard(raw: unknown): LolMasterBoardView | null {
  if (raw === null || raw === undefined) return null;
  const board = raw as { observedAt?: unknown; season?: unknown; coverage?: unknown; playerCount?: unknown; champions?: unknown };
  if (!isText(board.observedAt, 10, 40) || !isText(board.season, 10, 10) || !isCount(board.coverage, 100)
    || !isCount(board.playerCount, 100_000) || !Array.isArray(board.champions)) {
    throw new RankingValidationError("장인 게시본 형식을 확인할 수 없습니다.");
  }
  return {
    observedAt: board.observedAt,
    season: board.season,
    coverage: board.coverage,
    playerCount: board.playerCount,
    champions: board.champions.map((item: unknown) => {
      const champion = item as Record<string, unknown>;
      if (!champion || typeof champion !== "object" || !isCount(champion.championId, 100_000) || !isCount(champion.eligibleCount, 100_000)
        || !Array.isArray(champion.rows)) {
        throw new RankingValidationError("장인 챔피언 형식을 확인할 수 없습니다.");
      }
      return {
        championId: champion.championId,
        eligibleCount: champion.eligibleCount,
        rows: champion.rows.map((entry: unknown) => {
          const row = entry as Record<string, unknown>;
          if (!row || typeof row !== "object" || !isCount(row.rank, MASTER_ROW_LIMIT) || !isText(row.riot_id, 3, 60) || !isTier(row.tier)
            || !isCount(row.league_points, 100_000) || !isCount(row.games, 1_000_000) || !isCount(row.wins, 1_000_000)) {
            throw new RankingValidationError("장인 항목 형식을 확인할 수 없습니다.");
          }
          return { rank: row.rank, riotId: row.riot_id, tier: row.tier, leaguePoints: row.league_points, games: row.games, wins: row.wins };
        }),
      };
    }),
  };
}

// 시즌 누적 저장소 계약. 수집기와 영속성 계층이 같은 모양을 쓴다.
export type AccountState = {
  accountHmac: string; riotId: string; riotIdHmac: string; resolvedAt: string | null;
  cursor: SeasonCursor | null; checkedAt: string | null;
};

export type RankingStore = {
  getAccountStates(seasonKey: string, accountHmacs: string[]): Promise<AccountState[]>;
  upsertAccount(input: { seasonKey: string; accountHmac: string; riotIdHmac: string; riotId: string; tier: string;
    leaguePoints: number; resolvedAt: string | null; listedAt: string; seasonEnd: string }): Promise<void>;
  // 'stale'은 읽은 뒤 다른 실행이 커서를 바꾼 경우다. 이 계정은 이번 실행에서 건너뛴다.
  commitProgress(input: { seasonKey: string; accountHmac: string; expectedCursorMs: number | null; cursor: SeasonCursor | null;
    deltas: Array<{ championId: number; games: number; wins: number }>; checkedAt: string }): Promise<"ok" | "stale">;
  listChampionCounts(seasonKey: string, accountHmacs: string[]): Promise<Array<{ accountHmac: string; championId: number; games: number; wins: number }>>;
  excludedKeys(): Promise<string[]>;
  saveRankingPublication(input: { rows: unknown[]; playerCount: number; observedAt: string }): Promise<void>;
  saveMasterPublication(input: { seasonKey: string; coverage: number; playerCount: number;
    champions: MasterBoardChampion[]; observedAt: string }): Promise<void>;
  purgeExpiredSeasons(nowIso: string): Promise<number>;
};

