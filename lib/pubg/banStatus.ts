/**
 * PUBG's banType is an observation made at a point in time.  It is not a
 * statement about the reason, start time, or duration of a sanction.
 */
export type BanStatus = "none" | "temporary" | "permanent" | "unknown";
export type BanPlatform = "steam" | "kakao";

export type BanObservation = {
  accountId: string;
  platform: BanPlatform;
  status: BanStatus;
  rawType: string | null;
  checkedAt: string;
};

const STATUS_VALUES = new Set<BanStatus>(["none", "temporary", "permanent", "unknown"]);
const ACCOUNT_ID_PATTERN = /^account\.[A-Za-z0-9_-]+$/u;

/** PUBG platform values accepted by every ban boundary. */
export function isBanPlatform(value: unknown): value is BanPlatform {
  return value === "steam" || value === "kakao";
}

/** Keep account ids case-sensitive; PUBG ids are identifiers, not nicknames. */
export function isBanAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

export function isBanStatus(value: unknown): value is BanStatus {
  return typeof value === "string" && STATUS_VALUES.has(value as BanStatus);
}

/**
 * Normalise only values PUBG documents.  Missing values and generic `Banned`
 * strings stay unknown so callers never infer a sanction from incomplete data.
 */
export function normalizeBanStatus(raw: unknown): BanStatus {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "innocent":
    case "none":
      return "none";
    case "temporaryban":
      return "temporary";
    case "permanentban":
      return "permanent";
    default:
      return "unknown";
  }
}

/** Preserve the upstream value for audit/debugging without accepting objects. */
export function normalizeBanRawType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value.slice(0, 128) : null;
}

export function createBanObservation(input: {
  accountId: string;
  platform: BanPlatform;
  rawType: unknown;
  checkedAt?: string;
}): BanObservation {
  if (!isBanPlatform(input.platform) || !isBanAccountId(input.accountId)) {
    throw new Error("ban-observation-invalid-identity");
  }
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error("ban-observation-invalid-time");
  return {
    accountId: input.accountId,
    platform: input.platform,
    status: normalizeBanStatus(input.rawType),
    rawType: normalizeBanRawType(input.rawType),
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

export type BanStatusLabelOptions = { checkedAt?: string | null };

/** Safe, non-accusatory Korean copy for the profile/watch UI. */
export function banStatusLabel(status: BanStatus, options: BanStatusLabelOptions = {}): string {
  const checkedAt = options.checkedAt
    ? ` · 마지막 확인 ${options.checkedAt}`
    : " · 확인 시각 없음";
  switch (status) {
    case "none":
      return `현재 제재 표시 없음${checkedAt}`;
    case "temporary":
      return `임시 제재 확인${checkedAt}`;
    case "permanent":
      return `영구 제재 확인${checkedAt}`;
    default:
      return `제재 상태 확인 실패${checkedAt}`;
  }
}

/** Worker cadence after a successful observation. */
export function banStatusIntervalMs(status: BanStatus): number {
  switch (status) {
    case "temporary":
      return 6 * 60 * 60 * 1000;
    case "permanent":
      return 7 * 24 * 60 * 60 * 1000;
    case "none":
    case "unknown":
      return 24 * 60 * 60 * 1000;
  }
}

export function nextBanCheckAt(status: BanStatus, now = new Date()): string {
  return new Date(now.getTime() + banStatusIntervalMs(status)).toISOString();
}
