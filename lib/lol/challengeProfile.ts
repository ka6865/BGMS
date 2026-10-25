export type LolChallengeCatalog = Array<{
  id: number; name: string; description: string; thresholds: Record<string, number>; percentiles: Record<string, number>;
}>;
export type LolChallengePoints = { level: string; current: number; percentile: number | null };
export type LolChallengeProfile = {
  status: "ready" | "failed"; titleMappingUnverified: boolean;
  total: LolChallengePoints | null;
  categories: Array<LolChallengePoints & { name: string }>;
  rarest: Array<{ id: number; name: string; description: string; level: string; percentile: number; threshold: number | null }>;
  distributionStatus: "ready" | "unavailable";
};

export const LOL_CHALLENGE_LEVELS: Record<string, string> = {
  NONE: "미등급", IRON: "아이언", BRONZE: "브론즈", SILVER: "실버", GOLD: "골드", PLATINUM: "플래티넘",
  DIAMOND: "다이아몬드", MASTER: "마스터", GRANDMASTER: "그랜드마스터", CHALLENGER: "챌린저",
};
const CATEGORIES: Record<string, string> = {
  IMAGINATION: "창의성", EXPERTISE: "전문성", TEAMWORK: "협동과 전략", VETERANCY: "수집과 경험", COLLECTION: "수집", LEGACY: "유산",
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const ratio = (value: unknown): value is number => finite(value) && value <= 1;
// 공식 설명의 태그는 문구로만 표시하며 HTML로 실행하지 않는다.
const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").slice(0, max).trim() : "";
const levels = (value: unknown, fractions = false) => Object.fromEntries(Object.entries(object(value))
  .filter(([key, value]) => Object.hasOwn(LOL_CHALLENGE_LEVELS, key) && (fractions ? ratio(value) : finite(value)))) as Record<string, number>;

export function parseLolChallengeCatalog(config: unknown, distribution: unknown): LolChallengeCatalog {
  if (!Array.isArray(config) || config.length > 2000 || !distribution || typeof distribution !== "object" || Array.isArray(distribution))
    throw new Error("invalid challenge catalog");
  const percentiles = object(distribution);
  return config.flatMap(value => {
    const row = object(value); const ko = object(object(row.localizedNames).ko_KR);
    if (!Number.isSafeInteger(row.id) || (row.id as number) < 0 || !["ENABLED", "ARCHIVED"].includes(String(row.state))) return [];
    const name = text(ko.name, 160);
    if (!name) return [];
    const raw = object(percentiles[String(row.id)]);
    const direct = levels(raw, true);
    const seasons = Object.values(raw).filter(value => value && typeof value === "object" && !Array.isArray(value));
    // shortcut: 시즌 식별자가 없는 player-data는 분포 시즌이 하나일 때만 연결하며, 복수 시즌은 공식 계약 확인 후 확장한다.
    return [{ id: row.id as number, name, description: text(ko.description ?? ko.shortDescription, 1000),
      thresholds: levels(row.thresholds), percentiles: Object.keys(direct).length ? direct : seasons.length === 1 ? levels(seasons[0], true) : {} }];
  });
}

function points(value: unknown): LolChallengePoints | null {
  const row = object(value);
  if (typeof row.level !== "string" || !Object.hasOwn(LOL_CHALLENGE_LEVELS, row.level) || !finite(row.current)) return null;
  const percentile = row.percentile ?? row.precentile;
  return { level: row.level, current: row.current, percentile: ratio(percentile) ? percentile : null };
}

export function buildLolChallengeProfile(value: unknown, catalog?: LolChallengeCatalog): LolChallengeProfile {
  const row = object(value);
  if (!Array.isArray(row.challenges) || row.challenges.length > 2000 || !points(row.totalPoints)) throw new Error("invalid challenge player");
  const byId = new Map(catalog?.map(challenge => [challenge.id, challenge]));
  const seen = new Set<number>();
  const rarest = row.challenges.flatMap(value => {
    const challenge = object(value); const id = challenge.challengeId;
    if (typeof id !== "number" || seen.has(id) || typeof challenge.level !== "string" || challenge.level === "NONE") return [];
    seen.add(id);
    const config = byId.get(id); const percentile = config?.percentiles[challenge.level];
    if (!config || !ratio(percentile)) return [];
    return [{ id, name: config.name, description: config.description, level: challenge.level, percentile,
      threshold: config.thresholds[challenge.level] ?? null }];
  }).sort((a, b) => a.percentile - b.percentile || a.id - b.id).slice(0, 3);
  return { status: "ready", titleMappingUnverified: !!object(row.preferences).title, total: points(row.totalPoints),
    categories: Object.entries(CATEGORIES).flatMap(([key, name]) => {
      const item = points(object(row.categoryPoints)[key]); return item ? [{ name, ...item }] : [];
    }), rarest, distributionStatus: catalog && catalog.some(item => Object.keys(item.percentiles).length) ? "ready" : "unavailable" };
}
