import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { acquireLolCollectionLease, releaseLolCollectionLease } from "./persistence.server";
import { requestJson } from "./riotSearch.server";
import { parseLolPlatformStatus, type LolPlatformStatus, type LolStatusItem } from "./status";

const TTL = 5 * 60_000;
type StoredStatus = { payload: { items?: LolStatusItem[] }; fetchedAt: string; nextRefreshAt: string };
const unavailable: LolPlatformStatus = { items: [], fetchedAt: null, stale: true, available: false };
let memory: { value: LolPlatformStatus; expiresAt: number } | undefined;
let inflight: Promise<LolPlatformStatus> | undefined;

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createServiceRoleSupabase().rpc(name, args).abortSignal(AbortSignal.timeout(2500));
  if (error) throw new Error("상태 캐시 요청 실패");
  return data as T;
}
function storedValue(row: StoredStatus | null): LolPlatformStatus {
  return row && Array.isArray(row.payload?.items)
    ? { items: row.payload.items, fetchedAt: row.fetchedAt, stale: Date.now() - Date.parse(row.fetchedAt) >= TTL, available: true }
    : unavailable;
}
async function load(): Promise<{ value: LolPlatformStatus; expiresAt: number }> {
  let previous = memory?.value ?? unavailable;
  let lease: Awaited<ReturnType<typeof acquireLolCollectionLease>> = null;
  let expiresAt = Date.now() + TTL;
  try {
    const cached = await rpc<StoredStatus | null>("get_lol_platform_status");
    previous = storedValue(cached);
    if (cached && Date.parse(cached.nextRefreshAt) > Date.now()) {
      expiresAt = Date.parse(cached.nextRefreshAt);
      return { value: previous, expiresAt };
    }
    lease = await acquireLolCollectionLease("status:kr", 30);
    if (!lease) { expiresAt = Date.now() + 5000; return { value: previous, expiresAt }; }
    // lease 취득 전에 다른 인스턴스가 갱신했을 수 있으므로 다시 읽는다.
    const latest = await rpc<StoredStatus | null>("get_lol_platform_status");
    previous = storedValue(latest);
    if (latest && Date.parse(latest.nextRefreshAt) > Date.now()) {
      expiresAt = Date.parse(latest.nextRefreshAt);
      return { value: previous, expiresAt };
    }
    await rpc("defer_lol_platform_status");
    const items = parseLolPlatformStatus(await requestJson("kr", "/lol/status/v4/platform-data", 0, true));
    await rpc("save_lol_platform_status", { p_payload: { items } });
    return { value: { items, fetchedAt: new Date().toISOString(), stale: false, available: true }, expiresAt };
  } catch {
    return { value: { ...previous, stale: true }, expiresAt };
  } finally {
    if (lease) { try { await releaseLolCollectionLease(lease); } catch { /* 만료된 lease는 자동 회수한다. */ } }
  }
}

export async function getLolPlatformStatus(): Promise<LolPlatformStatus> {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return unavailable;
  if (memory && memory.expiresAt > Date.now()) return memory.value;
  if (!inflight) inflight = load().then(cached => {
    memory = cached;
    return cached.value;
  }).finally(() => { inflight = undefined; });
  return inflight;
}
