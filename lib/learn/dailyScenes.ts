import type { RankerScene } from "./lessons";
import type { DailyEvidence } from "./dailyEvidence";

export type DailyScene = {
  id: string;
  kind: "opening" | "movement" | "combat" | "recovery" | "finish";
  title: string;
  startSeconds: number;
  anchorSeconds: number;
  endSeconds: number;
  evidenceIds: string[];
  sourceIndices?: number[];
  situation: string;
  action: string;
  outcome: string;
  lesson?: string;
  mapSnapshot?: NonNullable<RankerScene["mapSnapshot"]> & {
    pathSegments?: { x: number; y: number }[][];
    observations?: { x: number; y: number; timeSeconds: number; evidenceId: string; label: string; side?: "ally" | "opponent"; sourceIndices?: number[] }[];
    zoneObservedSeconds?: number;
    zoneSourceIndices?: number[];
    blueZone?: { x: number; y: number; radius: number; observedSeconds: number; sourceIndex: number;
      status: "waiting" | "shrinking" | "complete" | "unknown"; countdownSeconds?: number; phase?: number };
  };
};

type Fact = DailyEvidence["facts"][number];
type Evidence = DailyEvidence;

type Observation = { x: number; y: number; timeSeconds: number; evidenceId: string; label: string; side?: "ally" | "opponent"; sourceIndices?: number[] };
const factLabel: Record<string, string> = {
  landing: "착지", aircraft: "비행기", route: "위치 표본", zone: "자기장", encounter: "교전",
  kill: "처치", teammate_kill: "팀 교전", teammate_death: "팀원 사망", revive: "소생",
  down: "기절", knock: "기절 기록", finish: "경기 종료", vehicle: "차량 탑승",
};
const timeLabel = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
const hasPoint = (point: { x: number; y: number }) => Number.isFinite(point.x) && Number.isFinite(point.y);

function makeScene(fact: Fact, kind: DailyScene["kind"], title: string, evidenceIds = [fact.id], outcome = "", mapSnapshot?: DailyScene["mapSnapshot"], sourceIndices = fact.sourceIndices): DailyScene {
  const label = factLabel[fact.kind] ?? "경기";
  return {
    id: `scene-${kind}-${fact.id}`, kind, title, startSeconds: fact.timeSeconds,
    anchorSeconds: fact.timeSeconds, endSeconds: fact.timeSeconds, evidenceIds,
    ...(sourceIndices?.length ? { sourceIndices: [...new Set(sourceIndices)] } : {}),
    situation: `${timeLabel(fact.timeSeconds)} · ${label} 시점`, action: fact.text, outcome,
    ...(mapSnapshot ? { mapSnapshot } : {}),
  };
}

function mapForFact(evidence: Evidence, fact: Fact, kind: DailyScene["kind"], intervalEnd = fact.timeSeconds): DailyScene["mapSnapshot"] {
  const observations: Observation[] = [];
  if (fact.kind === "encounter") {
    const encounter = evidence.encounters?.find((item) => item.id === fact.id);
    const targetTime = encounter?.snapshots?.find((item) => item.offsetSeconds === 0)?.targetTimeSeconds ?? fact.timeSeconds;
    const snapshot = encounter?.snapshots?.find((item) => item.offsetSeconds === 0)
      ?? encounter?.snapshots?.find((item) => item.targetTimeSeconds === targetTime);
    for (const point of snapshot?.points ?? []) {
      if (point.sampleTimeSeconds > targetTime || targetTime - point.sampleTimeSeconds > 15 || !hasPoint(point)) continue;
      observations.push({ x: point.x / 100, y: point.y / 100, timeSeconds: point.sampleTimeSeconds, evidenceId: fact.id, side: point.side, sourceIndices: point.sourceIndices,
        label: `${point.player} · ${timeLabel(point.sampleTimeSeconds)} 관측 위치` });
    }
  } else if (kind === "movement" && fact.kind === "route") {
    const routeFacts = evidence.facts.filter((item) => item.kind === "route").sort((a, b) => a.timeSeconds - b.timeSeconds);
    const start = evidence.route.filter((point) => point.timeSeconds === fact.timeSeconds && hasPoint(point)).at(0);
    if (start) observations.push({ x: start.x, y: start.y, timeSeconds: start.timeSeconds, evidenceId: fact.id,
      sourceIndices: routeFacts.find((item) => item.timeSeconds === start.timeSeconds)?.sourceIndices,
      label: `${timeLabel(start.timeSeconds)} 위치 표본`, side: "ally" });
    const endSeconds = Math.min(fact.timeSeconds + 180, intervalEnd);
    for (const point of evidence.route) {
      if (point.timeSeconds <= fact.timeSeconds || point.timeSeconds > endSeconds || !hasPoint(point)) continue;
      const matchingFact = routeFacts.find((item) => item.timeSeconds === point.timeSeconds);
      if (!matchingFact) continue;
      observations.push({ x: point.x, y: point.y, timeSeconds: point.timeSeconds, evidenceId: matchingFact.id, sourceIndices: matchingFact.sourceIndices,
        label: `${timeLabel(point.timeSeconds)} 위치 표본`, side: "ally" });
    }
  } else if ((kind === "opening" || kind === "recovery") && fact.position && hasPoint(fact.position)
    && (kind !== "opening" || fact.actorId === evidence.accountId)) {
    const actorLabel = fact.actorId === evidence.accountId ? evidence.nickname : "소생 팀원";
    const sampleTime = fact.positionTimeSeconds ?? fact.timeSeconds;
    if (sampleTime <= fact.timeSeconds && fact.timeSeconds - sampleTime <= 45) {
      observations.push({ x: fact.position.x, y: fact.position.y, timeSeconds: sampleTime, evidenceId: fact.id, sourceIndices: fact.sourceIndices,
        label: `${actorLabel} · ${timeLabel(sampleTime)} 기록 위치`, side: "ally" });
    }
  } else {
    const route = evidence.route.filter((point) => point.timeSeconds <= fact.timeSeconds && fact.timeSeconds - point.timeSeconds <= 20)
      .sort((a, b) => b.timeSeconds - a.timeSeconds)[0];
    const routeFact = route && evidence.facts.find((item) => item.kind === "route" && item.timeSeconds === route.timeSeconds);
    if (route && routeFact && hasPoint(route)) observations.push({ x: route.x, y: route.y, timeSeconds: route.timeSeconds,
      evidenceId: routeFact.id, sourceIndices: routeFact.sourceIndices, label: `${evidence.nickname} · ${timeLabel(route.timeSeconds)} 관측 위치`, side: "ally" });
  }
  const anchor = kind === "combat"
    ? observations.find((item) => item.side === "ally" && item.label.startsWith(`${evidence.nickname} ·`))
    : observations[0];
  if (kind === "combat" && !anchor) return undefined;
  if (!anchor) return undefined;
  const selectedSeconds = fact.kind === "encounter"
    ? evidence.encounters?.find((item) => item.id === fact.id)?.snapshots?.find((item) => item.offsetSeconds === 0)?.targetTimeSeconds ?? fact.timeSeconds
    : fact.timeSeconds;
  const zone = evidence.zones.filter((item) => item.center && Number.isFinite(item.radius) && item.radius! > 0
    && item.observedSeconds <= selectedSeconds && selectedSeconds - item.observedSeconds <= 45)
    .sort((a, b) => b.observedSeconds - a.observedSeconds)[0];
  const marks = kind === "movement" ? [] : observations.filter((item) => item !== anchor).map((item) => ({
    x: item.x, y: item.y, kind: item.side === "ally" ? "teammate" as const : "opponent" as const, label: item.label,
  }));
  let pathSegments: { x: number; y: number }[][] | undefined;
  if (kind === "movement" && observations.length > 0) {
    const firstTime = observations[0].timeSeconds;
    const lastTime = observations.at(-1)!.timeSeconds;
    const allLifeEvents = evidence.facts.filter((item) =>
      (item.kind === "player_death" && item.victimId === evidence.accountId)
      || (item.kind === "player_return" && item.actorId === evidence.accountId))
      .sort((a, b) => a.timeSeconds - b.timeSeconds || (a.kind === "player_death" ? -1 : 1));
    const priorLifeEvent = allLifeEvents.filter((item) => item.timeSeconds < firstTime).at(-1);
    const lifeEvents = allLifeEvents.filter((item) => item.timeSeconds >= firstTime && item.timeSeconds <= lastTime);
    const initiallyDead = priorLifeEvent?.kind === "player_death";
    if (initiallyDead || lifeEvents.some((item) => item.kind === "player_death")) {
      const segments: { x: number; y: number }[][] = [];
      pathSegments = segments;
      let segment: { x: number; y: number }[] = [];
      let dead = initiallyDead;
      let eventIndex = 0;
      const closeSegment = () => {
        if (segment.length) segments.push(segment);
        segment = [];
      };
      for (const observation of observations) {
        while (eventIndex < lifeEvents.length && lifeEvents[eventIndex].timeSeconds <= observation.timeSeconds) {
          const event = lifeEvents[eventIndex++];
          if (event.kind === "player_death") {
            closeSegment();
            dead = true;
          } else {
            dead = false;
          }
        }
        if (!dead) segment.push({ x: observation.x, y: observation.y });
      }
      closeSegment();
    }
  }
  return {
    path: kind === "movement" ? observations.map(({ x, y }) => ({ x, y })) : [{ x: anchor.x, y: anchor.y }],
    ...(pathSegments ? { pathSegments } : {}),
    pathStartSeconds: observations[0].timeSeconds, pathEndSeconds: observations.at(-1)!.timeSeconds,
    ...(zone?.center && zone.radius ? {
      zone: { x: zone.center.x, y: zone.center.y, radius: zone.radius },
      zoneObservedSeconds: zone.observedSeconds,
      ...(zone.sourceIndices?.length ? { zoneSourceIndices: zone.sourceIndices } : {}),
    } : {}),
    ...(marks.length ? { marks } : {}),
    ...(kind === "opening" ? { playerLabel: "랭커 위치" } : kind === "recovery" ? { playerLabel: anchor.label.startsWith(`${evidence.nickname} ·`) ? "랭커 위치" : "팀원 위치" } : {}),
    viewSize: 4096, observations,
  };
}

/** Convert recorded evidence into short, chronological scene candidates. */
export function buildDailySceneCandidates(source: DailyEvidence): DailyScene[] {
  const evidence = source as Evidence;
  const facts = [...evidence.facts].filter((fact) => fact.id && Number.isFinite(fact.timeSeconds) && fact.timeSeconds >= 0)
    .sort((a, b) => a.timeSeconds - b.timeSeconds || a.id.localeCompare(b.id)) as Fact[];
  const scenes: DailyScene[] = [];
  const routeFacts = facts.filter((fact) => fact.kind === "route");
  const consumedRouteFacts = new Set<string>();
  let combatNumber = 0;
  for (const fact of facts) {
    let kind: DailyScene["kind"] | null = null;
    if (fact.kind === "landing" && fact.id === "landing") kind = "opening";
    else if (["route", "zone", "vehicle"].includes(fact.kind)) kind = "movement";
    else if (fact.kind === "encounter") kind = "combat";
    else if (fact.kind === "revive") kind = "recovery";
    else if (fact.kind === "finish") kind = "finish";
    if (!kind) continue;
    if (fact.kind === "route" && consumedRouteFacts.has(fact.id)) continue;
    const routeGroup = fact.kind === "route" ? routeFacts.filter((item, index) => {
      const firstIndex = routeFacts.findIndex((entry) => entry.id === fact.id);
      return index >= firstIndex && item.timeSeconds <= fact.timeSeconds + 180
        && (index === firstIndex || routeFacts[index - 1].timeSeconds >= fact.timeSeconds);
    }) : [];
    routeGroup.forEach((item) => consumedRouteFacts.add(item.id));
    const routeEnd = routeGroup.at(-1)?.timeSeconds ?? fact.timeSeconds;
    let title = fact.kind === "landing" ? "착지 기록"
      : fact.kind === "route" ? `이동 위치 표본 ${timeLabel(fact.timeSeconds)}–${timeLabel(routeEnd)}`
        : fact.kind === "zone" ? `${fact.text.match(/^(\d+)번째/)?.[1] ?? ""}페이즈 자기장`
          : fact.kind === "encounter" ? `교전 ${++combatNumber}`
            : fact.kind === "revive" ? "아군 소생" : fact.kind === "vehicle" ? "차량 탑승" : "경기 종료";
    const encounter = fact.kind === "encounter" ? evidence.encounters?.find((item) => item.id === fact.id) : undefined;
    const actions = encounter?.actions ?? [];
    const firstHit = actions.find((item) => item.kind === "first_hit");
    const alliedNames = new Set([...(encounter?.rosterAllies ?? []), ...(encounter?.allies ?? [])]);
    const keyActions = actions.filter((item) => (item.kind === "kill" || item.kind === "knock" || item.kind === "ally_down")
      && (item.actorId === evidence.accountId || alliedNames.has(item.actor))).slice(0, 2);
    const actualKills = actions.filter((item) => item.kind === "kill"
      && (item.actorId === evidence.accountId || alliedNames.has(item.actor)));
    const actionText = fact.kind === "encounter" && encounter
      ? [firstHit ? `${timeLabel(firstHit.timeSeconds)} 첫 확인 피해: ${firstHit.actor} → ${firstHit.victim} (${firstHit.weapon})` : "첫 확인 피해 정보 없음",
        ...keyActions
          .map((item) => `${timeLabel(item.timeSeconds)} ${item.actor} → ${item.victim} ${item.kind === "kill" ? "처치" : item.kind === "knock" ? "기절" : "아군 기절"}${item.weapon ? ` · ${item.weapon}` : ""}`)].join(" · ")
      : fact.text;
    if (fact.kind === "encounter" && firstHit) title += ` · ${firstHit.victim}`;
    const outcome = fact.kind === "landing" ? "착지 위치 기록"
      : fact.kind === "revive" ? "소생 완료 기록"
        : fact.kind === "finish" ? fact.text
          : fact.kind === "encounter" ? encounter?.teamKills
            ? `기록된 팀 처치 ${encounter.teamKills}명${actualKills.length ? `: ${actualKills.map((item) => `${timeLabel(item.timeSeconds)} ${item.victim}`).join(" · ")}` : ""}`
            : "이 교전에서 팀 처치 기록은 확인되지 않습니다."
            : fact.kind === "route" ? "다음 위치 표본과 함께 관측 시점을 확인할 수 있습니다."
              : fact.kind === "zone" || fact.kind === "vehicle" ? fact.text : "경기 기록을 확인할 수 있습니다.";
    const mapSnapshot = mapForFact(evidence, fact, kind, fact.kind === "route" ? routeEnd : fact.timeSeconds);
    const actionSources = new Set(actions.flatMap((item) => item.sourceIndices ?? []));
    const linkedActionFacts = fact.kind === "encounter" ? facts.filter((item) => item.sourceIndices?.some((index) => actionSources.has(index))) : [];
    const ids = fact.kind === "route" ? routeGroup.map((item) => item.id)
      : [fact.id, ...linkedActionFacts.map((item) => item.id)];
    const sourceIndices = [...ids.flatMap((id) => facts.find((item) => item.id === id)?.sourceIndices ?? []), ...actions.flatMap((item) => item.sourceIndices ?? [])];
    const sceneAction = fact.kind === "route" ? routeGroup.map((item) => `${timeLabel(item.timeSeconds)} ${item.text}`).join(" · ") : actionText;
    const sceneOutcome = fact.kind === "route" ? `${routeGroup.length}개 위치 표본을 ${timeLabel(fact.timeSeconds)}–${timeLabel(routeEnd)}에 관측했습니다.` : outcome;
    const lesson = fact.kind === "revive" ? "팀원이 쓰러졌다면, 다음 이동 전에 소생 가능 여부와 합류 상태를 확인해 보세요." : undefined;
    const sceneSituation = fact.kind === "encounter" && encounter
      ? `${timeLabel(encounter.startSeconds)}–${timeLabel(encounter.endSeconds)} · ${firstHit ? `처음 확인된 피해 ${firstHit.actor} → ${firstHit.victim}` : "처음 확인된 교전 행동"}`
      : fact.kind === "revive" ? `${timeLabel(fact.timeSeconds)} · 소생 기록` : undefined;
    const encounterAnchor = fact.kind === "encounter" ? encounter?.snapshots?.find((item) => item.offsetSeconds === 0)?.targetTimeSeconds : undefined;
    scenes.push({ ...makeScene(fact, kind, title, ids, sceneOutcome, mapSnapshot, sourceIndices), action: sceneAction,
      ...(sceneSituation ? { situation: sceneSituation } : {}), ...(lesson ? { lesson } : {}),
      ...(encounterAnchor !== undefined ? { anchorSeconds: encounterAnchor, startSeconds: encounter?.startSeconds ?? fact.timeSeconds, endSeconds: encounter?.endSeconds ?? fact.timeSeconds } : {}),
      ...(fact.kind === "route" && mapSnapshot ? { endSeconds: Math.min(routeEnd, mapSnapshot.pathEndSeconds ?? routeEnd) } : {}),
      ...(fact.kind === "route" ? { startSeconds: fact.timeSeconds, situation: `${timeLabel(fact.timeSeconds)}–${timeLabel(routeEnd)} · 위치 표본 시점` } : {}),
    });
  }
  return scenes.sort((a, b) => a.anchorSeconds - b.anchorSeconds || a.id.localeCompare(b.id));
}

function distinctScenes(scenes: DailyScene[]) {
  const usedEvidence = new Set<string>();
  const usedSources = new Set<number>();
  return scenes.filter((scene) => {
    if (!scene.evidenceIds.length || scene.evidenceIds.some((id) => usedEvidence.has(id))
      || scene.sourceIndices?.some((index) => usedSources.has(index))) return false;
    scene.evidenceIds.forEach((id) => usedEvidence.add(id));
    scene.sourceIndices?.forEach((index) => usedSources.add(index));
    return true;
  });
}

function deterministicFallback(candidates: DailyScene[]) {
  const chronological = [...candidates].sort((a, b) => a.anchorSeconds - b.anchorSeconds || a.id.localeCompare(b.id));
  const picked: DailyScene[] = [];
  const add = (scene: DailyScene | undefined) => {
    if (!scene || picked.some((item) => item.id === scene.id) || distinctScenes([...picked, scene]).length !== picked.length + 1) return;
    picked.push(scene);
  };
  add(chronological.find(({ kind }) => kind === "opening"));
  add(chronological.find(({ kind }) => kind === "recovery"));
  add(chronological.find(({ kind }) => kind === "combat"));
  add(chronological.find(({ kind }) => kind === "movement"));
  add([...chronological].reverse().find(({ kind }) => kind === "finish"));
  const full = distinctScenes(picked).sort((a, b) => a.anchorSeconds - b.anchorSeconds || a.id.localeCompare(b.id));
  return full.length >= 3 ? full.slice(0, 5) : [];
}

export function validateDailySceneSelection(value: unknown, candidates: DailyScene[]): {
  scenes: DailyScene[]; usedFallback: boolean; rejectedReasons: string[];
} {
  const rejectedReasons: string[] = [];
  const candidateById = new Map(candidates.map((scene) => [scene.id, scene]));
  const rawIds = typeof value === "object" && value !== null && Array.isArray((value as { sceneIds?: unknown }).sceneIds)
    ? (value as { sceneIds: unknown[] }).sceneIds : [];
  if (!rawIds.length) rejectedReasons.push("missing_or_empty_selection");
  if (rawIds.some((id) => typeof id !== "string")) rejectedReasons.push("invalid_scene_id");
  const seenIds = new Set<string>();
  const selected: DailyScene[] = [];
  for (const id of rawIds) {
    if (typeof id !== "string") continue;
    if (seenIds.has(id)) { rejectedReasons.push("duplicate_scene_id"); continue; }
    seenIds.add(id);
    const scene = candidateById.get(id);
    if (!scene) { rejectedReasons.push("unknown_scene_id"); continue; }
    selected.push(scene);
  }
  const unique = distinctScenes(selected);
  if (unique.length !== selected.length) rejectedReasons.push("overlapping_evidence");
  selected.splice(0, selected.length, ...unique);
  if (selected.some((scene, index) => index > 0 && scene.anchorSeconds < selected[index - 1].anchorSeconds)) {
    rejectedReasons.push("chronology_reordered");
  }
  selected.sort((a, b) => a.anchorSeconds - b.anchorSeconds || a.id.localeCompare(b.id));
  const finish = [...candidates].filter(({ kind }) => kind === "finish")
    .sort((a, b) => a.anchorSeconds - b.anchorSeconds).at(-1);
  if (finish && !selected.some(({ kind }) => kind === "finish")) {
    selected.push(finish);
    selected.sort((a, b) => a.anchorSeconds - b.anchorSeconds || a.id.localeCompare(b.id));
    rejectedReasons.push("finish_inserted");
  }
  if (selected.length > 5) { selected.splice(5); rejectedReasons.push("too_many_scenes"); }
  if (selected.length < 3) rejectedReasons.push("insufficient_distinct_scenes");
  const usedFallback = rejectedReasons.length > 0;
  const scenes = selected.length >= 3 && !usedFallback ? selected : deterministicFallback(candidates);
  return { scenes, usedFallback, rejectedReasons: [...new Set(rejectedReasons)] };
}
