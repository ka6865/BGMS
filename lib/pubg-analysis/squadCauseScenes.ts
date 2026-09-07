import { MAP_NAMES } from "./constants";
import { TimelineEvent } from "./types";
import { normalizeName } from "./utils";
import { deriveSquadRecoveryStatsFromTimeline } from "./squadRecoveryStats";

export type SquadCauseSceneType =
  | "late_trade"
  | "isolation_death"
  | "no_smoke_rescue"
  | "focus_fire_success"
  | "team_wipe"
  | "revive_save"
  | "safe_revive_without_smoke"
  | "clutch_recovery"
  | "recall_recovery"
  | "team_collapse";

export type SquadCauseSceneSeverity = "good" | "warning" | "danger";
export type SquadCauseSceneConfidence = "high" | "medium" | "low";

export interface SquadCauseScene {
  id: string;
  type: SquadCauseSceneType;
  matchId: string;
  mapName: string;
  mapDisplayName: string;
  phase?: number;
  timestampMs: number;
  displayTime: string;
  title: string;
  reason: string;
  severity: SquadCauseSceneSeverity;
  confidence: SquadCauseSceneConfidence;
  actors: string[];
  facts: string[];
  metricSnapshot: {
    tradeLatencyMs?: number | null;
    benchmarkTradeLatencyMs?: number | null;
    deathIsolation?: number;
    minDistanceM?: number;
    smokeUsedWithin15s?: boolean;
    reviveWithin30s?: boolean;
    reviveDelayMs?: number | null;
    recallWithin180s?: boolean;
    recallDelayMs?: number | null;
    enemyPressureEventsWithin10s?: number;
    friendlyDamageEventsAfterKnock?: number;
    recoveryEvents?: number;
    affectedTeammates?: number;
    teamSize?: number;
    collapseWindowMs?: number;
    focusEventCount?: number;
    teamWipes?: number;
    isolationDangerThreshold?: number;
    minDistanceDangerMeters?: number;
  };
  replayWindow: {
    startMs: number;
    endMs: number;
  };
  mapFocus?: {
    x: number;
    y: number;
  };
  aiBrief: string;
}

export interface SquadCauseSceneMatchInput {
  matchId: string;
  mapName?: string;
  mapDisplayName?: string;
  winPlace?: number;
  createdAt?: string;
  fullResult: {
    mapName?: string;
    timeline?: TimelineEvent[];
    stats?: {
      winPlace?: number;
    };
    matchInfo?: {
      tier?: string;
      map?: string;
      mapId?: string;
    };
    team?: Array<{
      name?: string;
    }>;
    isolationData?: {
      deathIsolation?: number;
      minDist?: number;
      isolationIndex?: number;
    };
    tradeStats?: {
      tradeLatencyMs?: number;
      teammateKnocks?: number;
      smokeRescues?: number;
      revCount?: number;
      enemyTeamWipes?: number;
    };
  };
}

export interface ExtractSquadCauseScenesOptions {
  maxScenes?: number;
  benchmarkTradeLatencyMs?: number | null;
  isolationDangerThreshold?: number;
  minDistanceDangerMeters?: number;
  tradeWindowMs?: number;
  smokeWindowMs?: number;
  reviveWindowMs?: number;
}

export interface SquadCauseScenePromptInput {
  nickname: string;
  groupKey: string;
  squadGrade?: string;
  matchCount?: number;
  stats?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  benchmarkStats?: Record<string, unknown>;
  scenes: SquadCauseScene[];
  coachingStyle?: "mild" | "spicy";
}

export interface SquadCauseSceneAiValidationIssue {
  code: string;
  phrase: string;
  message: string;
}

const DEFAULT_OPTIONS = {
  maxScenes: 5,
  benchmarkTradeLatencyMs: 12000,
  isolationDangerThreshold: 2.5,
  minDistanceDangerMeters: 80,
  tradeWindowMs: 30000,
  smokeWindowMs: 15000,
  reviveWindowMs: 30000
};

const SEVERITY_SCORE: Record<SquadCauseSceneSeverity, number> = {
  danger: 300,
  warning: 200,
  good: 100
};

const SUBJECT_DIVERSITY_TYPES = new Set<SquadCauseSceneType>([
  "late_trade",
  "isolation_death",
  "no_smoke_rescue",
  "revive_save",
  "safe_revive_without_smoke",
  "recall_recovery"
]);

const SCENE_TYPE_LABELS: Record<SquadCauseSceneType, string> = {
  late_trade: "백업 지연",
  isolation_death: "고립 위험",
  no_smoke_rescue: "복구 미확인",
  focus_fire_success: "화력 집중",
  team_wipe: "적 스쿼드 전멸 기여",
  revive_save: "연막 소생",
  safe_revive_without_smoke: "연막 없는 소생 성공",
  clutch_recovery: "전력 복구",
  recall_recovery: "리콜/복귀 복구",
  team_collapse: "팀 전원 치명 이벤트"
};

const SCENE_ID_LABELS: Record<SquadCauseSceneType, string> = {
  late_trade: "백업지연",
  isolation_death: "고립위험",
  no_smoke_rescue: "복구미확인",
  focus_fire_success: "화력집중",
  team_wipe: "적전멸기여",
  revive_save: "연막소생",
  safe_revive_without_smoke: "연막없는소생성공",
  clutch_recovery: "전력복구",
  recall_recovery: "리콜복귀복구",
  team_collapse: "팀전원치명이벤트"
};

function formatTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getMapDisplayName(mapName: string, fallback?: string): string {
  if (fallback) return fallback;
  return MAP_NAMES[mapName] || mapName || "알 수 없음";
}

function getEventActors(event: TimelineEvent): string[] {
  return [event.attacker, event.victim, event.playerName].filter(Boolean) as string[];
}

function getEventTargetName(event: TimelineEvent): string {
  return event.victim || event.playerName || "팀원";
}

function getCriticalEventLabel(event: TimelineEvent): string {
  if (event.type === "TEAM_KNOCK" || event.type === "DOWNED") return "기절 이벤트";
  if (event.type === "TEAM_DIED" || event.type === "DIED") return "사망 이벤트";
  return "치명 이벤트";
}

function getCriticalEventOutcome(event: TimelineEvent): string {
  if (event.type === "TEAM_KNOCK" || event.type === "DOWNED") return "기절";
  if (event.type === "TEAM_DIED" || event.type === "DIED") return "사망";
  return "치명 이벤트";
}

function isFriendlyDamageEvent(event: TimelineEvent): boolean {
  return event.type === "KILL" || event.type === "KNOCK" || event.type === "TEAM_KILL";
}

function isKnockOrDeathEvent(event: TimelineEvent): boolean {
  return event.type === "TEAM_KNOCK" || event.type === "DOWNED" || event.type === "TEAM_DIED" || event.type === "DIED";
}

function isSmokeEvent(event: TimelineEvent): boolean {
  if (event.type !== "ITEM_USE") return false;
  const weapon = (event.weapon || "").toLowerCase();
  return weapon.includes("연막") || weapon.includes("smoke") || weapon.includes("m79");
}

function isReviveEventForVictim(event: TimelineEvent, victim?: string): boolean {
  if (event.type !== "REVIVE" && event.type !== "TEAM_REVIVE") return false;
  if (!victim) return true;
  return normalizeName(event.victim || "") === normalizeName(victim);
}

function isRecallEventForVictim(event: TimelineEvent, victim?: string): boolean {
  if (event.type !== "RECALL" && event.type !== "TEAM_RECALL" && event.type !== "REDEPLOY") return false;
  if (!victim) return true;
  return normalizeName(event.victim || "") === normalizeName(victim);
}

function isRecoveryEvent(event: TimelineEvent): boolean {
  return event.type === "REVIVE" ||
    event.type === "TEAM_REVIVE" ||
    event.type === "RECALL" ||
    event.type === "TEAM_RECALL" ||
    event.type === "REDEPLOY";
}

function isEnemyPressureEvent(event: TimelineEvent): boolean {
  return event.type === "DAMAGE_TAKEN" ||
    event.type === "TEAM_KNOCK" ||
    event.type === "DOWNED" ||
    event.type === "TEAM_DIED" ||
    event.type === "DIED";
}

function sceneBase(
  type: SquadCauseSceneType,
  match: SquadCauseSceneMatchInput,
  event: TimelineEvent,
  options: Required<ExtractSquadCauseScenesOptions>
) {
  const mapName = match.mapName || match.fullResult.mapName || "Unknown";
  return {
    id: `${match.matchId}:${SCENE_ID_LABELS[type]}:${Math.round(event.ts)}`,
    type,
    matchId: match.matchId,
    mapName,
    mapDisplayName: getMapDisplayName(mapName, match.mapDisplayName),
    phase: event.phase,
    timestampMs: event.ts,
    displayTime: formatTime(event.ts),
    actors: Array.from(new Set(getEventActors(event))),
    replayWindow: {
      startMs: Math.max(0, event.ts - 15000),
      endMs: event.ts + 15000
    },
    mapFocus: event.x !== undefined && event.y !== undefined
      ? { x: event.x, y: event.y }
      : undefined,
    metricSnapshot: {
      benchmarkTradeLatencyMs: options.benchmarkTradeLatencyMs
    }
  };
}

function pushUnique(scenes: SquadCauseScene[], scene: SquadCauseScene): void {
  const key = `${scene.matchId}:${scene.type}:${scene.timestampMs}`;
  if (!scenes.some(existing => `${existing.matchId}:${existing.type}:${existing.timestampMs}` === key)) {
    scenes.push(scene);
  }
}

function scoreScene(scene: SquadCauseScene): number {
  let score = SEVERITY_SCORE[scene.severity];
  if (scene.type === "late_trade" && scene.metricSnapshot.tradeLatencyMs) {
    score += Math.min(80, Math.round(scene.metricSnapshot.tradeLatencyMs / 1000));
  }
  if (scene.type === "isolation_death") {
    score += Math.round((scene.metricSnapshot.deathIsolation || 0) * 10);
    score += Math.round((scene.metricSnapshot.minDistanceM || 0) / 5);
  }
  if (scene.type === "team_wipe") score += 40;
  if (scene.type === "clutch_recovery") score += 45;
  if (scene.type === "recall_recovery") score += 30;
  if (scene.type === "safe_revive_without_smoke") score += 25;
  if (scene.type === "team_collapse") score += 70;
  if (scene.confidence === "high") score += 20;
  if (scene.confidence === "low") score -= 30;
  return score;
}

function getSceneSubjectKey(scene: SquadCauseScene): string | null {
  if (!SUBJECT_DIVERSITY_TYPES.has(scene.type)) return null;
  const subject = scene.actors[scene.actors.length - 1];
  if (!subject) return null;
  return `${scene.matchId}:${scene.type}:${normalizeName(subject)}`;
}

function getSceneMatchTypeKey(scene: SquadCauseScene): string | null {
  if (!SUBJECT_DIVERSITY_TYPES.has(scene.type)) return null;
  return `${scene.matchId}:${scene.type}`;
}

function selectDiverseScenes(scenes: SquadCauseScene[], maxScenes: number): SquadCauseScene[] {
  const sortedScenes = [...scenes].sort((a, b) => {
    const scoreDelta = scoreScene(b) - scoreScene(a);
    if (scoreDelta !== 0) return scoreDelta;
    return a.timestampMs - b.timestampMs;
  });

  const selected: SquadCauseScene[] = [];
  const typeCounts = new Map<SquadCauseSceneType, number>();
  const matchCounts = new Map<string, number>();
  const timeBuckets = new Set<string>();
  const subjectKeys = new Set<string>();
  const matchTypeKeys = new Set<string>();

  sortedScenes.forEach(scene => {
    if (selected.length >= maxScenes) return;
    const typeCount = typeCounts.get(scene.type) || 0;
    const matchCount = matchCounts.get(scene.matchId) || 0;
    const timeBucket = `${scene.matchId}:${Math.floor(scene.timestampMs / 10000)}`;
    const subjectKey = getSceneSubjectKey(scene);
    const matchTypeKey = getSceneMatchTypeKey(scene);
    if (typeCount >= 2) return;
    if (matchCount >= 3) return;
    if (timeBuckets.has(timeBucket)) return;
    if (matchTypeKey && matchTypeKeys.has(matchTypeKey)) return;
    if (subjectKey && subjectKeys.has(subjectKey)) return;

    selected.push(scene);
    typeCounts.set(scene.type, typeCount + 1);
    matchCounts.set(scene.matchId, matchCount + 1);
    timeBuckets.add(timeBucket);
    if (subjectKey) subjectKeys.add(subjectKey);
    if (matchTypeKey) matchTypeKeys.add(matchTypeKey);
  });

  sortedScenes.forEach(scene => {
    if (selected.length >= maxScenes) return;
    if (selected.some(item => item.id === scene.id)) return;
    const timeBucket = `${scene.matchId}:${Math.floor(scene.timestampMs / 10000)}`;
    const subjectKey = getSceneSubjectKey(scene);
    const matchTypeKey = getSceneMatchTypeKey(scene);
    if (timeBuckets.has(timeBucket)) return;
    if (matchTypeKey && matchTypeKeys.has(matchTypeKey)) return;
    if (subjectKey && subjectKeys.has(subjectKey)) return;
    selected.push(scene);
    timeBuckets.add(timeBucket);
    if (subjectKey) subjectKeys.add(subjectKey);
    if (matchTypeKey) matchTypeKeys.add(matchTypeKey);
  });

  sortedScenes.forEach(scene => {
    if (selected.length >= maxScenes) return;
    if (selected.some(item => item.id === scene.id)) return;
    selected.push(scene);
  });

  if (maxScenes >= 5 && !selected.some(scene => scene.severity === "good")) {
    const bestGoodScene = sortedScenes.find(scene =>
      scene.severity === "good" &&
      !selected.some(item => item.id === scene.id)
    );
    if (bestGoodScene) {
      const replaceableIndex = selected.findIndex(scene => scene.severity === "warning");
      if (replaceableIndex >= 0) {
        selected[replaceableIndex] = bestGoodScene;
      } else {
        const lowestScoreIndex = selected.reduce((lowestIndex, scene, index) =>
          scoreScene(scene) < scoreScene(selected[lowestIndex]) ? index : lowestIndex
        , 0);
        selected[lowestScoreIndex] = bestGoodScene;
      }
    }
  }

  return selected;
}

export function extractSquadCauseScenes(
  matches: SquadCauseSceneMatchInput[],
  options: ExtractSquadCauseScenesOptions = {}
): SquadCauseScene[] {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  const scenes: SquadCauseScene[] = [];

  matches.forEach((match) => {
    const timeline = [...(match.fullResult.timeline || [])].sort((a, b) => a.ts - b.ts);
    if (timeline.length === 0) return;

    const recovery = deriveSquadRecoveryStatsFromTimeline(timeline, match.mapName || match.fullResult.mapName);
    const isolation = match.fullResult.isolationData || {};
    const tradeStats = match.fullResult.tradeStats || {};
    const deathIsolation = Number(isolation.deathIsolation ?? isolation.isolationIndex ?? 0);
    const minDistanceM = Number(isolation.minDist ?? 0);

    timeline.filter(isKnockOrDeathEvent).forEach((event) => {
      const targetName = getEventTargetName(event);
      const hasRecentSameVictimCritical = timeline.some(candidate =>
        candidate.ts < event.ts &&
        event.ts - candidate.ts <= 45000 &&
        isKnockOrDeathEvent(candidate) &&
        normalizeName(getEventTargetName(candidate)) === normalizeName(targetName)
      );
      const isFollowUpDeath = (event.type === "TEAM_DIED" || event.type === "DIED") && hasRecentSameVictimCritical;
      const isInitialKnock = event.type === "TEAM_KNOCK" || event.type === "DOWNED";
      const nextFriendlyDamage = timeline.find(candidate =>
        isFriendlyDamageEvent(candidate) &&
        candidate.ts > event.ts &&
        candidate.ts <= event.ts + resolvedOptions.tradeWindowMs
      );
      const tradeLatencyMs = nextFriendlyDamage ? nextFriendlyDamage.ts - event.ts : null;
      const smokeUsedWithin15s = timeline.some(candidate =>
        isSmokeEvent(candidate) &&
        candidate.ts >= event.ts &&
        candidate.ts <= event.ts + resolvedOptions.smokeWindowMs
      );
      const lifeClosure = timeline.find(candidate =>
        candidate !== event && candidate.ts >= event.ts &&
        normalizeName(candidate.victim || "") === normalizeName(event.victim || "") &&
        ["REVIVE", "TEAM_REVIVE", "DIED", "TEAM_DIED", "TEAM_KNOCK", "DOWNED"].includes(candidate.type) &&
        !(candidate.ts === event.ts && ["TEAM_KNOCK", "DOWNED"].includes(candidate.type))
      );
      const reviveEvent = lifeClosure && isReviveEventForVictim(lifeClosure, event.victim)
        && lifeClosure.ts <= event.ts + resolvedOptions.reviveWindowMs ? lifeClosure : undefined;
      const reviveWithin30s = Boolean(reviveEvent);
      const reviveDelayMs = reviveEvent ? reviveEvent.ts - event.ts : null;
      const recallEvent = timeline.find(candidate =>
        candidate.ts >= event.ts &&
        candidate.ts <= event.ts + 180000 &&
        isRecallEventForVictim(candidate, event.victim)
      );
      const recallDelayMs = recallEvent ? recallEvent.ts - event.ts : null;
      const enemyPressureEventsWithin10s = timeline.filter(candidate =>
        candidate !== event &&
        candidate.ts >= event.ts &&
        candidate.ts <= event.ts + 10000 &&
        isEnemyPressureEvent(candidate) &&
        normalizeName(getEventTargetName(candidate)) === normalizeName(targetName)
      ).length;
      const noTrade = tradeLatencyMs === null;
      const slowTrade = tradeLatencyMs !== null && resolvedOptions.benchmarkTradeLatencyMs !== null &&
        tradeLatencyMs > resolvedOptions.benchmarkTradeLatencyMs + 3000;
      const rescuedWithUtility = reviveWithin30s && recovery.smokeRescueCandidates.some(candidate =>
        candidate.knockTs === event.ts && normalizeName(candidate.victim) === normalizeName(targetName)
        && candidate.smokeDeltaMs <= resolvedOptions.smokeWindowMs
      );

      if (isInitialKnock && !smokeUsedWithin15s && reviveWithin30s && enemyPressureEventsWithin10s === 0) {
        const base = sceneBase("safe_revive_without_smoke", match, event, resolvedOptions);
        const rescuer = reviveEvent?.attacker || "팀원";
        pushUnique(scenes, {
          ...base,
          title: "연막 없이 안전 소생 성공",
          reason: "기절 직후 연막은 확인되지 않았지만, 소생 성공과 낮은 즉시 압박이 함께 확인되었습니다.",
          severity: "good",
          confidence: "medium",
          facts: [
            `${base.displayTime}에 ${targetName} 기절 이벤트 발생`,
            "15초 안에 확인된 연막 사용 없음",
            `${reviveDelayMs !== null ? `${(reviveDelayMs / 1000).toFixed(1)}초 뒤` : "30초 안에"} ${rescuer}의 소생 성공 확인`,
            "기절 후 10초 안에 같은 대상 추가 피격/치명 이벤트 없음",
            "엄폐물, 시야각, 실제 안전 여부는 요약 타임라인만으로 확정 불가"
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            smokeUsedWithin15s,
            reviveWithin30s,
            reviveDelayMs,
            tradeLatencyMs,
            enemyPressureEventsWithin10s
          },
          aiBrief: `${base.displayTime} 장면은 연막 없이 소생이 성공했지만, 엄폐/시야는 측정 불가인 성공 예외입니다.`
        });
      }

      if ((event.type === "TEAM_DIED" || event.type === "DIED") && recallEvent) {
        const base = sceneBase("recall_recovery", match, recallEvent, resolvedOptions);
        pushUnique(scenes, {
          ...base,
          title: "리콜/복귀로 전력 복구",
          reason: "사망 이후 직접 소생은 아니지만 리콜 또는 복귀 성공 이벤트가 확인되었습니다.",
          severity: "good",
          confidence: "medium",
          actors: Array.from(new Set([...base.actors, targetName].filter(Boolean))),
          facts: [
            `${formatTime(event.ts)}에 ${targetName} 사망 이벤트 발생`,
            `${base.displayTime}에 ${recallEvent.type} 이벤트 확인`,
            recallDelayMs !== null ? `사망 후 ${(recallDelayMs / 1000).toFixed(1)}초 뒤 전력 복구 이벤트` : "180초 안에 전력 복구 이벤트",
            "블루칩 회수자와 회수 시점은 현재 요약 타임라인만으로 확정하지 않음"
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            recallWithin180s: true,
            recallDelayMs
          },
          aiBrief: `${formatTime(event.ts)} 사망 이후 ${base.displayTime}에 리콜/복귀 성공이 확인된 복구 장면입니다.`
        });
      }

      if (isInitialKnock && !reviveWithin30s && !rescuedWithUtility && (noTrade || slowTrade)) {
        const base = sceneBase("late_trade", match, event, resolvedOptions);
        const deltaText = tradeLatencyMs === null
          ? "30초 안에 확인된 복수 킬 없음"
          : `기준보다 ${((tradeLatencyMs - (resolvedOptions.benchmarkTradeLatencyMs ?? tradeLatencyMs)) / 1000).toFixed(1)}초 느림`;
        const title = smokeUsedWithin15s
          ? "연막 이후 후속 성과 미확인"
          : "아군 기절 후 백업 지연";
        const reason = smokeUsedWithin15s
          ? `${targetName} 기절 이후 연막 사용은 확인됐지만, 30초 안에 복수 킬 또는 소생 성공 이벤트가 확인되지 않았습니다.`
          : `${targetName} 기절 이후 30초 안에 복수 킬 또는 소생 성공이 확인되지 않았거나, 관측된 비교 기준보다 늦었습니다.`;
        const facts = [
          `${base.displayTime}에 ${targetName} ${getCriticalEventLabel(event)} 발생`,
          deltaText,
          ...(resolvedOptions.benchmarkTradeLatencyMs === null ? [] : [`비교 기준 백업 속도 ${(resolvedOptions.benchmarkTradeLatencyMs / 1000).toFixed(1)}초`])
        ];
        if (smokeUsedWithin15s) facts.push("15초 안에 연막 사용은 확인됨");
        if (!reviveWithin30s) facts.push("30초 안에 소생 성공 이벤트 없음");

        pushUnique(scenes, {
          ...base,
          title,
          reason,
          severity: noTrade ? "danger" : "warning",
          confidence: nextFriendlyDamage ? "high" : "medium",
          facts,
          metricSnapshot: {
            ...base.metricSnapshot,
            tradeLatencyMs,
            smokeUsedWithin15s,
            reviveWithin30s
          },
          aiBrief: smokeUsedWithin15s
            ? `${base.displayTime} ${targetName} 기절 후 연막은 확인됐지만 후속 성과 이벤트가 확인되지 않았습니다.`
            : `${base.displayTime} ${targetName} 기절 후 백업이 늦었습니다. ${deltaText}.`
        });
      }

      if (isInitialKnock && !smokeUsedWithin15s && !reviveWithin30s) {
        const base = sceneBase("no_smoke_rescue", match, event, resolvedOptions);
        pushUnique(scenes, {
          ...base,
          title: "기절 직후 연막/소생 성공 미확인",
          reason: "기절 직후 15초 안에 확인된 연막 사용이 없고, 30초 안에 소생 성공 이벤트도 확인되지 않았습니다.",
          severity: "warning",
          confidence: "medium",
          facts: [
            `${base.displayTime}에 ${targetName} 기절 이벤트 발생`,
            "15초 안에 확인된 연막 사용 없음",
            "30초 안에 확인된 소생 성공 이벤트 없음",
            "소생 시도 여부와 실제 안전 여부는 요약 타임라인만으로 확정 불가"
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            smokeUsedWithin15s,
            reviveWithin30s,
            tradeLatencyMs
          },
          aiBrief: `${base.displayTime} 기절 장면에서 연막 사용과 소생 성공 이벤트는 확인되지 않았지만, 소생 시도 여부는 측정 불가입니다.`
        });
      }

      if (isInitialKnock && rescuedWithUtility) {
        const base = sceneBase("revive_save", match, event, resolvedOptions);
        pushUnique(scenes, {
          ...base,
          title: "연막 이후 소생 성공",
          reason: "기절 위치 근처에서 연막을 사용한 뒤 소생한 기록입니다. 연막의 실제 엄폐 효과는 확인할 수 없습니다.",
          severity: "good",
          confidence: "high",
          facts: [
            `${base.displayTime}에 ${targetName} 기절 이벤트 발생`,
            "15초 안에 연막 사용 확인",
            "30초 안에 소생 성공 확인"
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            smokeUsedWithin15s,
            reviveWithin30s,
            tradeLatencyMs
          },
          aiBrief: `${base.displayTime} 장면에서 기절 위치 근처 연막 사용 후 소생이 확인됩니다. 연막의 실제 엄폐 효과나 구출 의도는 측정하지 못합니다.`
        });
      }

      const hasIsolationRisk =
        deathIsolation >= resolvedOptions.isolationDangerThreshold ||
        minDistanceM >= resolvedOptions.minDistanceDangerMeters;
      if (hasIsolationRisk && !isFollowUpDeath) {
        const base = sceneBase("isolation_death", match, event, resolvedOptions);
        const isDistanceRisk = minDistanceM >= resolvedOptions.minDistanceDangerMeters;
        const isRecoveredKnock = isInitialKnock && reviveWithin30s;
        const roundedDistanceM = Math.round(minDistanceM);
        const outcome = getCriticalEventOutcome(event);
        const facts = [
          `${base.displayTime}에 ${targetName} ${getCriticalEventLabel(event)} 발생`,
          `아군 평균 거리 ${roundedDistanceM}m / 위험 기준 ${resolvedOptions.minDistanceDangerMeters}m`,
          `팀 간격 위험도 ${deathIsolation.toFixed(2)} / 위험 기준 ${resolvedOptions.isolationDangerThreshold}`,
          "팀 간격 위험도는 팀원과의 거리/대열 상태를 요약한 BGMS 파생 지표",
          "매치 단위 추정이라 엄폐물, 시야, 지형 원인은 단정하지 않음"
        ];
        if (!isDistanceRisk) {
          facts.push("아군 평균 거리는 위험 기준 이내라 거리만으로 고립 원인을 단정하지 않음");
        }
        if (reviveWithin30s) {
          facts.push("30초 안에 소생 성공 이벤트 확인");
        }
        pushUnique(scenes, {
          ...base,
          title: isDistanceRisk
            ? `팀과 ${roundedDistanceM}m 떨어진 상태에서 ${outcome}`
            : `팀 간격 위험 신호가 있는 ${outcome}`,
          reason: isDistanceRisk
            ? `아군 평균 거리가 위험 기준 ${resolvedOptions.minDistanceDangerMeters}m를 넘어, 즉시 백업이나 소생 각이 늦어질 수 있는 거리 조건입니다.`
            : "아군 평균 거리는 위험 기준 이내지만, 매치 단위 팀 간격 위험도가 높아 거리만으로 원인을 단정하지 않고 보조 지표로 표시합니다.",
          severity: isRecoveredKnock ? "warning" : "danger",
          confidence: "medium",
          facts,
          metricSnapshot: {
            ...base.metricSnapshot,
            deathIsolation,
            minDistanceM,
            isolationDangerThreshold: resolvedOptions.isolationDangerThreshold,
            minDistanceDangerMeters: resolvedOptions.minDistanceDangerMeters,
            smokeUsedWithin15s,
            reviveWithin30s
          },
          aiBrief: isRecoveredKnock
            ? `${base.displayTime} ${targetName} ${outcome} 장면은 팀 간격 위험도가 높았지만 30초 안에 소생 성공 이벤트가 확인된 복구 동반 장면입니다.`
            : isDistanceRisk
              ? `${base.displayTime} ${targetName} ${outcome} 장면은 아군 평균 거리 ${roundedDistanceM}m로 즉시 백업이나 소생 각이 늦어질 수 있는 거리 조건입니다.`
              : `${base.displayTime} ${targetName} ${outcome} 장면은 팀 간격 위험도가 높지만 거리만으로 원인을 단정할 수 없는 장면입니다.`
        });
      }
    });

    const teamNames = (match.fullResult.team || [])
      .map(member => normalizeName(member.name || ""))
      .filter(Boolean);
    const criticalEvents = timeline.filter(isKnockOrDeathEvent);
    const firstCriticalEvent = criticalEvents[0];
    if (firstCriticalEvent) {
      const criticalWindowEvents = criticalEvents.filter(candidate =>
        candidate.ts >= firstCriticalEvent.ts &&
        candidate.ts <= firstCriticalEvent.ts + 60000
      );
      const affectedTeammates = new Set(
        criticalWindowEvents.map(candidate => normalizeName(getEventTargetName(candidate))).filter(Boolean)
      );
      const friendlyDamageAfterKnock = timeline.filter(candidate =>
        isFriendlyDamageEvent(candidate) &&
        candidate.ts > firstCriticalEvent.ts &&
        candidate.ts <= firstCriticalEvent.ts + 60000
      );
      const recoveryEvents = timeline.filter(candidate =>
        isRecoveryEvent(candidate) &&
        candidate.ts > firstCriticalEvent.ts &&
        candidate.ts <= firstCriticalEvent.ts + 180000
      );

      if (affectedTeammates.size >= 2 && friendlyDamageAfterKnock.length >= 2 && recoveryEvents.length > 0) {
        const anchor = recoveryEvents[0];
        const base = sceneBase("clutch_recovery", match, anchor, resolvedOptions);
        pushUnique(scenes, {
          ...base,
          title: "다수 치명 이벤트 이후 전력 복구",
          reason: "다수 아군 치명 이벤트 이후 아군 공격 이벤트와 소생/리콜 복구 이벤트가 이어졌습니다.",
          severity: "good",
          confidence: "medium",
          facts: [
            `${formatTime(firstCriticalEvent.ts)}부터 60초 안에 아군 ${affectedTeammates.size}명 치명 이벤트`,
            `같은 구간 이후 아군 공격 이벤트 ${friendlyDamageAfterKnock.length}개`,
            `180초 안에 소생/리콜/복귀 이벤트 ${recoveryEvents.length}개`,
            "이 장면은 전력 복구 장면이며, 적 전원 처치 확정 장면이 아님",
            "적 전원 처치 여부는 별도 적 스쿼드 전멸 기여 장면에서만 표현"
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            affectedTeammates: affectedTeammates.size,
            friendlyDamageEventsAfterKnock: friendlyDamageAfterKnock.length,
            recoveryEvents: recoveryEvents.length
          },
          aiBrief: `${formatTime(firstCriticalEvent.ts)} 이후 다수 아군 치명 이벤트 뒤 공격 이벤트와 복구 이벤트가 연결된 전력 복구 장면입니다.`
        });
      }

      if (teamNames.length >= 2) {
        const collapseWindowEvents = criticalEvents.filter(candidate =>
          candidate.ts >= firstCriticalEvent.ts &&
          candidate.ts <= firstCriticalEvent.ts + 30000
        );
        const collapsedMembers = new Set(
          collapseWindowEvents.map(candidate => normalizeName(getEventTargetName(candidate))).filter(name =>
            teamNames.includes(name)
          )
        );
        const hasRecoveryAfterCollapse = timeline.some(candidate =>
          candidate.ts > firstCriticalEvent.ts &&
          candidate.ts <= firstCriticalEvent.ts + 180000 &&
          isRecoveryEvent(candidate)
        );

        if (collapsedMembers.size >= teamNames.length && !hasRecoveryAfterCollapse) {
          const base = sceneBase("team_collapse", match, firstCriticalEvent, resolvedOptions);
          pushUnique(scenes, {
            ...base,
            title: "팀 전원 치명 이벤트",
            reason: "등록된 스쿼드 전원이 짧은 시간 안에 기절/사망 이벤트로 기록되어, 이후 구조 행동을 평가할 생존 전제가 약합니다.",
            severity: "danger",
            confidence: "medium",
            facts: [
              `${base.displayTime}부터 30초 안에 등록 팀원 ${teamNames.length}명 중 ${collapsedMembers.size}명 치명 이벤트`,
              "180초 안에 소생/리콜/복귀 이벤트 없음",
              "팀 전원 치명 이벤트 이후에는 개별 팀원의 구조 미이행으로 단정하지 않음"
            ],
            metricSnapshot: {
              ...base.metricSnapshot,
              affectedTeammates: collapsedMembers.size,
              teamSize: teamNames.length,
              recoveryEvents: 0,
              collapseWindowMs: 30000
            },
            aiBrief: `${base.displayTime} 이후 팀 전원 치명 이벤트가 확인되어 구조 책임보다 교전 진입 조건을 봐야 하는 장면입니다.`
          });
        }
      }
    }

    const friendlyDamageEvents = timeline.filter(isFriendlyDamageEvent);
    for (let i = 0; i < friendlyDamageEvents.length; i++) {
      const event = friendlyDamageEvents[i];
      const cluster = friendlyDamageEvents.filter(candidate =>
        candidate.ts >= event.ts &&
        candidate.ts <= event.ts + 10000
      );
      const uniqueVictims = new Set(cluster.map(candidate => normalizeName(candidate.victim || "")).filter(Boolean));
      if (cluster.length >= 2 && uniqueVictims.size >= 2) {
        const base = sceneBase("focus_fire_success", match, event, resolvedOptions);
        pushUnique(scenes, {
          ...base,
          title: "짧은 시간 내 화력 집중 성공",
          reason: "10초 안에 서로 다른 대상에게 아군 피해 이벤트가 여러 번 연결되었습니다.",
          severity: "good",
          confidence: "high",
          facts: [
            `${base.displayTime}부터 10초 안에 아군 공격 이벤트 ${cluster.length}개`,
            `서로 다른 대상 ${uniqueVictims.size}명에게 피해 흐름 확인`
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            focusEventCount: cluster.length,
            teamWipes: tradeStats.enemyTeamWipes || 0
          },
          aiBrief: `${base.displayTime} 구간은 짧은 시간 안에 아군 화력이 집중된 성공 장면입니다.`
        });
        break;
      }
    }

    if ((tradeStats.enemyTeamWipes || 0) > 0) {
      const anchor = friendlyDamageEvents.find(event => event.type === "KILL" || event.type === "TEAM_KILL") || friendlyDamageEvents[0];
      if (anchor) {
        const base = sceneBase("team_wipe", match, anchor, resolvedOptions);
        pushUnique(scenes, {
          ...base,
          title: "적 스쿼드 전멸 기여",
          reason: "해당 매치에서 적 스쿼드 전멸 기여가 집계되었습니다.",
          severity: "good",
          confidence: "medium",
          facts: [
            `매치 내 적 스쿼드 전멸 기여 ${tradeStats.enemyTeamWipes}회`,
            `${base.displayTime} 근처 아군 킬 이벤트를 대표 장면으로 사용`
          ],
          metricSnapshot: {
            ...base.metricSnapshot,
            teamWipes: tradeStats.enemyTeamWipes
          },
          aiBrief: `${base.displayTime} 근처 교전은 적 스쿼드 전멸 기여 대표 장면입니다.`
        });
      }
    }
  });

  return selectDiverseScenes(scenes, resolvedOptions.maxScenes);
}

export function buildSquadCauseScenePrompt(input: SquadCauseScenePromptInput): string {
  const styleLabel = input.coachingStyle === "mild" ? "다정한 코치" : "팩트 기반 매운맛 코치";
  const sceneTypeCounts = input.scenes.reduce((acc, scene) => {
    const label = SCENE_TYPE_LABELS[scene.type];
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const compactScenes = input.scenes.map(scene => ({
    id: scene.id,
    typeLabel: SCENE_TYPE_LABELS[scene.type],
    severity: scene.severity,
    confidence: scene.confidence,
    matchId: scene.matchId,
    map: scene.mapDisplayName,
    time: scene.displayTime,
    phase: scene.phase ?? "측정 불가",
    title: scene.title,
    reason: scene.reason,
    actors: scene.actors,
    facts: scene.facts,
    metrics: scene.metricSnapshot
  }));

  return `
당신은 PUBG 스쿼드 전술 리포트를 검증하는 ${styleLabel}입니다.

[분석 대상]
- 기준 유저: ${input.nickname}
- 스쿼드 조합: ${input.groupKey}
- 함께 플레이한 경기 수: ${input.matchCount ?? "측정 불가"}
- 스쿼드 등급: ${input.squadGrade ?? "측정 불가"}

[집계 지표]
${JSON.stringify({
    stats: input.stats || {},
    scores: input.scores || {},
    benchmarkStats: input.benchmarkStats || {}
  }, null, 2)}

[원인 장면 후보]
${JSON.stringify(compactScenes, null, 2)}

[장면 유형 카운트]
${JSON.stringify(sceneTypeCounts, null, 2)}

[엄격한 작성 규칙]
- 위 JSON에 있는 facts와 metrics만 근거로 사용하십시오.
- 보이스 콜, 소통, 팀워크 수준, 팀 응집력, 복구 능력, 전투력, 전투 진입 각, 심리 상태, 의도, 파밍 욕심, 침착함, 지원 의식처럼 측정되지 않은 내용은 추론하지 마십시오.
- "수비적으로 플레이했다", "겁먹었다", "방치했다", "소생 시도조차 안 했다", "개인 파밍을 했다"처럼 이벤트로 직접 확인되지 않은 행동/의도 표현은 금지입니다.
- "필수적인 연막", "즉각적인 연막", "즉각적인 공격", "즉각적인 복구", "즉각적인 백업", "연막조차 사용하지 않았다", "소생에 실패했다", "소생을 시도하십시오", "소생을 성공시키십시오", "소생 성공률", "반드시 복수 킬", "백업 불가능", "안전하게 이루어지지 않는", "불필요한 교전 회피", "교전 진입은 피하십시오", "전투 진입 각", "복구 능력", "전투력", "엄폐물 확보", "시야 유지", "복구를 포기했다", "팀워크를 발휘해야 한다", "팀 응집력", "소통해야 한다", "침착하게", "지원 부족", "전력 복구 실패", "복구 실패 문제"처럼 측정 근거를 넘어서는 평가/처방 표현은 금지입니다.
- 좌표만 보고 엄폐물, 건물 구조, 시야각을 단정하지 마십시오.
- 측정되지 않은 항목은 반드시 "측정 불가"라고 쓰십시오.
- "30초 안에 소생 성공 이벤트 없음"은 "소생 시도 없음"이 아니라 "소생 성공 이벤트가 확인되지 않음"으로만 표현하십시오.
- "15초 안에 확인된 연막 사용 없음"은 "연막 미사용이 판단 미스"가 아니라 "연막 사용 이벤트가 확인되지 않음"으로만 표현하십시오.
- "30초 안에 확인된 소생 성공 이벤트 없음"은 "소생 실패"가 아니라 "소생 성공 이벤트가 확인되지 않음"으로만 표현하십시오.
- "소생 성공 이벤트가 확인되지 않음"을 다음 판 행동으로 바꿀 때는 "소생을 시도/성공"처럼 결과를 강요하지 말고, "안전 조건 확인 후 복구 선택지 확보"처럼 조건부 행동으로만 표현하십시오.
- "15초 안에 연막 사용은 확인됨"과 "30초 안에 복수 킬/소생 성공 없음"이 함께 있으면 "연막 이후 후속 성과 미확인"으로 표현하고, 수비적 플레이나 판단 미스를 단정하지 마십시오.
- "연막 사용 없음"과 "소생 성공"이 함께 있으면 연막 없는 판단 미스로 단정하지 말고, 연막 없는 소생 성공 장면의 근거와 한계를 함께 설명하십시오.
- "소생 성공률" 또는 "복구 성공률"은 별도 비율 필드가 제공되지 않았으면 쓰지 말고, "totalRevives"와 "totalTeammateKnocks" 같은 원본 집계 숫자로만 표현하십시오.
- "안전함/불안전함"은 엄폐물, 시야각, 적 위치 정밀 판정이 없으면 단정하지 말고 "안전 조건 확인"처럼 조건부로만 표현하십시오.
- 엄폐물 확보, 시야 유지, 시야각, 건물 구조는 현재 facts와 metrics에 없으면 다음 행동으로도 쓰지 마십시오.
- 교전 필요성이나 회피 필요성은 현재 facts만으로 단정하지 마십시오.
- "reviveWithin30s: true"인 장면은 복구 성공 이벤트가 확인된 장면이므로 전력 손실 확정이나 복구 실패처럼 표현하지 마십시오.
- "deathIsolation"은 위험 기준 이상이지만 "minDistanceM"이 위험 기준 이내인 장면은 "거리를 줄여라"로 처방하지 말고, 거리만으로 원인을 단정할 수 없다고 설명하십시오.
- RECALL, TEAM_RECALL, REDEPLOY는 전력 복구 성공으로 표현할 수 있지만, 별도 facts가 없으면 블루칩 회수자/회수 시점은 단정하지 마십시오.
- 팀 전원 치명 이벤트 장면은 이후의 구조 미이행을 개인 책임으로 단정하지 말고, 교전 진입 조건과 복구 불가능성을 구분하십시오.
- 전력 복구 장면은 적 전원 처치를 의미하지 않습니다. "적 전원 처치가 확인되었습니다", "적을 다 잡았다" 같은 표현은 적 스쿼드 전멸 기여 장면에서만 사용하십시오.
- totalTeamWipes는 아군 전멸 횟수가 아니라 적 전멸 기여 지표입니다. "팀 전멸"처럼 주체가 모호한 표현을 쓰지 말고 "적 전멸 기여" 또는 "적 스쿼드 전멸 기여"로만 표현하십시오.
- 답변 본문에는 내부 장면 타입명을 쓰지 말고 한글 장면명으로만 표현하십시오. sceneId는 식별자이므로 그대로 복사해도 됩니다.
- "많다", "반복된다", "상습" 같은 빈도 표현은 [장면 유형 카운트] 또는 [집계 지표] 숫자를 함께 인용할 때만 사용하십시오.
- 각 장면마다 "원인", "근거 수치", "다음 판 행동"을 분리해서 작성하되, 다음 판 행동은 관측 가능한 행동(간격 유지, 백업 각 확보, 위험 시 연막 사용, 안전 조건 확인 후 복구 선택지 확보)으로만 작성하십시오.
- tradeLatencyMs는 반드시 초 단위로 변환해 작성하십시오.
- confidence가 medium 또는 low인 장면은 "매치 단위 지표 기반 추정"처럼 한계를 함께 적으십시오.
- 장면별 답변을 작성한 뒤, 스스로 unsupportedClaims에 금지 표현 또는 근거 부족 표현이 없는지 검사하십시오.

[출력 형식]
JSON만 출력하십시오.
{
  "verdict": "원인 장면만으로 유저가 납득할 수 있는지에 대한 한 줄 판정",
  "sceneFeedbacks": [
    {
      "sceneId": "원인 장면 id",
      "diagnosis": "장면 원인 설명",
      "evidence": "숫자와 이벤트 근거",
      "advice": "다음 판에서 바로 바꿀 행동",
      "confidenceNote": "근거의 신뢰도와 한계",
      "riskFlags": ["근거가 약하거나 단정 위험이 있는 표현. 없으면 빈 배열"],
      "unsupportedClaims": ["facts와 metrics로 뒷받침되지 않는 주장. 반드시 빈 배열을 목표로 하십시오."]
    }
  ],
  "overallCoaching": "스쿼드 전체가 우선 바꿔야 할 전술 1개"
  }
  `.trim();
}

function shouldIgnoreAiValidationMatch(code: string, text: string, index: number, length: number): boolean {
  const context = text.slice(Math.max(0, index - 24), index + length + 36);
  if (code === "clutch_enemy_wipe_claim") {
    return /아님|아닙|아닌|아니며|아니라|아니므로|의미하지 않습니다/.test(context);
  }
  if (code === "team_wipe_ambiguity_claim") {
    return /적 팀 전멸|상대 팀 전멸|적 스쿼드 전멸|적 전멸 기여|적 스쿼드 전멸 기여/.test(context);
  }
  return false;
}

export function validateSquadCauseSceneAiText(text: string): SquadCauseSceneAiValidationIssue[] {
  const checks: Array<{
    code: string;
    phrase: string;
    pattern: RegExp;
    message: string;
  }> = [
    {
      code: "communication_claim",
      phrase: "소통",
      pattern: /소통/g,
      message: "보이스 콜/소통은 텔레메트리로 측정되지 않습니다."
    },
    {
      code: "teamwork_claim",
      phrase: "팀워크",
      pattern: /팀워크/g,
      message: "팀워크 수준은 직접 측정 지표가 아니므로 이벤트 근거로 표현해야 합니다."
    },
    {
      code: "team_cohesion_claim",
      phrase: "팀 응집력",
      pattern: /팀 응집력|응집력/g,
      message: "팀 응집력은 현재 텔레메트리 facts와 metrics로 직접 측정되지 않습니다."
    },
    {
      code: "recovery_ability_claim",
      phrase: "복구 능력",
      pattern: /복구(?:하는)? 능력|복구 능력/g,
      message: "복구 능력은 직접 측정 지표가 아니므로 소생/리콜/복귀 이벤트 숫자로 표현합니다."
    },
    {
      code: "combat_power_claim",
      phrase: "전투력",
      pattern: /전투력/g,
      message: "전투력은 현재 원인 장면 facts와 metrics로 직접 측정되지 않습니다."
    },
    {
      code: "entry_angle_claim",
      phrase: "전투 진입 각",
      pattern: /전투 진입 각|교전 진입 각/g,
      message: "전투/교전 진입 각은 현재 facts와 metrics로 직접 측정되지 않습니다."
    },
    {
      code: "calmness_claim",
      phrase: "침착",
      pattern: /침착/g,
      message: "침착함은 심리/태도 추론이므로 사용하지 않습니다."
    },
    {
      code: "support_shortage_claim",
      phrase: "지원 부족",
      pattern: /지원 부족/g,
      message: "지원 부족은 측정되지 않은 평가 표현입니다."
    },
    {
      code: "mandatory_smoke_claim",
      phrase: "필수적인 연막",
      pattern: /필수적인 연막/g,
      message: "연막 필요 여부는 장면 정밀 판정 없이는 단정하지 않습니다."
    },
    {
      code: "immediate_smoke_claim",
      phrase: "즉각적인 연막",
      pattern: /즉각적인 연막|즉시 연막/g,
      message: "연막은 조건부 선택지로 표현해야 하며 즉각/필수 행동으로 단정하지 않습니다."
    },
    {
      code: "immediate_action_claim",
      phrase: "즉각적인 공격/복구",
      pattern: /즉각적인 (?:공격|복구|백업)|즉시 (?:공격|복구|백업)/g,
      message: "공격/복구는 현재 facts만으로 즉각 행동을 강요하지 말고 안전 조건 확인 후 선택지로 표현합니다."
    },
    {
      code: "smoke_blaming_claim",
      phrase: "연막조차",
      pattern: /연막조차/g,
      message: "연막 사용 없음은 이벤트 미확인으로만 표현해야 합니다."
    },
    {
      code: "revive_failure_claim",
      phrase: "소생에 실패",
      pattern: /소생에 실패/g,
      message: "소생 성공 이벤트 없음은 소생 실패로 단정하지 않습니다."
    },
    {
      code: "revive_attempt_claim",
      phrase: "소생을 시도",
      pattern: /소생(?:을|를)?\s*시도(?! 여부)/g,
      message: "소생 시도 여부는 현재 요약 타임라인만으로 확정하지 않습니다."
    },
    {
      code: "revive_success_instruction_claim",
      phrase: "소생을 성공",
      pattern: /소생(?:을|를)?\s*성공(?:시키|시켜|해야|하십|하십시오|하도록|시키십시오)/g,
      message: "소생 성공은 결과 이벤트로만 표현하고 다음 행동으로 강요하지 않습니다."
    },
    {
      code: "revive_rate_claim",
      phrase: "소생/복구 성공률",
      pattern: /(?:소생|복구) 성공률/g,
      message: "소생/복구 성공률은 별도 비율 필드가 없으면 원본 집계 숫자로만 표현합니다."
    },
    {
      code: "mandatory_outcome_claim",
      phrase: "반드시",
      pattern: /반드시/g,
      message: "결과를 보장하거나 강제하는 처방은 현재 장면 근거만으로 부적절합니다."
    },
    {
      code: "impossibility_claim",
      phrase: "불가능",
      pattern: /불가능/g,
      message: "불가능은 절대 단정 표현이므로 제한/어려움/측정 불가로 표현해야 합니다."
    },
    {
      code: "safety_assertion_claim",
      phrase: "안전하게 이루어지지",
      pattern: /안전하게 이루어지지|안전하지 않|불안전/g,
      message: "복구 안전성은 엄폐물/시야각/적 위치 정밀 판정 없이는 단정하지 않습니다."
    },
    {
      code: "cover_vision_claim",
      phrase: "엄폐물/시야",
      pattern: /엄폐물|시야각|시야 유지|건물 구조/g,
      message: "엄폐물, 시야각, 건물 구조는 현재 원인 장면 facts와 metrics로 측정되지 않습니다."
    },
    {
      code: "engagement_judgment_claim",
      phrase: "불필요한 교전",
      pattern: /불필요한 교전|교전 회피|교전\s*진입(?:은|을|를)?\s*피하|교전.*피하십시오/g,
      message: "교전 필요성 또는 회피 필요성은 현재 장면 facts만으로 단정하지 않습니다."
    },
    {
      code: "power_loss_causality_claim",
      phrase: "전력 손실로 이어",
      pattern: /전력 손실로 이어/g,
      message: "전력 손실 인과는 기절/복구 이벤트 숫자로만 표현하고 직접 인과로 단정하지 않습니다."
    },
    {
      code: "recovery_failure_claim",
      phrase: "전력 복구 실패",
      pattern: /전력 복구 실패|복구 실패 문제/g,
      message: "복구 실패 문제는 단정하지 말고 소생/리콜/복귀 이벤트 확인 여부로만 표현합니다."
    },
    {
      code: "clutch_enemy_wipe_claim",
      phrase: "적 전원 처치",
      pattern: /적 전원 처치(?:가|는|를)?\s*(?:확인|확정|했습니다|되었|됨)/g,
      message: "전력 복구 장면은 적 전원 처치 확정 장면이 아닙니다."
    },
    {
      code: "wipe_slang_claim",
      phrase: "적을 다 잡",
      pattern: /적을 다 잡/g,
      message: "적 전원 처치는 별도 적 스쿼드 전멸 기여 장면에서만 표현합니다."
    },
    {
      code: "team_wipe_ambiguity_claim",
      phrase: "팀 전멸",
      pattern: /팀 전멸/g,
      message: "totalTeamWipes는 아군 전멸이 아니라 적 전멸 기여로 명확히 표현해야 합니다."
    }
  ];

  return checks.reduce<SquadCauseSceneAiValidationIssue[]>((issues, check) => {
    for (const match of text.matchAll(check.pattern)) {
      const index = match.index ?? 0;
      if (shouldIgnoreAiValidationMatch(check.code, text, index, match[0].length)) continue;
      issues.push({
        code: check.code,
        phrase: check.phrase,
        message: check.message
      });
      break;
    }
    return issues;
  }, []);
}
