import { describe, expect, it } from "vitest";
import { applyMatchAiPercentiles, formatMatchAiPercentileSection, toMatchAiPercentiles } from "@/lib/pubg-analysis/matchAiPercentiles";
import { applyMatchAiClockPolicy, applyMatchAiSceneRefs, buildMatchAiFlowLines } from "@/lib/pubg-analysis/matchAiScenes";
import { applyMatchAiEvidencePolicy } from "@/lib/pubg-analysis/matchAiEvidence";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";

const row = (metric: string, total: number, above: number, below: number) => ({
  metric, game_mode: "squad", match_type: "competitive", sample_count: total, at_or_above: above, at_or_below: below,
});

const match = {
  stats: { kills: 2, assists: 0, DBNOs: 2, damageDealt: 300, timeSurvived: 790, winPlace: 9, deathType: "byplayer" },
  timeline: [
    { ts: 300_000, type: "KNOCK", weapon: "M416", distance: 40, victim: "EnemyA", x: 10, y: 10 },
    { ts: 780_000, type: "DOWNED", weapon: "AKM", attacker: "EnemyB", x: 20, y: 20 },
    { ts: 790_000, type: "DIED", attacker: "EnemyB", x: 20, y: 20 },
  ],
  matchReport: {
    version: 4,
    landing: { timeMs: 120_000, enemiesNear: 3, enemiesFar: 5, teamsNear: 1 },
    fights: [
      { startMs: 290_000, endMs: 310_000, opponentTeamIds: [5], opponents: ["EnemyA"], dealt: 250, taken: 40, enemyDowns: 1, teamDowns: 0, openedBy: "us", outcome: "won" },
      { startMs: 760_000, endMs: 790_000, opponentTeamIds: [7, 8], opponents: ["EnemyB"], dealt: 85, taken: 410, enemyDowns: 0, teamDowns: 2, openedBy: "them", outcome: "lost" },
    ],
    death: { timeMs: 790_000, phase: 4, type: "thirdParty", killer: "EnemyB", killerTeamId: 7, killerIsBot: false, weapon: "AKM", cause: "gun", distanceM: 60, knockedAtMs: 780_000, teamsInLastMinute: 2, movedBeforeFightM: 20, inVehicle: false, nearestTeammateM: 140, openedBy: "them" },
    circles: [{ index: 3, phase: 3, timeMs: 600_000, status: "outside", outsideByM: 220.4 }],
    heal: { damageTaken: 0, healthRestored: 0, heals: 0, boosts: 0, midFightHeals: 0 },
    kills: [], teams: [], carePackages: [], bots: [],
  },
};

describe("BGMS 기록 백분위", () => {
  it("동점을 포함해 보수적으로 상위·하위를 정하고 표본이 적거나 중간이면 뺀다", () => {
    const items = toMatchAiPercentiles([
      row("survival_time", 1000, 900, 138),
      row("damage", 1000, 121, 880),
      row("kills", 1000, 520, 600),
      { ...row("damage", 150, 1, 150), game_mode: "duo-fpp" },
    ]);
    expect(items.map(({ metric, direction, percent }) => [metric, direction, percent]))
      .toEqual([["damage", "top", 13], ["survival_time", "bottom", 14]]);
    expect(items[0].scope).toBe("스쿼드 경쟁전");
    expect(formatMatchAiPercentileSection(items)).toContain("- 공식 피해량: 상위 13%");
    expect(toMatchAiPercentiles([row("damage", 199, 1, 199)])).toEqual([]);
    expect(toMatchAiPercentiles([row("damage", 1000, 0, 1000)])[0].percent).toBe(1);
  });

  it("서버 값과 다른 % 순위 문장은 지우고 캐시 재적용에도 같다", () => {
    const items = toMatchAiPercentiles([row("damage", 1000, 121, 880)]);
    const text = JSON.stringify({
      signature: "상위 1% 폭격기",
      signatureSub: "BGMS 기록 기준 공식 피해량 상위 13%입니다.",
      briefFeedback: ["킬은 상위 5%였습니다. 교전 마무리는 좋았습니다.", "생존은 하위 3%입니다.", "딜은 상위 13%입니다."],
      finalVerdict: "마무리.",
      actionItems: [{ icon: "🎯", title: "원 먼저", desc: "하위 10%라서 원 안으로 먼저 이동하세요." }],
    });
    const fresh = applyMatchAiPercentiles(text, items);
    const parsed = JSON.parse(fresh);
    expect(parsed.benchmarkPercentiles).toHaveLength(1);
    expect(parsed.signature).toBe("폭격기");
    expect(parsed.signatureSub).toBe("BGMS 기록 기준 공식 피해량 상위 13%입니다.");
    expect(parsed.briefFeedback).toEqual(["교전 마무리는 좋았습니다.", "BGMS 기록 비교는 근거가 없어 보류합니다.", "딜은 상위 13%입니다."]);
    expect(parsed.actionItems[0].desc).toBe("");
    expect(applyMatchAiPercentiles(fresh)).toBe(fresh);
    // 백분위 근거가 없으면 모델이 쓴 % 순위는 모두 지운다. 모델이 만든 필드도 검증한다.
    const forged = JSON.parse(applyMatchAiPercentiles(JSON.stringify({ benchmarkPercentiles: [{ metric: "damage", direction: "top", percent: 99 }], finalVerdict: "상위 99%입니다." })));
    expect(forged.benchmarkPercentiles).toBeUndefined();
    expect(forged.finalVerdict).toBe("BGMS 기록 비교는 근거가 없어 보류합니다.");
  });

  it("근거 정책과 장면 검증이 서버 백분위 필드를 지우지 않는다", () => {
    const items = toMatchAiPercentiles([row("damage", 1000, 121, 880)]);
    const text = applyMatchAiPercentiles(JSON.stringify({ signature: "화력", briefFeedback: ["a.", "b.", "c."], finalVerdict: "d.", actionItems: [] }), items);
    const after = applyMatchAiSceneRefs(applyMatchAiEvidencePolicy(text, match), match, text);
    expect(JSON.parse(after).benchmarkPercentiles).toEqual(items);
  });
});

describe("경기 흐름과 경과 시각", () => {
  it("교전·사망·자기장·착지를 측정값과 장면 ID로 적고 상대 닉네임은 넣지 않는다", () => {
    const lines = buildMatchAiFlowLines(match);
    expect(lines).toEqual([
      "- 착지 2:00 | 300m 안 적 3명(1팀)",
      "- 교전 4:50~5:10 | 우리 팀이 먼저 사격 | 결과 승리 | 우리 팀이 준 피해 250 / 받은 피해 40 | 적 쓰러짐 1 · 우리 팀 쓰러짐 0 | 장면 KNOCK-300000",
      "- 교전 12:40~13:10 | 상대가 먼저 사격 | 결과 패배 | 우리 팀이 준 피해 85 / 받은 피해 410 | 적 쓰러짐 0 · 우리 팀 쓰러짐 2 | 장면 DOWNED-780000, DIED-790000",
      "- 내 사망 13:10 | 사망 유형 써드파티 · 최근 1분간 2팀 교전 · 60m | 가장 가까운 팀원 140m | 마지막 교전은 상대가 먼저 사격 | 장면 DOWNED-780000, DIED-790000",
      "- 자기장 10:00 | 3페이즈 새 원이 정해질 때 원 밖 220m",
    ]);
    expect(lines.join("\n")).not.toMatch(/Enemy/u);
    expect(buildMatchAiFlowLines({ timeline: [] })).toEqual([]);
  });

  it("장면·흐름에 없는 경과 시각은 조사까지 지우고 있는 시각은 남긴다", () => {
    const text = JSON.stringify({
      signatureSub: "x",
      briefFeedback: ["12:40 교전은 상대가 먼저 쐈습니다.", "7:15 교전에서 밀렸습니다.", "3:33에 원 밖이었습니다."],
      finalVerdict: "10:00 원 밖 220m였습니다.",
      actionItems: [{ icon: "🎯", title: "원 먼저", desc: "9:59쯤 원 안으로 들어가세요." }],
    });
    const parsed = JSON.parse(applyMatchAiClockPolicy(text, match));
    expect(parsed.briefFeedback).toEqual(["12:40 교전은 상대가 먼저 쐈습니다.", "교전에서 밀렸습니다.", "원 밖이었습니다."]);
    expect(parsed.finalVerdict).toBe("10:00 원 밖 220m였습니다.");
    expect(parsed.actionItems[0].desc).toBe("원 안으로 들어가세요.");
    const once = applyMatchAiClockPolicy(text, match);
    expect(applyMatchAiClockPolicy(once, match)).toBe(once);
  });

  it("문장에 섞인 장면 ID를 지우고 1페이즈 원 밖 기록은 흐름에 넣지 않는다", () => {
    const text = JSON.stringify({ briefFeedback: ["12:40 교전(DOWNED-780000)은 졌습니다.", "마지막 13:10 DIED-790000 장면처럼 당했습니다.", "c."] });
    expect(JSON.parse(applyMatchAiClockPolicy(text, match)).briefFeedback)
      .toEqual(["12:40 교전은 졌습니다.", "마지막 13:10 장면처럼 당했습니다.", "c."]);
    // 라우트처럼 정리한 원문과 비교하면 ID만 지운 문장은 장면 연결을 유지한다.
    const raw = JSON.stringify({ briefFeedback: ["12:40 교전(DOWNED-780000)은 졌습니다.", "b.", "c."], briefFeedbackSceneIds: ["DOWNED-780000", null, null] });
    const tidied = applyMatchAiClockPolicy(raw, match);
    expect(JSON.parse(applyMatchAiSceneRefs(tidied, match, tidied)).briefFeedbackSceneIds).toEqual(["DOWNED-780000", null, null]);
    const early = { ...match, matchReport: { ...match.matchReport, circles: [{ index: 1, phase: 1, timeMs: 100_000, status: "outside", outsideByM: 3666 }] } };
    expect(buildMatchAiFlowLines(early).some((line) => line.startsWith("- 자기장"))).toBe(false);
  });
});

describe("단일 경기 코칭 프롬프트", () => {
  const base = { ...match, mapName: "Erangel", gameMode: "squad" };

  it("경기 흐름·백분위 섹션과 행동 하나 규칙을 넣고 비교 평균을 엘리트로 부르지 않는다", () => {
    const percentiles = toMatchAiPercentiles([row("damage", 1000, 121, 880)]);
    const { fullPrompt } = buildMatchAiCoachingPrompt({ matchData: base, coachingStyle: "spicy", percentiles });
    expect(fullPrompt).toContain("[경기 흐름]");
    expect(fullPrompt).toContain("장면 DOWNED-780000, DIED-790000");
    expect(fullPrompt).toContain("[BGMS 기록 비교] (스쿼드 경쟁전 BGMS 기록 1000경기 기준");
    expect(fullPrompt).toContain("actionItems는 정확히 1개");
    expect(fullPrompt).not.toContain("Elite");
    const none = buildMatchAiCoachingPrompt({ matchData: base, coachingStyle: "spicy" }).fullPrompt;
    expect(none).not.toContain("[BGMS 기록 비교] (");
    expect(none).toContain("[순위 비교 금지]");
  });

  it("매운맛은 반말로 쓰고 순한맛은 반말 지시를 받지 않는다", () => {
    const spicy = buildMatchAiCoachingPrompt({ matchData: base, coachingStyle: "spicy" }).fullPrompt;
    const mild = buildMatchAiCoachingPrompt({ matchData: base, coachingStyle: "mild" }).fullPrompt;
    expect(spicy).toContain("반말(~했네, ~잖아, ~해 봐)로만 쓰십시오");
    expect(mild).toContain("다정한 코치");
    expect(mild).not.toContain("반말");
  });
});
