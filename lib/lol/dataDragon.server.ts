import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";

const DEFAULT_VERSION = "16.21.1";
const TTL_MS = 6 * 60 * 60_000;
const MAX_BYTES = 64 * 1024;
type Version = { version: string; fetched_at: string };
let lastSuccess: Version | undefined;
let retryAt = 0;
let inflight: Promise<string> | undefined;
const valid = (value: unknown): value is string => typeof value === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);

export async function getLolDataDragonVersion(): Promise<string> {
  if (Date.now() < retryAt) return lastSuccess?.version ?? DEFAULT_VERSION;
  if (inflight) return inflight;
  const request = (async () => {
    if (!lastSuccess && process.env.LOL_PERSISTENCE_ENABLED === "true") {
      try {
        const { data, error } = await createServiceRoleSupabase().from("lol_data_dragon_versions")
          .select("version,fetched_at").eq("singleton", true).abortSignal(AbortSignal.timeout(1000)).maybeSingle();
        if (error) throw error;
        if (data && valid(data.version) && Number.isFinite(Date.parse(data.fetched_at))) lastSuccess = data;
      } catch { console.warn("[lol-ddragon] cache_failed", { reasonCode: "db_read_failed" }); }
    }
    if (lastSuccess && Date.parse(lastSuccess.fetched_at) + TTL_MS > Date.now()) {
      retryAt = Date.parse(lastSuccess.fetched_at) + TTL_MS;
      return lastSuccess.version;
    }
    try {
      const response = await fetch("https://ddragon.leagueoflegends.com/api/versions.json", {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000),
      });
      if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) {
        await response.body?.cancel();
        throw new Error("invalid_versions_response");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_BYTES) throw new Error("versions_too_large");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const versions: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(versions) || !valid(versions[0])) throw new Error("invalid_latest_version");
      lastSuccess = { version: versions[0], fetched_at: new Date().toISOString() };
      retryAt = Date.now() + TTL_MS;
      if (process.env.LOL_PERSISTENCE_ENABLED === "true") {
        try {
          const { error } = await createServiceRoleSupabase().from("lol_data_dragon_versions")
            .upsert({ singleton: true, ...lastSuccess }).abortSignal(AbortSignal.timeout(1000));
          if (error) throw error;
        } catch { console.warn("[lol-ddragon] cache_failed", { reasonCode: "db_write_failed" }); }
      }
    } catch {
      retryAt = Date.now() + 60_000;
      console.warn("[lol-ddragon] fallback", { reasonCode: "versions_unavailable" });
    }
    return lastSuccess?.version ?? DEFAULT_VERSION;
  })();
  inflight = request;
  try { return await request; } finally { if (inflight === request) inflight = undefined; }
}
