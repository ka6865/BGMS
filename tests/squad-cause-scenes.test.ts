import { describe, expect, it } from "vitest";
import fixture from "./fixtures/squad-cause-scenes.json";
import {
  buildSquadCauseScenePrompt,
  extractSquadCauseScenes,
  SquadCauseSceneMatchInput,
  validateSquadCauseSceneAiText
} from "../lib/pubg-analysis/squadCauseScenes";

describe("squad cause scene experiment", () => {
  const matches = fixture.matches as SquadCauseSceneMatchInput[];
  const exceptionMatches: SquadCauseSceneMatchInput[] = [
    {
      matchId: "fixture-safe-revive-without-smoke",
      mapName: "Baltic_Main",
      mapDisplayName: "에란겔",
      fullResult: {
        mapName: "Baltic_Main",
        team: [
          { name: "Player_A" },
          { name: "Beta" },
          { name: "Charlie" },
          { name: "Delta" }
        ],
        isolationData: {
          deathIsolation: 1.1,
          minDist: 24,
          isolationIndex: 1.1
        },
        tradeStats: {
          tradeLatencyMs: 0,
          teammateKnocks: 1,
          smokeRescues: 0,
          revCount: 1,
          enemyTeamWipes: 0
        },
        timeline: [
          {
            ts: 180000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_A",
            victim: "Beta",
            weapon: "ACE32",
            x: 2100,
            y: 3300
          },
          {
            ts: 198000,
            type: "TEAM_REVIVE",
            attacker: "Player_A",
            victim: "Beta",
            x: 2110,
            y: 3310
          }
        ]
      }
    },
    {
      matchId: "fixture-recall-recovery",
      mapName: "Desert_Main",
      mapDisplayName: "미라마",
      fullResult: {
        mapName: "Desert_Main",
        team: [
          { name: "Player_A" },
          { name: "Beta" },
          { name: "Charlie" },
          { name: "Delta" }
        ],
        isolationData: {
          deathIsolation: 1.6,
          minDist: 42,
          isolationIndex: 1.6
        },
        tradeStats: {
          tradeLatencyMs: 0,
          teammateKnocks: 1,
          smokeRescues: 0,
          revCount: 0,
          enemyTeamWipes: 0
        },
        timeline: [
          {
            ts: 250000,
            type: "TEAM_DIED",
            attacker: "Enemy_B",
            victim: "Charlie",
            weapon: "SLR",
            x: 4200,
            y: 1800
          },
          {
            ts: 335000,
            type: "TEAM_RECALL",
            attacker: "Delta",
            victim: "Charlie",
            x: 5200,
            y: 2600
          }
        ]
      }
    },
    {
      matchId: "fixture-clutch-recovery",
      mapName: "Tiger_Main",
      mapDisplayName: "태이고",
      fullResult: {
        mapName: "Tiger_Main",
        team: [
          { name: "Player_A" },
          { name: "Beta" },
          { name: "Charlie" },
          { name: "Delta" }
        ],
        isolationData: {
          deathIsolation: 1.4,
          minDist: 35,
          isolationIndex: 1.4
        },
        tradeStats: {
          tradeLatencyMs: 7000,
          teammateKnocks: 2,
          smokeRescues: 0,
          revCount: 1,
          enemyTeamWipes: 0
        },
        timeline: [
          {
            ts: 430000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_C",
            victim: "Beta",
            weapon: "베릴 M762",
            x: 3100,
            y: 4100
          },
          {
            ts: 435000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_D",
            victim: "Charlie",
            weapon: "M416",
            x: 3120,
            y: 4120
          },
          {
            ts: 442000,
            type: "KILL",
            attacker: "Player_A",
            victim: "Enemy_C",
            weapon: "ACE32",
            x: 3160,
            y: 4180
          },
          {
            ts: 448000,
            type: "TEAM_KILL",
            attacker: "Delta",
            victim: "Enemy_D",
            weapon: "Mini14",
            x: 3180,
            y: 4200
          },
          {
            ts: 456000,
            type: "TEAM_REVIVE",
            attacker: "Player_A",
            victim: "Beta",
            x: 3110,
            y: 4110
          },
          {
            ts: 530000,
            type: "TEAM_RECALL",
            attacker: "Delta",
            victim: "Charlie",
            x: 5100,
            y: 2800
          }
        ]
      }
    },
    {
      matchId: "fixture-team-collapse",
      mapName: "Baltic_Main",
      mapDisplayName: "에란겔",
      fullResult: {
        mapName: "Baltic_Main",
        team: [
          { name: "Player_A" },
          { name: "Beta" },
          { name: "Charlie" },
          { name: "Delta" }
        ],
        isolationData: {
          deathIsolation: 2.0,
          minDist: 58,
          isolationIndex: 2.0
        },
        tradeStats: {
          tradeLatencyMs: 0,
          teammateKnocks: 4,
          smokeRescues: 0,
          revCount: 0,
          enemyTeamWipes: 0
        },
        timeline: [
          {
            ts: 610000,
            type: "DOWNED",
            attacker: "Enemy_E",
            victim: "Player_A",
            weapon: "AUG",
            x: 6100,
            y: 7100
          },
          {
            ts: 616000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_F",
            victim: "Beta",
            weapon: "AKM",
            x: 6110,
            y: 7110
          },
          {
            ts: 621000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_G",
            victim: "Charlie",
            weapon: "SLR",
            x: 6120,
            y: 7120
          },
          {
            ts: 628000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_H",
            victim: "Delta",
            weapon: "Beryl M762",
            x: 6130,
            y: 7130
          }
        ]
      }
    }
  ];

  it("타임라인과 전술 지표에서 원인 장면 후보를 추출한다", () => {
    const scenes = extractSquadCauseScenes(matches, {
      benchmarkTradeLatencyMs: 11642,
      maxScenes: 10
    });

    const sceneTypes = scenes.map(scene => scene.type);
    expect(sceneTypes).toContain("late_trade");
    expect(sceneTypes).toContain("no_smoke_rescue");
    expect(sceneTypes).toContain("isolation_death");
    expect(sceneTypes).toContain("revive_save");
    expect(sceneTypes).toContain("focus_fire_success");
    expect(sceneTypes).toContain("team_wipe");

    const lateTrade = scenes.find(scene =>
      scene.type === "late_trade" &&
      scene.matchId === "fixture-late-trade" &&
      scene.metricSnapshot.tradeLatencyMs !== null
    );
    expect(lateTrade?.metricSnapshot.tradeLatencyMs).toBe(19000);
    expect(lateTrade?.facts.join(" ")).toContain("기준보다 7.4초 느림");
    expect(lateTrade?.facts.join(" ")).not.toContain("기절/사망");

    const noSmoke = scenes.find(scene => scene.type === "no_smoke_rescue");
    expect(noSmoke?.metricSnapshot.smokeUsedWithin15s).toBe(false);
    expect(noSmoke?.metricSnapshot.reviveWithin30s).toBe(false);

    const isolation = scenes.find(scene => scene.type === "isolation_death");
    expect(isolation?.confidence).toBe("medium");
    expect(isolation?.title).toContain("팀과");
    expect(isolation?.title).toContain("떨어진 상태");
    expect(isolation?.reason).toContain("즉시 백업이나 소생 각이 늦어질 수 있는 거리 조건");
    expect(isolation?.facts.join(" ")).toContain("매치 단위");
    expect(isolation?.facts.join(" ")).toContain("팀 간격 위험도");
    expect(isolation?.facts.join(" ")).toContain("BGMS 파생 지표");
    expect(isolation?.facts.join(" ")).not.toContain("기절/사망");
  });

  it("구조 예외 상황을 얕은 연막/소생 실패로 오판하지 않는다", () => {
    const scenes = extractSquadCauseScenes(exceptionMatches, {
      benchmarkTradeLatencyMs: 11642,
      maxScenes: 30
    });

    const sceneTypes = scenes.map(scene => scene.type);
    expect(sceneTypes).toContain("safe_revive_without_smoke");
    expect(sceneTypes).toContain("recall_recovery");
    expect(sceneTypes).toContain("clutch_recovery");
    expect(sceneTypes).toContain("team_collapse");

    const safeRevive = scenes.find(scene =>
      scene.type === "safe_revive_without_smoke" &&
      scene.matchId === "fixture-safe-revive-without-smoke"
    );
    expect(safeRevive?.severity).toBe("good");
    expect(safeRevive?.metricSnapshot.smokeUsedWithin15s).toBe(false);
    expect(safeRevive?.metricSnapshot.reviveWithin30s).toBe(true);
    expect(safeRevive?.metricSnapshot.enemyPressureEventsWithin10s).toBe(0);
    expect(safeRevive?.facts.join(" ")).toContain("엄폐물, 시야각, 실제 안전 여부는 요약 타임라인만으로 확정 불가");

    const recallRecovery = scenes.find(scene => scene.type === "recall_recovery");
    expect(recallRecovery?.severity).toBe("good");
    expect(recallRecovery?.metricSnapshot.recallWithin180s).toBe(true);
    expect(recallRecovery?.facts.join(" ")).toContain("블루칩 회수자와 회수 시점은 현재 요약 타임라인만으로 확정하지 않음");

    const clutchRecovery = scenes.find(scene => scene.type === "clutch_recovery");
    expect(clutchRecovery?.severity).toBe("good");
    expect(clutchRecovery?.metricSnapshot.affectedTeammates).toBe(2);
    expect(clutchRecovery?.metricSnapshot.teamWipes).toBeUndefined();
    expect(clutchRecovery?.facts.join(" ")).toContain("적 전원 처치 확정 장면이 아님");
    expect(clutchRecovery?.facts.join(" ")).toContain("별도 적 스쿼드 전멸 기여 장면에서만 표현");
    expect(clutchRecovery?.facts.join(" ")).not.toContain("clutch_recovery");
    expect(clutchRecovery?.facts.join(" ")).not.toContain("team_wipe");

    const teamCollapse = scenes.find(scene => scene.type === "team_collapse");
    expect(teamCollapse?.severity).toBe("danger");
    expect(teamCollapse?.metricSnapshot.teamSize).toBe(4);
    expect(teamCollapse?.metricSnapshot.affectedTeammates).toBe(4);
    expect(teamCollapse?.facts.join(" ")).toContain("개별 팀원의 구조 미이행으로 단정하지 않음");
  });

  it("최대 5개 장면에서는 성공적인 복구 예외를 최소 1개 포함한다", () => {
    const scenes = extractSquadCauseScenes([...matches, ...exceptionMatches], {
      benchmarkTradeLatencyMs: 11642,
      maxScenes: 5
    });

    expect(scenes).toHaveLength(5);
    expect(scenes.some(scene => scene.severity === "good")).toBe(true);
    expect(scenes.some(scene =>
      scene.type === "safe_revive_without_smoke" ||
      scene.type === "recall_recovery" ||
      scene.type === "clutch_recovery" ||
      scene.type === "revive_save" ||
      scene.type === "team_wipe"
    )).toBe(true);
  });

  it("소생 성공이 확인된 근거리 고립 지표 장면은 손실 확정으로 만들지 않는다", () => {
    const recoveredIsolationMatch: SquadCauseSceneMatchInput = {
      matchId: "fixture-recovered-isolation",
      mapName: "Desert_Main",
      mapDisplayName: "미라마",
      fullResult: {
        mapName: "Desert_Main",
        team: [
          { name: "Player_A" },
          { name: "Beta" },
          { name: "Charlie" },
          { name: "Delta" }
        ],
        isolationData: {
          deathIsolation: 3.2,
          minDist: 50,
          isolationIndex: 3.2
        },
        tradeStats: {
          tradeLatencyMs: 0,
          teammateKnocks: 1,
          smokeRescues: 0,
          revCount: 1,
          enemyTeamWipes: 0
        },
        timeline: [
          {
            ts: 240000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_A",
            victim: "Beta",
            weapon: "ACE32",
            x: 1400,
            y: 2400
          },
          {
            ts: 258000,
            type: "TEAM_REVIVE",
            attacker: "Player_A",
            victim: "Beta",
            x: 1420,
            y: 2420
          }
        ]
      }
    };

    const scenes = extractSquadCauseScenes([recoveredIsolationMatch], {
      benchmarkTradeLatencyMs: 11642,
      maxScenes: 10
    });
    const isolationScene = scenes.find(scene => scene.type === "isolation_death");

    expect(isolationScene?.severity).toBe("warning");
    expect(isolationScene?.facts.join(" ")).toContain("아군 평균 거리는 위험 기준 이내");
    expect(isolationScene?.facts.join(" ")).toContain("30초 안에 소생 성공 이벤트 확인");
  });

  it("같은 매치의 같은 대상자 반복 장면은 상위 장면에서 가능한 한 중복 선택하지 않는다", () => {
    const repeatedIsolationMatch: SquadCauseSceneMatchInput = {
      matchId: "fixture-repeated-isolation",
      mapName: "Desert_Main",
      mapDisplayName: "미라마",
      fullResult: {
        mapName: "Desert_Main",
        team: [
          { name: "Player_A" },
          { name: "Beta" },
          { name: "Charlie" },
          { name: "Delta" }
        ],
        isolationData: {
          deathIsolation: 3.2,
          minDist: 240,
          isolationIndex: 3.2
        },
        tradeStats: {
          tradeLatencyMs: 0,
          teammateKnocks: 2,
          smokeRescues: 0,
          revCount: 0,
          enemyTeamWipes: 0
        },
        timeline: [
          {
            ts: 120000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_A",
            victim: "Beta",
            weapon: "ACE32",
            x: 1100,
            y: 2100
          },
          {
            ts: 720000,
            type: "TEAM_KNOCK",
            attacker: "Enemy_B",
            victim: "Charlie",
            weapon: "Beryl M762",
            x: 1800,
            y: 2600
          }
        ]
      }
    };
    const scenes = extractSquadCauseScenes([repeatedIsolationMatch, ...exceptionMatches], {
      benchmarkTradeLatencyMs: 11642,
      maxScenes: 5
    });

    const repeatedIsolationScenes = scenes.filter(scene =>
      scene.matchId === "fixture-repeated-isolation" &&
      scene.type === "isolation_death"
    );

    expect(repeatedIsolationScenes).toHaveLength(1);
    expect(scenes.some(scene => scene.matchId !== "fixture-repeated-isolation")).toBe(true);
  });

  it("AI가 원본 이벤트를 추론하지 않도록 제약된 프롬프트를 생성한다", () => {
    const scenes = extractSquadCauseScenes(matches, {
      benchmarkTradeLatencyMs: 11642,
      maxScenes: 3
    });
    const prompt = buildSquadCauseScenePrompt({
      ...fixture.squadContext,
      scenes,
      coachingStyle: "spicy"
    });

    expect(prompt).toContain("facts와 metrics만 근거로 사용");
    expect(prompt).toContain("보이스 콜, 소통, 팀워크 수준");
    expect(prompt).toContain("팀 응집력");
    expect(prompt).toContain("복구 능력");
    expect(prompt).toContain("전투력");
    expect(prompt).toContain("전투 진입 각");
    expect(prompt).toContain("수비적으로 플레이했다");
    expect(prompt).toContain("필수적인 연막");
    expect(prompt).toContain("지원 부족");
    expect(prompt).toContain("전력 복구 실패");
    expect(prompt).toContain("복구 실패 문제");
    expect(prompt).toContain("즉각적인 연막");
    expect(prompt).toContain("즉각적인 공격");
    expect(prompt).toContain("즉각적인 복구");
    expect(prompt).toContain("즉각적인 백업");
    expect(prompt).toContain("소생 성공률");
    expect(prompt).toContain("복구 성공률");
    expect(prompt).toContain("안전하게 이루어지지 않는");
    expect(prompt).toContain("불필요한 교전 회피");
    expect(prompt).toContain("엄폐물 확보");
    expect(prompt).toContain("시야 유지");
    expect(prompt).toContain("reviveWithin30s: true");
    expect(prompt).toContain("거리만으로 원인을 단정할 수 없다고 설명");
    expect(prompt).toContain("소생을 성공시키십시오");
    expect(prompt).toContain("안전 조건 확인 후 복구 선택지 확보");
    expect(prompt).toContain("연막 사용 이벤트가 확인되지 않음");
    expect(prompt).toContain("소생 성공 이벤트가 확인되지 않음");
    expect(prompt).toContain("연막 없는 소생 성공 장면");
    expect(prompt).toContain("블루칩 회수자/회수 시점은 단정하지 마십시오");
    expect(prompt).toContain("팀 전원 치명 이벤트 장면");
    expect(prompt).toContain("전력 복구 장면은 적 전원 처치를 의미하지 않습니다");
    expect(prompt).toContain("적 스쿼드 전멸 기여 장면에서만 사용");
    expect(prompt).toContain("내부 장면 타입명을 쓰지 말고 한글 장면명으로만 표현");
    expect(prompt).toContain("적을 다 잡았다");
    expect(prompt).not.toContain("team_wipe");
    expect(prompt).not.toContain("clutch_recovery");
    expect(prompt).not.toContain("safe_revive_without_smoke");
    expect(prompt).not.toContain("team_collapse");
    expect(prompt).toContain("totalTeamWipes는 아군 전멸 횟수가 아니라 적 전멸 기여 지표");
    expect(prompt).toContain("측정 불가");
    expect(prompt).toContain("tradeLatencyMs는 반드시 초 단위");
    expect(prompt).toContain("sceneFeedbacks");
    expect(prompt).toContain("riskFlags");
    expect(prompt).toContain("unsupportedClaims");
  });

  it("AI 응답의 미측정 단정 표현을 후처리 검증으로 탐지한다", () => {
    const issues = validateSquadCauseSceneAiText(`
      아군 지원 부족이 보이고, 소통을 통해 팀워크를 발휘해야 합니다.
      백업 킬 또는 소생을 시도하십시오. 반드시 소생을 성공시켜야 합니다.
      높은 복구 성공률이 필요하고 즉각적인 연막 사용을 고려해야 합니다.
      복구 시도가 안전하게 이루어지지 않는 상황이며 불필요한 교전 회피가 필요합니다.
      다음 판에서는 개별 엄폐물 확보 및 시야 유지가 필요합니다.
      이 패턴은 즉각적인 전력 손실로 이어집니다.
      이 거리는 백업 불가능 상황입니다.
      거리가 벌어진 교전 진입은 피하십시오.
      이어진 교전에서 적 전원 처치가 확인되었습니다.
      다수 아군 치명 이벤트 후에도 침착하게 대응하십시오.
      낮은 팀 응집력과 심각한 전력 복구 실패 문제가 보입니다.
      즉각적인 복구와 즉각적인 공격, 즉각적인 백업이 필요합니다.
      기절 아군을 복구하는 능력과 지속적인 전투력, 전투 진입 각이 문제입니다.
      11회의 팀 전멸이 발생했습니다.
    `);

    const codes = issues.map(issue => issue.code);
    expect(codes).toContain("support_shortage_claim");
    expect(codes).toContain("communication_claim");
    expect(codes).toContain("teamwork_claim");
    expect(codes).toContain("revive_attempt_claim");
    expect(codes).toContain("revive_success_instruction_claim");
    expect(codes).toContain("revive_rate_claim");
    expect(codes).toContain("immediate_smoke_claim");
    expect(codes).toContain("mandatory_outcome_claim");
    expect(codes).toContain("impossibility_claim");
    expect(codes).toContain("safety_assertion_claim");
    expect(codes).toContain("cover_vision_claim");
    expect(codes).toContain("engagement_judgment_claim");
    expect(codes).toContain("power_loss_causality_claim");
    expect(codes).toContain("clutch_enemy_wipe_claim");
    expect(codes).toContain("calmness_claim");
    expect(codes).toContain("team_cohesion_claim");
    expect(codes).toContain("recovery_failure_claim");
    expect(codes).toContain("immediate_action_claim");
    expect(codes).toContain("recovery_ability_claim");
    expect(codes).toContain("combat_power_claim");
    expect(codes).toContain("entry_angle_claim");
    expect(codes).toContain("team_wipe_ambiguity_claim");
  });

  it("AI 응답 검증에서 소생 성공 이벤트 근거 문장은 강요 표현으로 오탐하지 않는다", () => {
    const issues = validateSquadCauseSceneAiText(`
      30초 내 소생 성공 이벤트 없음.
      30초 내 소생 성공 이벤트 확인됨.
      복구 이벤트는 소생 성공 결과로만 표현합니다.
    `);

    expect(issues.map(issue => issue.code)).not.toContain("revive_success_instruction_claim");
  });

  it("AI 응답 검증에서 부정 문맥의 적 전원 처치 안전 문장은 오탐하지 않는다", () => {
    const issues = validateSquadCauseSceneAiText(`
      이 장면은 다수 치명 이벤트 이후 전력 복구 장면이며, 적 전원 처치 확정 장면은 아닙니다.
      이 장면은 적 전원 처치 확정 장면이 아니므로 전력 복구로만 표현합니다.
      적 전원 처치 여부는 별도 적 스쿼드 전멸 기여 장면에서만 표현해야 합니다.
      totalTeamWipes는 적 전멸 기여 지표입니다.
    `);

    expect(issues.map(issue => issue.code)).not.toContain("clutch_enemy_wipe_claim");
    expect(issues.map(issue => issue.code)).not.toContain("team_wipe_ambiguity_claim");
  });
});

it('does not invent a 12-second benchmark when comparison is explicitly unavailable',()=>{
  const scenes=extractSquadCauseScenes(fixture.matches as SquadCauseSceneMatchInput[],{benchmarkTradeLatencyMs:null,maxScenes:30});
  expect(scenes.length).toBeGreaterThan(0);
  for(const scene of scenes){
    expect(scene.metricSnapshot?.benchmarkTradeLatencyMs).toBeNull();
    expect(scene.facts.join(' ')).not.toContain('비교 기준 백업 속도');
  }
});
