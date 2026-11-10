import { classifyLolItems } from "./championStats";

export const MAYHEM_TIP_LIMITS = { augments: 6, items: 6, summary: 60, usage: 1000, dailyPerUser: 10, pageSize: 20, comment: 500, comments: 300 } as const;

export type MayhemTipSort = "recent" | "top";
export type MayhemTipKind = "tip" | "question";
export type MayhemTipItem = { id: number; name: string; image: string; boots: boolean };
export type MayhemTip = {
  id: number; kind: MayhemTipKind; championId: number | null; augmentIds: number[]; itemIds: number[]; summary: string; usage: string;
  anonymous: boolean; author: string | null; up: number; down: number; myVote: -1 | 0 | 1; mine: boolean; comments: number; createdAt: string; updatedAt: string | null;
};
// 지운 댓글은 답글이 있을 때만 자리로 남고 본문과 작성자는 비운다. byTipAuthor는 글쓴이가 단 댓글 표시다.
export type MayhemTipComment = { id: number; parentId: number | null; body: string; author: string | null; anonymous: boolean; deleted: boolean; mine: boolean; byTipAuthor: boolean; createdAt: string };
export type MayhemTipCommentInput = { tipId: number; parentId: number | null; body: string; anonymous: boolean };
export type MayhemTipInput = { kind: MayhemTipKind; championId: number | null; augmentIds: number[]; itemIds: number[]; summary: string; usage: string; anonymous: boolean };

const ids = (value: unknown, min: number, max: number): number[] | null =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(id => Number.isSafeInteger(id) && id > 0 && id <= 1_000_000) && new Set(value).size === value.length ? value as number[] : null;
const controlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// 제보 본문 형식만 검사한다. 증강·아이템·챔피언이 실제로 있는지는 서버가 목록과 대조한다.
export function parseMayhemTipInput(value: unknown): MayhemTipInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const championId = body.championId === null ? null : Number.isSafeInteger(body.championId) && (body.championId as number) > 0 && (body.championId as number) <= 100_000 ? body.championId as number : undefined;
  const kind = body.kind ?? "tip";
  if (kind !== "tip" && kind !== "question") return null;
  // 질문은 관련 증강 없이도 올릴 수 있다.
  const augmentIds = ids(body.augmentIds ?? [], kind === "question" ? 0 : 1, MAYHEM_TIP_LIMITS.augments);
  const itemIds = ids(body.itemIds ?? [], 0, MAYHEM_TIP_LIMITS.items);
  const anonymous = body.anonymous ?? false;
  if (championId === undefined || !augmentIds || !itemIds || typeof anonymous !== "boolean" || typeof body.summary !== "string" || typeof body.usage !== "string") return null;
  const summary = body.summary.trim(), usage = body.usage.trim();
  if (summary.length < 2 || summary.length > MAYHEM_TIP_LIMITS.summary || usage.length > MAYHEM_TIP_LIMITS.usage || controlChars.test(summary) || controlChars.test(usage) || /[\r\n]/.test(summary)) return null;
  return { kind, championId, augmentIds, itemIds, summary, usage, anonymous };
}

export const parseMayhemTipId = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;

export function parseMayhemTipCommentInput(value: unknown): MayhemTipCommentInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const tipId = parseMayhemTipId(body.tipId), parentId = body.parentId === null || body.parentId === undefined ? null : parseMayhemTipId(body.parentId);
  const anonymous = body.anonymous ?? false;
  if (!tipId || (body.parentId != null && !parentId) || typeof anonymous !== "boolean" || typeof body.body !== "string") return null;
  const text = body.body.trim();
  if (!text || text.length > MAYHEM_TIP_LIMITS.comment || controlChars.test(text)) return null;
  return { tipId, parentId, body: text, anonymous };
}

type ItemJson = { data?: Record<string, { name?: string; image?: { full?: string }; maps?: Record<string, boolean> }> };

// 칼바람 맵(12)에서 살 수 있는 완성 아이템과 신발만 고를 수 있다.
// Data Dragon에는 같은 아이템이 모드별 번호(예: 강철심장 3084·223084)로 겹쳐 있어 이름마다 가장 작은 번호 하나만 남긴다.
// 황금 뒤집개(994403)·궁극의 히드라(226668)처럼 변형 번호만 있는 아수라장 아이템은 그 번호로 남는다.
// 77xxxx는 맵 12로 표시되지만 아수라장 통계에 나오지 않는 예전 칼바람용 번호(서풍·수호 천사 등)라 뺀다.
const legacyAramItem = (id: number) => id >= 770_000 && id < 780_000;
export function selectMayhemTipItems(json: unknown): MayhemTipItem[] {
  const data = (json as ItemJson | null)?.data ?? {};
  const meta = classifyLolItems(json);
  const byName = new Map<string, MayhemTipItem>();
  for (const [key, item] of Object.entries(data)) {
    const id = Number(key), kind = meta[id];
    if (!kind || legacyAramItem(id) || !(kind.final || kind.boots) || item.maps?.["12"] !== true || !item.name || !item.image?.full) continue;
    const name = item.name.replace(/<[^>]*>/g, "").trim();
    const current = byName.get(name);
    if (!current || id < current.id) byName.set(name, { id, name, image: item.image.full, boots: kind.boots });
  }
  return [...byName.values()].sort((a, b) => Number(a.boots) - Number(b.boots) || a.name.localeCompare(b.name, "ko"));
}
