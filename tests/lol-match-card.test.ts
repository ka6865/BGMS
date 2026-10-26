import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LolMatchCard from "@/components/lol/LolMatchCard";
import { matches } from "./fixtures/lol/browserScenario";
import type { LolRecentMatch } from "@/lib/lol/riotSearch.server";
import { summarizeRecentMatches } from "@/lib/lol/summary";

const render = (match: (typeof matches)[number]) => renderToStaticMarkup(createElement(LolMatchCard, {
  match: match as LolRecentMatch, ownRiotId: "홍길동#KR1", expanded: false, onToggle: () => {}, onSearch: () => {},
}));

describe("전적 카드 결과 표시", () => {
  it("다시하기는 승패 대신 다시하기로 표시한다", () => {
    const html = render({ ...matches[0], win: false, remake: true });
    expect(html).toContain("다시하기");
    expect(html).not.toMatch(/>(승리|패배)</);
  });
  it("일반 경기는 승리·패배를 표시한다", () => {
    expect(render({ ...matches[0], win: true, remake: false })).toContain(">승리<");
    expect(render({ ...matches[0], win: false, remake: false })).toContain(">패배<");
  });
});

describe("함께 플레이한 소환사 집계", () => {
  it("우리 팀·상대 팀을 나눠 소환사 아이콘과 본인 기준 승패로 센다", () => {
    const ownTeam = matches[0].details!.teams[0];
    const own = ownTeam.participants[0].riotId;
    const withIcons = (matchId: string, win: boolean) => {
      const base = structuredClone(matches[0]) as LolRecentMatch;
      base.matchId = matchId; base.win = win;
      base.details!.teams.forEach((team) => team.participants.forEach((player, index) => {
        player.profileIconId = team.teamId + index;
        player.win = team.teamId === ownTeam.teamId ? win : !win;
      }));
      return base;
    };
    const enemyPrefix = matches[0].details!.teams[1].participants[0].riotId.slice(0, 3);
    const summary = summarizeRecentMatches([withIcons("KR_A", true), withIcons("KR_B", false)], own).all;
    expect(summary.teammates[0]).toMatchObject({ games: 2, wins: 1, losses: 1, profileIconId: expect.any(Number) });
    expect(summary.opponents?.[0]).toMatchObject({ games: 2, wins: 1, losses: 1 });
    expect(summary.opponents?.every((player) => player.riotId.startsWith(enemyPrefix))).toBe(true);
  });
});
