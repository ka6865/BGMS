export const MAYHEM_TIP_LIMITS = { augments: 6, items: 6, summary: 60, usage: 1000, dailyPerUser: 10, pageSize: 20 } as const;

export type MayhemTipSort = "recent" | "top";
export type MayhemTipItem = { id: number; name: string; image: string; boots: boolean };
export type MayhemTip = {
  id: number; championId: number | null; augmentIds: number[]; itemIds: number[]; summary: string; usage: string;
  anonymous: boolean; author: string | null; up: number; down: number; myVote: -1 | 0 | 1; mine: boolean; createdAt: string; updatedAt: string | null;
};
export type MayhemTipInput = { championId: number | null; augmentIds: number[]; itemIds: number[]; summary: string; usage: string; anonymous: boolean };

const ids = (value: unknown, min: number, max: number): number[] | null =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(id => Number.isSafeInteger(id) && id > 0 && id <= 1_000_000) && new Set(value).size === value.length ? value as number[] : null;
const controlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// 제보 본문 형식만 검사한다. 증강·아이템·챔피언이 실제로 있는지는 서버가 목록과 대조한다.
export function parseMayhemTipInput(value: unknown): MayhemTipInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const championId = body.championId === null ? null : Number.isSafeInteger(body.championId) && (body.championId as number) > 0 && (body.championId as number) <= 100_000 ? body.championId as number : undefined;
  const augmentIds = ids(body.augmentIds, 1, MAYHEM_TIP_LIMITS.augments);
  const itemIds = ids(body.itemIds ?? [], 0, MAYHEM_TIP_LIMITS.items);
  const anonymous = body.anonymous ?? false;
  if (championId === undefined || !augmentIds || !itemIds || typeof anonymous !== "boolean" || typeof body.summary !== "string" || typeof body.usage !== "string") return null;
  const summary = body.summary.trim(), usage = body.usage.trim();
  if (summary.length < 2 || summary.length > MAYHEM_TIP_LIMITS.summary || usage.length > MAYHEM_TIP_LIMITS.usage || controlChars.test(summary) || controlChars.test(usage) || /[\r\n]/.test(summary)) return null;
  return { championId, augmentIds, itemIds, summary, usage, anonymous };
}

export const parseMayhemTipId = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
