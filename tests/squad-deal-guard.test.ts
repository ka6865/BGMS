import { describe, expect, it } from "vitest";
import { applySquadEvidencePolicy } from "@/lib/pubg-analysis/squadAiEvidence";
import { buildSquadMemberRecords, squadMemberFaultFeedback, type SquadMemberRecords } from "@/lib/pubg-analysis/squadMemberRecords";
import { squadDamageBaseline } from "@/lib/pubg-analysis/teamBenchmark";

const keyOf = (name: string) => name.toLowerCase();

describe("팀원 경기당 피해량 비교 평균", () => {
  const row = (game_mode: string, match_type: string, avg_damage: number, avg_damage_count: number) => ({ game_mode, match_type, avg_damage, avg_damage_count });

  it("티어 구간을 표본 수로 가중 평균하고 10 단위로 반올림한다", () => {
    expect(squadDamageBaseline([row("squad-fpp", "official", 300, 100), row("squad-fpp", "official", 200, 300)],
      [{ gameMode: "squad-fpp", matchType: "official" }])).toBe(230);
  });

  it("여러 모드가 섞이면 가장 낮은 평균을 쓰고, 한 모드라도 표본이 모자라면 비교하지 않는다", () => {
    const rows = [row("squad-fpp", "official", 300, 250), row("squad", "official", 260, 250), row("squad", "competitive", 400, 199)];
    expect(squadDamageBaseline(rows, [{ gameMode: "squad-fpp", matchType: "official" }, { gameMode: "squad", matchType: "official" }])).toBe(260);
    expect(squadDamageBaseline(rows, [{ gameMode: "squad-fpp", matchType: "official" }, { gameMode: "squad", matchType: "competitive" }])).toBeNull();
    expect(squadDamageBaseline(rows, [])).toBeNull();
  });
});

describe("팀원 절대 피해량 못한 점", () => {
  // 두 팀원이 같은 시각까지 살아 첫 사망 후보가 섞이지 않게 한다.
  const match = (bDamage: number, bSurvived = 1500) => ({ team: [
    { name: "A", damageDealt: 400, timeSurvived: 1500 },
    { name: "B", damageDealt: bDamage, timeSurvived: bSurvived },
  ] });
  const records = (matches: ReturnType<typeof match>[], damageBaseline: number | null = 260) =>
    buildSquadMemberRecords({ matches, memberKeys: ["a", "b"], selfKey: "a", keyOf, damageBaseline });
  const members = (map: Map<string, SquadMemberRecords>) => [{ name: "A", records: map.get("a") }, { name: "B", records: map.get("b") }];

  it("5분 이상 생존한 경기만 세고, 비교 평균이 없으면 기록을 만들지 않는다", () => {
    const map = records([match(50), match(70), match(900, 200)]);
    expect(map.get("b")?.damage).toEqual({ avg: 60, matches: 2, baseline: 260 });
    expect(records([match(50)], null).get("b")?.damage).toBeNull();
  });

  it("5경기 이상이고 같은 모드 평균의 절반 미만일 때만 못한 점과 조언을 쓴다", () => {
    const low = squadMemberFaultFeedback(members(records(Array.from({ length: 5 }, () => match(120)))), "mild");
    expect(low.get("B")).toEqual({
      fault: "5분 이상 생존한 5경기의 경기당 피해량이 120로 같은 모드 평균 260의 절반에 못 미칩니다.",
      advice: "다음 교전에서는 아군이 사격을 시작할 때 같은 적을 맞힐 수 있는 자리인지 확인해 보세요.",
    });
    expect(low.get("A")?.fault).toBe("");
    // 경계: 정확히 절반이면 후보가 아니다. 4경기뿐이어도 후보가 아니다.
    expect(squadMemberFaultFeedback(members(records(Array.from({ length: 5 }, () => match(130)))), "mild").get("B")?.fault).toBe("");
    expect(squadMemberFaultFeedback(members(records(Array.from({ length: 4 }, () => match(50)))), "mild").get("B")?.fault).toBe("");
  });

  it("매운맛 문장은 비중이 아니라 절대 피해량을 말하고 팀원마다 꼬리 문장을 고른다", () => {
    const spicy = squadMemberFaultFeedback(members(records(Array.from({ length: 6 }, () => match(40)))), "spicy").get("B")!;
    expect(spicy.fault).toMatch(/^5분 이상 생존한 6경기의 경기당 피해량이 40, 같은 모드 평균 260의 절반도 안 돼\. /u);
    expect(spicy.fault).not.toMatch(/비중|%/u);
  });
});

describe("첫 사망 매운맛 문장 변형", () => {
  it("팀원 이름에 따라 다른 꼬리 문장을 고르고 같은 이름이면 같은 문장이다", () => {
    const fault = (name: string) => squadMemberFaultFeedback([
      { name, records: { firstDeaths: { count: 5, matches: 10 }, initiative: null, farFromTeam: null, damage: null } },
      { name: "Other", records: { firstDeaths: { count: 1, matches: 10 }, initiative: null, farFromTeam: null, damage: null } },
    ], "spicy").get(name)!.fault;
    const tails = new Set(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map(name => fault(name).split("팀 최다, ")[1]));
    expect(tails.size).toBeGreaterThan(1);
    expect(fault("Alpha")).toBe(fault("Alpha"));
  });
});

describe("스쿼드 문장 반복·모순·영어 정리", () => {
  const knocksFewStats = { totalTeammateKnocks: 31, observedMatchCount: 10, totalTradeableKnocks: 29, totalTradeableTradeKills: 4 };
  const benchmarkStats = { avgTeammateKnocks: 4.4, avgTradeableTradeRate: 19.8 };
  const profiles = [{ name: "o_o7ouo7o_o", shares: { damage: 37, kill: 43 } }, { name: "Androgynous_", shares: { damage: 30, kill: 26 } }, { name: "returnee99", shares: { damage: 34, kill: 31 } }];

  it("허용 목록 밖 영어 단어가 남은 문장은 빼고 닉네임은 허용한다", () => {
    const result: any = applySquadEvidencePolicy({
      summary: "상세 분석 가능한 10경기 기준 부활 성공률이 14.8%로 global average 34%보다 낮습니다. o_o7ouo7o_o가 화력을 맡았습니다.",
      strength: "", weakness: "", coaching: "", overallOpinion: "",
    }, {}, null, undefined, profiles, { coachingStyle: "mild" });
    expect(result.summary).toBe("o_o7ouo7o_o가 화력을 맡았습니다.");
  });

  it("복수 근거가 없으면 '복수 기록이 늦게 남았다'는 시간 표현을 뺀다", () => {
    const options = { coachingStyle: "spicy", benchmarkStats, matchesSummary: [] };
    const result: any = applySquadEvidencePolicy({
      summary: "", strength: "", weakness: "", overallOpinion: "",
      coaching: "복수 기록이 평균보다 늦게 남았네. 다음 기록은 좀 덜 기다리게 해 봐.",
    }, knocksFewStats, null, undefined, profiles, options);
    expect(result.coaching).not.toMatch(/늦게|덜 기다리게/u);
  });

  it("앞 칸 문장을 뒤 칸에서 반복하지 않고, 약점을 반복하던 코칭은 조건부 점검으로 채운다", () => {
    const trade = "상세 분석 가능한 10경기 기준 100m 안에서 적에게 누운 아군 기절 29회 중 4회를 30초 안에 갚아 복수 성공률 13.8%, 전체 팀 평균 19.8%로 평균보다 낮아.";
    const options = { coachingStyle: "spicy", benchmarkStats, matchesSummary: [] };
    const once: any = applySquadEvidencePolicy({
      summary: "최근 26경기 중 최고 순위는 2위야.",
      strength: "최근 26경기 중 최고 순위는 2위야.",
      weakness: trade,
      coaching: `${trade} 복수 기록이 평균보다 늦게 남았네.`,
      overallOpinion: "",
    }, knocksFewStats, null, undefined, profiles, options);
    expect(once.summary).toBe("최근 26경기 중 최고 순위는 2위야.");
    expect(once.strength).toBe("");
    expect(once.coaching).toBe("다음에도 가까운 거리에서 아군이 눕는다면, 30초 안에 같은 적을 잡을 수 있는 상황인지 점검해 봐.");
    expect(applySquadEvidencePolicy(once, knocksFewStats, null, undefined, profiles, options)).toEqual(once);
  });

  it("칭찬 사실 뒤에는 놀림만 있다는 마무리를, 약점이 있으면 칭찬만 했다는 마무리를 쓰지 않는다", () => {
    const options = { coachingStyle: "spicy", benchmarkStats, matchesSummary: [2, 4, 6, 8, 10].map(winPlace => ({ winPlace })) };
    const result: any = applySquadEvidencePolicy({ summary: "", strength: "", weakness: "", coaching: "", overallOpinion: "x" },
      knocksFewStats, null, undefined, profiles, options);
    expect(result.overallOpinion).not.toMatch(/매운맛이 할 일이 많았던|기록부가 할 말이 많은|트집 잡을 데가 없어|칭찬만 하다 끝나는/u);
    const hypeOnly = { totalTeammateKnocks: 20, observedMatchCount: 10 };
    const withWeakness: any = applySquadEvidencePolicy({ summary: "", strength: "", weakness: "모델이 쓴 약점이야.", coaching: "", overallOpinion: "x" },
      hypeOnly, null, undefined, profiles, { coachingStyle: "spicy", benchmarkStats, matchesSummary: [] });
    expect(withWeakness.overallOpinion).not.toMatch(/트집 잡을 데가 없어|칭찬만 하다 끝나는/u);
  });
});
