import { describe, it, expect } from 'vitest';
import { AnalysisEngine } from '../lib/pubg-analysis/AnalysisEngine';
import { calcBenchmarkScore, getBenchmarkTier, getBaseTier, getNextTierInfo } from '../lib/pubg-analysis/benchmarkScore';
import { adaptObservedBenchmark } from '../lib/pubg-analysis/benchmarkAdapter';
import { buildMatchAiCoachingPrompt } from '../lib/pubg-analysis/matchAiCoachingPrompt';
import fs from 'fs';
import path from 'path';

const realDataPath = path.resolve(__dirname, '../scratch/test-data/revive-gold-match.json');
const hasRealDataFixture = fs.existsSync(realDataPath);

if (!hasRealDataFixture) {
  console.warn('⚠️ 테스트 데이터 파일이 없습니다. 실데이터 테스트 suite를 건너뜁니다.');
}

if (hasRealDataFixture) describe('AnalysisEngine 실데이터(Gold Match) 정밀 검증', () => {
  // 실제 KangHeeSung_ 님의 경기 데이터를 테스트 Fixture로 사용
  const telemetry = JSON.parse(fs.readFileSync(realDataPath, 'utf-8'));
  
  const nickname = "KangHeeSung_";
  const myAccountId = "account.a5fedccd38fb412eaa369658474f326f";
  const teamNames = new Set([nickname]);
  const teamAccountIds = new Set([myAccountId]);
  const eliteNames = new Set([]);
  const eliteAccountIds = new Set([]);
  const myRosterId = "my-roster";

  it('실제 경기에서의 자기장 누적 피해(bluezoneWaste)가 27 HP여야 함', () => {
    const engine = new AnalysisEngine(nickname, myAccountId, teamNames, teamAccountIds, eliteNames, eliteAccountIds, myRosterId);
    const result = engine.run(telemetry, { id: "gold-match", createdAt: "2026-05-02T16:00:00Z", gameMode: "squad" }, [], [], { damageDealt: 500, kills: 3, timeSurvived: 1200 }, [], {});
    
    expect(result.bluezoneWaste).toBe(27);
    console.log("TEST BENCHMARK:", JSON.stringify(result.benchmark, null, 2));
  });

  it('실제 경기에서의 선제 타격 효율(initiative_rate)이 약 17%여야 함', () => {
    const engine = new AnalysisEngine(nickname, myAccountId, teamNames, teamAccountIds, eliteNames, eliteAccountIds, myRosterId);
    const result = engine.run(telemetry, { id: "gold-match", createdAt: "2026-05-02T16:00:00Z", gameMode: "squad" }, [], [], { damageDealt: 500, kills: 3, timeSurvived: 1200 }, [], {});
    
    expect(Math.round(result.initiative_rate)).toBe(17);
    expect(result.initiativeSampleCount).toBe(6); // 6회 시도 중 1회 성공 (150m 초과 견제샷 필터링)
  });

  it('실제 경기에서의 자기장 끝선 플레이(edgePlay)가 8회여야 함', () => {
    const engine = new AnalysisEngine(nickname, myAccountId, teamNames, teamAccountIds, eliteNames, eliteAccountIds, myRosterId);
    const result = engine.run(telemetry, { id: "gold-match", createdAt: "2026-05-02T16:00:00Z", gameMode: "squad" }, [], [], { damageDealt: 500, kills: 3, timeSurvived: 1200 }, [], {});
    
    expect(result.zoneStrategy.edgePlayCount).toBe(8);
  });

  it('실제 경기에서의 교전 승리(wins)가 1회여야 함', () => {
    const engine = new AnalysisEngine(nickname, myAccountId, teamNames, teamAccountIds, eliteNames, eliteAccountIds, myRosterId);
    const result = engine.run(telemetry, { id: "gold-match", createdAt: "2026-05-02T16:00:00Z", gameMode: "squad" }, [], [], { damageDealt: 0, kills: 0 }, [], {});
    
    expect(result.duelStats.wins).toBe(1);
    expect(result.duelStats.losses).toBe(1); // 150m 초과 패배 또는 팀원 어시스트 보정으로 정제됨
  });

  it('차량 전투 지표(리드샷/라이딩샷) 초기화 및 작동 정합성 검증', () => {
    const engine = new AnalysisEngine(nickname, myAccountId, teamNames, teamAccountIds, eliteNames, eliteAccountIds, myRosterId);
    const result = engine.run(telemetry, { id: "gold-match", createdAt: "2026-05-02T16:00:00Z", gameMode: "squad" }, [], [], { damageDealt: 500, kills: 3, timeSurvived: 1200 }, [], {});
    
    expect(result.leadShotKills).toBe(0);
    expect(result.leadShotKnocks).toBe(0);
    expect(result.ridingShotKills).toBe(0);
    expect(result.ridingShotKnocks).toBe(0);
  });

  it('실시간 hitDetails 수집 및 LogMatchEnd의 hitDetails 누락 시 Fallback 정합성 검증', () => {
    const engine = new AnalysisEngine(nickname, myAccountId, teamNames, teamAccountIds, eliteNames, eliteAccountIds, myRosterId);
    
    // telemetry에서 LogMatchEnd를 찾고, w.hitDetails를 강제로 비워 텔레메트리 상세 누락 유실 상태를 모사
    const modifiedTelemetry = JSON.parse(JSON.stringify(telemetry));
    const matchEndEvent = modifiedTelemetry.find((e: any) => e._T === "LogMatchEnd");
    if (matchEndEvent && matchEndEvent.allWeaponStats) {
      matchEndEvent.allWeaponStats.forEach((player: any) => {
        if (player.accountId === myAccountId && player.stats) {
          player.stats.forEach((w: any) => {
            w.hitDetails = []; // ⚠️ 강제로 비워서 누락된 API 상태를 모사
          });
        }
      });
    }

    const result = engine.run(modifiedTelemetry, { id: "gold-match", createdAt: "2026-05-02T16:00:00Z", gameMode: "squad" }, [], [], { damageDealt: 500, kills: 3, timeSurvived: 1200 }, [], {});
    
    // 결과의 weaponStats를 확인
    expect(result.weaponStats).toBeDefined();
    const weaponKeys = Object.keys(result.weaponStats);
    expect(weaponKeys.length).toBeGreaterThan(0);
    
    // 실시간으로 누적된 명중 정보(hitDetails)가 Fallback을 통해 안전하게 복구되었는지 검증
    const mainWeaponKey = weaponKeys.find(key => key === "Dragunov" || key === "ACE32" || key === "FNFal");
    expect(mainWeaponKey).toBeDefined();
    if (mainWeaponKey) {
      const mainWeapon = (result.weaponStats as any)[mainWeaponKey];
      expect(mainWeapon.hitDetails).toBeDefined();
      expect(mainWeapon.hitDetails.length).toBeGreaterThan(0);
      expect(mainWeapon.hits).toBeGreaterThan(0);
      expect(mainWeapon.damage).toBeGreaterThan(0);
      console.log(`🎯 [Fallback Test Passed] ${mainWeaponKey} hitDetails count:`, mainWeapon.hitDetails.length);
    }
  });
});

describe('AnalysisEngine isolation measurement contract', () => {
  it('does not synthesize zero isolation metrics when no position telemetry was observed', () => {
    const engine = new AnalysisEngine(
      'Player',
      'account.player',
      new Set(['player']),
      new Set(['account.player']),
      new Set(),
      new Set(),
      'roster-player',
    );

    const result = engine.run(
      [],
      {
        id: 'no-position-telemetry',
        createdAt: '2026-08-27T00:00:00.000Z',
        gameMode: 'squad-fpp',
        matchType: 'official',
      },
      [],
      [],
      { name: 'Player', damageDealt: 0, kills: 0, winPlace: 10, timeSurvived: 600 },
      [],
      {},
    );

    expect(result.isolationData.isolationIndex).toBeUndefined();
    expect(result.isolationData.minDist).toBeUndefined();
    expect(result.isolationData.heightDiff).toBeUndefined();
    expect(result.isolationData.teammateCount).toBeUndefined();
  });
});

describe('AnalysisEngine observed benchmark contract', () => {
  it('does not invent elite comparison values or a relative badge without benchmark evidence', () => {
    const engine = new AnalysisEngine(
      'Player',
      'account.player',
      new Set(['player']),
      new Set(['account.player']),
      new Set(),
      new Set(),
      'roster-player',
    );

    const result = engine.run(
      [],
      {
        id: 'no-benchmark-evidence',
        createdAt: '2026-08-27T00:00:00.000Z',
        gameMode: 'squad-fpp',
        matchType: 'official',
      },
      [],
      [],
      { name: 'Player', damageDealt: 1_000, kills: 0, winPlace: 10, timeSurvived: 600 },
      [],
      adaptObservedBenchmark({ match_count: 4, avg_damage: 900, avg_damage_count: 4 }),
    );

    expect(result.eliteBenchmark).toBeNull();
    expect(result.teamImpact.damageImpact).toBeNull();
    expect(result.teamImpact.killImpact).toBeNull();
    expect(result.badges.map((badge: any) => badge.id)).not.toContain('ace');

    const { playerReportSummary } = buildMatchAiCoachingPrompt({ matchData: result });
    expect(playerReportSummary).toContain('측정 불가');
    expect(playerReportSummary).not.toContain('Elite Avg: 55%');
    expect(playerReportSummary).not.toContain('Elite Avg: 400');
  });

  it('compares only a benchmark metric with at least five valid samples', () => {
    const benchmark = adaptObservedBenchmark({
      match_count: 10,
      avg_damage: 500,
      avg_damage_count: 5,
      avg_kills: 4,
      avg_kills_count: 4,
    });
    const engine = new AnalysisEngine(
      'Player',
      'account.player',
      new Set(['player']),
      new Set(['account.player']),
      new Set(),
      new Set(),
      'roster-player',
    );

    const result = engine.run(
      [],
      {
        id: 'partial-benchmark-evidence',
        createdAt: '2026-08-27T00:00:00.000Z',
        gameMode: 'squad-fpp',
        matchType: 'official',
      },
      [],
      [],
      { name: 'Player', damageDealt: 1_000, kills: 10, winPlace: 10, timeSurvived: 600 },
      [],
      benchmark,
    );

    expect(result.teamImpact.damageImpact).toBe(200);
    expect(result.teamImpact.killImpact).toBeNull();
    expect(result.badges.map((badge: any) => badge.id)).toContain('ace');

    const { playerReportSummary } = buildMatchAiCoachingPrompt({ matchData: result });
    expect(playerReportSummary).toContain('Elite Avg: 측정 불가');
    expect(playerReportSummary).not.toContain('Elite Avg: 3%');
  });
});

describe('티어 산정 및 조기 탈락 폴백 엔진 검증', () => {
  it('benchmark component and total scores stay finite and within 0..100 for malformed inputs', () => {
    const baseInput = {
      rankPct: 0.2,
      survivalTime: 1200,
      initiativeRate: 50,
      counterLatencyMs: 500,
      pressureIndex: 2,
      smokeRate: 50,
      suppCount: 2,
      reviveRate: 50,
      tradeRate: 50,
      teamWipes: 1,
      reversalRate: 50,
      deathPhase: 5,
      suppRate: 50,
      survivalRankPct: 0.3,
      myKnockCount: 1,
      myDeathCount: 0,
      winPlace: 10,
    };

    const negativePressure = getBenchmarkTier({
      ...baseInput,
      pressureIndex: -100,
    }, true);
    const malformedRate = getBenchmarkTier({
      ...baseInput,
      initiativeRate: Number.NaN,
      pressureIndex: Number.POSITIVE_INFINITY,
    }, false);

    for (const result of [negativePressure, malformedRate]) {
      expect(Number.isFinite(result.score)).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      for (const value of Object.values(result.breakdown)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it('아군 공식 무기 통계가 실시간 소문자 키를 교체해 중복 저장되지 않아야 함', () => {
    const engine = new AnalysisEngine(
      'KangHeeSung_',
      'account.main',
      new Set(['kangheesung_', 'miaeq_q']),
      new Set(['account.main', 'account.miaeq']),
      new Set(),
      new Set(),
      'roster-main'
    );

    const result = engine.run(
      [
        {
          _T: 'LogPlayerTakeDamage',
          _D: '2026-08-13T00:00:01.000Z',
          attacker: { name: 'MiaeQ_Q', accountId: 'account.miaeq' },
          victim: { name: 'Enemy', accountId: 'account.enemy' },
          damage: 100,
          damageCauserName: 'Item_Weapon_Mk14_C',
          damageReason: 'HeadShot',
        },
        {
          _T: 'LogMatchEnd',
          _D: '2026-08-13T00:20:00.000Z',
          characters: [
            { character: { accountId: 'account.miaeq', name: 'MiaeQ_Q' } },
          ],
          allWeaponStats: [
            {
              accountId: 'account.miaeq',
              stats: [{
                weapon: 'Item_Weapon_Mk14_C',
                damage: 110,
                dBNODamage: 0,
                shots: 25,
                hits: 4,
                dBNOHits: 0,
                holdingTime: 12,
              }],
            },
          ],
        },
      ],
      { id: 'squad-weapon-key-match', createdAt: '2026-08-13T00:00:00Z', gameMode: 'squad' },
      [],
      [],
      { name: 'KangHeeSung_', damageDealt: 0, kills: 0 },
      [],
      {}
    );

    expect(Object.keys(result.squadWeaponStats || {})).toEqual(['MiaeQ_Q']);
    expect(result.squadWeaponStats?.MiaeQ_Q?.[0]).toMatchObject({
      weapon: 'Mk14', damage: 110, hits: 4, shots: 25,
    });
  });

  it('공식 딜량은 damageDealt에 유지하고 텔레메트리 유효 딜량은 processedDamageDealt에 분리해야 함', () => {
    const engine = new AnalysisEngine(
      'KangHeeSung_',
      'account.main',
      new Set(['kangheesung_']),
      new Set(['account.main']),
      new Set(),
      new Set(),
      'roster-main'
    );

    const result = engine.run(
      [],
      { id: 'official-damage-match', createdAt: '2026-06-24T00:00:00Z', gameMode: 'duo' },
      [],
      [],
      { name: 'KangHeeSung_', damageDealt: 1250, kills: 12, winPlace: 1, timeSurvived: 1700, DBNOs: 5 },
      [],
      {}
    );

    expect(result.stats.damageDealt).toBe(1250);
    expect(result.stats.processedDamageDealt).toBe(0);
  });

  it('90점 이상 획득 시 S+ 등급으로 판정되어야 함', () => {
    // 만점에 가까운 높은 지표 입력 (스쿼드 기준)
    const highInput = {
      rankPct: 0.05,
      survivalTime: 1700,
      initiativeRate: 90,
      counterLatencyMs: 150,
      pressureIndex: 4.8,
      smokeRate: 95,
      suppCount: 8,
      reviveRate: 95,
      tradeRate: 95,
      teamWipes: 3,
      reversalRate: 90,
      deathPhase: 8,
      suppRate: 90,
      survivalRankPct: 0.05,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 2
    };
    const result = getBenchmarkTier(highInput, false);
    expect(result.tier).toBe('S+');
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it('82점 이상 90점 미만 획득 시 S 등급으로 판정되어야 함', () => {
    const sInput = {
      rankPct: 0.08,
      survivalTime: 1600,
      initiativeRate: 75,
      counterLatencyMs: 300,
      pressureIndex: 4.2,
      smokeRate: 80,
      suppCount: 5,
      reviveRate: 80,
      tradeRate: 80,
      teamWipes: 2,
      reversalRate: 70,
      deathPhase: 7,
      suppRate: 70,
      survivalRankPct: 0.1,
      myKnockCount: 1,
      myDeathCount: 1,
      winPlace: 5
    };
    const result = getBenchmarkTier(sInput, false);
    expect(result.tier).toBe('S');
    expect(result.score).toBeGreaterThanOrEqual(82);
    expect(result.score).toBeLessThan(90);
  });

  it('미라마 12킬 1250딜 1등 캐리 판은 안정도 S와 하드캐리 이상 임팩트를 받아야 함', () => {
    const miramarCarryInput = {
      rankPct: 0.02,
      survivalTime: 1708,
      initiativeRate: 92,
      counterLatencyMs: -1,
      pressureIndex: 7.19,
      smokeRate: 0,
      suppCount: 0,
      reviveRate: 100,
      tradeRate: 100,
      teamWipes: 8,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: 0,
      isolationIndex: 0.8,
      survivalRankPct: 1 / 34,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 1,
      kills: 12,
      damageDealt: 1250,
      teamDamageShare: 84,
      safeRevivesWithoutSmoke: 1,
      teamMode: "duo" as const,
      tradeKills: 2,
      revives: 1,
      smokeRescues: 0,
    };

    const result = getBenchmarkTier(miramarCarryInput, false);

    expect(result.tier).toBe("S");
    expect(result.score).toBeGreaterThanOrEqual(82);
    expect(result.score).toBeLessThan(90);
    expect(result.impactScore).toBeGreaterThanOrEqual(110);
    expect(["HARD_CARRY", "LEGEND"]).toContain(result.impactGrade);
    expect(result.impactReasons).toEqual(expect.arrayContaining([
      "10킬 이상 화력 캐리",
      "1000딜 이상 압도적 화력",
      "연막 없이 안전 소생",
    ]));
    expect(result.impactReasons).not.toContain("1등 보너스");
  });

  it('1등 1킬 180딜 판은 생존 점수는 높아도 승리 기여 보정을 받지 않아야 함', () => {
    const result = getBenchmarkTier({
      rankPct: 0.55,
      survivalTime: 1700,
      initiativeRate: 35,
      counterLatencyMs: -1,
      pressureIndex: 1.2,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 0,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: -1,
      isolationIndex: 1,
      survivalRankPct: 1 / 25,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 1,
      kills: 1,
      damageDealt: 180,
      teamDamageShare: 20,
      teamMode: "squad" as const,
      tradeKills: 0,
      revives: 0,
      smokeRescues: 0,
    }, false);

    expect(result.impactReasons).not.toContain("승리 기여 근거 2개");
    expect(result.impactReasons).not.toContain("명확한 승리 기여");
    expect(result.impactReasons).not.toContain("승리 기여 근거 4개 이상");
  });

  it('듀오 팀 딜 35%는 팀 화력 보정을 받지 않고 스쿼드 35%는 인정한다', () => {
    const base = {
      rankPct: 0.2,
      survivalTime: 1400,
      initiativeRate: 50,
      counterLatencyMs: -1,
      pressureIndex: 3,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 0,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: -1,
      isolationIndex: 1,
      survivalRankPct: 1 / 25,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 1,
      kills: 3,
      damageDealt: 450,
      teamDamageShare: 35,
      tradeKills: 0,
      revives: 0,
      smokeRescues: 0,
    };

    const duo = getBenchmarkTier({ ...base, teamMode: "duo" as const }, false);
    const squad = getBenchmarkTier({ ...base, teamMode: "squad" as const }, false);

    expect(duo.impactReasons).not.toContain("듀오 팀 딜 55% 이상");
    expect(squad.impactReasons).toContain("스쿼드 팀 딜 35% 이상");
  });

  it('딜 낮은 막타형 전멸 기여는 약한 마무리 보정만 받는다', () => {
    const result = getBenchmarkTier({
      rankPct: 0.7,
      survivalTime: 1300,
      initiativeRate: 40,
      counterLatencyMs: -1,
      pressureIndex: 2,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 3,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: -1,
      isolationIndex: 1,
      survivalRankPct: 0.2,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 3,
      kills: 2,
      damageDealt: 180,
      teamDamageShare: 18,
      teamMode: "squad" as const,
      tradeKills: 0,
      revives: 0,
      smokeRescues: 0,
    }, false);

    expect(result.impactBonus).toBeLessThanOrEqual(5);
    expect(result.impactReasons).toContain("전멸 마무리 기여");
    expect(result.impactReasons).not.toContain("적 팀 전멸 결정 기여");
  });

  it('낮은 딜이라도 소생과 트레이드가 있으면 복구형 기여로 인정한다', () => {
    const result = getBenchmarkTier({
      rankPct: 0.65,
      survivalTime: 1500,
      initiativeRate: 40,
      counterLatencyMs: -1,
      pressureIndex: 2,
      smokeRate: 0,
      suppCount: 0,
      reviveRate: 100,
      tradeRate: 100,
      teamWipes: 1,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: 0,
      isolationIndex: 1,
      survivalRankPct: 0.12,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 2,
      kills: 1,
      damageDealt: 220,
      teamDamageShare: 18,
      teamMode: "squad" as const,
      tradeKills: 1,
      revives: 1,
      smokeRescues: 0,
    }, false);

    expect(result.contributionTypes).toEqual(expect.arrayContaining(["RECOVERY", "SUPPORT"]));
    expect(result.impactReasons).toEqual(expect.arrayContaining(["소생 성공", "트레이드 성공"]));
  });

  it('솔로 고킬 치킨은 팀 지표 없이 화력형 캐리로 인정한다', () => {
    const result = getBenchmarkTier({
      rankPct: 0.05,
      survivalTime: 1700,
      initiativeRate: 70,
      counterLatencyMs: -1,
      pressureIndex: 4,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 0,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: -1,
      survivalRankPct: 1 / 100,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 1,
      kills: 8,
      damageDealt: 700,
      teamMode: "solo" as const,
    }, true);

    expect(result.contributionTypes).toContain("FIREPOWER");
    expect(result.impactScore).toBeGreaterThanOrEqual(110);
  });

  it('조기 사망 또는 고립 과다는 매치 임팩트 보정을 감경한다', () => {
    const highImpactInput = {
      rankPct: 0.05,
      survivalTime: 1500,
      initiativeRate: 70,
      counterLatencyMs: -1,
      pressureIndex: 4,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 4,
      reversalRate: -1,
      deathPhase: 0,
      suppRate: -1,
      isolationIndex: 1,
      survivalRankPct: 0.1,
      myKnockCount: 0,
      myDeathCount: 0,
      winPlace: 1,
      kills: 10,
      damageDealt: 1000,
      teamDamageShare: 50,
      teamMode: "squad" as const,
      tradeKills: 1,
      revives: 1,
    };
    const safe = getBenchmarkTier(highImpactInput, false);
    const risky = getBenchmarkTier({
      ...highImpactInput,
      survivalTime: 500,
      deathPhase: 2,
      myDeathCount: 1,
      isolationIndex: 4.8,
      survivalRankPct: 0.5,
    }, false);

    expect(risky.impactBonus).toBeLessThan(safe.impactBonus);
    expect(risky.impactReasons).toEqual(expect.arrayContaining(["조기 사망 리스크 감경", "고립 리스크 감경"]));
  });

  it('getBaseTier 함수가 S+ 와 S 모두 S를 반환해야 함', () => {
    expect(getBaseTier('S+')).toBe('S');
    expect(getBaseTier('S')).toBe('S');
    expect(getBaseTier('A+')).toBe('A');
    expect(getBaseTier('B-')).toBe('B');
  });

  it('조기 탈락자(10분 미만 또는 3페이즈 이하 사망)는 폴백 혜택이 낮게 적용되어야 함', () => {
    // 생존시간 500초(10분 미만), 사망페이즈 2 (조기 탈락)
    // 폴백이 필요한 음수(-1) 전달
    const earlyDeathInput = {
      rankPct: 0.4,
      survivalTime: 500,
      initiativeRate: -1,
      counterLatencyMs: -1,
      pressureIndex: 1.0,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 0,
      reversalRate: -1,
      deathPhase: 2,
      suppRate: -1,
      survivalRankPct: 0.8,
      myKnockCount: 1,
      myDeathCount: 1,
      winPlace: 80
    };

    // 생존시간 700초(10분 이상), 사망페이즈 4 (정상 탈락)
    // 동일하게 폴백이 필요한 음수(-1) 전달
    const normalDeathInput = {
      rankPct: 0.4,
      survivalTime: 700,
      initiativeRate: -1,
      counterLatencyMs: -1,
      pressureIndex: 1.0,
      smokeRate: -1,
      suppCount: 0,
      reviveRate: -1,
      tradeRate: -1,
      teamWipes: 0,
      reversalRate: -1,
      deathPhase: 4,
      suppRate: -1,
      survivalRankPct: 0.6,
      myKnockCount: 0,
      myDeathCount: 1,
      winPlace: 60
    };

    const earlyScore = calcBenchmarkScore(earlyDeathInput, false);
    const normalScore = calcBenchmarkScore(normalDeathInput, false);

    // 정상 탈락자가 높은 폴백율(70~80%)을 적용받으므로 점수가 훨씬 높아야 함
    // (물론 생존시간과 데스페이즈 자체 점수 차이도 있지만, 폴백 차이[Smoke 30->70, Revive 30->80, Trade 30->80 등]로 인해 점수 격차가 매우 큼)
    expect(normalScore).toBeGreaterThan(earlyScore + 10); // 최소 10점 이상의 폴백 점수 차이가 나야 함
  });

  it('getNextTierInfo 함수가 S+ 등급일 때 null을 반환해야 함', () => {
    // 95점인 경우 S+ 등급으로 추정되므로 getNextTierInfo는 null을 반환해야 함
    expect(getNextTierInfo(95)).toBeNull();
  });
});

describe('AnalysisEngine 연막 구출 지표 검증', () => {
  const baseTime = Date.parse("2026-06-11T10:00:00Z");
  const at = (ms: number) => new Date(baseTime + ms).toISOString();

  const matchAttr = {
    id: "smoke-rescue-match",
    createdAt: at(0),
    gameMode: "squad",
    mapName: "Baltic_Main",
    matchType: "official"
  };

  const participants = [
    {
      id: "p-me",
      attributes: {
        stats: {
          name: "Player_A",
          playerId: "account.me",
          damageDealt: 300,
          kills: 0,
          assists: 0,
          DBNOs: 0,
          winPlace: 5,
          timeSurvived: 900
        },
        accountId: "account.me"
      }
    },
    {
      id: "p-team",
      attributes: {
        stats: {
          name: "Team_B",
          playerId: "account.team",
          damageDealt: 100,
          kills: 0,
          assists: 0,
          DBNOs: 0,
          winPlace: 5,
          timeSurvived: 900
        },
        accountId: "account.team"
      }
    }
  ];

  const rosters = [
    {
      id: "roster-1",
      relationships: {
        participants: {
          data: [{ id: "p-me" }, { id: "p-team" }]
        }
      }
    }
  ];

  it('팀원 연막은 타임라인에 남기되 개인 연막/구출 지표에는 합산하지 않는다', () => {
    const telemetry = [
      { _T: "LogMatchStart", _D: at(0) },
      {
        _T: "LogPlayerPosition",
        _D: at(1_000),
        character: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } }
      },
      {
        _T: "LogPlayerPosition",
        _D: at(1_000),
        character: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } }
      },
      {
        _T: "LogPlayerMakeGroggy",
        _D: at(10_000),
        attacker: { name: "Enemy", accountId: "account.enemy", location: { x: 2000, y: 2000, z: 0 } },
        victim: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } },
        damageCauserName: "WeapBerylM762_C"
      },
      {
        _T: "LogPlayerUseThrowable",
        _D: at(11_000),
        attackId: 101,
        character: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } },
        weaponId: "Item_Weapon_SmokeBomb_C"
      },
      {
        _T: "LogPlayerUseThrowable",
        _D: at(12_000),
        attackId: 102,
        character: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } },
        weaponId: "Item_Weapon_SmokeBomb_C"
      },
      {
        _T: "LogThrowableUse",
        _D: at(12_000),
        attackId: 102,
        character: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } },
        weaponId: "Item_Weapon_SmokeBomb_C"
      },
      {
        _T: "LogPlayerRevive",
        _D: at(25_000),
        reviver: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } },
        victim: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } }
      }
    ];

    const engine = new AnalysisEngine(
      "Player_A",
      "account.me",
      new Set(["player_a", "team_b"]),
      new Set(["account.me", "account.team"]),
      new Set(),
      new Set(),
      "roster-1"
    );

    const result = engine.run(
      telemetry,
      matchAttr,
      rosters,
      participants,
      participants[0].attributes.stats,
      participants.map(p => p.attributes.stats),
      {}
    );

    expect(result.itemUseSummary.smokes).toBe(1);
    expect(result.tradeStats.smokeCount).toBe(1);
    expect(result.tradeStats.smokeRescues).toBe(1);
    expect(result.tradeStats.revCount).toBe(1);
    expect(result.tradeStats.teammateKnocks).toBe(1);
    expect(result.timeline.filter(event => event.type === "ITEM_USE")).toHaveLength(2);
  });

  it('팀원 회복템은 타임라인에 남기되 개인 회복/부스트 지표에는 합산하지 않는다', () => {
    const telemetry = [
      { _T: "LogMatchStart", _D: at(0) },
      {
        _T: "LogPlayerPosition",
        _D: at(1_000),
        character: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } }
      },
      {
        _T: "LogPlayerPosition",
        _D: at(1_000),
        character: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } }
      },
      {
        _T: "LogHeal",
        _D: at(10_000),
        character: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } },
        item: { itemId: "Item_Heal_FirstAid_C" }
      },
      {
        _T: "LogPlayerUseHeal",
        _D: at(11_000),
        character: { name: "Team_B", accountId: "account.team", location: { x: 1050, y: 1000, z: 0 } },
        item: { itemId: "Item_Boost_EnergyDrink_C" }
      },
      {
        _T: "LogHeal",
        _D: at(12_000),
        character: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } },
        item: { itemId: "Item_Heal_Bandage_C" }
      },
      {
        _T: "LogPlayerUseHeal",
        _D: at(13_000),
        character: { name: "Player_A", accountId: "account.me", location: { x: 1000, y: 1000, z: 0 } },
        item: { itemId: "Item_Boost_PainKiller_C" }
      }
    ];

    const engine = new AnalysisEngine(
      "Player_A",
      "account.me",
      new Set(["player_a", "team_b"]),
      new Set(["account.me", "account.team"]),
      new Set(),
      new Set(),
      "roster-1"
    );

    const result = engine.run(
      telemetry,
      matchAttr,
      rosters,
      participants,
      participants[0].attributes.stats,
      participants.map(p => p.attributes.stats),
      {}
    );

    expect(result.itemUseStats.heals).toBe(1);
    expect(result.itemUseStats.boosts).toBe(1);
    expect(result.timeline.filter(event => event.type === "ITEM_USE")).toHaveLength(4);
  });
});
