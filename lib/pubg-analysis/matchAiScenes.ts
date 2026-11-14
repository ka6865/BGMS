// 단일 경기 AI 코칭 문장이 가리킬 수 있는 장면 목록. 서버는 이 목록을 프롬프트에 넣고 응답의 장면 ID를 검증하며,
// 화면은 같은 규칙으로 타임라인에서 장면을 다시 찾는다. 모델은 목록 안에서 ID를 고르기만 한다.
import type { MatchFight, MatchReport } from "./matchReport";
import { DEATH_TYPE_LABELS, describeDeath, FIGHT_OUTCOME_LABELS, formatMatchClock } from "./matchReportView";
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

const MAX_FLOW_FIGHTS = 8;

function readMatchReport(match: unknown): MatchReport | null {
  const report = (match as { matchReport?: unknown } | null)?.matchReport;
  return report && typeof report === "object" && !Array.isArray(report) ? report as MatchReport : null;
}

const isFight = (fight: unknown): fight is MatchFight => {
  const value = fight as MatchFight | null;
  return !!value && finite(value.startMs) && finite(value.endMs) && value.endMs >= value.startMs
    && finite(value.dealt) && finite(value.taken) && finite(value.enemyDowns) && finite(value.teamDowns)
    && Object.hasOwn(FIGHT_OUTCOME_LABELS, value.outcome) && (value.openedBy === "us" || value.openedBy === "them");
};

/**
 * 프롬프트용 경기 흐름. 경기 리포트의 교전 결과·사망 유형·자기장 이탈·착지를 측정값 그대로 쓰고,
 * 그 시간대에 있는 장면 ID를 붙여 모델이 "왜"를 장면에 묶어 말하게 한다. 상대 닉네임은 넣지 않는다.
 */
export function buildMatchAiFlowLines(match: unknown): string[] {
  const report = readMatchReport(match);
  if (!report) return [];
  const catalog = buildMatchAiSceneCatalog(match);
  const sceneIds = (start: number, end: number) => catalog.filter((scene) => scene.ts >= start && scene.ts <= end).map((scene) => scene.id);
  const lines: string[] = [];

  const landing = report.landing;
  if (landing && finite(landing.timeMs) && finite(landing.enemiesNear) && finite(landing.teamsNear)) {
    lines.push(`- 착지 ${formatMatchClock(landing.timeMs)} | 300m 안 적 ${landing.enemiesNear}명(${landing.teamsNear}팀)`);
  }

  // 쓰러짐이 있거나 장면이 걸린 교전을 먼저 남기고 시간순으로 둔다.
  const fights = (Array.isArray(report.fights) ? report.fights : []).filter(isFight);
  const weight = (fight: MatchFight) => (fight.enemyDowns + fight.teamDowns > 0 ? 2 : 0) + (sceneIds(fight.startMs, fight.endMs).length > 0 ? 1 : 0);
  const kept = [...fights].sort((a, b) => weight(b) - weight(a)).slice(0, MAX_FLOW_FIGHTS).sort((a, b) => a.startMs - b.startMs);
  for (const fight of kept) {
    const ids = sceneIds(fight.startMs, fight.endMs);
    lines.push([
      `- 교전 ${formatMatchClock(fight.startMs)}~${formatMatchClock(fight.endMs)}`,
      fight.openedBy === "us" ? "우리 팀이 먼저 사격" : "상대가 먼저 사격",
      `결과 ${FIGHT_OUTCOME_LABELS[fight.outcome].label}`,
      `우리 팀이 준 피해 ${Math.round(fight.dealt)} / 받은 피해 ${Math.round(fight.taken)}`,
      `적 쓰러짐 ${fight.enemyDowns} · 우리 팀 쓰러짐 ${fight.teamDowns}`,
      `장면 ${ids.length ? ids.join(", ") : "없음"}`,
    ].join(" | "));
  }

  const death = report.death;
  if (death && finite(death.timeMs) && Object.hasOwn(DEATH_TYPE_LABELS, death.type)) {
    const extra: string[] = [];
    if (death.type !== "isolated" && finite(death.nearestTeammateM)) extra.push(`가장 가까운 팀원 ${death.nearestTeammateM}m`);
    if (death.type !== "ambushed" && (death.openedBy === "us" || death.openedBy === "them")) extra.push(death.openedBy === "us" ? "마지막 교전은 우리 팀이 먼저 사격" : "마지막 교전은 상대가 먼저 사격");
    const ids = sceneIds(finite(death.knockedAtMs) ? death.knockedAtMs : death.timeMs, death.timeMs);
    lines.push([`- 내 사망 ${formatMatchClock(death.timeMs)}`, `사망 유형 ${describeDeath(death)}`, ...extra, `장면 ${ids.length ? ids.join(", ") : "없음"}`].join(" | "));
  }

  for (const circle of Array.isArray(report.circles) ? report.circles : []) {
    // 1페이즈 원은 낙하·착지 중에 정해져 원 밖이 당연하므로 쓰지 않는다.
    if (circle?.status !== "outside" || !finite(circle.timeMs) || !finite(circle.phase) || circle.phase < 2 || !finite(circle.outsideByM)) continue;
    lines.push(`- 자기장 ${formatMatchClock(circle.timeMs)} | ${circle.phase}페이즈 새 원이 정해질 때 원 밖 ${Math.round(circle.outsideByM)}m`);
  }
  return lines;
}

/** 응답이 쓸 수 있는 경과 시각. 장면 목록과 경기 흐름에 적힌 시각만 허용한다. */
function allowedMatchClocks(match: unknown): Set<string> {
  const clocks = new Set(buildMatchAiSceneCatalog(match).map((scene) => formatMatchClock(scene.ts)));
  for (const line of buildMatchAiFlowLines(match)) {
    for (const clock of line.match(/\d{1,3}:[0-5]\d/gu) ?? []) clocks.add(clock);
  }
  return clocks;
}

const CLOCK_FIELDS = ["signature", "signatureSub", "finalVerdict"] as const;
// 목록에 없는 시각은 뒤에 붙은 조사까지 지운다. "12:40 교전에서" → "교전에서", "12:40에" → "".
const CLOCK_TOKEN = /(?:약\s*)?(\d{1,3}:[0-5]\d)(?:\s*(?:초|분))?(?:쯤|경)?(?:에(?:는|서)?|의)?\s*/gu;
// 장면 ID는 sceneId 필드에만 쓴다. 문장에 섞인 ID는 괄호째 지운다. "교전(KNOCK-1)은" → "교전은".
const SCENE_ID_TOKEN = new RegExp(`\\s*\\(?\\b(?:${Object.keys(SCENE_LABELS).join("|")})-\\d+\\b\\)?`, "gu");

/**
 * 응답 문장의 경과 시각을 이 경기의 장면·흐름 시각으로 검증한다. 목록에 없는 시각은 지워
 * 모델이 시점을 지어내지 못하게 하고, 문장에 섞인 장면 ID도 지운다. JSON이 아니면 그대로 둔다. 재적용해도 결과가 같다.
 */
export function applyMatchAiClockPolicy(text: string, match: unknown): string {
  const record = parseRecord(text);
  if (!record) return text;
  const allowed = allowedMatchClocks(match);
  const scrub = (value: unknown): unknown => (typeof value === "string"
    ? value.replace(SCENE_ID_TOKEN, "").replace(CLOCK_TOKEN, (token, clock: string) => (allowed.has(clock) ? token : "")).replace(/\s{2,}/gu, " ").trim()
    : value);
  const next: Record<string, unknown> = { ...record };
  for (const key of CLOCK_FIELDS) if (key in next) next[key] = scrub(next[key]);
  if (Array.isArray(next.briefFeedback)) next.briefFeedback = next.briefFeedback.map(scrub);
  if (Array.isArray(next.actionItems)) {
    next.actionItems = next.actionItems.map((item) => (item && typeof item === "object" && !Array.isArray(item)
      ? { ...item, title: scrub((item as Record<string, unknown>).title), desc: scrub((item as Record<string, unknown>).desc) }
      : item));
  }
  return JSON.stringify(next) === JSON.stringify(record) ? text : JSON.stringify(next);
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

function parseRecord(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const actionItemKey = (item: Record<string, unknown>) => JSON.stringify([item.title, item.desc, item.sceneId]);

/**
 * 응답 JSON의 장면 ID를 이 경기 장면 목록으로 검증한다. 목록에 없는 ID는 지우고, briefFeedbackSceneIds는
 * briefFeedback과 같은 길이로 맞춘다. 유효한 ID가 하나도 없으면 필드를 뺀다. JSON이 아니면 그대로 둔다.
 * beforePolicy(근거 정책 적용 전 텍스트)를 주면 정책이 바꾼 briefFeedback 문장과 title·desc가 바뀐 행동 제안의 ID도 지운다.
 */
export function applyMatchAiSceneRefs(text: string, match: unknown, beforePolicy?: string): string {
  const record = parseRecord(text);
  if (!record) return text;
  const before = parseRecord(beforePolicy);
  const ids = new Set(buildMatchAiSceneCatalog(match).map((scene) => scene.id));
  const valid = (value: unknown): string | null => (typeof value === "string" && ids.has(value) ? value : null);
  const { briefFeedbackSceneIds, ...next } = record;
  if (Array.isArray(record.briefFeedback)) {
    const refs = Array.isArray(briefFeedbackSceneIds) ? briefFeedbackSceneIds : [];
    // 정책은 briefFeedback을 문장별로 치환할 뿐 길이를 바꾸지 않으므로 같은 인덱스끼리 비교한다.
    const original = Array.isArray(before?.briefFeedback) ? before.briefFeedback : null;
    const aligned = record.briefFeedback.map((sentence, index) => (
      before && original?.[index] !== sentence ? null : valid(refs[index])
    ));
    if (aligned.some(Boolean)) next.briefFeedbackSceneIds = aligned;
  }
  if (Array.isArray(record.actionItems)) {
    // 정책은 desc가 빈 항목을 지워 인덱스가 어긋난다. 정책 전 항목의 (title, desc, sceneId)가 그대로 남은 항목만 ID를 유지한다.
    const unchanged = new Map<string, number>();
    if (before && Array.isArray(before.actionItems)) {
      for (const item of before.actionItems) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const key = actionItemKey(item as Record<string, unknown>);
        unchanged.set(key, (unchanged.get(key) ?? 0) + 1);
      }
    }
    next.actionItems = record.actionItems.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const { sceneId, ...rest } = item as Record<string, unknown>;
      let id = valid(sceneId);
      if (id && before) {
        const key = actionItemKey(item as Record<string, unknown>);
        const count = unchanged.get(key) ?? 0;
        if (count > 0) unchanged.set(key, count - 1);
        else id = null;
      }
      return id ? { ...rest, sceneId: id } : rest;
    });
  }
  return JSON.stringify(next);
}
