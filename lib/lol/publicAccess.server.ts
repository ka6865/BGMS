import "server-only";
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { extractClientIp } from "@/lib/board/ipUtils";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { isSameOriginLolRequest } from "./http.server";

const buckets = new Map<string, { count: number; expiresAt: number }>();
const salt = randomBytes(32);
const limits = { search: 10, read: 30 };

export function requireLolPublicPage(): void {
  if (process.env.LOL_PUBLIC_ENABLED !== "true") notFound();
}

export async function guardLolPublicRequest(request: Request, kind: keyof typeof limits, sameOrigin = true): Promise<NextResponse | null> {
  const fail = (error: string, status: number, retryAfter?: number) => NextResponse.json({ error }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow",
      ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
  });
  if (process.env.LOL_PUBLIC_ENABLED !== "true") return fail("요청한 페이지를 찾을 수 없습니다.", 404);
  if (sameOrigin) {
    const headers = new Headers(request.headers);
    // 브라우저의 같은 출처 GET은 Origin을 생략하므로 Fetch Metadata를 함께 확인한다.
    if (request.method === "GET" && !headers.has("origin") && headers.get("sec-fetch-site") === "same-origin") {
      headers.set("origin", new URL(request.url).origin);
    }
    if (!isSameOriginLolRequest(new Request(request.url, { headers }))) return fail("요청 출처를 확인할 수 없습니다.", 403);
  }
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key);
  const secret = process.env.LOL_PARTICIPANT_REF_SECRET?.trim();
  const hmacKey = secret ? Buffer.from(hkdfSync("sha256", secret, "bgms-lol", "public-rate-limit:v1", 32)) : salt;
  const ip = createHmac("sha256", hmacKey).update(extractClientIp(request)).digest("hex");
  const key = `${kind}:${ip}`;
  let reasonCode = "missing_participant_ref_secret";
  if (secret) {
    const signal = AbortSignal.timeout(1000);
    try {
      const { data, error } = await createServiceRoleSupabase().rpc("consume_lol_public_rate_limit", {
        p_key: key, p_limit: limits[kind], p_window_seconds: 60,
      }).abortSignal(signal);
      if (error) throw error;
      if (!data || typeof data.allowed !== "boolean" || !Number.isSafeInteger(data.retry_after) || data.retry_after < 0) {
        throw new Error("invalid_rate_limit_result");
      }
      if (!data.allowed) return fail("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, Math.max(1, data.retry_after));
      // DB 장애 직전 요청도 메모리 제한에 반영한다.
      let recent = buckets.get(key);
      if (!recent && buckets.size < 10_000) {
        recent = { count: 0, expiresAt: now + 60_000 };
        buckets.set(key, recent);
      }
      if (recent) recent.count += 1;
      return null;
    } catch { reasonCode = signal.aborted ? "db_timeout" : "db_error"; }
  }
  console.warn("[lol-public] rate_limit_fallback", { reasonCode });
  let bucket = buckets.get(key);
  // shortcut: DB 장애 중에는 인스턴스별 제한이며, 장기 장애 시 공개 기능을 닫는다.
  if (!bucket) {
    if (buckets.size >= 10_000) return fail("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, 60);
    bucket = { count: 0, expiresAt: now + 60_000 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limits[kind]) return fail("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)));
  bucket.count += 1;
  return null;
}
