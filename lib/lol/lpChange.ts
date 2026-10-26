// 경기별 LP 증감 귀속.
// Riot API(Match-V5·League-V4)는 판별 LP 증감을 주지 않는다. BGMS가 검색·갱신 때 저장한 랭크 관측
// 두 개 사이에 그 큐의 경기가 정확히 한 판 있을 때만, 그 차이를 그 판의 변화로 본다.
// 근거가 부족한 판에는 값을 붙이지 않는다(화면은 기존 승리·패배 표시를 유지한다).

export type LolRankedObservation = {
  queueType: string;
  tier: string;
  rank: string;
  lp: number;
  wins: number;
  losses: number;
  recordedAt: string;
};

export type LolLpChange = { kind: "lp"; value: number } | { kind: "promotion" } | { kind: "demotion" };

export type LolLpGame = {
  matchId: string;
  queueId: number;
  gameEndTimestamp: number;
  win: boolean | null;
  remake: boolean;
};

const QUEUE_TYPES: Record<number, string> = { 420: "RANKED_SOLO_5x5", 440: "RANKED_FLEX_SR" };
const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
const DIVISIONS = ["IV", "III", "II", "I"];
// 마스터 이상은 디비전이 없어 같은 티어 안에서는 LP만 비교한다.
const APEX_FROM = TIERS.indexOf("MASTER");
// 한 판의 LP 변화로 보기 어려운 차이는 버린다(관측 오류·경기 밖 변화 방지).
const MAX_SINGLE_GAME_LP = 100;

function divisionPosition(observation: LolRankedObservation): number | null {
  const tier = TIERS.indexOf(observation.tier);
  if (tier < 0) return null;
  if (tier >= APEX_FROM) return APEX_FROM * 4 + (tier - APEX_FROM);
  const division = DIVISIONS.indexOf(observation.rank);
  return division < 0 ? null : tier * 4 + division;
}

function changeBetween(before: LolRankedObservation, after: LolRankedObservation, win: boolean): LolLpChange | null {
  const from = divisionPosition(before);
  const to = divisionPosition(after);
  if (from === null || to === null) return null;
  if (from === to) {
    const value = after.lp - before.lp;
    // 승리에 LP가 줄거나 패배에 LP가 늘면 경기 밖 변화가 섞인 것으로 보고 붙이지 않는다.
    if (Math.abs(value) > MAX_SINGLE_GAME_LP || (win && value < 0) || (!win && value > 0)) return null;
    return { kind: "lp", value };
  }
  if (to > from) return win ? { kind: "promotion" } : null;
  return win ? null : { kind: "demotion" };
}

export function attributeLolLpChanges(observations: LolRankedObservation[], games: LolLpGame[]): Map<string, LolLpChange> {
  const result = new Map<string, LolLpChange>();
  for (const [queueId, queueType] of Object.entries(QUEUE_TYPES)) {
    const series = observations
      .filter((row) => row.queueType === queueType && Number.isFinite(Date.parse(row.recordedAt)))
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    const queueGames = games.filter((game) => game.queueId === Number(queueId) && !game.remake);
    for (let index = 1; index < series.length; index += 1) {
      const before = series[index - 1];
      const after = series[index];
      const wins = after.wins - before.wins;
      const losses = after.losses - before.losses;
      // 판 수가 정확히 1 늘어야 한다. 시즌 초기화·배치처럼 기록이 줄거나 여러 판이면 판별 값을 알 수 없다.
      if (wins + losses !== 1 || wins < 0 || losses < 0) continue;
      const start = Date.parse(before.recordedAt);
      const end = Date.parse(after.recordedAt);
      const candidates = queueGames.filter((game) => game.gameEndTimestamp > start && game.gameEndTimestamp <= end);
      if (candidates.length !== 1) continue;
      const [game] = candidates;
      if (typeof game.win !== "boolean" || game.win !== (wins === 1)) continue;
      const change = changeBetween(before, after, game.win);
      if (change) result.set(game.matchId, change);
    }
  }
  return result;
}
