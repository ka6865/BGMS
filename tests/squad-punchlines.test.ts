import { describe, expect, it } from "vitest";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";
import { formatSquadPunchlineBlock, selectSquadMemberPunchlines, selectSquadPunchlines, SQUAD_PUNCHLINE_KIND_LIMIT, SQUAD_PUNCHLINE_LIMIT } from "@/lib/pubg-analysis/squadPunchlines";

// 테스트 입력은 필요한 값만 바꿔 쓰므로 느슨한 타입을 쓴다.
type LooseInput = Record<string, any>;

// 측정 가능한 지표가 모두 있는 팀 입력이다. 테스트마다 필요한 값만 덮어쓴다.
function teamInput(overrides: LooseInput = {}) {
  return {
    stats: {
      avgIsolation: null,
      avgTradeLatency: 15300,
      totalTradeKills: 4,
      totalTeammateKnocks: 10,
      totalRevives: 1,
      totalSmokeRescues: 0,
      avgCoverRate: null,
      totalTeamWipes: null,
    },
    scores: { formation: null, backupSpeed: null, survivalCare: null, focusFire: null, teamWipe: null },
    squadGrade: null,
    benchmarkStats: { avgTradeLatency: 10400, avgReviveRate: 17, avgSmokeRate: 3.6, avgIsolation: null, avgTeamWipes: null, sampleCount: 900 },
    matchesSummary: [],
    roleProfiles: [],
    ...overrides,
  };
}

const duoProfiles = [
  { name: "KangHeeSung_", totalKills: 8, totalDamage: 1120, shares: { damage: 73, kill: 67, assist: 50, dbno: 69 } },
  { name: "MiaeQ_Q", totalKills: 4, totalDamage: 420, shares: { damage: 27, kill: 33, assist: 50, dbno: 31 } },
];

describe("squad punchline team facts", () => {
  it("picks a backup-slow roast with both measured seconds", () => {
    const picks = selectSquadPunchlines(teamInput());
    const backup = picks.find((item) => item.id === "backup_slow");
    expect(backup).toEqual({
      id: "backup_slow",
      kind: "roast",
      metric: "avgTradeLatency",
      fact: "백업 속도 평균 15.3초, 전체 팀 평균 10.4초로 평균보다 느립니다.",
    });
  });

  it("drops the backup fact when the trade sample is below three kills", () => {
    const picks = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalTradeKills: 2 } }));
    expect(picks.map((item) => item.id)).not.toContain("backup_slow");
  });

  it("drops the backup fact when the population benchmark is unavailable", () => {
    const picks = selectSquadPunchlines(teamInput({ benchmarkStats: { avgTradeLatency: null, avgReviveRate: 17 } }));
    expect(picks.map((item) => item.id)).not.toContain("backup_slow");
  });

  it("calls a backup inside the 30 percent band neutral", () => {
    // 10400 대비 12000은 1.15배라 기준 1.3배에 못 미친다.
    const picks = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, avgTradeLatency: 12000 } }));
    expect(picks.map((item) => item.id)).not.toContain("backup_slow");
    expect(picks.map((item) => item.id)).not.toContain("backup_fast");
  });

  it("marks a fast backup as a hype fact", () => {
    const picks = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, avgTradeLatency: 7000 } }));
    expect(picks.find((item) => item.id === "backup_fast")).toMatchObject({ kind: "hype", fact: "백업 속도 평균 7.0초, 전체 팀 평균 10.4초로 평균보다 빠릅니다." });
  });

  it("compares the revive rate to the population rate with a 5 point gap", () => {
    const low = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalRevives: 1, totalTeammateKnocks: 10 } }));
    expect(low.find((item) => item.id === "revive_low")).toMatchObject({ kind: "roast", metric: "reviveRate" });
    const high = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalRevives: 4, totalTeammateKnocks: 10 } }));
    expect(high.find((item) => item.id === "revive_high")).toMatchObject({ kind: "hype", metric: "reviveRate" });
  });

  it("does not compare revive rates on fewer than five knocks", () => {
    const picks = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalRevives: 0, totalTeammateKnocks: 4 } }));
    expect(picks.map((item) => item.id)).not.toContain("revive_low");
    expect(picks.map((item) => item.id)).not.toContain("revive_high");
  });

  it("states the smoke-rescue zero only with five or more knocks and never mentions smoke attempts", () => {
    const zero = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalSmokeRescues: 0, totalTeammateKnocks: 6 } }));
    const zeroFact = zero.find((item) => item.id === "smoke_rescue_zero");
    expect(zeroFact).toMatchObject({ kind: "roast", fact: "아군 기절 6회 중 연막 구출 성공 기록은 0회입니다." });
    expect(zeroFact?.fact).not.toMatch(/아꼈|안 쓰|던졌/);
    const few = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalSmokeRescues: 0, totalTeammateKnocks: 3 } }));
    expect(few.map((item) => item.id)).not.toContain("smoke_rescue_zero");
  });

  it("hypes three or more smoke rescues", () => {
    const picks = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalSmokeRescues: 3, totalTeammateKnocks: 5, totalRevives: 3 } }));
    expect(picks.find((item) => item.id === "smoke_rescue_many")).toMatchObject({ kind: "hype", fact: "연막 구출 성공 기록이 3회입니다." });
  });

  it("roasts a damage spread of forty points or more between measured members", () => {
    const picks = selectSquadPunchlines(teamInput({ roleProfiles: duoProfiles }));
    expect(picks.find((item) => item.id === "damage_spread")).toEqual({
      id: "damage_spread",
      kind: "roast",
      metric: "damageSpread",
      fact: "팀 딜 비중이 73%(KangHeeSung_)와 27%(MiaeQ_Q)로 갈렸습니다.",
    });
    const even = selectSquadPunchlines(teamInput({
      roleProfiles: [{ name: "A", shares: { damage: 55 } }, { name: "B", shares: { damage: 45 } }],
    }));
    expect(even.map((item) => item.id)).not.toContain("damage_spread");
  });

  it("uses win counts only when there are at least five matches for a zero-win roast", () => {
    const five = selectSquadPunchlines(teamInput({ matchesSummary: [5, 9, 12, 14, 20].map((winPlace) => ({ winPlace })) }));
    expect(five.find((item) => item.id === "wins_zero")).toMatchObject({ kind: "roast", fact: "최근 5경기에서 우승 기록이 0회입니다." });
    const four = selectSquadPunchlines(teamInput({ matchesSummary: [5, 9, 12, 14].map((winPlace) => ({ winPlace })) }));
    expect(four.map((item) => item.id)).not.toContain("wins_zero");
  });

  it("hypes wins and treats a top-three finish as a hype only when there was no win", () => {
    const won = selectSquadPunchlines(teamInput({ matchesSummary: [1, 4, 9].map((winPlace) => ({ winPlace })) }));
    expect(won.find((item) => item.id === "wins_some")).toMatchObject({ kind: "hype", fact: "최근 3경기에서 우승 1회를 기록했습니다." });
    expect(won.map((item) => item.id)).not.toContain("best_rank_top");
    const runnerUp = selectSquadPunchlines(teamInput({ matchesSummary: [2, 6, 12, 14, 18].map((winPlace) => ({ winPlace })) }));
    expect(runnerUp.find((item) => item.id === "best_rank_top")).toMatchObject({ kind: "hype", fact: "최근 5경기 중 최고 순위는 2위입니다." });
  });

  it("ignores placements that are missing or not positive integers", () => {
    const picks = selectSquadPunchlines(teamInput({ matchesSummary: [0, null, undefined, 1.5, -2].map((winPlace) => ({ winPlace })) }));
    expect(picks.map((item) => item.id)).not.toContain("wins_zero");
    expect(picks.map((item) => item.id)).not.toContain("wins_some");
    expect(picks.map((item) => item.id)).not.toContain("best_rank_top");
  });

  it("does not turn the squad grade into a joke fact", () => {
    const measured = { survivalCare: 80, backupSpeed: 70, smokeRescue: 60, damageBalance: 75, placement: 65 };
    for (const squadGrade of ["A", "C+", null]) {
      const ids = selectSquadPunchlines(teamInput({ squadGrade, scores: measured })).map((item) => item.id);
      expect(ids).not.toContain("squad_grade_high");
      expect(ids).not.toContain("squad_grade_low");
    }
  });

  it("never builds facts from unmeasured isolation, cover, or wipe metrics", () => {
    const picks = selectSquadPunchlines(teamInput({
      stats: { avgIsolation: null, avgCoverRate: null, totalTeamWipes: null, avgTradeLatency: null, totalTradeKills: null },
      benchmarkStats: { avgIsolation: 1.36, avgTeamWipes: 5.33, avgTradeLatency: 10400, avgReviveRate: 17 },
    }));
    expect(picks).toEqual([]);
    const text = JSON.stringify(picks);
    expect(text).not.toMatch(/고립|isolation|엄호|cover|전멸|wipe/i);
  });

  it("returns no facts for empty or malformed input without throwing", () => {
    expect(selectSquadPunchlines({})).toEqual([]);
    expect(selectSquadPunchlines({ stats: { avgTradeLatency: Number.NaN, totalTradeKills: "x" }, benchmarkStats: null })).toEqual([]);
    expect(selectSquadPunchlines({ roleProfiles: [null, {}] as never })).toEqual([]);
  });

  it("selects deterministically, caps the total and each direction", () => {
    const input = teamInput({
      stats: { ...teamInput().stats, totalSmokeRescues: 0, totalTeammateKnocks: 10, totalRevives: 1 },
      squadGrade: "A",
      scores: { formation: 80, backupSpeed: 70, survivalCare: 60, focusFire: 75, teamWipe: 65 },
      roleProfiles: duoProfiles,
      matchesSummary: [2, 5, 8, 12, 15].map((winPlace) => ({ winPlace })),
    });
    const first = selectSquadPunchlines(input);
    expect(selectSquadPunchlines(input)).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(SQUAD_PUNCHLINE_LIMIT);
    expect(first.filter((item) => item.kind === "roast").length).toBeLessThanOrEqual(SQUAD_PUNCHLINE_KIND_LIMIT);
    expect(first.filter((item) => item.kind === "hype").length).toBeLessThanOrEqual(SQUAD_PUNCHLINE_KIND_LIMIT);
    expect(first.length).toBeGreaterThanOrEqual(2);
    // 가중치 순서: 백업(0.47) → 딜 편차(0.46) → 구조 성공률(0.41) → 최고 순위(0.3)
    expect(first.map((item) => item.id)).toEqual(["backup_slow", "damage_spread", "revive_low", "best_rank_top"]);
  });

  it("does not pad the list when only one fact is measurable", () => {
    const picks = selectSquadPunchlines(teamInput({ stats: { ...teamInput().stats, totalTradeKills: 0, avgTradeLatency: null, totalSmokeRescues: null } }));
    expect(picks.length).toBe(1);
    expect(picks[0].id).toBe("revive_low");
  });
});

describe("squad punchline member facts", () => {
  it("gives the duo carry a hype and the other member the steady bookkeeping line", () => {
    const members = selectSquadMemberPunchlines({ roleProfiles: duoProfiles });
    expect(members).toEqual([
      { name: "KangHeeSung_", id: "member_damage_carry", kind: "hype", metric: "damageShare", fact: "팀 딜 비중이 73%입니다." },
      { name: "MiaeQ_Q", id: "member_steady", kind: "hype", metric: "damageShare,killShare", fact: "팀 딜 비중 27%, 팀 킬 비중 33%입니다." },
    ]);
  });

  it("calls a low-damage, high-kill member a kill-log delivery using only the two shares", () => {
    const members = selectSquadMemberPunchlines({
      roleProfiles: [
        { name: "Solo_A", totalKills: 6, totalDamage: 300, shares: { damage: 5, kill: 60 } },
        { name: "Solo_B", totalKills: 2, totalDamage: 900, shares: { damage: 60, kill: 20 } },
        { name: "Solo_C", totalKills: 1, totalDamage: 400, shares: { damage: 25, kill: 10 } },
        { name: "Solo_D", totalKills: 1, totalDamage: 300, shares: { damage: 10, kill: 10 } },
      ],
    });
    expect(members.find((item) => item.name === "Solo_A")).toMatchObject({
      id: "member_kill_log",
      kind: "roast",
      fact: "팀 딜 비중은 5%인데 팀 킬 비중은 60%입니다.",
    });
  });

  it("does not use kill shares when the team has fewer than five kills", () => {
    const members = selectSquadMemberPunchlines({
      roleProfiles: [
        { name: "A", totalKills: 1, shares: { damage: 5, kill: 100 } },
        { name: "B", totalKills: 1, shares: { damage: 95, kill: 0 } },
      ],
    });
    expect(members.find((item) => item.name === "A")).toMatchObject({ id: "member_low_damage", kind: "roast", fact: "팀 딜 비중은 5%입니다." });
  });

  it("skips members without measured damage shares and never invents a fact", () => {
    expect(selectSquadMemberPunchlines({ roleProfiles: [{ name: "A", shares: { damage: null, kill: null } }] })).toEqual([]);
    expect(selectSquadMemberPunchlines({ roleProfiles: [] })).toEqual([]);
  });
});

describe("squad prompt punchline block", () => {
  const promptFor = (coachingStyle: "spicy" | "mild", overrides: LooseInput = {}) => buildSquadAiCoachingPrompt({
    groupKey: "KangHeeSung_",
    stats: { avgIsolation: null, avgTradeLatency: 15300, totalTradeKills: 4, totalTeammateKnocks: 10, totalRevives: 1, totalSmokeRescues: 0, avgCoverRate: null, totalTeamWipes: null },
    scores: { formation: null, backupSpeed: null, survivalCare: null, focusFire: null, teamWipe: null },
    roleProfiles: duoProfiles.map((profile) => ({ ...profile, role: "메인 딜러", roleDesc: "주력 화력" })),
    nickname: "KangHeeSung_",
    coachingStyle,
    squadGrade: null,
    benchmarkStats: { avgTradeLatency: 10400, avgReviveRate: 17, avgSmokeRate: 3.6, avgIsolation: null, avgTeamWipes: null, sampleCount: 900, scope: "team_population", teamMode: "duo", tier: null },
    matchCount: 5,
    teamMode: "duo",
    ...overrides,
  });

  it.each(["spicy", "mild"] as const)("puts the measured facts into the user prompt (%s)", (style) => {
    const { prompt } = promptFor(style);
    expect(prompt).toContain("[PUNCHLINE FACTS]");
    expect(prompt).toContain("backup_slow: 백업 속도 평균 15.3초, 전체 팀 평균 10.4초로 평균보다 느립니다.");
    expect(prompt).toContain("damage_spread: 팀 딜 비중이 73%(KangHeeSung_)와 27%(MiaeQ_Q)로 갈렸습니다.");
    expect(prompt).toContain("KangHeeSung_ [hype] member_damage_carry: 팀 딜 비중이 73%입니다.");
  });

  it("states an empty fact list explicitly so the model does not invent numbers", () => {
    const { prompt } = promptFor("spicy", { stats: {}, benchmarkStats: {}, roleProfiles: [] });
    expect(prompt).toContain("측정 가능한 팀 재료가 없습니다.");
    expect(prompt).toContain("측정 가능한 개인 재료가 없습니다.");
  });

  it("lets the spicy persona joke only from the facts and gives pass lines for missing evidence", () => {
    const { systemInstruction } = promptFor("spicy");
    expect(systemInstruction).toContain("[PUNCHLINE FACTS] are the only material");
    expect(systemInstruction).toContain("Copy every number from the facts exactly");
    // 근거 없는 칸은 넘김 문장이 아니라 빈 문자열로 둔다. 화면이 빈 칸을 숨긴다.
    expect(systemInstruction).toContain('output an empty string ("") for that field');
    expect(systemInstruction).not.toContain("이건 기록이 없어서 오늘은 봐드립니다.");
    expect(systemInstruction).not.toContain("증거 불충분, 이번 판은 무죄 방면.");
    expect(systemInstruction).not.toContain("현재 기록만으로 개인의 약점을 단정하기 어렵습니다.");
    expect(systemInstruction).not.toContain("장부");
  });

  it("keeps the mild persona to praise and advice from the same facts", () => {
    const { systemInstruction } = promptFor("mild");
    expect(systemInstruction).toContain("PUNCHLINE FACTS are for praise and practice advice only");
    expect(systemInstruction).toContain('output an empty string ("")');
    expect(systemInstruction).not.toContain("현재 기록만으로 개인의 약점을 단정하기 어렵습니다.");
    expect(systemInstruction).not.toContain("증거 불충분, 이번 판은 무죄 방면.");
  });

  it("tells both personas that fault and advice are written by the server and records are neutral facts", () => {
    for (const style of ["spicy", "mild"] as const) {
      const { prompt, systemInstruction } = promptFor(style);
      expect(prompt).toContain("[MEASURED OBSERVATIONS]");
      expect(systemInstruction).toContain("Use shares for praise only");
      expect(systemInstruction).toContain('Always output an empty string ("") for both fault and advice');
      expect(systemInstruction).toContain("Individual records are neutral facts");
      expect(systemInstruction).not.toContain("못한 점 후보");
    }
  });
});

describe("매운맛 한마디", () => {
  const team = [
    { id: "backup_slow", kind: "roast" as const, metric: "avgTradeLatency", fact: "백업 속도 평균 15.3초, 전체 팀 평균 10.4초로 평균보다 느립니다." },
    { id: "unknown_id", kind: "hype" as const, metric: "x", fact: "알 수 없는 재료입니다." },
  ];
  const members = [
    { name: "A", id: "member_damage_carry", kind: "hype" as const, metric: "damageShare", fact: "팀 딜 비중이 73%입니다." },
    { name: "B", id: "member_low_damage", kind: "roast" as const, metric: "damageShare", fact: "팀 딜 비중은 5%입니다." },
  ];

  it("매운맛은 재료 뒤에 서버가 쓴 한마디를 붙이고, 사실 문장은 그대로 둔다", () => {
    const block = formatSquadPunchlineBlock(team, members, { jabs: true });
    expect(block).toContain("backup_slow: 백업 속도 평균 15.3초, 전체 팀 평균 10.4초로 평균보다 느립니다. → 한마디: 아군이 쓰러지고 장례식 준비까지 끝난 뒤에야 도착하는 백업이었습니다.");
    expect(block).toContain("A [hype] member_damage_carry: 팀 딜 비중이 73%입니다. → 한마디: 화력 지분을 혼자 쓸어 담은 캐리입니다.");
  });

  it("한마디가 없는 재료와 낮은 딜 비중에는 붙이지 않는다", () => {
    const block = formatSquadPunchlineBlock(team, members, { jabs: true });
    const lines = block.split("\n");
    expect(lines).toContain("- [hype] unknown_id: 알 수 없는 재료입니다.");
    expect(lines).toContain("- B [roast] member_low_damage: 팀 딜 비중은 5%입니다.");
  });

  it("옵션이 없으면 한마디 없이 기존 모양 그대로다", () => {
    expect(formatSquadPunchlineBlock(team, members)).not.toContain("한마디");
  });

  it("프롬프트는 매운맛에만 한마디를 싣는다", () => {
    const promptFor = (coachingStyle: "spicy" | "mild") => buildSquadAiCoachingPrompt({
      groupKey: "KangHeeSung_",
      stats: { avgIsolation: null, avgTradeLatency: 15300, totalTradeKills: 4, totalTeammateKnocks: 10, totalRevives: 1, totalSmokeRescues: 0, avgCoverRate: null, totalTeamWipes: null },
      scores: { formation: null, backupSpeed: null, survivalCare: null, focusFire: null, teamWipe: null },
      roleProfiles: duoProfiles.map((profile) => ({ ...profile, role: "메인 딜러", roleDesc: "주력 화력" })),
      nickname: "KangHeeSung_",
      coachingStyle,
      squadGrade: null,
      benchmarkStats: { avgTradeLatency: 10400, avgReviveRate: 17, avgSmokeRate: 3.6, avgIsolation: null, avgTeamWipes: null, sampleCount: 900, scope: "team_population", teamMode: "duo", tier: null },
      matchCount: 5,
      teamMode: "duo",
    });
    expect(promptFor("spicy").prompt).toContain("→ 한마디:");
    expect(promptFor("mild").prompt).not.toContain("한마디");
    expect(promptFor("spicy").systemInstruction).toContain("must contain that 한마디");
  });
});
