import type { BanObservation, BanPlatform, BanStatus } from "./banStatus";

export type BanWatchRole = "killer" | "finisher" | "knocker";

export type BanWatchItem = {
  id: string;
  userId: string;
  platform: BanPlatform;
  subjectAccountId: string;
  targetAccountId: string;
  matchId: string;
  eventAt: string;
  role: BanWatchRole;
  nicknameAtMatch: string;
  mapName: string | null;
  weapon: string | null;
  note: string | null;
  createdAt: string;
  activeUntil: string;
  baselineStatus: BanStatus | null;
  baselineCheckedAt: string | null;
  lastViewedAt: string | null;
  /** Joined common-cache fields returned by GET /api/pubg/ban-watch. */
  currentStatus?: BanStatus;
  currentRawType?: string | null;
  currentCheckedAt?: string | null;
  currentError?: string | null;
};

export type BanStatusRow = BanObservation & {
  lastAttemptAt: string | null;
  lastError: string | null;
  nextCheckAt: string | null;
  updatedAt: string;
};

export type BanStatusEvent = {
  id: number | string;
  platform: BanPlatform;
  accountId: string;
  previousStatus: BanStatus | null;
  observedStatus: BanStatus;
  rawType: string | null;
  observedAt: string;
  observationId: string;
};

export type BanWatchListResponse = {
  items: BanWatchItem[];
  statuses: BanStatusRow[];
  events: BanStatusEvent[];
};

export type BanWatchCreateInput = {
  platform: BanPlatform;
  subjectAccountId: string;
  /** Nickname from the subject participant, used only to revalidate identity. */
  subjectNicknameAtMatch?: string | null;
  targetAccountId: string;
  matchId: string;
  eventAt: string;
  role: BanWatchRole;
  nicknameAtMatch: string;
  mapName?: string | null;
  weapon?: string | null;
  note?: string | null;
};

export type BanWatchUpdateInput = {
  id: string;
  note?: string | null;
  markViewed?: boolean;
  extend?: boolean;
  refresh?: boolean;
};

export type BanWatchEncounterRequest = {
  platform: BanPlatform;
  matchId: string;
  subjectAccountId?: string;
  nickname?: string;
};
