import { findDisallowedLatinWords } from "./aiCoachingQuality";
import { WEAPON_NAMES } from "./constants";
import { toSummarySpicyBanmal } from "./spicyPunchlines";
import { categorizeWeapon } from "./weaponMetaBurst";

// 단일 경기 AI 코칭의 칭호·숫자·말투·영어를 서버 기록으로 정리한다.
// 새 응답과 캐시 응답에 같은 순서로 적용하며, 이미 정리된 텍스트에 다시 적용해도 결과가 같다.

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

// 타임라인 무기 칸은 표시 이름이라 원본 키로 분류한 지정사수·저격 소총의 표시 이름 목록을 만든다.
const MARKSMAN_WEAPON_NAMES = new Set(Object.entries(WEAPON_NAMES)
  .filter(([raw]) => ["DMR", "SR"].includes(categorizeWeapon(raw)))
  .map(([, display]) => display));
const THROWABLE_WEAPON = /grenade|molotov|c4|sticky|수류탄|화염병|점착/iu;

// 기준값. 근거는 docs/operations/2026-11-14-match-ai-coaching-quality.md의 칭호 근거 검증 절에 적는다.
const SNIPER_RANGE_M = 150;
const MARKSMAN_EVENT_RANGE_M = 100;
const CLOSE_RANGE_M = 30;
const CLOSE_EVENT_MIN = 2;
const PERFECT_ACCURACY_PCT = 80;
const PERFECT_MIN_ATTEMPTS = 3;
const EXPLOSIVE_ACCURACY_PCT = 30;
const SLAYER_KILLS = 5;
const SURVIVOR_TOP_PCT = 20;

interface TitleRule {
  id: "sniper" | "perfect" | "slayer" | "survivor" | "explosive" | "melee";
  label: string;
  pattern: RegExp;
}

const TITLE_RULES: readonly TitleRule[] = [
  { id: "sniper", label: "저격·명사수·원거리·스나이퍼", pattern: /저격|명사수|원거리|장거리|스나이퍼/u },
  { id: "perfect", label: "백발백중", pattern: /백발백중|필중/u },
  { id: "slayer", label: "슬레이어", pattern: /슬레이어/u },
  { id: "survivor", label: "생존왕", pattern: /생존왕/u },
  { id: "explosive", label: "폭파·투척", pattern: /폭파|폭탄|투척|수류탄/u },
  { id: "melee", label: "백병전·근접·근거리", pattern: /백병전|근접|근거리|육탄/u },
];

type MatchRecord = Record<string, any>;

/** 이 경기 기록으로 칭호 단어 묶음별 허용 여부를 판정한다. 근거 지표가 없으면 허용하지 않는다. */
export function judgeMatchTitleKeywords(match: unknown, storedPercentiles?: unknown): Record<TitleRule["id"], boolean> {
  const record = (match && typeof match === "object" ? match : {}) as MatchRecord;
  const stats = record.stats ?? {};
  const events = (Array.isArray(record.timeline) ? record.timeline : [])
    .filter((event: any) => (event?.type === "KILL" || event?.type === "KNOCK") && event?.isMe !== false);
  const distances = events.map((event: any) => finite(event.distance)).filter((value: number | null): value is number => value !== null);
  const longest = Math.max(finite(stats.longestKill) ?? 0, ...distances, 0);
  const marksmanAtRange = events.some((event: any) => MARKSMAN_WEAPON_NAMES.has(String(event.weapon ?? ""))
    && (finite(event.distance) ?? 0) >= MARKSMAN_EVENT_RANGE_M);
  const closeEvents = distances.filter((value: number) => value <= CLOSE_RANGE_M).length;

  const utility = record.combatPressure?.utilityStats ?? {};
  const lethal = finite(utility.lethalThrowCount);
  const hits = utility.accuracyStatus === "missing" ? null : finite(utility.hitCount);
  const accuracy = lethal !== null && lethal > 0 && hits !== null ? Math.min(hits, lethal) / lethal * 100 : null;
  const weaponStats = record.weaponStats && typeof record.weaponStats === "object" ? record.weaponStats : {};
  const throwableKill = Object.entries(weaponStats).some(([name, value]: [string, any]) => THROWABLE_WEAPON.test(name)
    && ((finite(value?.kills) ?? 0) + (finite(value?.dbnos) ?? 0)) > 0)
    || events.some((event: any) => THROWABLE_WEAPON.test(String(event.weapon ?? "")));

  const badgeIds = new Set((Array.isArray(record.badges) ? record.badges : []).map((badge: any) => badge?.id));
  const percentiles = Array.isArray(storedPercentiles) ? storedPercentiles : [];
  const survivalTop = percentiles.some((item: any) => item?.metric === "survival_time" && item?.direction === "top"
    && Number(item?.percent) <= SURVIVOR_TOP_PCT);

  const sniper = longest >= SNIPER_RANGE_M || marksmanAtRange;
  const melee = closeEvents >= CLOSE_EVENT_MIN;
  return {
    sniper,
    perfect: lethal !== null && lethal >= PERFECT_MIN_ATTEMPTS && accuracy !== null && accuracy >= PERFECT_ACCURACY_PCT,
    slayer: (finite(stats.kills) ?? 0) >= SLAYER_KILLS || badgeIds.has("slayer"),
    survivor: badgeIds.has("survivor") || survivalTop,
    explosive: (hits !== null && hits > 0 && accuracy !== null && accuracy >= EXPLOSIVE_ACCURACY_PCT) || throwableKill,
    melee,
  };
}

/** 프롬프트용 칭호 키워드 안내. 백분위는 생성 직전에 계산한 값을 넘긴다. */
export function formatMatchTitleKeywordSection(match: unknown, percentiles?: unknown): string {
  const judged = judgeMatchTitleKeywords(match, percentiles);
  const allowed = TITLE_RULES.filter((rule) => judged[rule.id]).map((rule) => rule.label);
  const blocked = TITLE_RULES.filter((rule) => !judged[rule.id]).map((rule) => rule.label);
  return [
    "[칭호 키워드] 서버가 이 경기 기록으로 확인한 결과입니다. signature에는 근거가 확인된 키워드만 쓰십시오.",
    `- 근거 확인: ${allowed.length ? allowed.join(", ") : "없음"}`,
    `- 근거 없음(사용 금지): ${blocked.length ? blocked.join(", ") : "없음"}`,
    "- 근접 계열과 저격 계열을 한 칭호에 함께 쓰지 마십시오. 서버가 근거 없는 칭호를 기록 기반 칭호로 바꿉니다.",
  ].join("\n");
}

const sentencesOf = (value: string): string[] => value.split(/(?<=[.!?。！？])\s+|\n+/u).map((part) => part.trim()).filter(Boolean);

function blockedRules(title: string, judged: Record<TitleRule["id"], boolean>): TitleRule[] {
  const hits = TITLE_RULES.filter((rule) => rule.pattern.test(title));
  // 근접과 저격이 함께 있으면 둘 다 근거가 있어도 모순이라 둘 다 막는다.
  const contradiction = hits.some((rule) => rule.id === "sniper") && hits.some((rule) => rule.id === "melee");
  return hits.filter((rule) => !judged[rule.id] || (contradiction && (rule.id === "sniper" || rule.id === "melee")));
}

function safeTitle(match: MatchRecord): string {
  const badges = Array.isArray(match.badges) ? match.badges : [];
  const badge = ["slayer", "ace", "survivor"].map((id) => badges.find((item: any) => item?.id === id)).find(Boolean);
  if (badge && typeof badge.name === "string") return badge.name;
  const damage = finite(match.stats?.damageDealt) ?? 0;
  return damage >= 100 ? "화력 기여형 플레이어" : "경기 기록 점검";
}

function factSentence(match: MatchRecord): string {
  const badges = Array.isArray(match.badges) ? match.badges : [];
  const badge = badges.find((item: any) => typeof item?.name === "string" && typeof item?.desc === "string");
  if (badge) return `${badge.name} 배지(${badge.desc})를 획득했습니다.`;
  const kills = finite(match.stats?.kills) ?? 0, damage = finite(match.stats?.damageDealt) ?? 0;
  return `이번 경기에서 ${kills}킬, 공식 피해량 ${Math.round(damage)}를 기록했습니다.`;
}

/** 근거 없는 단어가 든 칭호를 고친다. 남은 단어가 근거 있는 칭호면 그것을 쓰고, 아니면 서버 칭호로 바꾼다. */
function guardTitle(record: MatchRecord, match: MatchRecord): void {
  if (typeof record.signature !== "string") return;
  const judged = judgeMatchTitleKeywords(match, record.benchmarkPercentiles);
  const blocked = blockedRules(record.signature, judged);
  if (!blocked.length) return;
  const words = record.signature.split(/\s+/u).filter(Boolean);
  const dropped = words.filter((word: string) => blocked.some((rule) => rule.pattern.test(word)));
  const rest = words.filter((word: string) => !dropped.includes(word)).join(" ");
  const restSupported = TITLE_RULES.some((rule) => rule.pattern.test(rest)) && blockedRules(rest, judged).length === 0;
  record.signature = restSupported ? rest : safeTitle(match);
  // signatureSub는 근거 정책을 거친 관측 문장이라 유지하고, 지운 칭호 단어를 직접 가리키는 문장만 뺀다.
  if (typeof record.signatureSub === "string") {
    const kept = sentencesOf(record.signatureSub).filter((sentence) => !dropped.some((word: string) => sentence.includes(word)));
    record.signatureSub = kept.length ? kept.join(" ") : factSentence(match);
  }
}

// 소수점 셋째 자리 이상 숫자는 표시 규칙으로 줄인다. 피해량·딜량은 정수, 나머지는 한 자리다.
const LONG_DECIMAL = /(\d+\.\d{3,})/gu;
function roundLongDecimals(text: string): string {
  return text.replace(LONG_DECIMAL, (token, _match, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 10), offset);
    return /피해|딜/u.test(before) ? String(Math.round(Number(token))) : String(Number(Number(token).toFixed(1)));
  });
}

// 받침 여부로 '이야/야'를 고른다.
const hasBatchim = (char: string): boolean => {
  const code = char.charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
};
// 아·오 모음 어간은 '아', 그 밖은 '어'로 잇는다. 과거·추측 선어말 어미 뒤는 '어'다.
const banmalAfterStem = (stem: string): string => {
  if (/[았었였했겠]$/u.test(stem)) return `${stem}어`;
  const code = stem.charCodeAt(stem.length - 1) - 0xac00;
  const vowel = Math.floor((code % 588) / 28);
  return `${stem}${vowel === 0 || vowel === 8 ? "아" : "어"}`;
};
const END = "(?=[.!?]|$)";

/** 매운맛 문장 끝 존댓말을 반말로 바꾼다. 공용 어미 표 뒤에 남는 -습니다·-합니다·-입니다를 처리한다. */
export function toMatchSpicyBanmal(text: string): string {
  return toSummarySpicyBanmal(text)
    .replace(new RegExp(`([가-힣])습니다${END}`, "gu"), (_token, stem: string) => banmalAfterStem(stem))
    .replace(new RegExp(`합니다${END}`, "gu"), "해")
    .replace(new RegExp(`됩니다${END}`, "gu"), "돼")
    .replace(new RegExp(`([가-힣])입니다${END}`, "gu"), (_token, prev: string) => `${prev}${hasBatchim(prev) ? "이야" : "야"}`);
}

// 닉네임처럼 경기마다 다른 허용어. 이 경기 기록의 이름 칸에서 모은다.
const NAME_KEYS = /^(?:name|nickname|playerName|victim|attacker|killer|teamNames|opponents)$/u;
function collectNames(value: unknown, key = "", into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (NAME_KEYS.test(key) && value.trim()) into.add(value.trim());
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectNames(item, key, into));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([name, item]) => collectNames(item, name, into));
  }
  return into;
}

/** 허용 목록 밖 영어 단어가 든 문장을 뺀다. 모두 빠지면 fallback을 쓴다. */
function dropLatinSentences(value: unknown, allowed: Set<string>, fallback: string): unknown {
  if (typeof value !== "string" || findDisallowedLatinWords(value, allowed).length === 0) return value;
  const kept = sentencesOf(value).filter((sentence) => findDisallowedLatinWords(sentence, allowed).length === 0);
  return kept.length ? kept.join(" ") : fallback;
}

const PROSE_KEYS = ["signature", "signatureSub", "finalVerdict"] as const;

/** 칭호 근거, 긴 소수, 매운맛 결론 반말, 영어 단어를 정리한다. JSON이 아니면 그대로 둔다. */
export function applyMatchAiTitlePolicy(text: string, match: unknown, coachingStyle: string): string {
  let record: MatchRecord;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    record = { ...parsed };
  } catch {
    return text;
  }
  const source = (match && typeof match === "object" ? match : {}) as MatchRecord;
  const fact = factSentence(source);
  const names = collectNames(source);

  for (const key of PROSE_KEYS) {
    if (typeof record[key] !== "string") continue;
    const fallback = key === "signature" ? safeTitle(source) : fact;
    record[key] = dropLatinSentences(roundLongDecimals(record[key]), names, fallback);
  }
  if (Array.isArray(record.briefFeedback)) {
    record.briefFeedback = record.briefFeedback.map((item: unknown) => typeof item === "string"
      ? dropLatinSentences(roundLongDecimals(item), names, fact) : item);
  }
  if (Array.isArray(record.actionItems)) {
    record.actionItems = record.actionItems.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
      const next = { ...(item as MatchRecord) };
      if (typeof next.title === "string") next.title = dropLatinSentences(roundLongDecimals(next.title), names, "다음 경기 점검");
      if (typeof next.desc === "string") next.desc = dropLatinSentences(roundLongDecimals(next.desc), names, "");
      // 설명이 모두 빠진 행동 제안은 근거 정책과 같이 항목째 뺀다.
      return next.desc === "" ? [] : [next];
    });
  }
  guardTitle(record, source);
  if (coachingStyle === "spicy") {
    if (typeof record.finalVerdict === "string") record.finalVerdict = toMatchSpicyBanmal(record.finalVerdict);
    if (typeof record.signatureSub === "string") record.signatureSub = toMatchSpicyBanmal(record.signatureSub);
  }
  const next = JSON.stringify(record);
  return next === JSON.stringify(JSON.parse(text)) ? text : next;
}
