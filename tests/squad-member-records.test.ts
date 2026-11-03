import { describe, expect, it } from "vitest";
import { buildSquadMemberRecords, squadFaultCandidates } from "@/lib/pubg-analysis/squadMemberRecords";
import { buildSquadObservationBlock } from "@/lib/pubg-analysis/squadMemberDistribution";
import { sanitizeSquadAbilityClaims } from "@/lib/pubg-analysis/squadAiPolicy";

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
    expect(far(3, 5)).toEqual(["기절하거나 사망한 순간 가장 가까운 생존 팀원이 80m 이상 떨어져 있던 경기가 측정된 5경기 중 3경기입니다."]);
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

describe("개인 기록을 담은 관측 블록", () => {
  const profiles = [
    { name: "A", shares: { damage: 40, kill: 40, assist: 30, dbno: 40 }, records: { firstDeaths: { count: 4, matches: 7 }, initiative: { successes: 2, attempts: 9, matches: 5 }, farFromTeam: null } },
    { name: "B", shares: { damage: 30, kill: 30, assist: 30, dbno: 30 }, records: { firstDeaths: { count: 1, matches: 7 }, initiative: null, farFromTeam: null } },
    { name: "C", shares: { damage: 30, kill: 30, assist: 40, dbno: 30 }, records: { firstDeaths: { count: 0, matches: 7 }, initiative: null, farFromTeam: null } },
  ];

  it("개인 기록과 서버가 고른 못한 점 후보를 팀원 줄 아래에 적는다", () => {
    const block = buildSquadObservationBlock({ roleProfiles: profiles });
    expect(block).toContain("  개인 기록: 팀에서 가장 먼저 사망 4/7경기 · 선제 타격 9회 중 2회 성공");
    expect(block).toContain("  못한 점 후보: 팀에서 가장 먼저 사망한 경기가 비교한 7경기 중 4경기로 팀 최다입니다.");
    expect(block).toContain("  못한 점 후보: 선제 타격 시도 9회 중 2회만 성공했습니다.");
    expect(block.split("\n").filter(line => line.includes("못한 점 후보"))).toHaveLength(2);
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

  it("개인 기록과 못한 점 후보를 본인 줄 아래에 적고 팀원에게는 붙이지 않는다", () => {
    const block = buildSquadObservationBlock({ roleProfiles: profiles });
    expect(block).toContain("  개인 기록: 기절·사망 시점 가장 가까운 생존 팀원 80m 이상 4/6경기");
    expect(block).toContain("  못한 점 후보: 기절하거나 사망한 순간 가장 가까운 생존 팀원이 80m 이상 떨어져 있던 경기가 측정된 6경기 중 4경기입니다.");
    expect(block.split("\n").filter(line => line.includes("못한 점 후보"))).toHaveLength(1);
  });

  it("후보 문장과 조건부 확인 조언은 후처리를 그대로 통과한다", () => {
    const input = { memberFeedbacks: [{
      name: "A",
      praise: "딜 40%로 화력의 한 축을 맡았습니다.",
      fault: "기절하거나 사망한 순간 가장 가까운 생존 팀원이 80m 이상 떨어져 있던 경기가 측정된 6경기 중 4경기입니다.",
      advice: "다음 교전 전에 가장 가까운 아군의 위치를 확인해 보세요.",
    }] };
    expect(sanitizeSquadAbilityClaims(input)).toEqual(input);
  });
});
