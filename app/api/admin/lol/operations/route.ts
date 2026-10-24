import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { cleanupLolExpiredBatch, getLolOpsStatus, previewLolExpiredData } from "@/lib/lol/ops.server";
import { deleteLolAccountData } from "@/lib/lol/persistence.server";
import { clearLolPersonalCaches, resolveLolAccountForDeletion, RiotSearchError } from "@/lib/lol/riotSearch.server";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET() {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  try { return response(await getLolOpsStatus()); }
  catch { return response({ error: "LoL 운영 저장소를 사용할 수 없습니다." }, 503); }
}

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return response({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return response({ error: "LoL 영속 저장이 비활성화되어 있습니다." }, 503);
  if (Number(request.headers.get("content-length")) > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
  let body: { action?: unknown; confirm?: unknown; limit?: unknown; riotId?: unknown };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
  } catch { return response({ error: "정리 요청을 확인해 주세요." }, 400); }
  if (body.action === "account-preview" || body.action === "account-delete") {
    if (typeof body.riotId !== "string" || body.riotId.length > 81 || /[\u0000-\u001f\u007f]/.test(body.riotId)) {
      return response({ error: "Riot ID를 확인해 주세요." }, 400);
    }
    const parts = body.riotId.trim().split("#");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim() || parts[0].trim().length > 64 || parts[1].trim().length > 16) {
      return response({ error: "Riot ID를 확인해 주세요." }, 400);
    }
    if (body.action === "account-delete" && body.confirm !== true) return response({ error: "계정 삭제 확인이 필요합니다." }, 400);
    try {
      const account = await resolveLolAccountForDeletion(`${parts[0].trim()}#${parts[1].trim()}`);
      if (!account) return response({ error: "Riot 계정을 찾을 수 없습니다." }, 404);
      if (body.action === "account-preview") return response({ riotId: `${account.gameName}#${account.tagLine}` });
      const deleted = await deleteLolAccountData(account.puuid);
      clearLolPersonalCaches();
      return response(deleted);
    } catch (error) {
      if (error instanceof RiotSearchError && error.kind === "not_found") return response({ error: "Riot 계정을 찾을 수 없습니다." }, 404);
      return response({ error: "계정 데이터 삭제 요청을 처리하지 못했습니다." }, 503);
    }
  }
  if (body.action !== "preview" && body.action !== "cleanup") return response({ error: "정리 작업을 확인해 주세요." }, 400);
  if (body.action === "cleanup" && body.confirm !== true) return response({ error: "정리 실행 확인이 필요합니다." }, 400);
  const limit = body.limit ?? 100;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return response({ error: "배치 크기는 1~1000 사이 정수여야 합니다." }, 400);
  }
  try {
    return response(body.action === "preview" ? await previewLolExpiredData() : await cleanupLolExpiredBatch(limit));
  } catch { return response({ error: "LoL 운영 저장소를 사용할 수 없습니다." }, 503); }
}
