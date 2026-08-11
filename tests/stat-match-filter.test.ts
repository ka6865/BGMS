import { describe, expect, it } from "vitest";
import { classifyMatchMode, filterRenderableMatches } from "@/lib/stats/statsPageModel";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";

const matches: MatchSummaryData[] = [
  {
    matchId: "ranked-1",
    gameMode: "squad-fpp",
    matchType: "competitive",
    mapName: "Baltic_Main",
  },
  {
    matchId: "casual-1",
    gameMode: "squad",
    matchType: "airoyale",
    mapName: "Baltic_Main",
  },
  {
    matchId: "tdm-1",
    gameMode: "squad-fpp",
    matchType: "official",
    mapName: "PillarCompound_Main",
  },
  {
    matchId: "normal-1",
    gameMode: "duo",
    matchType: "official",
    mapName: "Desert_Main",
  },
  {
    matchId: "missing-1",
    gameMode: "squad-fpp",
    matchType: "competitive",
    mapName: "Baltic_Main",
  },
] as MatchSummaryData[];

describe("recent match classification and filtering", () => {
  it("treats competitive matchType as ranked even when gameMode has no ranked marker", () => {
    expect(classifyMatchMode({ gameMode: "squad-fpp", matchType: "competitive" })).toBe("ranked");
  });

  it("classifies airoyale and ai-match matchType as casual", () => {
    expect(classifyMatchMode({ gameMode: "squad", matchType: "airoyale" })).toBe("casual");
    expect(classifyMatchMode({ gameMode: "squad-ai", matchType: "official" })).toBe("casual");
  });

  it("uses known TDM map names when the game mode is recorded as a normal squad mode", () => {
    expect(classifyMatchMode({ gameMode: "tdm", matchType: "official" })).toBe("tdm");
    expect(classifyMatchMode({ gameMode: "squad-fpp", matchType: "official", mapName: "PillarCompound_Main" })).toBe("tdm");
  });

  it("filters by classified mode and never renders missing summaries", () => {
    expect(filterRenderableMatches(matches, ["missing-1"], "ranked").map((match) => match.matchId)).toEqual(["ranked-1"]);
    expect(filterRenderableMatches(matches, ["missing-1"], "tdm").map((match) => match.matchId)).toEqual(["tdm-1"]);
    expect(filterRenderableMatches(matches, ["missing-1"], "casual").map((match) => match.matchId)).toEqual(["casual-1"]);
    expect(filterRenderableMatches(matches, ["missing-1"], "normal").map((match) => match.matchId)).toEqual(["casual-1", "normal-1"]);
  });
});
