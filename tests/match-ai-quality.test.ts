import { describe, expect, it } from "vitest";
import { applyMatchAiPercentiles, formatMatchAiPercentileSection, toMatchAiPercentiles } from "@/lib/pubg-analysis/matchAiPercentiles";
import { applyMatchAiClockPolicy, applyMatchAiSceneRefs, buildMatchAiActionHints, buildMatchAiFlowLines, buildMatchAiSceneCatalog, formatMatchAiSceneLine, unwrapMatchAiJson } from "@/lib/pubg-analysis/matchAiScenes";
import { applyMatchAiActionPolicy, applyMatchAiEvidencePolicy } from "@/lib/pubg-analysis/matchAiEvidence";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";

const actionTexts = (match: unknown) => buildMatchAiActionHints(match).map((hint) => hint.text);

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
      "- 경기 중 받은 자기장 피해 합계 0",
    ]);
    expect(lines.join("\n")).not.toMatch(/Enemy/u);
    expect(buildMatchAiFlowLines({ timeline: [] })).toEqual([]);
  });

  it("시각 표기로 바꾼 경과 시각은 되돌려 검증하고, 기록에 없는 거리는 숫자만 지운다", () => {
    const text = JSON.stringify({
      briefFeedback: ["12시 40분 교전은 졌어.", "13시 01분부터 밀렸어.", "60m 거리에서 쓰러졌고 136미터 거리에서 맞았어."],
      finalVerdict: "3시 방향 220m 원 밖이었어.",
    });
    const parsed = JSON.parse(applyMatchAiClockPolicy(text, match));
    expect(parsed.briefFeedback).toEqual(["12:40 교전은 졌어.", "밀렸어.", "60m 거리에서 쓰러졌고 거리에서 맞았어."]);
    expect(parsed.finalVerdict).toBe("3시 방향 220m 원 밖이었어.");
    const once = applyMatchAiClockPolicy(text, match);
    expect(applyMatchAiClockPolicy(once, match)).toBe(once);
    // 프롬프트에 적힌 대열 거리는 문자열로 저장돼 있어도 허용한다.
    const spaced = { ...match, isolationData: { minDist: "33.7", heightDiff: 2 } };
    const kept = JSON.stringify({ finalVerdict: "아군과 34m 평균 거리를 유지했어." });
    expect(applyMatchAiClockPolicy(kept, spaced)).toBe(kept);
  });

  it("측정하지 않는 판단 단정은 그 쉼표 구간만 지운다", () => {
    const text = JSON.stringify({ briefFeedback: [
      "13:10 써드파티로 쓰러졌잖아, 교전 끝나고 방심하다가 누웠네.",
      "집중력이 부족했어.",
      "12:40 교전은 졌어. 멘탈이 흔들렸지.",
    ] });
    expect(JSON.parse(applyMatchAiClockPolicy(text, match)).briefFeedback).toEqual([
      "13:10 써드파티로 쓰러졌잖아.",
      "집중력이 부족했어.",
      "12:40 교전은 졌어.",
    ]);
  });

  it("```json 울타리를 벗겨 근거 정책이 JSON으로 읽게 한다", () => {
    const fenced = "```json\n{\"finalVerdict\":\"7:15 교전은 졌어.\"}\n```";
    expect(unwrapMatchAiJson(fenced)).toBe('{"finalVerdict":"7:15 교전은 졌어."}');
    expect(JSON.parse(applyMatchAiClockPolicy(unwrapMatchAiJson(fenced), match)).finalVerdict).toBe("교전은 졌어.");
    expect(unwrapMatchAiJson('{"a":1}')).toBe('{"a":1}');
  });

  it("차량으로 낸 킬은 사격이 아니라 차량 충돌로 적는다", () => {
    const [scene] = buildMatchAiSceneCatalog({ timeline: [{ ts: 244_374, type: "KILL", weapon: "포니 쿠페", distance: 1, victim: "EnemyC", x: 3, y: 3 }] });
    expect(formatMatchAiSceneLine(scene)).toBe("- KILL-244374 | 4:04 | 내 킬 (차량 충돌: 포니 쿠페, 1m)");
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

describe("행동 후보", () => {
  const finalize = (text: string, data: unknown) => {
    const tidied = applyMatchAiClockPolicy(unwrapMatchAiJson(text), data);
    const checked = applyMatchAiClockPolicy(applyMatchAiPercentiles(applyMatchAiEvidencePolicy(tidied, data)), data);
    return applyMatchAiActionPolicy(applyMatchAiSceneRefs(checked, data, tidied), data);
  };

  it.each([
    { desc: "엄폐한 적을 상대할 때 → 수류탄 궤적을 미리 계산해서 던진다" },
    { desc: "근접 교전 상황이 오면 → 주변 엄폐물 위치를 먼저 확보하고 사격한다", actionCandidateId: "unknown", sceneId: "KNOCK-300000" },
    { desc: "근접 교전 상황이 오면 → 주변 엄폐물을 확보한다", actionCandidateId: "third-party-790000", sceneId: "DIED-1" },
  ])("무근거 행동과 잘못된 후보·장면 ID를 실제 후보로 확정하고 두 번 정규화해도 같다: %j", (item) => {
    const hint = buildMatchAiActionHints(match)[0];
    const once = finalize(JSON.stringify({ actionItems: [{ title: "일반론", ...item }], briefFeedback: ["첫 문장"], briefFeedbackSceneIds: [null] }), match);
    const result = JSON.parse(once);
    expect(result.actionItems).toEqual([{ icon: "🎯", title: hint.title, desc: hint.text, actionCandidateId: hint.id, sceneId: "DIED-790000" }]);
    expect(result.briefFeedbackSceneIds).toBeUndefined();
    expect(finalize(once, match)).toBe(once);
  });

  it("모델이 고른 두 번째 적격 후보를 쓰고 다른 장면 ID는 후보 장면으로 교정한다", () => {
    const hot = { ...match, matchReport: { ...match.matchReport, landing: { timeMs: 64_000, enemiesNear: 8, teamsNear: 2 } } };
    const hints = buildMatchAiActionHints(hot);
    const once = finalize(JSON.stringify({ actionItems: [{ actionCandidateId: hints[1].id, sceneId: "DIED-790000", desc: "일반 조언" }] }), hot);
    expect(JSON.parse(once).actionItems[0]).toEqual({ icon: "🎯", title: hints[1].title, desc: hints[1].text, actionCandidateId: "hot-landing-64000" });
    expect(finalize(once, hot)).toBe(once);
    expect(buildMatchAiActionHints({ ...hot, matchReport: { ...hot.matchReport, death: null, fights: [] } })[0].id).toBe(hints[1].id);
  });

  it("같은 시각의 다른 사건을 사망·착지 장면으로 연결하지 않고 소수 시각은 장면과 같은 규칙으로 반올림한다", () => {
    const data = { ...match, timeline: [
      { ts: 790_000.4, type: "KILL", x: 1, y: 1 }, { ts: 790_000.4, type: "DIED", x: 1, y: 1 },
      { ts: 64_000, type: "KILL", x: 1, y: 1 },
    ], matchReport: { ...match.matchReport, death: { ...match.matchReport.death, timeMs: 790_000.4 }, landing: { timeMs: 64_000, enemiesNear: 8, teamsNear: 2 } } };
    const hints = buildMatchAiActionHints(data);
    expect(hints[0].sceneId).toBe("DIED-790000");
    expect(hints[1].sceneId).toBeNull();
  });

  it("후보가 없으면 관측 지표 점검을 남기고 가짜 후보·시각·장면은 만들지 않는다", () => {
    const data = { stats: { damageDealt: 606, processedDamageDealt: 585 }, timeline: [] };
    const once = finalize(JSON.stringify({ actionItems: [{ title: "피해 기록 점검", desc: "7:15 공식 피해량 606과 유효 딜량 585의 차이를 다음 경기에도 점검한다", actionCandidateId: "invented", sceneId: "DIED-1" }] }), data);
    expect(JSON.parse(once).actionItems).toEqual([{ title: "피해 기록 점검", desc: "공식 피해량 606과 유효 딜량 585의 차이를 다음 경기에도 점검한다" }]);
    expect(finalize(once, data)).toBe(once);
    expect(buildMatchAiActionHints(data)).toEqual([]);
  });

  it("행동 후보가 없는 경기는 이 경기 수치·시각 없는 일반론 제안을 빼고 멱등이다", () => {
    const data = { stats: { damageDealt: 606, processedDamageDealt: 585 }, timeline: [] };
    const generic = { title: "투척물 활용 유지", desc: "엄폐물 뒤의 적이 보이면 → 피해형 투척물을 먼저 던져서 각을 벌린 뒤 사격한다" };
    const grounded = { title: "피해 기록 점검", desc: "공식 피해량 606을 다음 경기에도 확인한다" };
    const once = finalize(JSON.stringify({ actionItems: [generic, grounded] }), data);
    expect(JSON.parse(once).actionItems).toEqual([grounded]);
    expect(finalize(once, data)).toBe(once);
    expect(JSON.parse(finalize(JSON.stringify({ actionItems: [generic] }), data)).actionItems).toEqual([]);
  });

  it("적중률이 100% 미만이면 '모두 유효하게' 같은 전부 표현을 뗀다", () => {
    const data = { stats: { damageDealt: 300 }, combatPressure: { utilityStats: { throwCount: 6, lethalThrowCount: 6, hitCount: 3 } }, timeline: [] };
    const text = JSON.stringify({ briefFeedback: ["총 투척 6회 중 피해형 투척 6회를 모두 유효하게 활용해 적중률 50%를 찍었잖아."] });
    const once = applyMatchAiEvidencePolicy(text, data);
    expect(JSON.parse(once).briefFeedback[0]).toBe("총 투척 6회 중 피해형 투척 6회를 유효하게 활용해 적중률 50%를 찍었잖아.");
    expect(applyMatchAiEvidencePolicy(once, data)).toBe(once);
  });

  it("행동 항목이 비어 있으면 첫 후보를 채우고 JSON이 아닌 응답은 그대로 둔다", () => {
    const once = finalize(JSON.stringify({ actionItems: [] }), match);
    expect(JSON.parse(once).actionItems[0].actionCandidateId).toBe(buildMatchAiActionHints(match)[0].id);
    expect(finalize(once, match)).toBe(once);
    expect(applyMatchAiActionPolicy("not-json", match)).toBe("not-json");
    expect(applyMatchAiActionPolicy("null", match)).toBe("null");
  });

  it("사망 유형·먼 원 밖·헛친 선제 교전·뜨거운 착지에서 측정값으로 최대 3개를 만든다", () => {
    const report = { ...match.matchReport, landing: { timeMs: 64_000, enemiesNear: 16, enemiesFar: 5, teamsNear: 4 },
      damageTaken: { sources: [{ attacker: null, attackerTeamId: null, isBot: false, cause: "zone", weapon: null, damage: 55.4, hits: 12 }], hits: [] },
      circles: [{ index: 3, phase: 3, timeMs: 790_000, status: "outside", outsideByM: 440 }, { index: 2, phase: 2, timeMs: 460_000, status: "outside", outsideByM: 1743 }],
      fights: [...match.matchReport.fights, { startMs: 400_000, endMs: 420_000, opponentTeamIds: [9], opponents: [], dealt: 180, taken: 30, enemyDowns: 0, teamDowns: 0, openedBy: "us", outcome: "brokeOff" }] };
    expect(actionTexts({ ...match, matchReport: report })).toEqual([
      "13:10 최근 1분간 2팀이 얽힌 교전에서 사망 → 교전을 끝내면 바로 자리를 옮기거나 다른 팀이 올 방향부터 확인한다",
      "13:10 3페이즈 원 밖 440m, 경기 중 자기장 피해 55 → 원이 정해지면 교전을 끊고 원 쪽으로 먼저 이동한다",
      "먼저 쏘고도 아무도 못 쓰러뜨린 교전 1번(첫 번째 6:40) → 먼저 쏠 때는 한 명에게 사격을 모으거나 투척물로 마무리한다",
    ]);
  });

  it("자기장 피해가 없으면 먼 원 밖도 후보가 아니고, 자기장 기절은 사망 유형보다 먼저 둔다", () => {
    const circles = [{ index: 3, phase: 3, timeMs: 600_000, status: "outside", outsideByM: 746 }];
    const noZone = { ...match, matchReport: { ...match.matchReport, death: null, circles } };
    // 자기장 피해가 없으면 원 밖 후보 대신 먼저 맞아 진 교전 후보만 남는다.
    expect(actionTexts(noZone)).toEqual(["상대가 먼저 쏴서 우리 팀만 쓰러진 교전 1번(첫 번째 12:40) → 넓은 곳은 다음 멈출 지점을 정하고 짧게 끊어 지난다"]);
    const knocked = { ...match, timeline: [...match.timeline, { ts: 763_000, type: "DOWNED", weapon: "자기장", x: 5, y: 5 }],
      matchReport: { ...match.matchReport, circles, damageTaken: { sources: [{ attacker: null, attackerTeamId: null, isBot: false, cause: "zone", weapon: null, damage: 70, hits: 20 }], hits: [] } } };
    const hints = actionTexts(knocked);
    expect(hints[0]).toBe("12:43 자기장 피해로 기절 → 원이 줄어들 때는 교전보다 원 안 진입을 먼저 한다");
    expect(hints.some((hint) => hint.includes("원 밖 746m"))).toBe(false);
    const outfought = (openedBy: string) => actionTexts({ ...match, matchReport: { ...match.matchReport, circles: [], death: { ...match.matchReport.death, type: "outfought", openedBy } } });
    expect(outfought("them")).toEqual(["상대가 먼저 쏴서 우리 팀만 쓰러진 교전 1번(첫 번째 12:40) → 넓은 곳은 다음 멈출 지점을 정하고 짧게 끊어 지난다"]);
    expect(outfought("us")).toEqual(["13:10 먼저 쏘고도 정면 교전에서 사망 → 먼저 쏠 때는 한 명에게 사격을 모아 숫자 우위부터 만든다"]);
  });

  it("팀원이 가까운 출혈 사망은 함께 쓰러진 교전으로, 2페이즈 원 밖은 후보에서 빼고, 후보 시각은 응답에 남긴다", () => {
    const near = { ...match, matchReport: { ...match.matchReport, death: { ...match.matchReport.death, type: "bledOut", nearestTeammateM: 13 },
      circles: [{ index: 2, phase: 2, timeMs: 460_000, status: "outside", outsideByM: 4335 }] } };
    expect(actionTexts(near)).toEqual(["13:10 팀원 13m 옆에서 같은 교전에 함께 쓰러져 소생을 못 받음 → 한 명이 기절하면 남은 사람은 맞서기 전에 연막부터 깔고 살린다"]);
    const far = { ...near, matchReport: { ...near.matchReport, death: { ...near.matchReport.death, nearestTeammateM: 140 } } };
    expect(actionTexts(far)[0]).toBe("13:10 기절 뒤 소생을 못 받고 사망(가장 가까운 팀원 140m) → 교전 전에 소생 가능한 거리로 팀원과 붙는다");
    const hot = { ...match, matchReport: { ...match.matchReport, landing: { timeMs: 64_000, enemiesNear: 8, enemiesFar: 0, teamsNear: 2 } } };
    const text = JSON.stringify({ actionItems: [{ icon: "🪂", title: "착지", desc: "1:04 착지처럼 적이 많으면 무기부터 줍는다" }] });
    expect(JSON.parse(applyMatchAiClockPolicy(text, hot)).actionItems[0].desc).toBe("1:04 착지처럼 적이 많으면 무기부터 줍는다");
  });
});

describe("단일 경기 코칭 프롬프트", () => {
  const base = { ...match, mapName: "Erangel", gameMode: "squad" };

  it("개인 공식 피해량·유효 딜량·팀 교전 피해를 서로 다른 라벨로 제공한다", () => {
    const data = { ...base, stats: { ...base.stats, damageDealt: 606, processedDamageDealt: 585 } };
    const prompt = buildMatchAiCoachingPrompt({ matchData: data }).fullPrompt;
    expect(prompt).toContain("공식 피해량 606 / 유효 딜량 585");
    expect(prompt).toContain("우리 팀이 준 피해 250");
    expect(prompt).toContain("피해 수치를 인용할 때는 반드시");
    expect(prompt).toContain("third-party-790000 | DIED-790000");
    expect(prompt).toContain('"actionCandidateId"');
    const missing = buildMatchAiCoachingPrompt({ matchData: { ...base, stats: { ...base.stats, processedDamageDealt: undefined }, matchReport: null } }).fullPrompt;
    expect(missing).toContain("공식 피해량 300 / 유효 딜량 측정 불가");
    expect(missing).toContain("관측된 수치나 시각을 desc에 그대로 인용한 점검");
    expect(missing).toContain("[전부 표현]");
  });

  it("경기 흐름·백분위 섹션과 행동 하나 규칙을 넣고 비교 평균을 엘리트로 부르지 않는다", () => {
    const percentiles = toMatchAiPercentiles([row("damage", 1000, 121, 880)]);
    const { fullPrompt } = buildMatchAiCoachingPrompt({ matchData: base, coachingStyle: "spicy", percentiles });
    expect(fullPrompt).toContain("[경기 흐름]");
    expect(fullPrompt).toContain("장면 DOWNED-780000, DIED-790000");
    expect(fullPrompt).toContain("[BGMS 기록 비교] (스쿼드 경쟁전 BGMS 기록 1000경기 기준");
    expect(fullPrompt).toContain("actionItems는 정확히 1개");
    expect(fullPrompt).not.toContain("Elite");
    expect(fullPrompt).toContain("[행동 후보]");
    expect(fullPrompt).toContain("'엄폐물로 숨는다', '엄폐 후 반격'처럼 어느 경기에나 맞는 행동은 쓰지 마십시오");
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
