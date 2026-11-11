// 단일 경기 AI 코칭 문장이 가리킬 수 있는 장면 목록. 서버는 이 목록을 프롬프트에 넣고 응답의 장면 ID를 검증하며,
// 화면은 같은 규칙으로 타임라인에서 장면을 다시 찾는다. 모델은 목록 안에서 ID를 고르기만 한다.
import { formatMatchClock } from "./matchReportView";
import type { TimelineEvent } from "./types";

const SCENE_LABELS: Partial<Record<TimelineEvent["type"], string>> = {
  KILL: "내 킬",
  KNOCK: "적 기절",
  DOWNED: "내 기절",
  DIED: "내 사망",
  REVIVE: "소생",
  TEAM_KNOCK: "팀원 기절",
  TEAM_DIED: "팀원 사망",
};
// 목록이 넘치면 내 기절·사망, 나머지 내 장면, 팀원 장면 순으로 남긴다.
const PERSONAL_TYPES = new Set<TimelineEvent["type"]>(["KILL", "KNOCK", "DOWNED", "DIED", "REVIVE"]);
const scenePriority = (scene: MatchAiScene): number =>
  scene.event.type === "DIED" || scene.event.type === "DOWNED" ? 0 : PERSONAL_TYPES.has(scene.event.type) ? 1 : 2;
const MAX_SCENES = 24;

export interface MatchAiScene {
  id: string;
  ts: number;
  label: string;
  event: TimelineEvent;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 위치가 있는 장면만 ID를 받는다. 좌표가 0,0이면 위치를 못 찾은 기본값이라 쓰지 않는다. */
function toScene(event: unknown): MatchAiScene | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as TimelineEvent;
  const label = SCENE_LABELS[candidate.type];
  if (!label || !finite(candidate.ts) || candidate.ts < 0) return null;
  if (!finite(candidate.x) || !finite(candidate.y) || (candidate.x === 0 && candidate.y === 0)) return null;
  const ts = Math.round(candidate.ts);
  return { id: `${candidate.type}-${ts}`, ts, label, event: candidate };
}

function eligibleScenes(timeline: unknown): MatchAiScene[] {
  if (!Array.isArray(timeline)) return [];
  const seen = new Set<string>();
  return timeline.flatMap((event) => {
    const scene = toScene(event);
    // 같은 종류·같은 시각이 겹치면 첫 장면만 쓴다. 서버와 화면이 같은 장면을 고르게 하기 위함이다.
    if (!scene || seen.has(scene.id)) return [];
    seen.add(scene.id);
    return [scene];
  });
}

/** 프롬프트에 넣을 장면 목록. 내 기절·사망을 항상 남기고 우선순위대로 최대 24개를 고른 뒤 시간순으로 둔다. */
export function buildMatchAiSceneCatalog(match: unknown): MatchAiScene[] {
  const scenes = eligibleScenes((match as { timeline?: unknown } | null)?.timeline);
  // 정렬은 안정적이라 같은 우선순위 안에서는 시간순이 유지된다.
  return scenes.sort((a, b) => scenePriority(a) - scenePriority(b)).slice(0, MAX_SCENES).sort((a, b) => a.ts - b.ts);
}

/** 프롬프트용 장면 한 줄. 상대 닉네임은 넣지 않는다. */
export function formatMatchAiSceneLine(scene: MatchAiScene): string {
  const details = [
    scene.event.weapon,
    finite(scene.event.distance) ? `${Math.round(scene.event.distance)}m` : null,
  ].filter(Boolean);
  return `- ${scene.id} | ${formatMatchClock(scene.ts)} | ${scene.label}${details.length ? ` (${details.join(", ")})` : ""}`;
}

/** 화면 칩 문구: 경과 시각과 사건 종류. */
export function matchAiSceneChipLabel(scene: MatchAiScene): string {
  return `${formatMatchClock(scene.ts)} ${scene.label}`;
}

/** 화면에서 장면 ID로 타임라인 이벤트를 찾는다. 타임라인에 없으면 null이라 칩을 그리지 않는다. */
export function findMatchAiScene(timeline: unknown, id: unknown): MatchAiScene | null {
  if (typeof id !== "string" || !id) return null;
  return eligibleScenes(timeline).find((scene) => scene.id === id) ?? null;
}

/**
 * 응답 JSON의 장면 ID를 이 경기 장면 목록으로 검증한다. 목록에 없는 ID는 지우고, briefFeedbackSceneIds는
 * briefFeedback과 같은 길이로 맞춘다. 유효한 ID가 하나도 없으면 필드를 뺀다. JSON이 아니면 그대로 둔다.
 */
export function applyMatchAiSceneRefs(text: string, match: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
  const record = parsed as Record<string, unknown>;
  const ids = new Set(buildMatchAiSceneCatalog(match).map((scene) => scene.id));
  const valid = (value: unknown): string | null => (typeof value === "string" && ids.has(value) ? value : null);
  const { briefFeedbackSceneIds, ...next } = record;
  if (Array.isArray(record.briefFeedback)) {
    const refs = Array.isArray(briefFeedbackSceneIds) ? briefFeedbackSceneIds : [];
    const aligned = record.briefFeedback.map((_, index) => valid(refs[index]));
    if (aligned.some(Boolean)) next.briefFeedbackSceneIds = aligned;
  }
  if (Array.isArray(record.actionItems)) {
    next.actionItems = record.actionItems.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const { sceneId, ...rest } = item as Record<string, unknown>;
      const id = valid(sceneId);
      return id ? { ...rest, sceneId: id } : rest;
    });
  }
  return JSON.stringify(next);
}
