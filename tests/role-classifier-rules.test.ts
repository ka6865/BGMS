import { describe, expect, it } from "vitest";
import { classifyRole, extractRoleMetrics } from "@/lib/pubg-analysis/roleClassifier";
import { referencePercentile, roleScorePercentile, ROLE_REFERENCE_QUANTILES, ROLE_SCORE_QUANTILES } from "@/lib/pubg-analysis/roleReference";

// ai-summary route의 aggregateMatches 결과 형식을 따른다(측정 불가 값은 "측정 불가" 문자열 또는 null).
// 기본 입력은 아무 지표도 판정할 수 없는 상태다.
const BASE = {
  mLen: 1,
  modeDistribution: { main: "squad" },
  avgReactionLatency: "측정 불가",
  avgBackupLatency: "측정 불가",
  userInitiativeRate: null,
  totalInitiativeAttempts: 0,
  avgDuelWinRate: null,
  totalDuelWins: 0,
  totalDuelLosses: 0,
  userReversalRate: null,
  totalReversalAttempts: 0,
  totalDistanceDamage: { short: 0, mid: 0, long: 0 },
  totalMaxHitDist: null,
  totalTeammateKnocks: 0,
  totalRevCount: 0,
  totalSmokeRescues: 0,
  totalTradeKills: 0,
  avgPressureIndex: null,
  avgPlacementPct: null,
  totalEdgePlay: null,
  goldenTimeAvg: { early: 0, mid1: 0, mid2: 0, late: 0 },
  totalBaitCount: null,
  totalSuppCount: null,
  totalUtilityHits: null,
  totalLethalThrows: null,
  avgTeamDamageShare: null,
  totalFocusFireCount: null,
  killContribFinal: { solo: 0, cleanup: 0, assist: 0 },
  totalRidingShotKnocks: 0,
  totalRidingShotKills: 0,
  totalLeadShotKnocks: 0,
  totalLeadShotKills: 0,
  vehicleCombatMatchCount: 0,
  weaponStatsFinal: {},
  weaponMatchCount: {},
};

const ROLE_EVIDENCE = {
  teamMatchCount: 3,
  version: 1, matchCount: 3, validWeaponHits: 6, distanceHitCount: 3,
  distanceDamage: { short: 100, mid: 100, long: 100 }, maxHitDist: 250, pressureIndex: 1,
  focusFireCount: 3, rescueCount: 1, rescueOpportunityCount: 3, positionSampleCount: 3,
  edgePlayCount: 1, goldenTimeDamage: { early: 100, mid1: 100, mid2: 50, late: 50 },
  metricMatchCounts: {
    initiative: 3, duelWin: 3, reversal: 3, tradeRate: 3, placement: 3,
    baitPerMatch: 3, supportPerMatch: 3, teamDamageShare: 3, assistShare: 3,
  },
};
const CANDIDATE_REFERENCE = {
  evidenceVersion: 1 as const,
  metrics: Object.fromEntries(Object.keys(ROLE_REFERENCE_QUANTILES).map((key) => [key, [0,10,20,30,40,50,60,70,80,90,100]])),
  roles: Object.fromEntries(Object.keys(ROLE_SCORE_QUANTILES).map((key) => [key, [0,10,20,30,40,50,60,70,80,90,100]])),
};

const classify = (overrides: Record<string, unknown> = {}, tier = "B") => classifyRole({ ...BASE, ...overrides }, {}, tier);

const TEAM_EVIDENCE = {matchCount:3,rescueCount:3,rescueOpportunityCount:3,teamDamageShare:40,teamDamageShareMatches:3,
  tradeKills:0,teammateKnocks:3,tradeRateMatches:3,tradeLatencySec:null,tradeLatencyMatches:0,
  baitPerMatch:0,supportPerMatch:0,supportMatches:3,focusFirePerMatch:0,assistShare:null,crossfireMatches:3};
const V2_REFERENCE = {...CANDIDATE_REFERENCE,evidenceVersion:2 as const};

describe("role-specific candidate opportunities", () => {
  it("judges rescue evidence without requiring gun hits, while preserving v1", () => {
    const roleEvidence={...ROLE_EVIDENCE,version:2,validWeaponHits:0,distanceHitCount:0,maxHitDist:null,pressureIndex:null,
      distanceDamage:{short:0,mid:0,long:0},team:TEAM_EVIDENCE};
    const stats={...BASE,mLen:3,roleEvidence};
    expect(classifyRole(stats,null,"B",V2_REFERENCE)).toMatchObject({primaryRole:"shield",status:"confirmed",presentation:"role"});
    expect(classifyRole(stats,null,"B",CANDIDATE_REFERENCE).status).toBe("insufficient");
  });
  it("uses actual observed team games and withholds only the incomplete team metric", () => {
    const stats={...BASE,mLen:3,roleEvidence:{...ROLE_EVIDENCE,version:2,team:{...TEAM_EVIDENCE,matchCount:2,teamDamageShareMatches:2,
      tradeRateMatches:1,supportMatches:2,crossfireMatches:2}}};
    expect(extractRoleMetrics(stats,2)).toMatchObject({rescueRate:100,teamDamageShare:40,tradeRate:null});
    expect(extractRoleMetrics({...stats,roleEvidence:{...stats.roleEvidence,team:{...stats.roleEvidence.team,matchCount:0}}},2).teamDamageShare).toBeNull();
  });
  it("explains observed distance facts without issuing a title below 85", () => {
    const result=classifyRole({...BASE,mLen:3,roleEvidence:{...ROLE_EVIDENCE,version:2,distanceDamage:{short:210,mid:60,long:30},team:TEAM_EVIDENCE}},null,"B",{evidenceVersion:2,metrics:{},roles:{}});
    expect(result).toMatchObject({status:"pending",primaryRole:"pending",presentation:"observed",title:"근거리 교전 중심"});
    expect(result.description).toContain("70.0%");
    expect(result.description).toContain("3경기");
    expect(result.reason).toContain("비교 자료");
  });
  it("requires linked lethal throw opportunities and rejects malformed v2 evidence", () => {
    const stats={...BASE,mLen:3,totalLethalThrows:2,totalUtilityHits:1,roleEvidence:{...ROLE_EVIDENCE,version:2,team:TEAM_EVIDENCE}};
    expect(extractRoleMetrics(stats,2).utilityHitsPerMatch).toBeNull();
    expect(extractRoleMetrics({...stats,totalLethalThrows:3},2).utilityHitsPerMatch).toBeCloseTo(1/3);
    expect(classifyRole({...stats,roleEvidence:{...stats.roleEvidence,team:{...TEAM_EVIDENCE,rescueCount:4}}},null,"B",V2_REFERENCE).status).toBe("insufficient");
    expect(classifyRole({...stats,mLen:2},null,"B",V2_REFERENCE).status).toBe("insufficient");
  });
  it("reports observed losses without inventing a distance specialty", () => {
    const roleEvidence={...ROLE_EVIDENCE,version:2,validWeaponHits:0,distanceHitCount:0,maxHitDist:null,pressureIndex:null,
      distanceDamage:{short:0,mid:0,long:0},team:{...TEAM_EVIDENCE,matchCount:0,teamDamageShareMatches:0,tradeRateMatches:0,supportMatches:0,crossfireMatches:0,tradeLatencyMatches:0}};
    const result=classifyRole({...BASE,mLen:3,totalDuelWins:0,totalDuelLosses:3,avgDuelWinRate:0,roleEvidence},null,"B",{evidenceVersion:2,metrics:{},roles:{}});
    expect(result).toMatchObject({status:"pending",presentation:"observed",title:"상대별 교전 기록",observedRoles:[]});
    expect(result.description).toContain("승리 0회, 패배 3회");
  });
});

// 기준 분포 95백분위를 넘는 값(백분위 97.5).
const STRONG_EXECUTOR = { avgDuelWinRate: 95, totalDuelWins: 19, totalDuelLosses: 1, userReversalRate: 50, totalReversalAttempts: 4 };
const STRONG_POINT_MAN = { userInitiativeRate: 80, totalInitiativeAttempts: 10, avgReactionLatency: "0.90s" };
// 기준 분포 중앙값(백분위 50).
const MEDIAN_EXECUTOR = { avgDuelWinRate: 70, totalDuelWins: 7, totalDuelLosses: 3, userReversalRate: 12.5, totalReversalAttempts: 8 };

describe("reference percentile", () => {
  it("interpolates between quantiles and clamps outside the observed range", () => {
    expect(referencePercentile("duelWin", 70)).toBe(50);
    expect(referencePercentile("duelWin", 72)).toBeCloseTo(50 + (2 / 3.684) * 10, 5);
    expect(referencePercentile("duelWin", 10)).toBe(2.5);
    expect(referencePercentile("duelWin", 99)).toBe(97.5);
  });

  it("uses the middle of a tied block such as many zero values", () => {
    // reversal 0은 5·10·20백분위에 걸쳐 있다.
    expect(referencePercentile("reversal", 0)).toBe(10);
    // reactionSec 3초는 90·95백분위에 걸쳐 있다(측정 상한).
    expect(referencePercentile("reactionSec", 3)).toBe(95);
    // 복수자 역할 점수 17.84는 5~30백분위에 걸쳐 있다.
    expect(roleScorePercentile("avenger", 17.84)).toBe(15);
  });
});

describe("legacy and candidate boundaries", () => {
  it("does not activate a new role definition just because new observations exist", () => {
    const stats={...BASE,...STRONG_EXECUTOR};
    expect(classifyRole({...stats,roleEvidence:ROLE_EVIDENCE},{},"B")).toEqual(classifyRole(stats,{},"B"));
  });
  it("keeps a missing comparison distribution pending instead of blaming the player", () => {
    const result=classifyRole({...BASE,mLen:3,roleEvidence:ROLE_EVIDENCE},null,"B",{evidenceVersion:1,metrics:{},roles:{}});
    expect(result).toMatchObject({primaryRole:"pending",status:"pending"});
    expect(result.reason).toContain("비교 자료");
  });
});

it("withholds team roles when the selected squad matches have no actual teammates", () => {
  const result=classifyRole({...BASE,mLen:3,avgTeamDamageShare:100,roleEvidence:{...ROLE_EVIDENCE,teamMatchCount:0}},null,"B",CANDIDATE_REFERENCE);
  expect(result.scores.mainGun).toBeNull();
});

it("names candidate support and early combat roles after observed actions", () => {
  const support=classifyRole({...BASE,mLen:3,totalBaitCount:999,totalSuppCount:999,roleEvidence:ROLE_EVIDENCE},null,"B",CANDIDATE_REFERENCE);
  expect(support.primaryRole).toBe("decoy");
  expect(support.title).toBe("전우의 지원군");
  expect(support.roleLabel).toContain("대응 지원가");
  const early=classifyRole({...BASE,mLen:3,roleEvidence:{...ROLE_EVIDENCE,goldenTimeDamage:{early:600,mid1:0,mid2:0,late:0}}},null,"B",CANDIDATE_REFERENCE);
  expect(early.primaryRole).toBe("dropPredator");
  expect(early.title).toBe("초반의 공격수");
});

describe("role metric extraction", () => {
  it("withholds metrics below their minimum opportunities", () => {
    const metrics = extractRoleMetrics({
      ...BASE,
      avgDuelWinRate: 100, totalDuelWins: 2, totalDuelLosses: 0,
      userInitiativeRate: 100, totalInitiativeAttempts: 2,
      totalTeammateKnocks: 2, totalRevCount: 2,
      totalDistanceDamage: { short: 200, mid: 0, long: 0 },
      killContribFinal: { solo: 1, cleanup: 0, assist: 1 },
    });
    expect(metrics).toMatchObject({ duelWin: null, initiative: null, rescueRate: null, tradeRate: null, shortShare: null, longShare: null, assistShare: null });
  });

  it("converts totals into shares and per-match rates", () => {
    const metrics = extractRoleMetrics({
      ...BASE,
      mLen: 4,
      totalTeammateKnocks: 4, totalRevCount: 1, totalSmokeRescues: 1, totalTradeKills: 1,
      totalDistanceDamage: { short: 300, mid: 100, long: 100 },
      totalEdgePlay: 8, totalUtilityHits: 2, avgBackupLatency: "12.50s",
      goldenTimeAvg: { early: 50, mid1: 25, mid2: 25, late: 0 },
      killContribFinal: { solo: 3, cleanup: 0, assist: 1 },
    });
    expect(metrics).toMatchObject({
      rescueRate: 50, tradeRate: 25, shortShare: 60, longShare: 20, edgePerMatch: 2,
      utilityHitsPerMatch: 0.5, tradeSec: 12.5, earlyShare: 50, assistShare: 25,
    });
  });
});

describe("evidence-version 1 role metrics", () => {
  it("uses only complete, versioned observations and measured reaction", () => {
    const metrics = extractRoleMetrics({
      ...BASE, mLen: 3, avgMeasuredReactionLatency: "1.25s", avgReactionLatency: "2.99s",
      userInitiativeRate: 80, avgDuelWinRate: 70, userReversalRate: 40,
      avgPlacementPct: 75, totalBaitCount: 6, totalSuppCount: 3, avgTeamDamageShare: 55,
      totalInitiativeAttempts: 99, totalDuelWins: 99, totalReversalAttempts: 99,
      totalTeammateKnocks: 99, totalRevCount: 99, totalSmokeRescues: 99,
      totalDistanceDamage: { short: 999, mid: 0, long: 0 }, totalMaxHitDist: 999,
      avgPressureIndex: 99, totalEdgePlay: 99, totalFocusFireCount: 99,
      totalUtilityHits: 3, totalLethalThrows: 6,
      killContribFinal: { solo: 0, cleanup: 0, assist: 3 },
      roleEvidence: ROLE_EVIDENCE,
    }, 1);
    expect(metrics).toMatchObject({
      initiative: 80, reactionSec: 1.25, duelWin: 70, reversal: 40,
      longShare: 100 / 3, shortShare: 100 / 3, maxHitDist: 250,
      rescueRate: 100 / 3, tradeRate: 0, pressure: 1, edgePerMatch: 100 / 3,
      earlyShare: 100 / 3, baitPerMatch: 2, supportPerMatch: 1,
      utilityHitsPerMatch: 1, lethalPerMatch: 2, teamDamageShare: 55,
      focusFirePerMatch: 1, assistShare: 100,
    });
  });

  it("withholds legacy-derived values unless every selected match is observed", () => {
    const roleEvidence = { ...ROLE_EVIDENCE, metricMatchCounts: { ...ROLE_EVIDENCE.metricMatchCounts, initiative: 2, duelWin: 2, reversal: 2, tradeRate: 2, placement: 2, baitPerMatch: 2, supportPerMatch: 2, teamDamageShare: 2, assistShare: 2 } };
    const metrics = extractRoleMetrics({
      ...BASE, mLen: 3, avgMeasuredReactionLatency: "1.25s", userInitiativeRate: 100,
      avgDuelWinRate: 100, userReversalRate: 100, avgPlacementPct: 100,
      totalBaitCount: 9, totalSuppCount: 9, avgTeamDamageShare: 100,
      killContribFinal: { assist: 9 }, roleEvidence,
    }, 1);
    expect(metrics).toMatchObject({ initiative: null, reactionSec: 1.25, duelWin: null, reversal: null, placement: null, baitPerMatch: null, supportPerMatch: null, teamDamageShare: null, assistShare: null });
  });

  it("preserves initiative, duel and reversal minimum opportunities", () => {
    const stats = {
      ...BASE, mLen: 3, roleEvidence: ROLE_EVIDENCE,
      userInitiativeRate: 100, totalInitiativeAttempts: 2,
      avgDuelWinRate: 100, totalDuelWins: 2, totalDuelLosses: 0,
      userReversalRate: 100, totalReversalAttempts: 1,
      avgMeasuredReactionLatency: "1.2s",
    };
    expect(extractRoleMetrics(stats, 1)).toMatchObject({ initiative: null, duelWin: null, reversal: null, reactionSec: 1.2 });
  });

  it("rejects malformed evidence and requires measured opportunity denominators", () => {
    const malformed = { ...ROLE_EVIDENCE, rescueCount: 4, rescueOpportunityCount: 3 };
    expect(Object.values(extractRoleMetrics({ ...BASE, roleEvidence: malformed }, 1)).every((value) => value === null)).toBe(true);
    const noOpportunities = { ...ROLE_EVIDENCE, distanceHitCount: 0, maxHitDist: 600, positionSampleCount: 0, edgePlayCount: 4, rescueOpportunityCount: 2 };
    expect(extractRoleMetrics({ ...BASE, roleEvidence: noOpportunities }, 1)).toMatchObject({ maxHitDist: null, edgePerMatch: null, rescueRate: null });
    for (const invalid of [
      { ...ROLE_EVIDENCE, validWeaponHits: 5.5 },
      { ...ROLE_EVIDENCE, distanceHitCount: 7 },
      { ...ROLE_EVIDENCE, edgePlayCount: 4 },
      { ...ROLE_EVIDENCE, metricMatchCounts: { ...ROLE_EVIDENCE.metricMatchCounts, duelWin: 4 } },
    ]) expect(Object.values(extractRoleMetrics({ ...BASE, mLen: 3, roleEvidence: invalid }, 1)).every((value) => value === null)).toBe(true);
    expect(Object.values(extractRoleMetrics({ ...BASE, mLen: 0, roleEvidence: { ...ROLE_EVIDENCE, matchCount: 0 } }, 1)).every((value) => value === null)).toBe(true);
  });
});

describe("candidate evidence classifier", () => {
  it("keeps unversioned and legacy classification unchanged", () => {
    expect(classify(STRONG_EXECUTOR).primaryRole).toBe("executor");
    expect(extractRoleMetrics({ ...BASE, ...STRONG_EXECUTOR, roleEvidence: ROLE_EVIDENCE }).duelWin).toBe(95);
  });

  it("withholds malformed references and candidate evidence below baseline minimums", () => {
    expect(classifyRole({ ...BASE, mLen: 3, roleEvidence: ROLE_EVIDENCE }, null, "B", { ...CANDIDATE_REFERENCE, evidenceVersion: 2 } as any).primaryRole).toBe("insufficient");
    expect(classifyRole({ ...BASE, mLen: 2, roleEvidence: ROLE_EVIDENCE }, null, "B", CANDIDATE_REFERENCE).primaryRole).toBe("insufficient");
    expect(classifyRole({ ...BASE, mLen: 3, roleEvidence: { ...ROLE_EVIDENCE, validWeaponHits: 5 } }, null, "B", CANDIDATE_REFERENCE).primaryRole).toBe("insufficient");
  });

  it("uses complete role metrics, measured reaction, and unrounded thresholds for confirmation", () => {
    const roleOnlyReference = {
      ...CANDIDATE_REFERENCE,
      metrics: { ...CANDIDATE_REFERENCE.metrics, duelWin: [0,10,20,30,40,50,60,70,80,90,100], reversal: [0,10,20,30,40,50,60,70,80,90,100] },
      roles: { ...CANDIDATE_REFERENCE.roles, executor: [0,10,20,30,40,50,60,70,80,90,100] },
    };
    const stats = {
      ...BASE, mLen: 3, roleEvidence: ROLE_EVIDENCE,
      totalDuelWins: 99, totalDuelLosses: 0, avgDuelWinRate: 100, userReversalRate: 100,
      totalReversalAttempts: 3,
      avgMeasuredReactionLatency: "1.2s", avgReactionLatency: "측정 불가",
    };
    const result = classifyRole(stats, null, "B", roleOnlyReference);
    expect(result.primaryRole).toBe("executor");
    expect(result.status).toBe("confirmed");
    expect(result.scores.executor).toBe(93.8);
    expect(result.scores.pointMan).toBeNull();
  });

  it("keeps an opportunity-free role null instead of withholding a supported role", () => {
    const result = classifyRole({
      ...BASE, mLen: 3, roleEvidence: { ...ROLE_EVIDENCE, rescueCount: 0, rescueOpportunityCount: 0 },
      totalDuelWins: 3, avgDuelWinRate: 90, totalDuelLosses: 0,
    }, null, "B", CANDIDATE_REFERENCE);
    expect(result.scores.shield).toBeNull();
    expect(result.primaryRole).not.toBe("insufficient");
  });

  it("does not confirm a 84.96 score displayed as 85.0", () => {
    const result = classifyRole({
      ...BASE, mLen: 3, roleEvidence: ROLE_EVIDENCE,
      totalDuelWins: 3, avgDuelWinRate: 84.96, totalDuelLosses: 0,
      userReversalRate: 84.96, totalReversalAttempts: 2, avgMeasuredReactionLatency: "측정 불가",
    }, null, "B", CANDIDATE_REFERENCE);
    expect(result.scores.executor).toBe(85);
    expect(result.primaryRole).not.toBe("executor");
  });

  it("requires all components for a role and six qualified roles for the commander", () => {
    const roleEvidence = { ...ROLE_EVIDENCE, distanceDamage: { short: 255, mid: 0, long: 45 }, goldenTimeDamage: { early: 255, mid1: 0, mid2: 0, late: 45 }, rescueCount: 6, rescueOpportunityCount: 6, positionSampleCount: 2, edgePlayCount: 1 };
    const stats = {
      ...BASE, mLen: 3, roleEvidence,
      userInitiativeRate: 85, totalInitiativeAttempts: 3, avgMeasuredReactionLatency: "측정 불가",
      totalDuelWins: 3, totalDuelLosses: 0, avgDuelWinRate: 85, totalReversalAttempts: 2, userReversalRate: 85,
      totalTeammateKnocks: 3, totalRevCount: 0, totalSmokeRescues: 0,
      avgTeamDamageShare: 85, avgPressureIndex: 85, avgPlacementPct: 85,
    };
    const reference = {
      ...CANDIDATE_REFERENCE,
      roles: { ...CANDIDATE_REFERENCE.roles, ...Object.fromEntries(["pointMan", "phantomOverwatch", "executor", "shield", "brawler", "mainGun"].map((role) => [role, [0,10,20,30,40,50,60,70,80,90,100]])) },
    };
    const result = classifyRole(stats, null, "B", reference);
    expect(result.scores.pointMan).toBeNull(); // 측정되지 않은 반응 시간으로 복합 점수를 만들지 않는다.
    expect(result.primaryRole).not.toBe("fieldCommander"); // 유효한 역할 여섯 개가 없어 지휘관으로 승격하지 않는다.
    expect(result.scores.grenadier).toBeNull(); // 사용 기회 없이 투척 무적중 0을 점수화하지 않는다.
  });
});

describe("role selection", () => {
  it("reports insufficient evidence when no metric can be judged", () => {
    const result = classify();
    expect(result).toMatchObject({ primaryRole: "insufficient", secondaryRole: null, title: "전술 분석 중", evidence: [], badges: [] });
  });

  it("picks the role that stands out against other players and explains it", () => {
    const result = classify(STRONG_EXECUTOR);
    expect(result).toMatchObject({ primaryRole: "executor", secondaryRole: null, title: "결투의 제왕", roleLabel: "처형자 (Executor)" });
    expect(result.scores.executor).toBe(97.5);
    expect(result.scores.pointMan).toBeNull();
    expect(result.evidence).toEqual(["1:1 승률 상위 3%", "역전 승률 상위 3%"]);
  });

  it("does not put the tier into the title", () => {
    expect(classify(STRONG_EXECUTOR, "S+").title).toBe(classify(STRONG_EXECUTOR, "C").title);
    expect(classify(STRONG_EXECUTOR, "S+").overallTier).toBe("S+");
  });

  it("does not apply the composite point-man distribution to initiative alone", () => {
    const result=classify({...STRONG_POINT_MAN,avgReactionLatency:"측정 불가"});
    expect(result.scores.pointMan).toBeNull();
    expect(result.primaryRole).not.toBe("pointMan");
    expect(result.evidence.join(" ")).not.toMatch(/반격/);
  });

  it("describes observed initiative and reply without claiming first fire", () => {
    const result=classify(STRONG_POINT_MAN);
    expect(result.description).toContain('선제 타격');
    expect(result.description).not.toMatch(/먼저 쏘|반사신경/);
    const withheld=classify({...STRONG_EXECUTOR,...STRONG_POINT_MAN,avgReactionLatency:'측정 불가'});
    expect(withheld.scores.pointMan).toBeNull();
    expect(withheld.primaryRole).not.toBe('pointMan');
    expect(withheld.secondaryRole).not.toBe('pointMan');
    expect(withheld.title).not.toMatch(/선봉/);
  });

  it("never falls back to legacy distributions for missing or invalid candidate quantiles", () => {
    for(const reference of [{metrics:{},roles:{}},{metrics:{initiative:[1,2]},roles:{}}]){
      const result=classifyRole({...BASE,...STRONG_POINT_MAN},null,'A',reference);
      expect(result.primaryRole).toBe('insufficient');
      expect(Object.values(result.scores).every(value=>value===null)).toBe(true);
      expect(result.evidence).toEqual([]);
      expect(result.weakness).toBeNull();
    }
  });

  it("treats a faster reaction as better", () => {
    expect(classify(STRONG_POINT_MAN).scores.pointMan).toBe(97.5);
    expect(classify({ ...STRONG_POINT_MAN, userInitiativeRate: null, totalInitiativeAttempts: 0 }).scores.pointMan).toBeNull();
    // 지표 백분위 5는 선봉대 역할 점수 분포의 5백분위(12.13)보다 낮다.
    expect(classify({ userInitiativeRate: 0, totalInitiativeAttempts: 10, avgReactionLatency: "3.00s" }).scores.pointMan).toBe(2.5);
  });

  it("uses a combo title only when both roles are strong, regardless of order", () => {
    const combo = classify({ ...STRONG_EXECUTOR, ...STRONG_POINT_MAN });
    expect(combo.title).toBe("선봉의 심판자");
    expect(combo.secondaryRole).not.toBeNull();
    expect(combo.roleLabel).toContain("보조:");

    const single = classify({ ...STRONG_EXECUTOR, userInitiativeRate: 50, totalInitiativeAttempts: 10, avgReactionLatency: "2.196s" });
    expect(single).toMatchObject({ primaryRole: "executor", secondaryRole: null, title: "결투의 제왕" });
  });

  it("falls back to balanced when no role reaches the 70th percentile", () => {
    const result = classify(MEDIAN_EXECUTOR);
    expect(result).toMatchObject({ primaryRole: "balanced", title: "균형형 전술가", secondaryRole: null, evidence: [] });
  });

  it("names a field commander when six roles are strong but none dominates", () => {
    // 각 지표를 기준 분포 80백분위 값으로 맞춘다.
    const result = classify({
      avgDuelWinRate: 82.353, totalDuelWins: 8, totalDuelLosses: 2, userReversalRate: 25, totalReversalAttempts: 4,
      userInitiativeRate: 62.5, totalInitiativeAttempts: 10, avgReactionLatency: "1.611s",
      avgPressureIndex: 4.91, avgPlacementPct: 84.853, totalEdgePlay: 13,
      totalUtilityHits: 1.6, totalLethalThrows: 3.333,
      totalDistanceDamage: { short: 681.95, mid: 318.05, long: 0 },
      avgTeamDamageShare: 46.18,
    });
    expect(result).toMatchObject({ primaryRole: "fieldCommander", title: "육각형 플레이어", secondaryRole: null });
    expect(result.scores.fieldCommander!).toBeGreaterThan(75);
    expect(result.scores.fieldCommander!).toBeLessThan(95);
    expect(result.evidence).toHaveLength(2);
  });

  it("does not judge team-only roles in solo mode", () => {
    const rescues = { totalTeammateKnocks: 6, totalRevCount: 6, totalTradeKills: 3, avgTeamDamageShare: 80 };
    expect(classify(rescues).scores).toMatchObject({ shield: 97.5, mainGun: 97.5 });
    const solo = classify({ ...rescues, modeDistribution: { main: "solo" } });
    expect(solo.scores).toMatchObject({ shield: null, avenger: null, mainGun: null, decoy: null, crossfire: null });
    expect(solo.primaryRole).toBe("insufficient");
  });
});

describe("weakness and badges", () => {
  it("reports the weakest metric only when it is in the bottom 20%", () => {
    expect(classify({ ...STRONG_POINT_MAN, avgDuelWinRate: 30, totalDuelWins: 3, totalDuelLosses: 7 }).weakness)
      .toBe("1:1 승률이(가) 다른 플레이어 대비 하위 3%입니다.");
    expect(classify({ ...STRONG_POINT_MAN, ...MEDIAN_EXECUTOR }).weakness).toBeNull();
  });

  it("adds vehicle and signature weapon badges without replacing the role title", () => {
    const result = classify({
      ...STRONG_EXECUTOR,
      totalRidingShotKnocks: 2, totalLeadShotKills: 1, vehicleCombatMatchCount: 2,
      mLen: 4, weaponStatsFinal: { WeapM416_C: { kills: 4, dbnos: 0 } }, weaponMatchCount: { WeapM416_C: 3 },
    });
    expect(result.title).toBe("결투의 제왕");
    expect(result.badges).toEqual(["차량 교전", "M416 주력"]);
    expect(classify({ ...STRONG_EXECUTOR, totalRidingShotKnocks: 3, vehicleCombatMatchCount: 1 }).badges).toEqual([]);
  });
});

describe("signature weapon", () => {
  const weaponOf = (weaponStatsFinal: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    classify({ weaponStatsFinal, ...extra });

  it("falls back to fists without weapon stats and to tactician when every weapon is ignored", () => {
    expect(weaponOf({}).signatureWeapon).toBe("주먹");
    expect(weaponOf({}).signatureWeaponStats).toEqual({ kills: 0, dbnos: 0, consistency: 0, isReliable: false });
    const ignored = weaponOf({ WeapSmokeBomb_C: { kills: 5 }, None: { kills: 9 } });
    expect(ignored.signatureWeapon).toBe("전술가");
    expect(ignored.signatureWeaponStats).toEqual({ kills: 0, dbnos: 0, consistency: 0, isReliable: false });
    // 대체 이름은 배지로 쓰지 않는다
    expect(ignored.badges).toEqual([]);
  });

  it("orders three weapons by kills x2 plus knocks", () => {
    const result = weaponOf({
      WeapAKM_C: { kills: 1, dbnos: 4 },
      WeapM416_C: { kills: 3, dbnos: 1 },
      WeapK2_C: { kills: 2, dbnos: 2 },
    });
    expect(result.signatureWeapon).toBe("M416");
    expect(weaponOf({ WeapAKM_C: { dbnos: 7 }, WeapM416_C: { kills: 3 } }).signatureWeapon).toBe("AKM");
  });

  it("defaults missing kill and knock counts to zero", () => {
    expect(weaponOf({ WeapM416_C: { kills: 1 } }).signatureWeaponStats).toMatchObject({ kills: 1, dbnos: 0 });
    expect(weaponOf({ WeapM416_C: { dbnos: 1 } }).signatureWeaponStats).toMatchObject({ kills: 0, dbnos: 1 });
  });

  it("ranks weapons by kills x2 plus knocks and maps the display name", () => {
    const result = weaponOf({ WeapAKM_C: { kills: 2, dbnos: 3 }, WeapM416_C: { kills: 4, dbnos: 0 } });
    expect(result.signatureWeapon).toBe("M416");
    expect(result.signatureWeaponStats).toMatchObject({ kills: 4, dbnos: 0 });
    expect(weaponOf({ WeapAKM_C: { kills: 2, dbnos: 5 }, WeapM416_C: { kills: 4, dbnos: 0 } }).signatureWeapon).toBe("AKM");
  });

  it("strips the item prefix for unmapped weapons", () => {
    expect(weaponOf({ Item_Weapon_Newgun_C: { kills: 1 } }).signatureWeapon).toBe("Newgun");
  });

  it.each([
    ["BP_Custom_C"], ["SomeVehicle"], ["Uaz_A_01_C"], ["Dacia_A_01_v2_C"], ["Coupe_RB"], ["Mirado_A"],
    ["Pony_Coupe"], ["Porter_C"], ["Zima_C"], ["BRDM_C"], ["Motorcycle_C"], ["Motorbike_C"], ["PickupTruck_A_01_C"],
    ["다시아"], ["uaz"], ["쿠페 RB"], ["오토바이"], ["지마"], ["포터"], ["포니 쿠페"], ["미라도"], ["툭툭"], ["로니"],
    ["픽업트럭"], ["brdm"], ["보급 트럭"], ["아쿠아레일"], ["보트"], ["차량"],
  ])("labels vehicle kills by %s as roadkill hunter", (id) => {
    expect(weaponOf({ [id]: { kills: 1 } }).signatureWeapon).toBe("고라니 사냥꾼");
  });

  it.each([
    ["ProjX_C"], ["Grenade_Shell"], ["Molotov_Fire"], ["custom_grenade"], ["custom_molotov"], ["WeapC4_C"],
    ["custom_smokebomb"], ["custom_flashbang"],
  ])("labels throwable kills by %s as demolition expert", (id) => {
    expect(weaponOf({ [id]: { kills: 1 } }).signatureWeapon).toBe("폭파 전문가");
  });

  it("labels unknown weapon kills as the dark assassin", () => {
    expect(weaponOf({ Unknown: { kills: 1 } }).signatureWeapon).toBe("어둠의 암살자");
  });

  it("measures consistency from used matches and requires score 6 and 50% for reliability", () => {
    const stats = (kills: number, dbnos: number, used: number | undefined, mLen: number) =>
      weaponOf({ WeapM416_C: { kills, dbnos } }, { mLen, weaponMatchCount: used === undefined ? {} : { WeapM416_C: used } }).signatureWeaponStats;
    expect(stats(3, 0, 5, 10)).toEqual({ kills: 3, dbnos: 0, consistency: 50, isReliable: true });
    expect(stats(2, 1, 5, 10)).toMatchObject({ isReliable: false });
    expect(stats(2, 2, 5, 10)).toMatchObject({ isReliable: true });
    expect(stats(0, 6, 5, 10)).toMatchObject({ isReliable: true });
    expect(stats(3, 0, 4, 10)).toEqual({ kills: 3, dbnos: 0, consistency: 40, isReliable: false });
    expect(stats(3, 0, undefined, 4)).toMatchObject({ consistency: 25 });
  });
});

