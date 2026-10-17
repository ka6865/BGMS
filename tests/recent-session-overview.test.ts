import { describe, expect, it } from "vitest";
import { buildRecentSessionOverview } from "@/lib/stats/recentSessionOverview";
import { buildReplayShareUrl, isActivationTarget, isHelpKey, isTypingTarget, replayKeyAction } from "@/lib/replay/replayShortcuts";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";

const summary = (id: string, createdAt: string, kills: number, winPlace: number, damageDealt: number, teammateNames: string[] = []) => ({
  matchId: id,
  createdAt,
  gameMode: "squad-fpp",
  matchType: "official",
  mapName: "Baltic_Main",
  teammateNames,
  stats: { kills, winPlace, damageDealt },
}) as unknown as MatchSummaryData;

function input(rows: MatchSummaryData[]) {
  return {
    matchIds: rows.map((row) => row.matchId),
    summaries: Object.fromEntries(rows.map((row) => [row.matchId, row])),
    summaryStatus: "ready" as const,
  };
}

describe("최근 세션", () => {
  it("시작 간격이 60분을 넘으면 세션을 나누고 가장 최근 세션을 요약한다", () => {
    const session = buildRecentSessionOverview(input([
      summary("m5", "2026-10-16T13:40:00Z", 1, 12, 150, ["Mate", "Other"]),
      summary("m4", "2026-10-16T13:05:00Z", 4, 1, 420, ["Mate"]),
      summary("m3", "2026-10-16T12:30:00Z", 2, 5, 230, ["Mate", "Other"]),
      summary("m2", "2026-10-16T10:00:00Z", 6, 2, 600, ["Old"]),
      summary("m1", "2026-10-16T09:40:00Z", 0, 30, 10, ["Old"]),
    ]));
    expect(session).toEqual({
      startedAt: "2026-10-16T12:30:00Z",
      lastStartedAt: "2026-10-16T13:40:00Z",
      games: 3,
      wins: 1,
      kills: 7,
      averageDamage: 267,
      bestRank: 1,
      killsByMatch: [2, 4, 1],
      teammates: [{ name: "Mate", games: 3 }, { name: "Other", games: 2 }],
      sessionCount: 2,
    });
  });

  it("시각이 없는 경기만 있으면 카드를 숨긴다", () => {
    expect(buildRecentSessionOverview(input([summary("m1", "", 1, 3, 100)]))).toBeNull();
  });
});

describe("리플레이 단축키와 공유 링크", () => {
  it("스페이스는 재생 토글, 방향키는 5초(Shift 30초) 이동", () => {
    expect(replayKeyAction(" ", false)).toEqual({ kind: "toggle" });
    expect(replayKeyAction("ArrowRight", false)).toEqual({ kind: "seek", deltaMs: 5_000 });
    expect(replayKeyAction("ArrowLeft", true)).toEqual({ kind: "seek", deltaMs: -30_000 });
    expect(replayKeyAction("a", false)).toBeNull();
    expect(replayKeyAction("?", true)).toBeNull();
    expect(isHelpKey("?")).toBe(true);
    expect(isHelpKey("/")).toBe(false);
  });

  it("입력 칸과 버튼에서는 단축키가 기본 동작을 막지 않는다", () => {
    expect(isTypingTarget({ tagName: "select" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(isActivationTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(true);
    expect(isActivationTarget(null)).toBe(false);
  });

  it("공유 링크는 기존 쿼리를 유지하고 t(초)만 바꾼다", () => {
    expect(buildReplayShareUrl("https://example.test/maps/Erangel?playback=m1&nickname=A&t=3", 754_900))
      .toBe("https://example.test/maps/Erangel?playback=m1&nickname=A&t=754");
  });
});
