import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLolMatchInsights, summarizeLolRecentTrends } from "@/lib/lol/insights";
import { parseLolChallengeCatalog, buildLolChallengeProfile } from "@/lib/lol/challengeProfile";
import { LolChallengesCard, LolMatchInsightSection, LolRecentTrendsCard } from "@/components/lol/LolInsightCards";
import type { LolPlayerMatchSummary } from "@/lib/lol/types";
import { challengeFixture } from "./fixtures/lol/challenges";
import { challengeConfigFixture, challengePercentilesFixture, challengePlayerFixture } from "./fixtures/lol/challengeProfile";

const input = { challenges: challengeFixture, position: "MIDDLE", queueId: 420, duration: 1500, visionScore: 25, opponentVisionScore: 18 };
const row = (values: Partial<LolPlayerMatchSummary> = {}) => ({ duration_seconds: 1500, remake: false, win: true,
  queue_id: 420, team_position: "MIDDLE", vision_score: 25, challenges: { ...challengeFixture, laningPhaseGoldExpAdvantage: 1, teamDamagePercentage: 0.3 },
  ...values } as LolPlayerMatchSummary);

describe("라인전·기여 사실 지표", () => {
  it("본인 challenges와 같은 포지션 상대의 시야 점수만 선택한다", () => {
    const result = buildLolMatchInsights(input);
    expect(result.laning.find(item => item.label === "시야 점수 격차")?.value).toBe("+7");
    expect(result.laning.find(item => item.label === "최대 CS 우위")?.description).toContain(String(challengeFixture.maxCsAdvantageOnLaneOpponent));
    expect(result.contribution.find(item => item.label === "팀 내 피해 비중")?.value).toBe("31%");
    expect(JSON.stringify(result)).not.toMatch(/laningPhaseGoldExpAdvantage|teamDamagePercentage|unknownPatchKey/);
    expect(buildLolMatchInsights({ ...input, opponentVisionScore: undefined }).laning.some(item => item.label === "시야 점수 격차")).toBe(false);
    expect(buildLolMatchInsights({ ...input, opponentVisionScore: 25 }).laning.find(item => item.label === "시야 점수 격차")?.description).toContain("같습니다");
  });
  it("정글러는 상대 정글러와 정글 CS·상대 정글·바위게·초반 갱킹을 비교한다", () => {
    const result = buildLolMatchInsights({ ...input, position: "JUNGLE",
      challenges: { ...challengeFixture, enemyJungleMonsterKills: 27, scuttleCrabKills: 4, killsOnLanersEarlyJungleAsJungler: 2, buffsStolen: 5 },
      opponentChallenges: { jungleCsBefore10Minutes: 42, enemyJungleMonsterKills: 17, scuttleCrabKills: 3 } });
    expect(result.opponentLabel).toBe("상대 정글러");
    expect(result.laning.find(item => item.label === "10분 정글 CS")).toMatchObject({ mine: 12, theirs: 42 });
    expect(result.laning.find(item => item.label === "상대 정글 몬스터")).toMatchObject({ mine: 27, theirs: 17 });
    expect(result.laning.find(item => item.label === "초반 갱킹 처치")).toMatchObject({ mine: 2, theirs: undefined });
    expect(result.contribution.find(item => item.label === "버프 스틸")?.amount).toBe(5);
    expect(result.laning.some(item => item.label === "10분 라인 CS")).toBe(false);
    expect(buildLolMatchInsights(input).opponentLabel).toBeUndefined();
  });
  it("정글·서포터·칼바람의 무관한 항목과 10분 미만 10분 CS를 숨긴다", () => {
    expect(buildLolMatchInsights({ ...input, position: "JUNGLE" }).laning.map(item => item.label)).toEqual(
      ["라인전 골드·경험치", "초반 골드·경험치", "최대 CS 우위", "최대 레벨 우위", "10분 정글 CS", "시야 점수 격차"]);
    expect(buildLolMatchInsights({ ...input, position: "UTILITY" }).laning.map(item => item.label)).toEqual(["시야 점수 격차"]);
    const aram = buildLolMatchInsights({ ...input, queueId: 450 });
    expect(aram.laning).toEqual([]); expect(aram.contribution.some(item => item.label === "포탑 방패")).toBe(false);
    expect(buildLolMatchInsights({ ...input, duration: 599 }).laning.some(item => item.label === "10분 라인 CS")).toBe(false);
  });
  it.each([null, [], { teamDamagePercentage: 2, laningPhaseGoldExpAdvantage: -1, maxCsAdvantageOnLaneOpponent: NaN }])("부재·잘못된 숫자를 표시하지 않는다: %j", challenges => {
    expect(buildLolMatchInsights({ ...input, challenges, visionScore: undefined })).toEqual({ laning: [], contribution: [] });
  });
  it("다시하기·짧은 경기는 숨기며 0과 우위 미달성은 열세로 단정하지 않는다", () => {
    expect(buildLolMatchInsights({ ...input, remake: true })).toEqual({ laning: [], contribution: [] });
    expect(buildLolMatchInsights({ ...input, duration: 299 })).toEqual({ laning: [], contribution: [] });
    const result = buildLolMatchInsights({ ...input, challenges: { laningPhaseGoldExpAdvantage: 0, teamDamagePercentage: 0 }, visionScore: undefined });
    expect(result.laning[0].value).toBe("우위 미달성"); expect(result.contribution[0].value).toBe("0%");
  });
  it("경향은 지표별 3경기 이상·유효 경기·최근 100경기만 사용한다", () => {
    expect(summarizeLolRecentTrends([row(), row()])).toBeUndefined();
    const trends = summarizeLolRecentTrends([row(), row(), row({ challenges: { ...row().challenges, laningPhaseGoldExpAdvantage: 0 } }), row({ remake: true })]);
    expect(trends?.sampleSize).toBe(3);
    expect(trends?.metrics.find(item => item.label === "라인전 우위 경기")?.value).toBe("66.7%");
    expect(trends?.metrics.find(item => item.label === "평균 팀 피해 비중")?.value).toBe("30%");
    expect(summarizeLolRecentTrends(Array.from({ length: 105 }, () => row()))?.sampleSize).toBe(100);
    expect(summarizeLolRecentTrends([row(), row(), row({ challenges: {} })])).toBeUndefined();
  });
});

describe("도전과제 한국어·희귀도 DTO", () => {
  const catalog = parseLolChallengeCatalog(challengeConfigFixture, challengePercentilesFixture);
  it("공식 티어별 분포로 가장 희귀한 세 개를 선택하고 원문을 제거한다", () => {
    const result = buildLolChallengeProfile({ ...challengePlayerFixture, puuid: "fixture-private" }, catalog);
    expect(result.rarest.map(item => item.id)).toEqual([102, 104, 103]);
    expect(result.rarest[0]).toMatchObject({ percentile: 0.003, threshold: 100, name: "가상의 수호자" });
    expect(result.total).toEqual({ level: "GOLD", current: 1234, percentile: 0.08 });
    expect(result.categories.map(item => item.name)).toEqual(["전문성", "협동과 전략"]);
    expect(JSON.stringify(result)).not.toMatch(/puuid|fixture-private|fixture-title-id|preferences|challengeIds/);
  });
  it("중첩 시즌은 단일 시즌만 연결하고 복수 시즌·미제공 비율은 추정하지 않는다", () => {
    expect(parseLolChallengeCatalog(challengeConfigFixture, { "102": { "2026": { DIAMOND: 0.003 } } })[1].percentiles).toEqual({ DIAMOND: 0.003 });
    const ambiguous = parseLolChallengeCatalog(challengeConfigFixture, { "102": { "2025": { DIAMOND: 0.01 }, "2026": { DIAMOND: 0.003 } } });
    expect(buildLolChallengeProfile(challengePlayerFixture, ambiguous).rarest).toEqual([]);
    expect(buildLolChallengeProfile(challengePlayerFixture).distributionStatus).toBe("unavailable");
  });
  it("등급 누락·숫자 문자열·NaN·범위 밖 비율·비공개 도전과제를 제외한다", () => {
    expect(() => buildLolChallengeProfile({})).toThrow(); expect(() => parseLolChallengeCatalog({}, {})).toThrow();
    expect(() => parseLolChallengeCatalog(Array(2001).fill({}), {})).toThrow();
    expect(parseLolChallengeCatalog([{ ...challengeConfigFixture[0], state: "HIDDEN" }], {})).toEqual([]);
    const invalid = parseLolChallengeCatalog(challengeConfigFixture, { "101": { GOLD: "0.1" }, "102": { DIAMOND: 1.1 }, "103": { SILVER: NaN } });
    expect(buildLolChallengeProfile(challengePlayerFixture, invalid).rarest).toEqual([]);
    expect(buildLolChallengeProfile({ ...challengePlayerFixture, totalPoints: { level: "GOLD", current: 1, precentile: 0.5 } }).total?.percentile).toBe(0.5);
  });
  it("본인 비율·순위를 우선 쓰고 0은 0.1% 미만으로, 분류 점수와 잘못된 순위는 제외한다", () => {
    const player = { ...challengePlayerFixture, challenges: [
      { challengeId: 1, level: "MASTER", percentile: 0 },
      { challengeId: 101, level: "GOLD", percentile: 0, position: 11, playersInLevel: 4000 },
      { challengeId: 102, level: "DIAMOND", percentile: 0.002, position: -1, playersInLevel: 10 },
      { challengeId: 104, level: "GOLD" },
    ] };
    const profile = buildLolChallengeProfile(player, catalog);
    expect(profile.achieved?.map(item => item.id)).toEqual([101, 102, 104]);
    expect(profile.achieved?.[0]).toMatchObject({ percentile: 0, position: 11, playersInLevel: 4000 });
    expect(profile.achieved?.[1]).not.toHaveProperty("position");
    expect(profile.achieved?.[2].percentile).toBe(0.05);
    const html = renderToStaticMarkup(createElement(LolChallengesCard, { profile }));
    expect(html).toContain("상위 0.1% 미만"); expect(html).toContain("등급 내 11위 / 4,000명");
    expect(html).not.toContain("상위 0%"); expect(html).not.toContain("달성한 도전과제 전체 보기");
    expect(renderToStaticMarkup(createElement(LolChallengesCard, { profile: buildLolChallengeProfile(challengePlayerFixture, catalog) })))
      .toContain("달성한 도전과제 전체 보기");
  });
  it("공개 칭호 추정 금지·관리자 안내·공식 분포·표본·오류 보존을 렌더한다", () => {
    const profile = buildLolChallengeProfile(challengePlayerFixture, catalog);
    const html = renderToStaticMarkup(createElement(LolChallengesCard, { profile }));
    expect(html).toContain("상위 0.3%"); expect(html).toContain("Riot 공식 분포");
    expect(html).not.toContain("칭호 매핑"); expect(html).not.toContain("fixture-title-id");
    expect(renderToStaticMarkup(createElement(LolChallengesCard, { profile, admin: true }))).toContain("칭호 매핑 미확인");
    expect(renderToStaticMarkup(createElement(LolChallengesCard, { profile: { ...profile, status: "failed" } }))).toContain("불러오지 못했습니다");
    expect(renderToStaticMarkup(createElement(LolRecentTrendsCard, { trends: summarizeLolRecentTrends([row(), row(), row()]) }))).toContain("최근 3경기");
    expect(renderToStaticMarkup(createElement(LolMatchInsightSection, { insights: buildLolMatchInsights(input) }))).toContain("라인전·기여");
  });
});
