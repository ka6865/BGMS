import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createBanObservation,
  isBanAccountId,
  isBanPlatform,
  isBanStatus,
  nextBanCheckAt,
  normalizeBanRawType,
  normalizeBanStatus,
  type BanObservation,
  type BanPlatform,
  type BanStatus,
} from "./banStatus";
import type {
  BanStatusEvent,
  BanStatusRow,
  BanWatchCreateInput,
  BanWatchEncounterRequest,
  BanWatchItem,
  BanWatchListResponse,
  BanWatchRole,
  BanWatchUpdateInput,
} from "./banWatch";

export type BanWatchDb = SupabaseClient;
export type BanWatchErrorCode =
  | "invalid_input" | "unauthenticated" | "not_found" | "target_limit" | "match_limit"
  | "store_unavailable" | "store_failed" | "rate_limited" | "encounter_busy"
  | "encounter_source_unavailable";

export class BanWatchError extends Error {
  readonly code: BanWatchErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: BanWatchErrorCode, status: number, message: string = code, retryAfterSeconds?: number) {
    super(message);
    this.name = "BanWatchError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function requiredEnv(name: string): string {
  const value = (process.env[name] || "").replace(/[\s'"`;]+/g, "").trim();
  if (!value) throw new BanWatchError("store_unavailable", 503, "ban-watch-credentials-missing");
  return value;
}

export function getBanWatchAdminClient(): BanWatchDb {
  return createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getBanWatchSessionUserId(): Promise<string | null> {
  const { createClient } = await import("@/utils/supabase/server");
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  return error || !data.user?.id ? null : data.user.id;
}

export async function requireBanWatchUserId(): Promise<string> {
  const id = await getBanWatchSessionUserId();
  if (!id) throw new BanWatchError("unauthenticated", 401, "로그인이 필요합니다.");
  return id;
}

const MATCH_ID = /^[A-Za-z0-9._-]{1,160}$/u;
const UUIDISH = /^[A-Za-z0-9-]{1,100}$/u;
const ROLE_VALUES = new Set<BanWatchRole>(["killer", "finisher", "knocker"]);

type EncounterLimiterEntry = { windowStartedAt: number; count: number; inFlight: boolean };
const encounterLimiter = new Map<string, EncounterLimiterEntry>();
const ENCOUNTER_WINDOW_MS = 60 * 1000;
const ENCOUNTER_LIMIT = 5;
export type EncounterQuota = {
  allowed: boolean;
  retryAfterSeconds: number;
  release: () => void;
  reason: "ok" | "rate_limited" | "busy";
};

/** Per-session guard; verified source loads are cached by the loader. */
export function acquireEncounterRequest(userId: string, now = Date.now()): EncounterQuota {
  const current = encounterLimiter.get(userId);
  // The limiter is process-local, so prune expired sessions opportunistically
  // to avoid retaining one map entry per user forever on a long-lived server.
  if (encounterLimiter.size > 1024) {
    for (const [key, value] of encounterLimiter) {
      if (now - value.windowStartedAt >= ENCOUNTER_WINDOW_MS && !value.inFlight) encounterLimiter.delete(key);
    }
  }
  const sameWindow = current && now - current.windowStartedAt < ENCOUNTER_WINDOW_MS;
  const entry = sameWindow && current ? current : { windowStartedAt: now, count: 0, inFlight: false };
  encounterLimiter.set(userId, entry);
  const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStartedAt + ENCOUNTER_WINDOW_MS - now) / 1000));
  if (entry.inFlight) return { allowed: false, retryAfterSeconds: 1, release: () => undefined, reason: "busy" };
  if (entry.count >= ENCOUNTER_LIMIT) return { allowed: false, retryAfterSeconds, release: () => undefined, reason: "rate_limited" };
  entry.count += 1;
  entry.inFlight = true;
  let released = false;
  return {
    allowed: true,
    retryAfterSeconds: 0,
    reason: "ok",
    release: () => {
      if (released) return;
      released = true;
      if (encounterLimiter.get(userId) === entry) entry.inFlight = false;
    },
  };
}

function cleanOptionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new BanWatchError("invalid_input", 400, "문자열 입력이 필요합니다.");
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new BanWatchError("invalid_input", 400, "입력 길이가 너무 깁니다.");
  return trimmed || null;
}

function cleanRequiredText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new BanWatchError("invalid_input", 400, "문자열 입력이 필요합니다.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new BanWatchError("invalid_input", 400, "입력값이 올바르지 않습니다.");
  return trimmed;
}

export function parseBanWatchCreateInput(value: unknown): BanWatchCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BanWatchError("invalid_input", 400, "요청 본문이 올바르지 않습니다.");
  const body = value as Record<string, unknown>;
  if (!isBanPlatform(body.platform) || !isBanAccountId(body.subjectAccountId) || !isBanAccountId(body.targetAccountId)
    || typeof body.matchId !== "string" || !MATCH_ID.test(body.matchId)
    || typeof body.eventAt !== "string" || !Number.isFinite(Date.parse(body.eventAt))
    || typeof body.role !== "string" || !ROLE_VALUES.has(body.role as BanWatchRole)
    || typeof body.nicknameAtMatch !== "string") throw new BanWatchError("invalid_input", 400, "경기 상대 입력이 올바르지 않습니다.");
  const subjectNickname = body.subjectNicknameAtMatch ?? body.nickname;
  return {
    platform: body.platform,
    subjectAccountId: body.subjectAccountId,
    subjectNicknameAtMatch: cleanOptionalText(subjectNickname, 64),
    targetAccountId: body.targetAccountId,
    matchId: body.matchId,
    eventAt: new Date(body.eventAt).toISOString(),
    role: body.role as BanWatchRole,
    nicknameAtMatch: cleanRequiredText(body.nicknameAtMatch, 64),
    mapName: cleanOptionalText(body.mapName, 128),
    weapon: cleanOptionalText(body.weapon, 128),
    note: cleanOptionalText(body.note, 200),
  };
}

export function parseBanWatchEncounterRequest(value: unknown): BanWatchEncounterRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BanWatchError("invalid_input", 400, "요청 본문이 올바르지 않습니다.");
  const body = value as Record<string, unknown>;
  if (!isBanPlatform(body.platform) || typeof body.matchId !== "string" || !MATCH_ID.test(body.matchId)) throw new BanWatchError("invalid_input", 400, "플랫폼 또는 매치 식별자가 올바르지 않습니다.");
  if (body.subjectAccountId !== undefined && !isBanAccountId(body.subjectAccountId)) throw new BanWatchError("invalid_input", 400, "플레이어 식별자가 올바르지 않습니다.");
  if (body.nickname !== undefined && (typeof body.nickname !== "string" || !body.nickname.trim() || body.nickname.length > 64)) throw new BanWatchError("invalid_input", 400, "닉네임이 올바르지 않습니다.");
  return { platform: body.platform, matchId: body.matchId, subjectAccountId: body.subjectAccountId as string | undefined, nickname: typeof body.nickname === "string" ? body.nickname.trim() : undefined };
}

export function parseBanWatchUpdateInput(value: unknown): BanWatchUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BanWatchError("invalid_input", 400, "요청 본문이 올바르지 않습니다.");
  const body = value as Record<string, unknown>;
  const id = cleanRequiredText(body.id, 100);
  if (!UUIDISH.test(id)) throw new BanWatchError("invalid_input", 400, "항목 식별자가 올바르지 않습니다.");
  const note = cleanOptionalText(body.note, 200);
  for (const key of ["markViewed", "extend", "refresh"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") throw new BanWatchError("invalid_input", 400, "옵션 값이 올바르지 않습니다.");
  }
  if (note === undefined && body.markViewed === undefined && body.extend === undefined && body.refresh === undefined) throw new BanWatchError("invalid_input", 400, "변경할 값이 없습니다.");
  return { id, ...(note !== undefined ? { note } : {}), ...(body.markViewed !== undefined ? { markViewed: body.markViewed as boolean } : {}), ...(body.extend !== undefined ? { extend: body.extend as boolean } : {}), ...(body.refresh !== undefined ? { refresh: body.refresh as boolean } : {}) };
}

function normalizeStatusRow(row: Record<string, unknown>): BanStatusRow | null {
  if (!isBanPlatform(row.platform) || !isBanAccountId(row.account_id)) return null;
  const rawType = normalizeBanRawType(row.raw_ban_type);
  const checkedAt = typeof row.checked_at === "string" && Number.isFinite(Date.parse(row.checked_at)) ? new Date(row.checked_at).toISOString() : "";
  return {
    platform: row.platform,
    accountId: row.account_id,
    status: isBanStatus(row.normalized_status) ? row.normalized_status : normalizeBanStatus(rawType),
    rawType,
    checkedAt,
    lastAttemptAt: typeof row.last_attempt_at === "string" ? row.last_attempt_at : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    nextCheckAt: typeof row.next_check_at === "string" ? row.next_check_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
  };
}

function normalizeWatchRow(row: Record<string, unknown>): BanWatchItem | null {
  if (typeof row.id !== "string" || typeof row.user_id !== "string" || !isBanPlatform(row.platform)
    || !isBanAccountId(row.subject_account_id) || !isBanAccountId(row.target_account_id)
    || typeof row.match_id !== "string" || typeof row.event_at !== "string"
    || !ROLE_VALUES.has(row.role as BanWatchRole) || typeof row.nickname_at_match !== "string"
    || typeof row.created_at !== "string" || typeof row.active_until !== "string") return null;
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    subjectAccountId: row.subject_account_id,
    targetAccountId: row.target_account_id,
    matchId: row.match_id,
    eventAt: row.event_at,
    role: row.role as BanWatchRole,
    nicknameAtMatch: row.nickname_at_match,
    mapName: typeof row.map_name === "string" ? row.map_name : null,
    weapon: typeof row.weapon === "string" ? row.weapon : null,
    note: typeof row.note === "string" ? row.note : null,
    createdAt: row.created_at,
    activeUntil: row.active_until,
    baselineStatus: isBanStatus(row.baseline_status) ? row.baseline_status : null,
    baselineCheckedAt: typeof row.baseline_checked_at === "string" ? row.baseline_checked_at : null,
    lastViewedAt: typeof row.last_viewed_at === "string" ? row.last_viewed_at : null,
  };
}

function normalizeEventRow(row: Record<string, unknown>): BanStatusEvent | null {
  if ((typeof row.id !== "number" && typeof row.id !== "string") || !isBanPlatform(row.platform)
    || !isBanAccountId(row.account_id) || !isBanStatus(row.observed_status)
    || typeof row.observed_at !== "string" || typeof row.observation_id !== "string") return null;
  return {
    id: row.id,
    platform: row.platform,
    accountId: row.account_id,
    previousStatus: row.previous_status === null || row.previous_status === undefined ? null : isBanStatus(row.previous_status) ? row.previous_status : "unknown",
    observedStatus: row.observed_status,
    rawType: normalizeBanRawType(row.raw_ban_type),
    observedAt: row.observed_at,
    observationId: row.observation_id,
  };
}

async function readStatusRows(db: BanWatchDb, ids: readonly string[]): Promise<BanStatusRow[]> {
  if (!ids.length) return [];
  const { data, error } = await db.from("pubg_ban_status").select("*").in("account_id", [...new Set(ids)]);
  if (error) throw new BanWatchError("store_failed", 503, "제재 상태를 불러오지 못했습니다.");
  return (Array.isArray(data) ? data : []).map((row) => normalizeStatusRow(row as Record<string, unknown>)).filter((row): row is BanStatusRow => row !== null);
}

export async function readPlayerBanStatus(platform: BanPlatform, accountId: string, db = getBanWatchAdminClient()): Promise<BanStatusRow | null> {
  if (!isBanPlatform(platform) || !isBanAccountId(accountId)) throw new BanWatchError("invalid_input", 400, "제재 대상 식별자가 올바르지 않습니다.");
  const { data, error } = await db.from("pubg_ban_status").select("*").eq("platform", platform).eq("account_id", accountId).maybeSingle();
  if (error) throw new BanWatchError("store_failed", 503, "제재 상태를 불러오지 못했습니다.");
  return data && typeof data === "object" ? normalizeStatusRow(data as Record<string, unknown>) : null;
}

export async function listBanWatchItems(userId: string, db = getBanWatchAdminClient()): Promise<BanWatchListResponse> {
  if (!userId) throw new BanWatchError("unauthenticated", 401);
  const { data: itemData, error: itemError } = await db.from("pubg_ban_watch_items").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(500);
  if (itemError) throw new BanWatchError("store_failed", 503, "제재 추적 목록을 불러오지 못했습니다.");
  const items = (Array.isArray(itemData) ? itemData : []).map((row) => normalizeWatchRow(row as Record<string, unknown>)).filter((row): row is BanWatchItem => row !== null);
  const keys = new Set(items.map((item) => `${item.platform}:${item.targetAccountId}`));
  const statuses = (await readStatusRows(db, items.map((item) => item.targetAccountId))).filter((status) => keys.has(`${status.platform}:${status.accountId}`));
  const statusByKey = new Map(statuses.map((status) => [`${status.platform}:${status.accountId}`, status]));
  const enrichedItems = items.map((item) => {
    const status = statusByKey.get(`${item.platform}:${item.targetAccountId}`);
    return status ? { ...item, currentStatus: status.status, currentRawType: status.rawType, currentCheckedAt: status.checkedAt || null, currentError: status.lastError } : item;
  });
  const eventRows = items.length ? await db.from("pubg_ban_status_events").select("*").in("account_id", [...new Set(items.map((item) => item.targetAccountId))]).order("observed_at", { ascending: false }).limit(1000) : { data: [], error: null };
  if (eventRows.error) throw new BanWatchError("store_failed", 503, "제재 상태 이력을 불러오지 못했습니다.");
  const events = (Array.isArray(eventRows.data) ? eventRows.data : []).map((row) => normalizeEventRow(row as Record<string, unknown>)).filter((row): row is BanStatusEvent => row !== null).filter((event) => keys.has(`${event.platform}:${event.accountId}`));
  return { items: enrichedItems, statuses, events };
}

async function readSingleWatchItem(db: BanWatchDb, userId: string, id: string): Promise<BanWatchItem | null> {
  const { data, error } = await db.from("pubg_ban_watch_items").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new BanWatchError("store_failed", 503, "제재 추적 항목을 불러오지 못했습니다.");
  return data && typeof data === "object" ? normalizeWatchRow(data as Record<string, unknown>) : null;
}

export async function scheduleBanStatusRefresh(platform: BanPlatform, accountId: string, db = getBanWatchAdminClient(), nextCheckAt?: string): Promise<boolean> {
  if (!isBanPlatform(platform) || !isBanAccountId(accountId)) throw new BanWatchError("invalid_input", 400, "제재 대상 식별자가 올바르지 않습니다.");
  const { data, error } = await db.rpc("schedule_pubg_ban_status", { p_platform: platform, p_account_id: accountId, p_next_check_at: nextCheckAt ?? new Date().toISOString() });
  if (error || data !== true) throw new BanWatchError("store_failed", 503, "제재 확인을 예약하지 못했습니다.");
  return true;
}

export type CreateWatchResult = { item: BanWatchItem; created: boolean; scheduled: boolean };
export async function createBanWatchItem(userId: string, rawInput: BanWatchCreateInput, db = getBanWatchAdminClient()): Promise<CreateWatchResult> {
  if (!userId) throw new BanWatchError("unauthenticated", 401);
  const input = parseBanWatchCreateInput(rawInput);
  const { data: statusData, error: statusError } = await db.from("pubg_ban_status").select("*").eq("platform", input.platform).eq("account_id", input.targetAccountId).maybeSingle();
  if (statusError) throw new BanWatchError("store_failed", 503, "제재 상태를 확인하지 못했습니다.");
  const baseline = statusData && typeof statusData === "object" ? normalizeStatusRow(statusData as Record<string, unknown>) : null;
  const { data, error } = await db.rpc("create_pubg_ban_watch_item", {
    p_user_id: userId, p_platform: input.platform, p_subject_account_id: input.subjectAccountId, p_target_account_id: input.targetAccountId,
    p_match_id: input.matchId, p_event_at: input.eventAt, p_role: input.role, p_nickname_at_match: input.nicknameAtMatch,
    p_map_name: input.mapName ?? null, p_weapon: input.weapon ?? null, p_note: input.note ?? null,
    p_baseline_status: baseline?.checkedAt ? baseline.status : null, p_baseline_checked_at: baseline?.checkedAt || null,
    p_active_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw new BanWatchError("store_failed", 503, "제재 추적 항목을 저장하지 못했습니다.");
  const value = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const code = typeof value?.code === "string" ? value.code : "";
  if (code === "user_target_limit") throw new BanWatchError("target_limit", 429, "활성 추적 대상은 50개까지 등록할 수 있습니다.");
  if (code === "target_match_limit") throw new BanWatchError("match_limit", 429, "한 대상의 경기 추적은 10개까지 등록할 수 있습니다.");
  if (code !== "created" && code !== "duplicate") throw new BanWatchError("store_failed", 503, "제재 추적 항목을 저장하지 못했습니다.");
  const id = typeof value?.id === "string" ? value.id : null;
  const item = id ? await readSingleWatchItem(db, userId, id) : null;
  if (!item) throw new BanWatchError("store_failed", 503, "저장된 제재 추적 항목을 확인하지 못했습니다.");
  const scheduled = !baseline?.checkedAt ? await scheduleBanStatusRefresh(input.platform, input.targetAccountId, db) : false;
  return { item, created: code === "created", scheduled };
}

export async function updateBanWatchItem(userId: string, rawInput: BanWatchUpdateInput, db = getBanWatchAdminClient()): Promise<BanWatchItem> {
  if (!userId) throw new BanWatchError("unauthenticated", 401);
  const input = parseBanWatchUpdateInput(rawInput);
  const current = await readSingleWatchItem(db, userId, input.id);
  if (!current) throw new BanWatchError("not_found", 404, "제재 추적 항목을 찾을 수 없습니다.");
  const patch: Record<string, unknown> = {};
  if (input.note !== undefined) patch.note = input.note;
  if (input.markViewed) patch.last_viewed_at = new Date().toISOString();
  if (input.extend) {
    const base = Math.max(Date.now(), Date.parse(current.activeUntil));
    const { data, error } = await db.rpc("extend_pubg_ban_watch_item", { p_user_id: userId, p_item_id: input.id, p_active_until: new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString() });
    if (error) throw new BanWatchError("store_failed", 503, "제재 추적 기간을 연장하지 못했습니다.");
    const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (result.code === "not_found") throw new BanWatchError("not_found", 404, "제재 추적 항목을 찾을 수 없습니다.");
    if (result.code === "user_target_limit") throw new BanWatchError("target_limit", 429, "활성 추적 대상은 50개까지 등록할 수 있습니다.");
    if (result.code !== "extended") throw new BanWatchError("store_failed", 503, "제재 추적 기간을 연장하지 못했습니다.");
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from("pubg_ban_watch_items").update(patch).eq("id", input.id).eq("user_id", userId);
    if (error) throw new BanWatchError("store_failed", 503, "제재 추적 항목을 수정하지 못했습니다.");
  }
  if (input.refresh) await scheduleBanStatusRefresh(current.platform, current.targetAccountId, db);
  return (await readSingleWatchItem(db, userId, input.id)) || current;
}

export async function deleteBanWatchItem(userId: string, id: string, db = getBanWatchAdminClient()): Promise<void> {
  if (!userId) throw new BanWatchError("unauthenticated", 401);
  if (!UUIDISH.test(id)) throw new BanWatchError("invalid_input", 400, "항목 식별자가 올바르지 않습니다.");
  const { data, error } = await db.from("pubg_ban_watch_items").delete().eq("id", id).eq("user_id", userId).select("id").maybeSingle();
  if (error) throw new BanWatchError("store_failed", 503, "제재 추적 항목을 삭제하지 못했습니다.");
  if (!data) throw new BanWatchError("not_found", 404, "제재 추적 항목을 찾을 수 없습니다.");
}

export type RecordBanObservationInput = { platform: BanPlatform; accountId: string; rawType: unknown; checkedAt?: string; nextCheckAt?: string; observationId?: string; leaseToken?: string | null };
export type RecordBanObservationResult = { code: "recorded" | "stale"; observationId?: string; observation: BanObservation };
export async function recordBanObservation(input: RecordBanObservationInput, db = getBanWatchAdminClient()): Promise<RecordBanObservationResult> {
  const observation = createBanObservation({ accountId: input.accountId, platform: input.platform, rawType: input.rawType, checkedAt: input.checkedAt });
  const nextCheckAt = input.nextCheckAt ?? nextBanCheckAt(observation.status, new Date(observation.checkedAt));
  if (!Number.isFinite(Date.parse(nextCheckAt))) throw new BanWatchError("invalid_input", 400, "제재 확인 예약 시각이 올바르지 않습니다.");
  const { data, error } = await db.rpc("record_pubg_ban_observation", {
    p_platform: observation.platform, p_account_id: observation.accountId, p_raw_ban_type: observation.rawType, p_normalized_status: observation.status,
    p_checked_at: observation.checkedAt, p_next_check_at: new Date(nextCheckAt).toISOString(), p_observation_id: input.observationId ?? null, p_lease_token: input.leaseToken ?? null,
  });
  if (error) throw new BanWatchError("store_failed", 503, "제재 상태를 저장하지 못했습니다.");
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const code = result.code;
  if (code !== "recorded" && code !== "stale") throw new BanWatchError("store_failed", 503, "제재 상태 저장 결과가 올바르지 않습니다.");
  return { code, observationId: typeof result.observation_id === "string" ? result.observation_id : undefined, observation };
}

export async function recordPlayerBanObservation(input: { platform: BanPlatform; accountId: string; banType: unknown; checkedAt?: string }, db = getBanWatchAdminClient()): Promise<RecordBanObservationResult> {
  return recordBanObservation({ platform: input.platform, accountId: input.accountId, rawType: input.banType, checkedAt: input.checkedAt }, db);
}

export type BanStatusLease = { platform: BanPlatform; accountId: string; leaseToken: string; leaseExpiresAt: string };
export async function claimDueBanStatusRows(db: BanWatchDb, limit = 10, now = new Date()): Promise<BanStatusLease[]> {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  const { data, error } = await db.rpc("claim_pubg_ban_status_batch", { p_limit: Math.min(Math.max(limit, 1), 10), p_lease_token: leaseToken, p_lease_expires_at: leaseExpiresAt });
  if (error) throw new BanWatchError("store_failed", 503, "제재 확인 대상을 예약하지 못했습니다.");
  return (Array.isArray(data) ? data : []).map((row) => {
    const value = row as Record<string, unknown>;
    if (!isBanPlatform(value.platform) || !isBanAccountId(value.account_id)) return null;
    return { platform: value.platform, accountId: value.account_id, leaseToken: typeof value.lease_token === "string" ? value.lease_token : leaseToken, leaseExpiresAt: typeof value.lease_expires_at === "string" ? value.lease_expires_at : leaseExpiresAt };
  }).filter((value): value is BanStatusLease => value !== null);
}

export async function recordBanStatusError(lease: BanStatusLease, errorCode: string, nextCheckAt: string, db: BanWatchDb): Promise<boolean> {
  const { data, error } = await db.rpc("record_pubg_ban_error", { p_platform: lease.platform, p_account_id: lease.accountId, p_error: errorCode.slice(0, 200), p_next_check_at: nextCheckAt, p_lease_token: lease.leaseToken });
  return !error && data === true;
}

export function formatBanObservationForLog(observation: BanObservation): Record<string, string> {
  return { platform: observation.platform, accountId: observation.accountId, status: observation.status, checkedAt: observation.checkedAt };
}

export type { BanObservation, BanPlatform, BanStatus, BanStatusEvent, BanStatusRow, BanWatchItem, BanWatchRole };
