// 최근 요약 토론 카드에 붙이는 경기 장면 근거. 판정 방향과 맞고 기록으로 확실한 장면만 서버가 고른다.
// 모델은 장면을 고르거나 문장을 쓰지 않는다. 맞는 장면이 없으면 카드는 지표만으로 판단한다.
import type { MatchFight } from "./matchReport";
import { formatMatchClock } from "./matchReportView";
import type { SummaryCard, SummaryTopicId } from "./aiSummaryCards";

export interface SummaryCardScene {
  matchId: string;
  clock: string;
  text: string;
}

type SceneMatch = {
  matchId?: unknown;
  mapName?: unknown;
  matchReport?: { fights?: unknown };
  timeline?: unknown;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function fightsOf(match: SceneMatch): MatchFight[] {
  const fights = match.matchReport?.fights;
  return Array.isArray(fights) ? fights.filter((fight): fight is MatchFight =>
    !!fight && finite(fight.startMs) && finite(fight.enemyDowns) && finite(fight.teamDowns)
    && (fight.openedBy === "us" || fight.openedBy === "them") && typeof fight.outcome === "string") : [];
}

function matchLabel(match: SceneMatch): string {
  return typeof match.mapName === "string" && match.mapName.trim() ? `${match.mapName.trim()} 경기` : "한 경기";
}

type Candidate = { match: SceneMatch; ms: number; weight: number; describe: (clock: string) => string };

function best(candidates: Candidate[]): SummaryCardScene | null {
  // 가장 뚜렷한 장면 하나. 같으면 앞 경기·이른 시각을 써서 같은 입력에 같은 장면이 나온다.
  const chosen = candidates.reduce<Candidate | null>((top, item) => !top || item.weight > top.weight ? item : top, null);
  if (!chosen || typeof chosen.match.matchId !== "string") return null;
  const clock = formatMatchClock(chosen.ms);
  return { matchId: chosen.match.matchId, clock, text: `${matchLabel(chosen.match)} ${clock}${chosen.describe(clock)}` };
}

/**
 * 주제와 승자에 맞는 장면 하나. 지원하는 주제만 고른다.
 * - 교전 주도권: 매운맛 승이면 상대가 먼저 쏴 우리 팀만 쓰러진 교전, 다정 승이면 우리가 먼저 쏴 적만 쓰러진 교전.
 * - 생존 운영: 매운맛 승이면 가장 이른 내 사망.
 */
export function pickSummaryCardScene(topicId: SummaryTopicId, winner: SummaryCard["winner"], matches: readonly unknown[]): SummaryCardScene | null {
  if (winner !== "kind" && winner !== "spicy") return null;
  const list = matches.filter((match): match is SceneMatch => !!match && typeof match === "object");
  if (topicId === "initiative") {
    const wanted = winner === "spicy" ? { openedBy: "them", outcome: "lost" } : { openedBy: "us", outcome: "won" };
    return best(list.flatMap((match) => fightsOf(match)
      .filter((fight) => fight.openedBy === wanted.openedBy && fight.outcome === wanted.outcome)
      .map((fight) => winner === "spicy"
        ? { match, ms: fight.startMs, weight: fight.teamDowns, describe: () => ` 교전: 상대가 먼저 쏴서 우리 팀만 ${fight.teamDowns}명 쓰러졌습니다.` }
        : { match, ms: fight.startMs, weight: fight.enemyDowns, describe: () => ` 교전: 우리가 먼저 쏴서 적 ${fight.enemyDowns}명을 쓰러뜨렸습니다.` })
      .filter((candidate) => candidate.weight > 0)));
  }
  if (topicId === "survival" && winner === "spicy") {
    return best(list.flatMap((match) => {
      const timeline = Array.isArray(match.timeline) ? match.timeline : [];
      const death = timeline.find((event) => event?.type === "DIED" && finite(event?.ts));
      // 이른 사망일수록 뚜렷하므로 시각의 음수를 가중치로 쓴다.
      return death ? [{ match, ms: death.ts as number, weight: -(death.ts as number), describe: () => "에 쓰러져 경기가 끝났습니다." }] : [];
    }));
  }
  return null;
}
