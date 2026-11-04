import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { createSourceDownloader } from "./augments/ingest";
import { createChampionSource } from "./mayhemChampionSource";
import { parseChampionTierSource } from "./mayhemChampionTiers";
import { fetchChampionTierSnapshot, fetchItemRatingSnapshot, fetchRankingIndex, fetchRankingSnapshot } from "./mayhemReferenceSource.server";
import { referencePersistenceEnabled, saveReferenceSnapshot } from "./mayhemReferenceStore.server";
import { type ReferenceKind, REFERENCE_MAX_BYTES } from "./mayhemReference";

const LEASE = "ops:lol-mayhem-reference";
const JOB = "mayhem-reference";
const signal = () => AbortSignal.timeout(10_000);
const safeCode = (error: unknown) => error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "reference_sync_failed";
export type ReferenceSyncSummary = { dryRun: boolean; status: "validated" | "awaiting_review" | "partial"; snapshots: number; skipped: number; failures: number; quotaDeferred: boolean; lastErrorCode: string | null };

async function withLease<T>(apply: boolean, run: (token: string, renew: () => Promise<void>) => Promise<T>): Promise<T> {
  const db = createServiceRoleSupabase();
  let token = "", lastRenew = 0;
  const started = Date.now();
  try {
    if (apply) {
      const lease = await db.rpc("acquire_lol_collection_lease", { p_key: LEASE, p_ttl_seconds: 120 }).abortSignal(signal());
      token = lease.data?.[0]?.lease_token ?? "";
      if (lease.error || !token) throw new Error("reference_lease_busy");
      const usage = await db.rpc("get_lol_mayhem_reference_storage_bytes").abortSignal(signal());
      if (usage.error || !Number.isSafeInteger(Number(usage.data)) || Number(usage.data) < 0 || Number(usage.data) + 64 * 1024 * 1024 > 2 * 1024 ** 3) throw new Error("reference_storage_budget");
    }
    const renew = async () => {
      if (Date.now() - started > 540_000) throw new Error("reference_sync_deadline");
      if (apply && Date.now() - lastRenew > 30_000) {
        const result = await db.rpc("renew_lol_mayhem_reference_lease", { p_token: token }).abortSignal(signal());
        if (result.error) throw new Error("reference_lease_expired");
        lastRenew = Date.now();
      }
    };
    return await run(token, renew);
  } finally {
    if (token) {
      try {
        const result = await db.rpc("release_lol_collection_lease", { p_key: LEASE, p_token: token }).abortSignal(signal());
        if (result.error) console.warn("[lol-mayhem-reference] reference_lease_release_failed");
      } catch { console.warn("[lol-mayhem-reference] reference_lease_release_failed"); }
    }
  }
}

const tierRights = () => ({ attribution: process.env.LOL_MAYHEM_STATS_ATTRIBUTION?.trim() ?? "", rightsBasis: process.env.LOL_MAYHEM_STATS_REUSE_BASIS?.trim() ?? "" });

// 기존 챔피언 수집에서 이미 결제한 목록 응답을 함께 보존한다.
export async function captureChampionTierList(list: { body: string; value: unknown }) {
  if (!referencePersistenceEnabled()) return;
  const normalized = parseChampionTierSource(list.value);
  await withLease(true, async (token, renew) => {
    await renew();
    return saveReferenceSnapshot({ kind: "champion_tiers", raw: list.body, normalized, upstreamVersion: normalized.dataVersion, ...tierRights(), leaseToken: token });
  });
}

async function registeredChampions(): Promise<number[]> {
  const download = createSourceDownloader((url, init) => fetch(url, { ...init, cache: "no-store", redirect: "error", signal: signal() }));
  const versions: unknown = JSON.parse(await download("https://ddragon.leagueoflegends.com/api/versions.json", true, 128 * 1024));
  if (!Array.isArray(versions) || !versions.length || versions.length > 1000 || typeof versions[0] !== "string" || !/^\d+\.\d+\.\d+$/.test(versions[0])) throw new Error("reference_champions_invalid");
  const value = JSON.parse(await download(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/champion.json`, true, REFERENCE_MAX_BYTES));
  if (!value?.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error("reference_champions_invalid");
  const ids = Object.values(value.data as Record<string, { key?: unknown }>).map(row => typeof row?.key === "string" && /^[1-9][0-9]{0,4}$/.test(row.key) ? Number(row.key) : NaN);
  if (!ids.length || ids.length > 300 || ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) throw new Error("reference_champions_invalid");
  return ids.sort((a, b) => a - b);
}

export async function ingestMayhemReferences(options: { apply: boolean; kinds?: ReferenceKind[] }): Promise<ReferenceSyncSummary> {
  if (options.apply && !referencePersistenceEnabled()) throw new Error("reference_sync_disabled");
  const kinds = options.kinds ?? ["champion_tiers", "item_ratings", "augment_rankings"];
  if (!kinds.length || new Set(kinds).size !== kinds.length || kinds.some(kind => !["champion_tiers", "item_ratings", "augment_rankings"].includes(kind))) throw new Error("reference_kind_invalid");
  const summary: ReferenceSyncSummary = { dryRun: !options.apply, status: options.apply ? "awaiting_review" : "validated", snapshots: 0, skipped: 0, failures: 0, quotaDeferred: false, lastErrorCode: null };
  const db = createServiceRoleSupabase();
  let lastError: string | null = null, batchBytes = 0;
  return withLease(options.apply, async (token, renew) => {
    let previousFailures = 0;
    if (options.apply) {
      const previous = await db.from("lol_data_sync_status").select("consecutive_failures").eq("job_key", JOB).abortSignal(signal()).maybeSingle();
      if (previous.error) throw new Error("reference_status_error");
      previousFailures = previous.data?.consecutive_failures ?? 0;
    }
    async function store<K extends ReferenceKind>(kind: K, snapshot: { raw: string; normalized: import("./mayhemReference").ReferencePayloads[K] }, upstreamVersion: string, rights: { attribution: string; rightsBasis: string }, championId = 0) {
      batchBytes += Buffer.byteLength(snapshot.raw) + Buffer.byteLength(JSON.stringify(snapshot.normalized));
      if (batchBytes > 64 * 1024 * 1024) throw new Error("reference_batch_too_large");
      await renew();
      if (options.apply) await saveReferenceSnapshot({ kind, ...snapshot, upstreamVersion, ...rights, championId, leaseToken: token });
      summary.snapshots++;
    }
    async function attempt(run: () => Promise<void>) {
      try { await renew(); await run(); }
      catch (error) {
        const code = safeCode(error);
        if (code === "reference_sync_deadline" || code === "reference_lease_expired" || code === "reference_batch_too_large") throw error;
        if (code === "stats_quota_deferred") summary.quotaDeferred = true;
        else { summary.failures++; lastError = code; }
      }
    }
    try {
      if (kinds.includes("champion_tiers")) await attempt(async () => {
        const rights = tierRights();
        if (!process.env.LOL_MAYHEM_STATS_API_KEY) throw new Error("stats_api_key_missing");
        if (!rights.attribution || rights.rightsBasis.length < 10) throw new Error("stats_collection_basis_missing");
        const version = await createChampionSource().config();
        if (options.apply) {
          const prior = await db.from("lol_mayhem_reference_releases").select("id").eq("kind", "champion_tiers")
            .eq("client_patch", version.gamePatch).eq("upstream_version", version.dataVersion).limit(1).abortSignal(signal());
          if (prior.error) throw new Error("reference_database_error");
          if (prior.data?.length) { summary.skipped++; return; }
        }
        const snapshot = await fetchChampionTierSnapshot({ beforeRequest: renew });
        await store("champion_tiers", snapshot, snapshot.normalized.dataVersion, rights);
      });
      if (kinds.includes("augment_rankings")) {
        await attempt(async () => {
          const patches = await fetchRankingIndex();
          for (const patch of patches) await attempt(async () => {
            const snapshot = await fetchRankingSnapshot(patch);
            const releaseId = (JSON.parse(snapshot.raw) as { meta?: { releaseId?: unknown } }).meta?.releaseId;
            if (typeof releaseId !== "string" || !releaseId.trim() || releaseId.length > 128) throw new Error("reference_version_invalid");
            await store("augment_rankings", snapshot, releaseId, { attribution: "데이터 출처: arammayhem.com — https://arammayhem.com/data/", rightsBasis: "CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ — 출처 링크를 표시하여 재사용" });
          });
        });
      }
      if (kinds.includes("item_ratings")) await attempt(async () => {
        const ids = await registeredChampions();
        for (const championId of ids) await attempt(async () => {
          const snapshot = await fetchItemRatingSnapshot(championId);
          if (!snapshot) { summary.skipped++; return; }
          await store("item_ratings", snapshot, `${snapshot.normalized.patch}:${snapshot.normalized.date}`, {
            attribution: "IESDEV ARAM: Mayhem item ratings; Riot Games Data Dragon",
            rightsBasis: "공개 증바람 전용 API의 아이템 등급과 공식 게임 메타데이터 보존. 공개 전 관리자 출처·사용 조건 검토.",
          }, championId);
        });
      });
    } catch (error) { summary.failures++; lastError = safeCode(error); }
    if (summary.failures || summary.quotaDeferred) summary.status = "partial";
    summary.lastErrorCode = lastError ?? (summary.quotaDeferred ? "stats_quota_deferred" : null);
    if (options.apply) {
      const result = await db.from("lol_data_sync_status").upsert({ job_key: JOB, last_checked_at: new Date().toISOString(),
        ...(summary.snapshots > 0 ? { last_fetch_succeeded_at: new Date().toISOString() } : {}),
        ...(summary.status !== "partial" ? { last_success_at: new Date().toISOString() } : {}),
        last_error_code: summary.lastErrorCode, consecutive_failures: summary.failures ? previousFailures + 1 : 0, counts: summary,
      }).abortSignal(signal());
      if (result.error) throw new Error("reference_status_error");
    }
    return summary;
  });
}
