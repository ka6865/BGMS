import { createClient } from "@/utils/supabase/server";
import {
  extractSquadCauseScenes,
  SquadCauseScene,
  SquadCauseSceneMatchInput
} from "@/lib/pubg-analysis/squadCauseScenes";
import {
  deriveSquadRecoveryStatsFromTimeline,
  hasSquadRecoveryTimelineSignals
} from "@/lib/pubg-analysis/squadRecoveryStats";
import { getValidFullResultForMatch, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { evaluateMatchEligibility } from "@/lib/pubg-analysis/matchEligibility";
import {
  selectBestMatches,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "@/lib/pubg-analysis/recentMatchSelection";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import {
  BENCHMARK_FILTER_VERSION,
  BENCHMARK_POPULATION_EVIDENCE_VERSION,
  getBenchmarkTierFamily,
  isCanonicalBenchmarkTier,
  isTrustedBenchmarkAggregate,
  MIN_BENCHMARK_SAMPLE_COUNT,
  type CanonicalBenchmarkTier,
} from "@/lib/pubg-analysis/benchmarkLookup";

// Invalid/legacy rows are filtered after hydration. Fetch a bounded window
// larger than the ten rows we ultimately expose so stale, custom, or
// unmarked entries cannot crowd newer valid matches out of the population.
const SQUAD_ANALYSIS_SOURCE_LIMIT = 100;

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function finiteRate(value: unknown): number | null {
  const numberValue = finiteNonNegative(value);
  return numberValue !== null && numberValue <= 1 ? numberValue : null;
}

export async function getSquadAnalysisData(nickname: string, platform: string = "steam", groupKey?: string | null) {
  // normalizeName: 소문자 + trim만 수행, 특수문자(-. 등) 제거 없음 → DB player_id와 정합성 보장
  const lowerNickname = normalizeName(nickname);
  const cachePlatform = normalizePlatform(platform);
  const supabase = await createClient();

  const { data: matchData, error: dbError } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, player_id, platform, data, updated_at")
    .eq("platform", cachePlatform)
    .eq("player_id", lowerNickname)
    .order("updated_at", { ascending: false })
    .limit(SQUAD_ANALYSIS_SOURCE_LIMIT);

  if (dbError) {
    console.error("[SQUAD-DB-ERROR]", dbError);
    throw new Error("Database error occurred.");
  }

  const validMatchData = (matchData || [])
    .flatMap((m: any, sourceIndex: number) => {
      const fullResult = getValidFullResultForMatch(m, {
        matchId: m?.match_id,
        playerId: lowerNickname,
        platform: cachePlatform,
        minResultVersion: RESULT_VERSION,
        requirePopulationEvidence: true,
        requireExactResultVersion: true,
      });
      if (!fullResult) return [];
      const eligibility = evaluateMatchEligibility({
        ...fullResult,
        ...m,
        // Preserve storage-side metadata as separate evidence.  A canonical
        // looking nested result must not hide a TDM/custom/AI marker on the
        // row itself.
        ...(m?.data && typeof m.data === "object" ? m.data : {}),
        metadataEvidence: [m, m?.data, fullResult].filter(Boolean),
      }, "ai");
      if (!eligibility.eligible) return [];
      return [{
        ...m,
        __sourceIndex: sourceIndex,
        __eligibility: eligibility,
        data: {
          ...(m.data || {}),
          fullResult,
        },
      }];
    }) as any[];

  if (validMatchData.length === 0) {
    return {
      message: "No match records found. Please search and analyze matches first.",
      groups: []
    };
  }

  const squadMatches = validMatchData.filter((m) => (
    m.__eligibility?.mode === "squad" || m.__eligibility?.mode === "squad-fpp"
  ));

  const groupMap = new Map<string, {
    matches: any[];
    memberNamesByKey: Map<string, string>;
  }>();

  squadMatches.forEach(m => {
    const fullResult = m.data?.fullResult;
    const team = fullResult.team || [];
    const teammateNameMap = new Map<string, string>();
    team.forEach((t: any) => {
      const name = String(t.name || "").trim();
      const normalized = normalizeName(name);
      if (!name || !normalized || normalized === lowerNickname) return;
      if (!teammateNameMap.has(normalized)) {
        teammateNameMap.set(normalized, name);
      }
    });
    const teammates = Array.from(teammateNameMap.values()).sort((a: string, b: string) => a.localeCompare(b));

    if (teammates.length === 0) return;

    const normalizedKey = Array.from(teammateNameMap.keys()).sort().join(",");
    const existing = groupMap.get(normalizedKey);
    if (existing) {
      existing.matches.push(m);
      teammateNameMap.forEach((displayName, normalizedName) => {
        if (!existing.memberNamesByKey.has(normalizedName)) {
          existing.memberNamesByKey.set(normalizedName, displayName);
        }
      });
    } else {
      groupMap.set(normalizedKey, {
        matches: [m],
        memberNamesByKey: teammateNameMap
      });
    }
  });

  const selectCandidates = (matches: any[]): RecentMatchCandidate<any>[] => matches.map((match, sourceIndex) => {
    const fullResult = match.data?.fullResult || {};
    const matchInfo = fullResult.matchInfo && typeof fullResult.matchInfo === "object"
      ? fullResult.matchInfo
      : {};
    const first = (...values: unknown[]) => values.find((value) => value !== undefined && value !== null && value !== "");
    const rawId = first(match.match_id, fullResult.matchId, fullResult.match_id, fullResult.id);
    // The shared best-match selector reads `candidate.value.benchmark.score`.
    // Storage rows keep the canonical benchmark nested under
    // `data.fullResult`; expose a shallow selector-only view so score ranking
    // sees that canonical value without mutating the DB row or dropping its
    // data for downstream aggregation.
    const selectorValue = {
      ...match,
      benchmark: fullResult.benchmark,
    };
    return {
      id: typeof rawId === "string" ? rawId : String(rawId ?? ""),
      createdAt: String(first(fullResult.createdAt, matchInfo.date, match.updated_at) || "") || null,
      matchType: String(first(fullResult.matchType, fullResult.match_type, matchInfo.matchType, match.match_type) || "") || null,
      gameMode: String(first(fullResult.gameMode, fullResult.game_mode, matchInfo.gameMode, matchInfo.mode, match.game_mode) || "") || null,
      mapName: String(first(fullResult.mapName, fullResult.map_name, matchInfo.mapName, matchInfo.mapId, match.map_name) || "") || null,
      sourceIndex: Number.isFinite(match.__sourceIndex) ? match.__sourceIndex : sourceIndex,
      value: selectorValue,
    };
  });

  const selectedGroupMatches = new Map<string, any[]>();
  const bestGroupMatches = new Map<string, any[]>();
  const groups = Array.from(groupMap.entries()).map(([normalizedKey, value]) => {
    const latestSelection = selectRecentMatches(selectCandidates(value.matches), { limit: 10 });
    const latestMatches = latestSelection.selected.map((candidate) => candidate.value);
    const bestMatches = selectBestMatches(latestSelection.selected, { limit: 5 }).map((candidate) => candidate.value);
    selectedGroupMatches.set(normalizedKey, latestMatches);
    bestGroupMatches.set(normalizedKey, bestMatches);
    return {
    groupKey: Array.from(value.memberNamesByKey.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, displayName]) => displayName)
      .join(", "),
    matchCount: latestMatches.length,
    matchIds: latestMatches.map((match) => match.match_id),
    members: Array.from(value.memberNamesByKey.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, displayName]) => displayName)
    };
  }).sort((a, b) => b.matchCount - a.matchCount);

  if (!groupKey) {
    return { groups };
  }

  const selectedGroup = groups.find(g => g.groupKey === groupKey);
  if (!selectedGroup) {
    throw new Error("Selected squad group not found.");
  }

  const normalizedGroupKey = Array.from(groupMap.entries())
    .find(([, value]) => Array.from(value.memberNamesByKey.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, displayName]) => displayName)
      .join(", ") === groupKey)?.[0];
  if (!normalizedGroupKey) throw new Error("Selected squad group not found.");
  const targetMatches = selectedGroupMatches.get(normalizedGroupKey) || [];
  const analysisMatches = bestGroupMatches.get(normalizedGroupKey) || [];
  const matchCount = analysisMatches.length;

  let accumIsolation = 0;
  let accumTradeLatency = 0;
  let validTradeLatencyCount = 0;
  let totalSmokeRescues = 0;
  let totalRevives = 0;
  let accumCoverRate = 0;
  let totalTeamWipes = 0;
  let accumTeammateKnocks = 0;

  const memberNameByKey = new Map<string, string>();
  const addSquadMember = (name: string) => {
    const displayName = String(name || "").trim();
    const normalizedName = normalizeName(displayName);
    if (!displayName || !normalizedName) return;
    if (!memberNameByKey.has(normalizedName)) {
      memberNameByKey.set(normalizedName, displayName);
    }
  };

  addSquadMember(nickname);
  selectedGroup.members.forEach(addSquadMember);
  const squadMemberKeys = Array.from(memberNameByKey.keys());

  const playerAccumStats: Record<string, { damage: number; kills: number; assists: number; dbnos: number }> = {};
  squadMemberKeys.forEach(key => {
    playerAccumStats[key] = { damage: 0, kills: 0, assists: 0, dbnos: 0 };
  });

  const tierCounts: Record<string, number> = {};
  let invalidTierSeen = false;

  analysisMatches.forEach(m => {
    const data = m.data || {};
    const fullResult = data.fullResult || {};
    const isolationData = fullResult.isolationData || {};
    const tradeStats = fullResult.tradeStats || {};
    const timeline = Array.isArray(fullResult.timeline) ? fullResult.timeline : [];
    const squadRecoveryStats = deriveSquadRecoveryStatsFromTimeline(timeline);
    const hasRecoveryTimeline = hasSquadRecoveryTimelineSignals(timeline);

    const isolation = finiteNonNegative(isolationData.isolationIndex);
    if (isolation !== null) accumIsolation += isolation;

    const tradeLatency = finiteNonNegative(tradeStats.tradeLatencyMs);
    // Zero milliseconds is a valid finite observation.  Keep it in the
    // denominator so a measured instant trade is not silently converted to
    // "unavailable" downstream.
    if (tradeLatency !== null) {
      accumTradeLatency += tradeLatency;
      validTradeLatencyCount++;
    }

    totalSmokeRescues += hasRecoveryTimeline ? squadRecoveryStats.squadSmokeRescues : (tradeStats.smokeRescues || 0);
    totalRevives += hasRecoveryTimeline ? squadRecoveryStats.squadRevives : (tradeStats.revCount || 0);
    const coverRate = finiteRate(tradeStats.coverRate);
    if (coverRate !== null) accumCoverRate += coverRate;
    totalTeamWipes += tradeStats.enemyTeamWipes || 0;
    accumTeammateKnocks += tradeStats.teammateKnocks || 0;

    const matchTier = fullResult.benchmark?.tier || fullResult.matchInfo?.tier;
    // Every selected best-five row must carry its own canonical tier proof.
    // A majority vote must never launder one missing/invalid row into a
    // measured squad tier.
    if (!isCanonicalBenchmarkTier(matchTier)) {
      invalidTierSeen = true;
    } else {
      tierCounts[matchTier] = (tierCounts[matchTier] || 0) + 1;
    }

    const team = fullResult.team || [];
    team.forEach((t: any) => {
      const matchingMemberKey = squadMemberKeys.find(memberKey => memberKey === normalizeName(t.name));
      if (matchingMemberKey) {
        playerAccumStats[matchingMemberKey].damage += t.damageDealt || 0;
        playerAccumStats[matchingMemberKey].kills += t.kills || 0;
        playerAccumStats[matchingMemberKey].assists += t.assists || 0;
        playerAccumStats[matchingMemberKey].dbnos += t.DBNOs || 0;
      }
    });
  });

  const measuredIsolationCount = analysisMatches.reduce((count, m) => (
    finiteNonNegative(m.data?.fullResult?.isolationData?.isolationIndex) === null ? count : count + 1
  ), 0);
  const measuredCoverCount = analysisMatches.reduce((count, m) => (
    finiteRate(m.data?.fullResult?.tradeStats?.coverRate) === null ? count : count + 1
  ), 0);
  const avgIsolation = measuredIsolationCount > 0 ? (accumIsolation / measuredIsolationCount) : null;
  const avgTradeLatency = validTradeLatencyCount > 0 ? (accumTradeLatency / validTradeLatencyCount) : null;
  const avgCoverRate = measuredCoverCount > 0 ? (accumCoverRate / measuredCoverCount) : null;

  let detectedTier: CanonicalBenchmarkTier | null = null;
  let maxCount = 0;
  for (const [tier, count] of Object.entries(tierCounts)) {
    if (count > maxCount) {
      maxCount = count;
      detectedTier = tier as CanonicalBenchmarkTier;
    }
  }

  if (invalidTierSeen || !isCanonicalBenchmarkTier(detectedTier)) {
    throw new Error("Squad benchmark data unavailable.");
  }

  const baseTierChar = detectedTier.charAt(0).toUpperCase();
  const targetTier: CanonicalBenchmarkTier = (
    ["S", "A", "B", "C", "D"].includes(baseTierChar) ? baseTierChar : "B"
  ) as CanonicalBenchmarkTier;

  interface BenchmarkStats {
    avgIsolation: number;
    avgTradeLatency: number;
    avgReviveRate: number;
    avgSmokeRate: number;
    avgTeamWipes: number;
  }

  const aggregateBenchmarkRows = (rows: unknown[], allowedTiers: ReadonlySet<string>): BenchmarkStats | null => {
    const trustedRows = rows.filter((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const candidate = row as Record<string, unknown>;
      return isCanonicalBenchmarkTier(candidate.tier)
        && allowedTiers.has(candidate.tier)
        && isTrustedBenchmarkAggregate(candidate);
    }) as Array<Record<string, unknown>>;
    if (trustedRows.length === 0) return null;

    const averageMetric = (field: string): number | null => {
      const values = trustedRows
        .map((row) => finiteNonNegative(row[field]))
        .filter((value): value is number => value !== null);
      if (values.length < MIN_BENCHMARK_SAMPLE_COUNT) return null;
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      return Number.isFinite(average) ? average : null;
    };

    const avgIsolation = averageMetric("isolation_index");
    const avgTradeLatency = averageMetric("trade_latency_ms");
    const avgReviveRate = averageMetric("revive_rate");
    const avgSmokeRate = averageMetric("smoke_rate");
    const avgTeamWipes = averageMetric("team_wipes");
    if (
      avgIsolation === null
      || avgTradeLatency === null
      || avgReviveRate === null
      || avgSmokeRate === null
      || avgTeamWipes === null
    ) return null;

    return { avgIsolation, avgTradeLatency, avgReviveRate, avgSmokeRate, avgTeamWipes };
  };

  let benchmark: BenchmarkStats | null = null;
  let benchmarkTier = detectedTier;

  try {
    const { data: dbBench, error: benchError } = await supabase
      .from("global_benchmarks")
      .select("tier, isolation_index, trade_latency_ms, revive_rate, smoke_rate, team_wipes, filter_version, population_evidence_version")
      .eq("platform", cachePlatform)
      .eq("tier", detectedTier)
      .eq("filter_version", BENCHMARK_FILTER_VERSION)
      .eq("population_evidence_version", BENCHMARK_POPULATION_EVIDENCE_VERSION)
      .in("game_mode", ["squad", "squad-fpp"])
      .in("match_type", ["official", "competitive"]);

    if (benchError) throw benchError;
    benchmark = aggregateBenchmarkRows(
      Array.isArray(dbBench) ? dbBench : [],
      new Set([detectedTier]),
    );
    if (benchmark === null) {
      const { data: dbBenchBase, error: benchBaseError } = await supabase
        .from("global_benchmarks")
        .select("tier, isolation_index, trade_latency_ms, revive_rate, smoke_rate, team_wipes, filter_version, population_evidence_version")
        .eq("platform", cachePlatform)
        .in("tier", getBenchmarkTierFamily(targetTier))
        .eq("filter_version", BENCHMARK_FILTER_VERSION)
        .eq("population_evidence_version", BENCHMARK_POPULATION_EVIDENCE_VERSION)
        .in("game_mode", ["squad", "squad-fpp"])
        .in("match_type", ["official", "competitive"]);

      if (benchBaseError) throw benchBaseError;
      benchmark = aggregateBenchmarkRows(
        Array.isArray(dbBenchBase) ? dbBenchBase : [],
        new Set(getBenchmarkTierFamily(targetTier)),
      );
      if (benchmark !== null) benchmarkTier = targetTier;
    }
    if (benchmark === null) throw new Error("Squad benchmark data unavailable.");
  } catch (err) {
    console.error("[SQUAD-ANALYZE] Live benchmark query failed; refusing synthetic benchmark evidence:", err);
    throw new Error("Squad benchmark data unavailable.");
  }

  const userReviveRate = (totalRevives / Math.max(1, accumTeammateKnocks)) * 100;
  const userSmokeRate = (totalSmokeRescues / Math.max(1, accumTeammateKnocks)) * 100;
  const userWipes = matchCount > 0 ? totalTeamWipes / matchCount : null;

  const formationScore = avgIsolation === null ? null : Math.max(10, Math.min(100, Math.round(70 + (benchmark.avgIsolation - avgIsolation) * 40)));
  const backupSpeedScore = avgTradeLatency === null ? null : Math.max(10, Math.min(100, Math.round(70 + (benchmark.avgTradeLatency - avgTradeLatency) / 150)));
  const survivalCareScore = Math.max(10, Math.min(100, Math.round(70 + (userReviveRate - benchmark.avgReviveRate) * 1.5 + (userSmokeRate - benchmark.avgSmokeRate) * 5)));
  const focusFireScore = avgCoverRate === null ? null : Math.max(10, Math.min(100, Math.round(70 + (avgCoverRate - 0.30) * 100)));
  const teamWipeScore = userWipes === null ? null : Math.max(10, Math.min(100, Math.round(70 + (userWipes - benchmark.avgTeamWipes) * 6)));

  const scores = {
    formation: formationScore,
    backupSpeed: backupSpeedScore,
    survivalCare: survivalCareScore,
    focusFire: focusFireScore,
    teamWipe: teamWipeScore
  };

  const scoreParts = [
    [formationScore, 0.20],
    [backupSpeedScore, 0.25],
    [survivalCareScore, 0.15],
    [focusFireScore, 0.25],
    [teamWipeScore, 0.15],
  ] as const;
  const scoreWeight = scoreParts.reduce((sum, [value, weight]) => value === null ? sum : sum + weight, 0);
  // An overall grade is measured only when every constituent score is
  // measured.  A partial weighted average can otherwise look like a genuine
  // B (or another grade) even though isolation/latency/cover evidence is
  // missing.
  const allScoresMeasured = scoreParts.every(([value]) => value !== null);
  const overallScore = allScoresMeasured
    ? Math.round(scoreParts.reduce((sum, [value, weight]) => value === null ? sum : sum + value * weight, 0) / scoreWeight)
    : null;

  let squadGrade: string | null = null;
  if (overallScore !== null) {
    if (overallScore >= 95) squadGrade = "S+";
    else if (overallScore >= 90) squadGrade = "S";
    else if (overallScore >= 87) squadGrade = "A+";
    else if (overallScore >= 83) squadGrade = "A";
    else if (overallScore >= 80) squadGrade = "A-";
    else if (overallScore >= 77) squadGrade = "B+";
    else if (overallScore >= 73) squadGrade = "B";
    else if (overallScore >= 70) squadGrade = "B-";
    else if (overallScore >= 65) squadGrade = "C+";
    else if (overallScore >= 60) squadGrade = "C";
    else if (overallScore >= 55) squadGrade = "C-";
    else if (overallScore >= 50) squadGrade = "D+";
    else squadGrade = "D";
  }

  const totalStats = { damage: 0, kills: 0, assists: 0, dbnos: 0 };
  squadMemberKeys.forEach(key => {
    const stats = playerAccumStats[key];
    totalStats.damage += stats.damage;
    totalStats.kills += stats.kills;
    totalStats.assists += stats.assists;
    totalStats.dbnos += stats.dbnos;
  });

  let maxDamageName = "";
  let maxDamageValue = -1;
  let maxDbnoName = "";
  let maxDbnoValue = -1;
  let maxKillName = "";
  let maxKillValue = -1;
  let maxAssistName = "";
  let maxAssistValue = -1;

  squadMemberKeys.forEach(key => {
    const name = memberNameByKey.get(key) || key;
    const stats = playerAccumStats[key];
    if (stats.damage > maxDamageValue) {
      maxDamageValue = stats.damage;
      maxDamageName = name;
    }
    if (stats.dbnos > maxDbnoValue) {
      maxDbnoValue = stats.dbnos;
      maxDbnoName = name;
    }
    if (stats.kills > maxKillValue) {
      maxKillValue = stats.kills;
      maxKillName = name;
    }
    if (stats.assists > maxAssistValue) {
      maxAssistValue = stats.assists;
      maxAssistName = name;
    }
  });

  const roleProfiles = squadMemberKeys.map(key => {
    const name = memberNameByKey.get(key) || key;
    const stats = playerAccumStats[key];
    const shares = {
      damage: totalStats.damage > 0 ? Math.round((stats.damage / totalStats.damage) * 100) : 25,
      kill: totalStats.kills > 0 ? Math.round((stats.kills / totalStats.kills) * 100) : 25,
      assist: totalStats.assists > 0 ? Math.round((stats.assists / totalStats.assists) * 100) : 25,
      dbno: totalStats.dbnos > 0 ? Math.round((stats.dbnos / totalStats.dbnos) * 100) : 25
    };

    let role = "전술가";
    let roleDesc = "균형 잡힌 전투 지표를 유지하며 팀의 운영을 돕는 전략가입니다.";

    const deviations = [
      { key: "메인 딜러", val: shares.damage, desc: "팀의 주력 화력을 담당하며 가장 높은 딜량 지분을 보유합니다.", isLeader: maxDamageName === name },
      { key: "선봉장", val: shares.dbno, desc: "교전 시 먼저 적을 기절시켜 전투의 포문을 여는 돌격대장입니다.", isLeader: maxDbnoName === name },
      { key: "해결사", val: shares.kill, desc: "기절한 적을 확실하게 마무리하거나 교전을 승리로 결정짓는 종결자입니다.", isLeader: maxKillName === name },
      { key: "지원가", val: shares.assist, desc: "아군의 전투를 보조하고 뛰어난 어시스트 기여도를 보여주는 서포터입니다.", isLeader: maxAssistName === name }
    ];

    const leaderCategories = deviations.filter(d => d.isLeader);

    if (leaderCategories.length > 0) {
      const bestCategory = leaderCategories.sort((a, b) => b.val - a.val)[0];
      role = bestCategory.key;
      roleDesc = bestCategory.desc;
    }

    return {
      name,
      role,
      roleDesc,
      avgDamage: matchCount > 0 ? Math.round(stats.damage / matchCount) : null,
      avgKills: matchCount > 0 ? Number((stats.kills / matchCount).toFixed(1)) : null,
      avgAssists: matchCount > 0 ? Number((stats.assists / matchCount).toFixed(1)) : null,
      avgDbnos: matchCount > 0 ? Number((stats.dbnos / matchCount).toFixed(1)) : null,
      totalDamage: stats.damage,
      totalKills: stats.kills,
      shares
    };
  });

  const MAP_DISPLAY_NAMES: Record<string, string> = {
    Baltic_Main: "에란겔",
    Desert_Main: "미라마",
    Savage_Main: "사녹",
    Tiger_Main: "태이고",
    Neon_Main: "론도",
    Kiki_Main: "데스턴",
    Summerland_Main: "칼린도",
    Heaven_Main: "헤이븐"
  };

  const matchesSummary = targetMatches.map(m => {
    const fullResult = (m.data as any)?.fullResult || {};
    const mapName = fullResult.mapName || "Unknown";
    const stats = fullResult.stats || {};
    const winPlace = stats.winPlace || 0;
    return {
      matchId: m.match_id,
      mapName,
      mapDisplayName: MAP_DISPLAY_NAMES[mapName] || mapName,
      winPlace,
      createdAt: fullResult.createdAt || m.updated_at
    };
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const causeSceneInputs: SquadCauseSceneMatchInput[] = analysisMatches.map(m => {
    const fullResult = (m.data as any)?.fullResult || {};
    const mapName = fullResult.mapName || "Unknown";
    return {
      matchId: m.match_id,
      mapName,
      mapDisplayName: MAP_DISPLAY_NAMES[mapName] || mapName,
      winPlace: fullResult.stats?.winPlace || 0,
      createdAt: fullResult.createdAt || m.updated_at,
      fullResult
    };
  });

  const causeScenes: SquadCauseScene[] = extractSquadCauseScenes(causeSceneInputs, {
    maxScenes: 5,
    benchmarkTradeLatencyMs: Math.round(benchmark.avgTradeLatency)
  });

  return {
    groupKey,
    // `matchCount` is the population used by the AI/role/potential metrics
    // (best five within the latest ten). Keep both counts explicit so UI
    // callers can still label the complete latest-ten window accurately.
    matchCount,
    latestMatchCount: targetMatches.length,
    bestMatchCount: analysisMatches.length,
    matchesSummary,
    selectedMatchIds: analysisMatches.map((match) => match.match_id),
    stats: {
      avgIsolation: avgIsolation === null ? null : Number(avgIsolation.toFixed(2)),
      avgTradeLatency: avgTradeLatency === null ? null : Math.round(avgTradeLatency),
      totalSmokeRescues,
      totalRevives,
      avgCoverRate: avgCoverRate === null ? null : Number(avgCoverRate.toFixed(2)),
      totalTeamWipes,
      totalTeammateKnocks: accumTeammateKnocks
    },
    scores,
    squadGrade,
    roleProfiles,
    causeScenes,
    benchmarkStats: {
      tier: benchmarkTier,
      avgIsolation: Number(benchmark.avgIsolation.toFixed(2)),
      avgTradeLatency: Math.round(benchmark.avgTradeLatency),
      avgReviveRate: Number(benchmark.avgReviveRate.toFixed(2)),
      avgSmokeRate: Number(benchmark.avgSmokeRate.toFixed(2)),
      avgTeamWipes: Number(benchmark.avgTeamWipes.toFixed(2))
    }
  };
}
