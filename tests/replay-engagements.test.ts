import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectTeamEngagements,
  FIGHT_LEAD_IN_MS,
  findFightStarts,
  nextFightSeekMs,
  recentOpponents,
} from "@/lib/replay/replayEngagements";

const team = ["Me", "Mate"];

describe("리플레이 아군 교전", () => {
  it("아군이 공격자나 피해자인 피해·기절·처치만 모으고 상대 이름을 소문자로 남긴다", () => {
    const engagements = collectTeamEngagements([
      { type: "damage", relativeTimeMs: 5_000, attackerName: "Enemy", victimName: "mate" },
      { type: "damage", relativeTimeMs: 1_000, attackerName: "ME", victimName: "Enemy" },
      { type: "damage", relativeTimeMs: 2_000, attackerName: "Other", victimName: "Enemy" },
      { type: "groggy", relativeTimeMs: 6_000, attacker: "Me", victim: "Enemy2" },
      { type: "kill", relativeTimeMs: 7_000, attacker: "", victim: "Mate" },
      { type: "shot", relativeTimeMs: 8_000, name: "Me" },
    ], team);

    expect(engagements).toEqual([
      { timeMs: 1_000, opponent: "enemy" },
      { timeMs: 5_000, opponent: "enemy" },
      { timeMs: 6_000, opponent: "enemy2" },
      { timeMs: 7_000, opponent: null },
    ]);
  });

  it("30초 넘게 끊기면 다른 교전으로 나누고, 다음 교전은 시작 3초 전으로 이동한다", () => {
    const starts = findFightStarts([10_000, 20_000, 45_000, 90_000, 95_000].map((timeMs) => ({ timeMs, opponent: "e" })));

    expect(starts).toEqual([10_000, 90_000]);
    expect(nextFightSeekMs(starts, 0)).toBe(10_000 - FIGHT_LEAD_IN_MS);
    expect(nextFightSeekMs(starts, 7_000)).toBe(90_000 - FIGHT_LEAD_IN_MS);
    expect(nextFightSeekMs(starts, 50_000)).toBe(90_000 - FIGHT_LEAD_IN_MS);
    expect(nextFightSeekMs(starts, 87_000)).toBeNull();
  });

  it("최근 20초 안의 교전 상대만 이름 표시 대상으로 고른다", () => {
    const engagements = [
      { timeMs: 10_000, opponent: "old" },
      { timeMs: 25_000, opponent: "recent" },
      { timeMs: 30_000, opponent: null },
      { timeMs: 40_000, opponent: "future" },
    ];

    expect([...recentOpponents(engagements, 35_000)]).toEqual(["recent"]);
    expect([...recentOpponents(engagements, 5_000)]).toEqual([]);
  });

  it("실제 스쿼드 경기에서 교전을 여러 개로 나눈다", () => {
    const replay = JSON.parse(readFileSync("public/learn/replays/2026-09-22-squad.json", "utf8"));
    const engagements = collectTeamEngagements(replay.events, replay.teamNames);
    const starts = findFightStarts(engagements);

    expect(engagements.length).toBeGreaterThan(200);
    expect(starts.length).toBeGreaterThan(3);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
