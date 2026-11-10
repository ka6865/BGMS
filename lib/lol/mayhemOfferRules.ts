// 증강이 제시되지 않는 조건. Riot이 데이터로 주지 않아 관리자가 DB(lol_mayhem_offer_rules)에 정리한다.
// verified=false는 Riot 원문으로 확인하지 못한 정보라 화면에 "확인 필요"로 표시한다. augmentId는 공식 증강 번호(AugmentPlatformId)다.
export type MayhemOfferRuleKind = "random_excluded" | "condition";
export type MayhemOfferRule = { id: number; augmentId: number; kind: MayhemOfferRuleKind; text: string; patch: string | null; verified: boolean };
export type MayhemOfferNote = { text: string; patch: string | null; verified: boolean };
export type MayhemOfferRuleStatus = "candidate" | "active" | "rejected";
export type MayhemOfferRuleAdmin = Omit<MayhemOfferRule, "augmentId"> & { augmentId: number | null; status: MayhemOfferRuleStatus; sourceQuote: string | null; sourceUrl: string | null; createdAt: string; updatedAt: string | null };

// 무작위로 증강을 주는 증강: 전환: 프리즘·골드·혼돈, 판도라의 상자, 나는 왕이다.
export const MAYHEM_RANDOM_GRANTERS = [1238, 1237, 1243, 12317, 1337] as const;
const RANDOM_EXCLUDED_TEXT = "전환·판도라의 상자·나는 왕이다가 무작위로 주는 증강에서는 나오지 않습니다.";

export function mayhemOfferNotes(rules: MayhemOfferRule[], id: number): MayhemOfferNote[] {
  const own = rules.filter(rule => rule.augmentId === id);
  return [
    ...own.filter(rule => rule.kind === "random_excluded").map(rule => ({ text: RANDOM_EXCLUDED_TEXT, patch: rule.patch, verified: rule.verified })),
    ...own.filter(rule => rule.kind === "condition").map(({ text, patch, verified }) => ({ text, patch, verified })),
  ];
}

// 무작위 제외 목록을 주는 쪽 카드에 보여 준다. 하나라도 확인되지 않았으면 목록 전체를 확인 필요로 본다.
export function mayhemRandomExcluded(rules: MayhemOfferRule[]): { ids: number[]; patch: string | null; verified: boolean } {
  const excluded = rules.filter(rule => rule.kind === "random_excluded");
  const order = (patch: string) => patch.split(".").reduce((sum, part) => sum * 100 + Number(part), 0);
  const patches = excluded.map(rule => rule.patch).filter((patch): patch is string => !!patch).sort((a, b) => order(a) - order(b));
  return { ids: excluded.map(rule => rule.augmentId), patch: patches.at(-1) ?? null, verified: excluded.length > 0 && excluded.every(rule => rule.verified) };
}

export type MayhemOfferRuleInput = { augmentId: number | null; kind: MayhemOfferRuleKind; text: string; patch: string | null; verified: boolean; status: MayhemOfferRuleStatus; sourceUrl: string | null };

// 관리자 입력 형식만 검사한다. 게시(active)하려면 대상 증강이, 조건이면 문장도 있어야 한다.
export function parseMayhemOfferRuleInput(value: unknown): MayhemOfferRuleInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const augmentId = body.augmentId === null ? null : Number.isSafeInteger(body.augmentId) && (body.augmentId as number) > 0 && (body.augmentId as number) <= 1_000_000 ? body.augmentId as number : undefined;
  const text = typeof body.text === "string" ? body.text.trim() : undefined;
  const patch = body.patch === null || body.patch === "" ? null : typeof body.patch === "string" && /^[0-9]{2}\.[0-9]{1,2}$/.test(body.patch) ? body.patch : undefined;
  const sourceUrl = body.sourceUrl === null || body.sourceUrl === "" ? null : typeof body.sourceUrl === "string" && body.sourceUrl.length <= 500 && /^https:\/\/[^\s]+$/.test(body.sourceUrl) ? body.sourceUrl : undefined;
  if (augmentId === undefined || text === undefined || text.length > 300 || patch === undefined || sourceUrl === undefined || typeof body.verified !== "boolean"
    || (body.kind !== "random_excluded" && body.kind !== "condition") || !["candidate", "active", "rejected"].includes(body.status as string)) return null;
  if (body.status === "active" && (augmentId === null || (body.kind === "condition" && !text))) return null;
  return { augmentId, kind: body.kind, text, patch, verified: body.verified, status: body.status as MayhemOfferRuleInput["status"], sourceUrl };
}
