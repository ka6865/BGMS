import { describe, expect, it } from "vitest";
import { collectMatchPlayerNames } from "@/lib/replay/replayInterpolation";
import { ENEMY_TEAM_COLORS, enemyTeamColor } from "@/lib/replay/squadColors";

describe("리플레이 실제 참가자", () => {
  it("경기 시작 뒤 위치가 있는 선수만 참가자로 본다", () => {
    const names = collectMatchPlayerNames([
      { type: "position", name: "Lobby_Leaver", relativeTimeMs: -66_000, x: 1, y: 1 },
      { type: "position", name: "Player", relativeTimeMs: -10_000, x: 1, y: 1 },
      { type: "position", name: "Player", relativeTimeMs: 5_000, x: 2, y: 2 },
      { type: "kill", attacker: "환경/자연사", victim: "Player", relativeTimeMs: 9_000 },
      { type: "groggy", name: "Unknown", relativeTimeMs: 9_000 },
    ]);
    expect([...names]).toEqual(["player"]);
  });
});

describe("적 팀 색", () => {
  it("팀 번호로 정해져 화면과 등장 순서에 관계없이 같다", () => {
    expect(enemyTeamColor(1)).toBe(ENEMY_TEAM_COLORS[1]);
    expect(enemyTeamColor(1 + ENEMY_TEAM_COLORS.length)).toBe(ENEMY_TEAM_COLORS[1]);
    expect(enemyTeamColor(undefined)).toBe(ENEMY_TEAM_COLORS[0]);
    expect(enemyTeamColor(-3)).toBe(ENEMY_TEAM_COLORS[3]);
  });
});
