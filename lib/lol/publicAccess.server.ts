import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { extractClientIp } from "@/lib/board/ipUtils";
import { isSameOriginLolRequest } from "./http.server";

const buckets = new Map<string, { count: number; expiresAt: number }>();
const salt = randomBytes(32);
const limits = { search: 10, read: 30 };

export function requireLolPublicPage(): void {
  if (process.env.LOL_PUBLIC_ENABLED !== "true") notFound();
}

export function guardLolPublicRequest(request: Request, kind: keyof typeof limits, sameOrigin = true): NextResponse | null {
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
  const ip = createHmac("sha256", salt).update(extractClientIp(request)).digest("hex");
  const key = `${kind}:${ip}`;
  let bucket = buckets.get(key);
  // shortcut: 인스턴스별 메모리 제한이므로 다중 인스턴스 공개 운영 때 공유 저장소로 전환한다.
  if (!bucket) {
    if (buckets.size >= 10_000) return fail("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, 60);
    bucket = { count: 0, expiresAt: now + 60_000 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limits[kind]) return fail("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)));
  bucket.count += 1;
  return null;
}
