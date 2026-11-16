// 단일 경기 AI 코칭 문장이 가리킬 수 있는 장면 목록. 서버는 이 목록을 프롬프트에 넣고 응답의 장면 ID를 검증하며,
// 화면은 같은 규칙으로 타임라인에서 장면을 다시 찾는다. 모델은 목록 안에서 ID를 고르기만 한다.
import { ISOLATION_MIN_DISTANCE_M, type MatchFight, type MatchReport } from "./matchReport";
import { DEATH_TYPE_LABELS, describeDeath, FIGHT_OUTCOME_LABELS, formatMatchClock } from "./matchReportView";
import { WEAPON_NAMES } from "./constants";
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

// 차량 이름이 무기 칸에 오면 모델이 사격으로 읽으므로 차량 충돌로 적는다.
const VEHICLE_NAMES = new Set(Object.entries(WEAPON_NAMES).filter(([key]) => key.startsWith("Vehicle_")).map(([, name]) => name));

/** 프롬프트용 장면 한 줄. 상대 닉네임은 넣지 않는다. */
export function formatMatchAiSceneLine(scene: MatchAiScene): string {
  const weapon = scene.event.weapon;
  const details = [
    weapon && VEHICLE_NAMES.has(weapon) ? `차량 충돌: ${weapon}` : weapon,
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

/** 경기 중 받은 자기장 피해 합계. 피격 목록은 앞 60개만 남지만 출처별 합계는 전체다. */
function zoneDamageTaken(report: MatchReport): number {
  const sources = Array.isArray(report.damageTaken?.sources) ? report.damageTaken.sources : [];
  return Math.round(sources.reduce((sum, source) => sum + (source?.cause === "zone" && finite(source.damage) ? source.damage : 0), 0));
}

/** 사망 시각을 포함한 교전에서 우리 팀이 쓰러진 수. */
function lastFightTeamDowns(report: MatchReport, deathMs: number): number {
  const fight = (Array.isArray(report.fights) ? report.fights : []).filter(isFight).find((item) => item.startMs <= deathMs && deathMs <= item.endMs);
  return fight ? fight.teamDowns : 0;
}

/** 내가 자기장 피해로 기절한 시각. 사망 유형이 다른 원인이어도 실제 원인일 수 있어 따로 찾는다. */
function zoneKnockMs(match: unknown): number | null {
  const timeline = (match as { timeline?: unknown } | null)?.timeline;
  if (!Array.isArray(timeline)) return null;
  const event = timeline.find((item) => item?.type === "DOWNED" && item?.weapon === "자기장" && finite(item?.ts));
  return event ? event.ts : null;
}

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
  lines.push(`- 경기 중 받은 자기장 피해 합계 ${zoneDamageTaken(report)}`);
  return lines;
}

const MAX_ACTION_HINTS = 3;
// 2페이즈까지는 원 밖이 흔하므로 3페이즈부터 300m 이상 벗어난 경우만 쓴다.
const FAR_OUTSIDE_CIRCLE_PHASE = 3;
const FAR_OUTSIDE_CIRCLE_M = 300;
// 원 밖 거리는 새 원이 정해진 순간의 위치라 실수의 근거가 아니다. 실제 자기장 피해가 있을 때만 이동 후보를 만든다.
const ZONE_DAMAGE_EVIDENCE = 30;
const HOT_LANDING_ENEMIES = 4;
const WASTED_OPENING_DEALT = 150;

export interface MatchAiActionHint {
  id: string;
  title: string;
  text: string;
  sceneId: string | null;
}

const ACTION_TITLES = {
  "zone-knock": "원 안 진입 먼저", "zone-death": "새 원 이동 먼저", "isolated-bleed": "소생 거리 유지",
  "team-bleed": "연막 후 소생", "third-party": "교전 뒤 주변 확인", rotating: "이동 경로 확인",
  ambushed: "다음 멈출 지점 정하기", isolated: "팀원 합류 후 교전", outfought: "한 명에게 사격 집중",
  "zone-damage": "교전 끊고 원 이동", "wasted-opening": "선제 교전 마무리", "shot-first-loss": "짧게 끊어 이동", "hot-landing": "무기 먼저 확보",
} as const;

/**
 * 프롬프트용 행동 후보. 사망 유형·자기장 이탈·교전 결과·착지에서 이 경기에만 해당하는 조건을 골라
 * 모델이 '엄폐물로 숨기' 같은 일반 조언 대신 측정된 상황에 묶인 행동을 고르게 한다. 사망 원인을 먼저 둔다.
 */
export function buildMatchAiActionHints(match: unknown): MatchAiActionHint[] {
  const report = readMatchReport(match);
  if (!report) return [];
  const hints: MatchAiActionHint[] = [];
  const catalog = buildMatchAiSceneCatalog(match);
  const add = (kind: keyof typeof ACTION_TITLES, start: number, end: number, text: string) => {
    const scene = kind === "hot-landing" || kind === "zone-damage" ? null : catalog.find((item) => (
      item.ts >= Math.round(start) && item.ts <= Math.round(end)
      && (kind === "wasted-opening" || kind === "shot-first-loss"
        || item.event.type === (kind === "zone-knock" ? "DOWNED" : "DIED"))
    ));
    hints.push({ id: `${kind}-${Math.round(start)}`, title: ACTION_TITLES[kind], text, sceneId: scene?.id ?? null });
  };
  const death = report.death;
  const zoneKnock = zoneKnockMs(match);
  if (zoneKnock !== null && death?.type !== "zone") {
    add("zone-knock", zoneKnock, zoneKnock, `${formatMatchClock(zoneKnock)} 자기장 피해로 기절 → 원이 줄어들 때는 교전보다 원 안 진입을 먼저 한다`);
  }
  if (death && finite(death.timeMs) && Object.hasOwn(DEATH_TYPE_LABELS, death.type)) {
    const at = formatMatchClock(death.timeMs);
    const teammate = finite(death.nearestTeammateM) ? `${death.nearestTeammateM}m` : null;
    switch (death.type) {
      case "zone":
        add("zone-death", death.timeMs, death.timeMs, `${at} 자기장 사망 → 새 원이 정해지면 교전보다 이동을 먼저 시작한다`);
        break;
      case "bledOut":
        if (finite(death.nearestTeammateM) && death.nearestTeammateM >= ISOLATION_MIN_DISTANCE_M) {
          add("isolated-bleed", death.timeMs, death.timeMs, `${at} 기절 뒤 소생을 못 받고 사망(가장 가까운 팀원 ${teammate}) → 교전 전에 소생 가능한 거리로 팀원과 붙는다`);
        } else if (lastFightTeamDowns(report, death.timeMs) >= 2) {
          // 팀원이 가까웠는데 못 살렸다면 같은 교전에서 함께 쓰러진 경우다.
          add("team-bleed", death.timeMs, death.timeMs, `${at} 팀원${teammate ? ` ${teammate}` : ""} 옆에서 같은 교전에 함께 쓰러져 소생을 못 받음 → 한 명이 기절하면 남은 사람은 맞서기 전에 연막부터 깔고 살린다`);
        }
        break;
      case "thirdParty":
        add("third-party", death.timeMs, death.timeMs, `${at} 최근 1분간 ${finite(death.teamsInLastMinute) ? `${death.teamsInLastMinute}팀` : "여러 팀"}이 얽힌 교전에서 사망 → 교전을 끝내면 바로 자리를 옮기거나 다른 팀이 올 방향부터 확인한다`);
        break;
      case "rotating":
        add("rotating", death.timeMs, death.timeMs, `${at} ${death.inVehicle ? "차량 이동 중" : `직전 ${finite(death.movedBeforeFightM) ? `${death.movedBeforeFightM}m ` : ""}이동 중`} 사망 → 이동 전에 경로의 교전 소리·킬로그를 확인하고 짧게 끊어 이동한다`);
        break;
      case "ambushed":
        add("ambushed", death.timeMs, death.timeMs, `${at} 상대가 먼저 쏘고 반격 피해가 거의 없이 사망 → 이동을 시작하기 전에 다음 멈출 지점을 먼저 정한다`);
        break;
      case "isolated":
        add("isolated", death.timeMs, death.timeMs, `${at} 팀원과 ${teammate ?? "멀리"} 떨어져 사망 → 팀원과 거리를 좁힌 뒤에 교전을 연다`);
        break;
      case "outfought":
        // 상대 수는 측정하지 않는다. 먼저 쏘고 진 경우만 사격 집중을 권한다.
        if (death.openedBy === "us") add("outfought", death.timeMs, death.timeMs, `${at} 먼저 쏘고도 정면 교전에서 사망 → 먼저 쏠 때는 한 명에게 사격을 모아 숫자 우위부터 만든다`);
        break;
    }
  }

  const circles = (Array.isArray(report.circles) ? report.circles : []).flatMap((circle) => (
    circle?.status === "outside" && finite(circle.timeMs) && finite(circle.phase) && circle.phase >= FAR_OUTSIDE_CIRCLE_PHASE
      && finite(circle.outsideByM) && circle.outsideByM >= FAR_OUTSIDE_CIRCLE_M
      ? [{ timeMs: circle.timeMs, phase: circle.phase, outsideByM: circle.outsideByM }] : []));
  const farthest = circles.sort((a, b) => b.outsideByM - a.outsideByM)[0];
  const zoneDamage = zoneDamageTaken(report);
  if (farthest && zoneDamage >= ZONE_DAMAGE_EVIDENCE && death?.type !== "zone" && zoneKnock === null) {
    add("zone-damage", farthest.timeMs, farthest.timeMs, `${formatMatchClock(farthest.timeMs)} ${farthest.phase}페이즈 원 밖 ${Math.round(farthest.outsideByM)}m, 경기 중 자기장 피해 ${zoneDamage} → 원이 정해지면 교전을 끊고 원 쪽으로 먼저 이동한다`);
  }

  const fights = (Array.isArray(report.fights) ? report.fights : []).filter(isFight);
  const wasted = fights.filter((fight) => fight.openedBy === "us" && fight.enemyDowns === 0 && fight.dealt >= WASTED_OPENING_DEALT);
  if (wasted.length > 0) {
    add("wasted-opening", wasted[0].startMs, wasted[0].endMs, `먼저 쏘고도 아무도 못 쓰러뜨린 교전 ${wasted.length}번(첫 번째 ${formatMatchClock(wasted[0].startMs)}) → 먼저 쏠 때는 한 명에게 사격을 모으거나 투척물로 마무리한다`);
  }

  // 다른 후보가 없을 때만 쓴다. 먼저 맞아 진 교전은 흔해서 사망·자기장 후보보다 뒤에 둔다.
  const shotFirstLosses = fights.filter((fight) => fight.openedBy === "them" && fight.outcome === "lost" && fight.teamDowns > 0);
  if (hints.length === 0 && shotFirstLosses.length > 0) {
    add("shot-first-loss", shotFirstLosses[0].startMs, shotFirstLosses[0].endMs, `상대가 먼저 쏴서 우리 팀만 쓰러진 교전 ${shotFirstLosses.length}번(첫 번째 ${formatMatchClock(shotFirstLosses[0].startMs)}) → 넓은 곳은 다음 멈출 지점을 정하고 짧게 끊어 지난다`);
  }

  const landing = report.landing;
  if (landing && finite(landing.timeMs) && finite(landing.enemiesNear) && landing.enemiesNear >= HOT_LANDING_ENEMIES) {
    add("hot-landing", landing.timeMs, landing.timeMs, `착지 ${formatMatchClock(landing.timeMs)} 300m 안 적 ${landing.enemiesNear}명 → 같은 곳에 내리면 무기 하나를 먼저 줍고 첫 교전 위치를 정한다`);
  }
  return hints.slice(0, MAX_ACTION_HINTS);
}

/** 응답이 쓸 수 있는 경과 시각. 장면 목록·경기 흐름·행동 후보에 적힌 시각만 허용한다. */
function allowedMatchClocks(match: unknown): Set<string> {
  const clocks = new Set(buildMatchAiSceneCatalog(match).map((scene) => formatMatchClock(scene.ts)));
  for (const line of [...buildMatchAiFlowLines(match), ...buildMatchAiActionHints(match).map((hint) => hint.text)]) {
    for (const clock of line.match(/\d{1,3}:[0-5]\d/gu) ?? []) clocks.add(clock);
  }
  return clocks;
}

/** 응답이 쓸 수 있는 거리(m). 장면·흐름·행동 후보와 프롬프트의 대열 거리에 적힌 값만 허용한다. */
function allowedMatchDistances(match: unknown): Set<number> {
  const distances = new Set<number>();
  for (const scene of buildMatchAiSceneCatalog(match)) if (finite(scene.event.distance)) distances.add(Math.round(scene.event.distance));
  for (const line of [...buildMatchAiFlowLines(match), ...buildMatchAiActionHints(match).map((hint) => hint.text)]) {
    for (const [, value] of line.matchAll(/(\d+(?:\.\d+)?)m/gu)) distances.add(Math.round(Number(value)));
  }
  const isolation = (match as { isolationData?: { minDist?: unknown; heightDiff?: unknown } } | null)?.isolationData;
  // 프롬프트는 문자열 수치도 그대로 적으므로 숫자로 바꿔 비교한다.
  for (const value of [isolation?.minDist, isolation?.heightDiff]) {
    const meters = value === null || value === undefined || value === "" ? NaN : Number(value);
    if (Number.isFinite(meters)) distances.add(Math.round(meters));
  }
  return distances;
}

const CLOCK_FIELDS = ["signature", "signatureSub", "finalVerdict"] as const;
// 경과 시각을 "13시 01분"처럼 시각 표기로 바꿔 쓰면 m:ss로 되돌린 뒤 같은 규칙으로 검증한다. "3시 방향"은 건드리지 않는다.
const KOREAN_CLOCK_TOKEN = /(\d{1,2})시\s*(\d{1,2})분/gu;
// 목록에 없는 시각은 뒤에 붙은 조사까지 지운다. "12:40 교전에서" → "교전에서", "12:40에" → "".
const CLOCK_TOKEN = /(?:약\s*)?(\d{1,3}:[0-5]\d)(?:\s*(?:초|분))?(?:쯤|경)?(?:에(?:는|서)?|의|부터)?\s*/gu;
// 목록에 없는 거리는 숫자와 단위만 지운다. "136미터 거리에서" → "거리에서". km는 건드리지 않는다.
const DISTANCE_TOKEN = /(?:약\s*)?(?<![\d.])(\d{1,4}(?:\.\d+)?)\s*(?:m|미터)(?![A-Za-z])(?:\s*(?:정도|쯤))?(?:에서|의|까지|나)?\s*/gu;
// 장면 ID는 sceneId 필드에만 쓴다. 문장에 섞인 ID는 괄호째 지운다. "교전(KNOCK-1)은" → "교전은".
const SCENE_ID_TOKEN = new RegExp(`\\s*\\(?\\b(?:${Object.keys(SCENE_LABELS).join("|")})-\\d+\\b\\)?`, "gu");
// 측정하지 않는 마음가짐·판단을 단정하는 표현. 이 표현이 든 쉼표 구간만 지운다.
const JUDGMENT_TOKEN = /방심|집중력|멘탈|안일|판단 (?:미스|실수|착오)/u;

/** 쉼표·문장 단위로 나눠 판단 단정 구간을 지운다. 모든 구간이 걸리면 원문을 둔다. */
function dropJudgmentClauses(value: string): string {
  if (!JUDGMENT_TOKEN.test(value)) return value;
  const sentences = value.split(/(?<=[.!?])\s+/u).map((sentence) => {
    const clauses = sentence.split(/,\s*/u);
    const kept = clauses.filter((clause) => !JUDGMENT_TOKEN.test(clause));
    if (kept.length === clauses.length) return sentence;
    if (kept.length === 0) return "";
    const joined = kept.join(", ").trim();
    return /[.!?]$/u.test(joined) ? joined : `${joined}.`;
  }).filter(Boolean);
  return sentences.length > 0 ? sentences.join(" ") : value;
}

/**
 * 응답 문장의 경과 시각·거리를 이 경기의 장면·흐름 값으로 검증한다. 목록에 없는 값은 지워 모델이 시점과 거리를
 * 지어내지 못하게 하고, 문장에 섞인 장면 ID와 측정하지 않는 판단 단정 구간도 지운다. JSON이 아니면 그대로 둔다. 재적용해도 결과가 같다.
 */
export function applyMatchAiClockPolicy(text: string, match: unknown): string {
  const record = parseRecord(text);
  if (!record) return text;
  const allowed = allowedMatchClocks(match);
  const distances = allowedMatchDistances(match);
  const scrub = (value: unknown): unknown => (typeof value === "string"
    ? dropJudgmentClauses(value
      .replace(SCENE_ID_TOKEN, "")
      .replace(KOREAN_CLOCK_TOKEN, (_token, minutes: string, seconds: string) => `${Number(minutes)}:${seconds.padStart(2, "0")}`)
      .replace(CLOCK_TOKEN, (token, clock: string) => (allowed.has(clock) ? token : ""))
      .replace(DISTANCE_TOKEN, (token, meters: string) => (distances.has(Math.round(Number(meters))) ? token : ""))
      .replace(/\s{2,}/gu, " ").trim())
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

/** 모델이 응답을 ```json 울타리로 감싸면 근거 정책이 JSON으로 읽지 못하므로 먼저 벗긴다. */
export function unwrapMatchAiJson(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
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
