import { describe, expect, it } from "vitest";
import { applySquadEvidencePolicy, listReplacedSquadFields } from "@/lib/pubg-analysis/squadAiEvidence";

// KangHeeSung_ 4인 파티와 같은 모양이다. 소생 14/30(46.7%)은 표본 기준(기절 5회)을 넘고, 생존 케어 점수는 없다.
const STATS = {
  avgIsolation: null, avgTradeLatency: 12409, totalSmokeRescues: 3, totalRevives: 14,
  avgCoverRate: null, totalTeamWipes: null, totalTeammateKnocks: 30, totalTradeKills: 2,
};
const SCORES = { formation: null, backupSpeed: null, survivalCare: null, focusFire: null, teamWipe: null };
const BENCHMARK = { avgReviveRate: 34.1 };

const run = (strength: string, options: Record<string, unknown> = { benchmarkStats: BENCHMARK }, stats: Record<string, unknown> = STATS) =>
  applySquadEvidencePolicy(
    { summary: "", strength, weakness: "", coaching: "", overallOpinion: "", memberFeedbacks: [] },
    stats, null, SCORES, [], options,
  ) as { strength: string };

describe("생존 케어 점수가 없을 때 소생 문장 처리", () => {
  it("측정된 소생률과 전체 평균 퍼센트만 담은 문장은 살린다", () => {
    const sentence = "아군 기절 30회 중 14회 부활 성공률 46.7%, 전체 팀 평균 34.1%로 평균보다 높습니다.";
    expect(run(sentence).strength).toBe(sentence);
  });

  it("측정값과 다른 퍼센트가 하나라도 있으면 보류한다", () => {
    expect(run("부활 성공률 58.0%로 평균보다 높습니다.").strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
    expect(run("부활 성공률 46.7%, 전체 팀 평균 40.0%입니다.").strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
  });

  it("능력을 평가하는 말이 섞이면 측정값이 맞아도 보류한다", () => {
    expect(run("부활 성공률 46.7%로 소생 능력이 우수합니다.").strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
    expect(run("연막 구출 실력이 훌륭합니다.").strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
  });

  it("숫자 없이 비율을 말하는 문장은 보류한다", () => {
    expect(run("소생 비율이 높습니다.").strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
  });

  it("기절 표본이 기준(5회) 미만이면 맞는 숫자여도 보류한다", () => {
    const fewKnocks = { ...STATS, totalTeammateKnocks: 4, totalRevives: 2 };
    expect(run("부활 성공률 50.0%입니다.", { benchmarkStats: BENCHMARK }, fewKnocks).strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
  });

  it("전체 평균을 모르면 우리 팀 소생률만 인정한다", () => {
    expect(run("부활 성공률 46.7%입니다.", {}).strength).toBe("부활 성공률 46.7%입니다.");
    expect(run("전체 팀 평균 34.1% 대비 부활 성공률 46.7%입니다.", {}).strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
  });

  it("연막 구출 횟수 문장은 그대로 둔다", () => {
    expect(run("연막 구출 성공 기록이 3회입니다.").strength).toBe("연막 구출 성공 기록이 3회입니다.");
  });

  it("같은 입력에 여러 번 적용해도 결과가 같다(멱등)", () => {
    const once = run("아군 기절 30회 중 14회 부활 성공률 46.7%, 전체 팀 평균 34.1%입니다. 소생 능력이 우수합니다.");
    const twice = run(once.strength);
    expect(twice.strength).toBe(once.strength);
    expect(once.strength).toContain("46.7%");
    expect(once.strength).toContain("생존 케어 평가는 근거가 부족해 보류합니다.");
  });
});

describe("listReplacedSquadFields", () => {
  it("바뀐 칸 이름만 돌려주고 문장 내용은 담지 않는다", () => {
    const raw = { summary: "a", strength: "b", weakness: "", coaching: "", overallOpinion: "c", memberFeedbacks: [{ name: "X", praise: "p", fault: "f", advice: "d" }] };
    const processed = { ...raw, strength: "보류", memberFeedbacks: [{ name: "X", praise: "p", fault: "보류", advice: "d" }] };
    expect(listReplacedSquadFields(raw, processed)).toEqual(["strength", "memberFeedbacks[0].fault"]);
    expect(listReplacedSquadFields(raw, raw)).toEqual([]);
    expect(listReplacedSquadFields(null, undefined)).toEqual([]);
  });
});

describe("소생 점수가 있을 때 소생 문장 처리", () => {
  const withScore = (sentence: string) => applySquadEvidencePolicy(
    { summary: "", strength: sentence, weakness: "", coaching: "", overallOpinion: "", memberFeedbacks: [] },
    STATS, null, { ...SCORES, survivalCare: 71 }, [], { benchmarkStats: BENCHMARK },
  ) as { strength: string };

  it("점수 문장은 허용한다", () => {
    expect(withScore("소생 점수는 71점입니다.").strength).toBe("소생 점수는 71점입니다.");
  });

  it("점수를 퍼센트로 잘못 쓴 문장은 보류한다", () => {
    expect(withScore("소생률 71%를 기록했습니다.").strength).toBe("생존 케어 평가는 근거가 부족해 보류합니다.");
  });

  it("측정된 소생률 퍼센트는 허용한다", () => {
    const sentence = "아군 기절 30회 중 14회를 살려 소생률 46.7%입니다.";
    expect(withScore(sentence).strength).toBe(sentence);
  });
});
