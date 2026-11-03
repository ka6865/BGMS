import { describe, expect, it } from "vitest";
import { buildSquadMemberRecords, squadFaultCandidates, squadMemberFaultFeedback } from "@/lib/pubg-analysis/squadMemberRecords";
import { buildSquadObservationBlock } from "@/lib/pubg-analysis/squadMemberDistribution";
import { sanitizeSquadAbilityClaims } from "@/lib/pubg-analysis/squadAiPolicy";
import { applySquadEvidencePolicy } from "@/lib/pubg-analysis/squadAiEvidence";
import { squadSpicyMemberPraise } from "@/lib/pubg-analysis/squadPunchlines";

const keyOf = (name: string) => name.toLowerCase();
const KEYS = ["a", "b", "c"];
const team = (a: number, b: number, c: number) => [
  { name: "A", timeSurvived: a }, { name: "B", timeSurvived: b }, { name: "C", timeSurvived: c },
];
const build = (matches: Parameters<typeof buildSquadMemberRecords>[0]["matches"]) =>
  buildSquadMemberRecords({ matches, memberKeys: KEYS, selfKey: "a", keyOf });

describe("buildSquadMemberRecords", () => {
  it("경기마다 가장 먼저 죽은 팀원을 센다", () => {
    const records = build([
      { team: team(300, 900, 1200) },
      { team: team(500, 400, 1200) },
      { team: team(200, 800, 900) },
    ]);
    expect(records.get("a")?.firstDeaths).toEqual({ count: 2, matches: 3 });
    expect(records.get("b")?.firstDeaths).toEqual({ count: 1, matches: 3 });
    expect(records.get("c")?.firstDeaths).toEqual({ count: 0, matches: 3 });
  });

  it("동시 사망이나 측정 팀원이 2명 미만인 경기는 먼저 죽은 사람을 정하지 않는다", () => {
    const records = build([
      { team: team(700, 700, 900) },
      { team: [{ name: "A", timeSurvived: 100 }] },
      { team: [{ name: "A", timeSurvived: 0 }, { name: "B", timeSurvived: 500 }] },
    ]);
    expect(records.get("a")?.firstDeaths).toEqual({ count: 0, matches: 1 });
  });

  it("측정 가능한 경기가 없으면 null이다", () => {
    expect(build([{ team: [] }]).get("a")?.firstDeaths).toBeNull();
  });

  it("선제 타격은 본인에게만 붙이고 값이 없는 경기는 실패로 세지 않는다", () => {
    const records = build([
      { team: [], initiative_rate: 50, initiativeSampleCount: 4 },
      { team: [], initiative_rate: 25, initiativeSampleCount: 4 },
      { team: [], initiative_rate: null, initiativeSampleCount: 5 },
      { team: [], initiative_rate: 150, initiativeSampleCount: 5 },
    ]);
    expect(records.get("a")?.initiative).toEqual({ successes: 3, attempts: 8, matches: 2 });
    expect(records.get("b")?.initiative).toBeNull();
  });
});

describe("기절·사망 시점 팀원 거리 집계", () => {
  const sample = (nearest: number | null, alive = 2) => ({ atMs: 1_000, nearestAliveTeammateM: nearest, aliveTeammateCount: alive, locationAgeMs: nearest === null ? null : 3_000 });
  const ctx = (atKnock: ReturnType<typeof sample> | null, atDeath: ReturnType<typeof sample> | null) => ({ team: [], deathContext: { atKnock, atDeath } });

  it("기절 시점 거리를 우선하고, 쓸 수 없으면 사망 시점 거리를 쓴다", () => {
    const records = build([
      ctx(sample(120), sample(10)),
      ctx(sample(null), sample(90)),
      ctx(null, sample(20)),
    ]);
    expect(records.get("a")?.farFromTeam).toEqual({ count: 2, measured: 3 });
    expect(records.get("b")?.farFromTeam).toBeNull();
  });

  it("생존 팀원이 없었거나 거리가 비어 있거나 기록이 없는 경기는 측정된 경기에 넣지 않는다", () => {
    const records = build([
      ctx(null, sample(null, 0)),
      ctx(null, sample(null, 2)),
      { team: [], deathContext: null },
      { team: [] },
      ctx(null, sample(79.9)),
    ]);
    expect(records.get("a")?.farFromTeam).toEqual({ count: 0, measured: 1 });
  });

  it("측정된 경기가 없으면 null이다", () => {
    expect(build([{ team: [], deathContext: null }]).get("a")?.farFromTeam).toBeNull();
  });
});

describe("squadFaultCandidates", () => {
  const member = (name: string, records: Parameters<typeof squadFaultCandidates>[0][number]["records"]) => ({ name, records });

  it("선제 타격 성공이 시도의 절반 미만이고 시도가 6회 이상일 때만 후보가 된다", () => {
    const low = squadFaultCandidates([member("A", { firstDeaths: null, initiative: { successes: 2, attempts: 8, matches: 3 }, farFromTeam: null })]);
    expect(low.get("A")).toEqual(["선제 타격 시도 8회 중 2회만 성공했습니다."]);
    const half = squadFaultCandidates([member("A", { firstDeaths: null, initiative: { successes: 4, attempts: 8, matches: 3 }, farFromTeam: null })]);
    expect(half.get("A")).toEqual([]);
    const few = squadFaultCandidates([member("A", { firstDeaths: null, initiative: { successes: 0, attempts: 5, matches: 3 }, farFromTeam: null })]);
    expect(few.get("A")).toEqual([]);
  });

  it("멀리 떨어진 기절·사망은 측정 3경기 이상이고 절반 이상일 때만 후보가 된다", () => {
    const far = (count: number, measured: number) => squadFaultCandidates([member("A", { firstDeaths: null, initiative: null, farFromTeam: { count, measured } })]).get("A");
    expect(far(3, 5)).toEqual(["기절·사망 순간 가장 가까운 생존 팀원이 80m 밖에 있던 경기가 측정된 5경기 중 3경기입니다."]);
    expect(far(2, 5)).toEqual([]);
    expect(far(2, 2)).toEqual([]);
  });

  it("첫 사망은 단독 최다이고 3경기 이상, 비교 경기의 40% 이상일 때만 후보가 된다", () => {
    const some = (a: number, b: number) => [
      member("A", { firstDeaths: { count: a, matches: 7 }, initiative: null, farFromTeam: null }),
      member("B", { firstDeaths: { count: b, matches: 7 }, initiative: null, farFromTeam: null }),
    ];
    expect(squadFaultCandidates(some(3, 1)).get("A")).toEqual(["팀에서 가장 먼저 사망한 경기가 비교한 7경기 중 3경기로 팀 최다입니다."]);
    expect(squadFaultCandidates(some(3, 3)).get("A")).toEqual([]);
    expect(squadFaultCandidates(some(2, 1)).get("A")).toEqual([]);
  });
});

describe("squadFaultCandidates 말투", () => {
  const records = { firstDeaths: { count: 4, matches: 7 }, initiative: { successes: 7, attempts: 21, matches: 7 }, farFromTeam: { count: 4, measured: 6 } };
  const members = [{ name: "A", records }, { name: "B", records: { firstDeaths: { count: 1, matches: 7 }, initiative: null, farFromTeam: null } }];

  it("다정한맛은 기록만 쓰고, 매운맛은 같은 기록 뒤에 비꼬는 한마디가 붙는다", () => {
    const mild = squadFaultCandidates(members, "mild").get("A")!;
    const spicy = squadFaultCandidates(members, "spicy").get("A")!;
    expect(mild).toHaveLength(3);
    expect(spicy).toHaveLength(3);
    // 같은 숫자를 쓰고, 한마디는 같은 문장 안에 붙는다(문장 수는 같다).
    for (const digits of [["6", "4"], ["7", "4"], ["21", "7"]]) {
      const index = [["6", "4"], ["7", "4"], ["21", "7"]].findIndex(entry => entry.join() === digits.join());
      digits.forEach(digit => { expect(mild[index]).toContain(digit); expect(spicy[index]).toContain(digit); });
    }
    expect(mild.join("")).not.toContain("상습 1위");
    expect(spicy.join(" ")).toContain("아군은 같은 판에 있었는데 거리는 다른 판이었습니다.");
    expect(spicy.join(" ")).toContain("첫 퇴장 부문 상습 1위입니다.");
    expect(spicy.join(" ")).toContain("선제권은 상대가 더 자주 챙겨 갔습니다.");
    spicy.forEach(text => expect(text.match(/[.!?]/g)).toHaveLength(1));
  });

  it("후보가 없는 팀원은 말투와 상관없이 비어 있다", () => {
    expect(squadFaultCandidates(members, "spicy").get("B")).toEqual([]);
  });

  it("거리가 가장 앞, 첫 사망, 선제 타격 순서다", () => {
    const texts = squadFaultCandidates(members, "mild").get("A")!;
    expect(texts[0]).toContain("80m 밖");
    expect(texts[1]).toContain("가장 먼저 사망");
    expect(texts[2]).toContain("선제 타격");
  });

  it("매운맛 문장도 후처리를 그대로 통과한다", () => {
    const fault = squadFaultCandidates(members, "spicy").get("A")!.join(" ");
    const input = { memberFeedbacks: [{ name: "A", praise: "딜 43%로 화력의 한 축을 맡았습니다.", fault, advice: "다음 교전 전에 가장 가까운 아군의 위치를 확인해 보세요." }] };
    expect(sanitizeSquadAbilityClaims(input)).toEqual(input);
  });
});

describe("개인 기록을 담은 관측 블록", () => {
  const profiles = [
    { name: "A", shares: { damage: 40, kill: 40, assist: 30, dbno: 40 }, records: { firstDeaths: { count: 4, matches: 7 }, initiative: { successes: 2, attempts: 9, matches: 5 }, farFromTeam: null } },
    { name: "B", shares: { damage: 30, kill: 30, assist: 30, dbno: 30 }, records: { firstDeaths: { count: 1, matches: 7 }, initiative: null, farFromTeam: null } },
    { name: "C", shares: { damage: 30, kill: 30, assist: 40, dbno: 30 }, records: { firstDeaths: { count: 0, matches: 7 }, initiative: null, farFromTeam: null } },
  ];

  it("개인 기록만 팀원 줄 아래에 적고, 못한 점 후보 문장은 모델에게 주지 않는다", () => {
    const block = buildSquadObservationBlock({ roleProfiles: profiles });
    expect(block).toContain("  개인 기록: 팀에서 가장 먼저 사망 4/7경기 · 선제 타격 9회 중 2회 성공");
    expect(block).not.toContain("못한 점 후보");
  });

  it("후보 문장은 보류 문장으로 바뀌지 않고, 비중 지목은 여전히 막는다", () => {
    const input = { memberFeedbacks: [{
      name: "A",
      praise: "딜 40%로 화력의 한 축을 맡았습니다.",
      fault: "선제 타격 시도 9회 중 2회만 성공했습니다.",
      advice: "먼저 사격할 수 있는 각도와 상대 위치를 확인해 보세요.",
    }] };
    expect(sanitizeSquadAbilityClaims(input)).toEqual(input);
  });
});

describe("기절·사망 시점 거리를 담은 관측 블록", () => {
  const profiles = [
    { name: "A", shares: { damage: 40, kill: 40, assist: 30, dbno: 40 }, records: { firstDeaths: null, initiative: null, farFromTeam: { count: 4, measured: 6 } } },
    { name: "B", shares: { damage: 60, kill: 60, assist: 70, dbno: 60 }, records: { firstDeaths: null, initiative: null, farFromTeam: null } },
  ];

  it("개인 기록을 본인 줄 아래에만 적고 후보 문장은 싣지 않는다", () => {
    const block = buildSquadObservationBlock({ roleProfiles: profiles });
    expect(block).toContain("  개인 기록: 기절·사망 시점 가장 가까운 생존 팀원 80m 이상 4/6경기");
    expect(block).not.toContain("못한 점 후보");
    expect(block.split("\n").filter(line => line.includes("개인 기록"))).toHaveLength(1);
  });

  it("후보 문장과 조건부 확인 조언은 후처리를 그대로 통과한다", () => {
    const input = { memberFeedbacks: [{
      name: "A",
      praise: "딜 40%로 화력의 한 축을 맡았습니다.",
      fault: "기절·사망 순간 가장 가까운 생존 팀원이 80m 밖에 있던 경기가 측정된 6경기 중 4경기입니다.",
      advice: "다음 교전 전에 가장 가까운 아군의 위치를 확인해 보세요.",
    }] };
    expect(sanitizeSquadAbilityClaims(input)).toEqual(input);
  });
});

describe("서버가 쓰는 개인 못한 점과 조언", () => {
  const records = { firstDeaths: { count: 4, matches: 7 }, initiative: { successes: 7, attempts: 21, matches: 7 }, farFromTeam: { count: 4, measured: 6 } };
  const roleProfiles = [
    { name: "A", shares: { damage: 43, kill: 36, assist: 32, dbno: 50 }, records },
    { name: "B", shares: { damage: 28, kill: 26, assist: 37, dbno: 25 }, records: { firstDeaths: { count: 1, matches: 7 }, initiative: null, farFromTeam: null } },
  ];
  const modelResult = {
    summary: "요약", strength: "강점", weakness: "", coaching: "", overallOpinion: "총평",
    memberFeedbacks: [
      { name: "A", praise: "딜 43%로 화력의 한 축을 맡았습니다.", fault: "선제권 확보가 저조했습니다.", advice: "아군의 위치를 80m 이내로 유지하세요." },
      { name: "B", praise: "어시스트 37%로 지원했습니다.", fault: "어시스트 비중이 낮습니다.", advice: "더 분발하세요." },
    ],
  };
  const stats = { avgTradeLatency: 9000, totalTradeKills: 12, totalTeammateKnocks: 41, totalRevives: 19 };

  it("모델이 쓴 못한 점과 조언은 버리고 서버 문장으로 바꾼다", () => {
    const result: any = applySquadEvidencePolicy(modelResult, stats, "B", undefined, roleProfiles, { coachingStyle: "mild" });
    const [a, b] = result.memberFeedbacks;
    expect(a.praise).toBe(modelResult.memberFeedbacks[0].praise);
    expect(a.fault).toBe(squadMemberFaultFeedback(roleProfiles, "mild").get("A")!.fault);
    expect(a.fault).toContain("80m 밖");
    expect(a.advice).toBe("다음 교전 전에 가장 가까운 아군의 위치를 확인해 보세요.");
    expect(b.fault).toBe("");
    expect(b.advice).toBe("");
  });

  it("매운맛은 서버가 붙인 한마디까지 그대로 나가고 두 번 적용해도 같다", () => {
    const once: any = applySquadEvidencePolicy(modelResult, stats, "B", undefined, roleProfiles, { coachingStyle: "spicy" });
    expect(once.memberFeedbacks[0].fault).toContain("아군은 같은 판에 있었는데 거리는 다른 판이었습니다.");
    expect(once.memberFeedbacks[0].fault).toContain("첫 퇴장 부문 상습 1위입니다.");
    expect(once.memberFeedbacks[0].fault).toContain("선제권은 상대가 더 자주 챙겨 갔습니다.");
    expect(applySquadEvidencePolicy(once, stats, "B", undefined, roleProfiles, { coachingStyle: "spicy" })).toEqual(once);
  });

  it("조언은 맨 앞 후보 종류에 맞는 문장 하나다", () => {
    const onlyFirstDeath = [{ name: "A", shares: roleProfiles[0].shares, records: { ...records, farFromTeam: null, initiative: null } }, roleProfiles[1]];
    expect(squadMemberFaultFeedback(onlyFirstDeath, "mild").get("A")!.advice).toBe("다음 교전에서는 아군이 함께 사격할 수 있는지 확인한 뒤 들어가 보세요.");
    const onlyInitiative = [{ name: "A", shares: roleProfiles[0].shares, records: { ...records, farFromTeam: null, firstDeaths: null } }, roleProfiles[1]];
    expect(squadMemberFaultFeedback(onlyInitiative, "mild").get("A")!.advice).toBe("먼저 사격할 수 있는 각도와 상대 위치를 확인해 보세요.");
  });

  it("개인 기록이 없는 roleProfiles는 모델 문장을 기존 규칙대로 거른다", () => {
    const legacy = roleProfiles.map(({ name, shares }) => ({ name, shares }));
    const result: any = applySquadEvidencePolicy(modelResult, stats, "B", undefined, legacy, { coachingStyle: "mild" });
    expect(result.memberFeedbacks[0].fault).toBe("선제권 확보가 저조했습니다.");
  });
});

describe("매운맛 개인 칭찬", () => {
  const punch = (id: string, kind: "hype" | "roast", fact: string, name = "A") => ({ name, id, kind, fact });

  it("높은 비중과 꾸준한 팀원에게만 사실 문장과 한마디를 한 문장으로 잇는다", () => {
    expect(squadSpicyMemberPraise(punch("member_damage_carry", "hype", "팀 딜 비중이 73%입니다."))).toMatch(/^팀 딜 비중이 73%, .+입니다\.$/);
    expect(squadSpicyMemberPraise(punch("member_kill_log", "roast", "팀 딜 비중은 5%인데 팀 킬 비중은 60%입니다."))).toBe("팀 딜 비중은 5%인데 팀 킬 비중은 60%, 킬로그 배달부 기록입니다.");
    expect(squadSpicyMemberPraise(punch("member_low_damage", "roast", "팀 딜 비중은 5%입니다."))).toBeNull();
  });

  it("같은 재료여도 팀원 이름에 따라 한마디가 달라지고, 같은 이름은 항상 같다", () => {
    const names = ["KangHeeSung_", "ckadmfdls__", "MiaeQ_Q", "Suk-Cun", "Player_A", "Player_B"];
    const lines = names.map(name => squadSpicyMemberPraise(punch("member_steady", "hype", "팀 딜 비중 28%, 팀 킬 비중 26%입니다.", name)));
    expect(new Set(lines).size).toBeGreaterThan(1);
    expect(squadSpicyMemberPraise(punch("member_steady", "hype", "팀 딜 비중 28%, 팀 킬 비중 26%입니다.", "MiaeQ_Q"))).toBe(lines[2]);
  });

  it("정책은 매운맛에서만 칭찬을 서버 문장으로 확정하고 다정한맛은 모델 문장을 둔다", () => {
    const profiles = [
      { name: "A", totalKills: 8, shares: { damage: 75, kill: 75, assist: 50, dbno: 75 }, records: null },
      { name: "B", totalKills: 6, shares: { damage: 25, kill: 25, assist: 50, dbno: 25 }, records: null },
    ];
    const result = { summary: "요약", strength: "", weakness: "", coaching: "", overallOpinion: "총평",
      memberFeedbacks: [{ name: "A", praise: "모델이 쓴 평범한 칭찬입니다.", fault: "", advice: "" }, { name: "B", praise: "모델이 쓴 칭찬입니다.", fault: "", advice: "" }] };
    const stats = { avgTradeLatency: 9000, totalTradeKills: 12, totalTeammateKnocks: 41, totalRevives: 19 };
    const spicy: any = applySquadEvidencePolicy(result, stats, "B", undefined, profiles, { coachingStyle: "spicy" });
    expect(spicy.memberFeedbacks[0].praise).toContain("팀 딜 비중이 75%");
    expect(spicy.memberFeedbacks[0].praise).not.toContain("모델이 쓴");
    expect(applySquadEvidencePolicy(spicy, stats, "B", undefined, profiles, { coachingStyle: "spicy" })).toEqual(spicy);
    const mild: any = applySquadEvidencePolicy(result, stats, "B", undefined, profiles, { coachingStyle: "mild" });
    expect(mild.memberFeedbacks[0].praise).toBe("모델이 쓴 평범한 칭찬입니다.");
  });
});
