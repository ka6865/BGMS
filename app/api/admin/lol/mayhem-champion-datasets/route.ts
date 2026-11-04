import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { getChampionDatasetAdmin, getChampionDatasetReadiness, reviewChampionDataset, MAYHEM_CHAMPION_DATASET_TAG } from "@/lib/lol/mayhemChampionDatasetStore.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const readyToReview = (readiness: Awaited<ReturnType<typeof getChampionDatasetReadiness>>) => readiness.apiKeyConfigured && readiness.reuseConfirmed && readiness.enabled && readiness.persistenceEnabled;

export async function GET() {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  try {
    const readiness = await getChampionDatasetReadiness();
    if (!readiness.apiKeyConfigured) return reply({ releases: [], publications: [], sync: [], readiness, databaseAvailable: false });
    if (!readiness.persistenceEnabled) return reply({ releases: [], publications: [], sync: [], readiness, databaseAvailable: false });
    const data = await getChampionDatasetAdmin();
    return reply({ ...data, readiness, databaseAvailable: true });
  } catch {
    return reply({ releases: [], publications: [], sync: [], readiness: await getChampionDatasetReadiness(), databaseAvailable: false });
  }
}

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return reply({ error: "요청 출처를 확인해 주세요." }, 403);
  let body: Record<string, unknown>;
  try {
    if (Number(request.headers.get("content-length")) > 4096) return reply({ error: "요청이 너무 큽니다." }, 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096) return reply({ error: "요청이 너무 큽니다." }, 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_body");
    body = parsed as Record<string, unknown>;
  } catch { return reply({ error: "요청을 확인해 주세요." }, 400); }
  if (body.confirm !== true || !access.userId) return reply({ error: "검토 확인이 필요합니다." }, 400);
  if (!(body.action === "approve" || body.action === "reject" || body.action === "publish" || body.action === "rollback")
    || !validId(body.id) || !(body.expectedPublication === null || validId(body.expectedPublication))) return reply({ error: "검토한 버전과 현재 공개본을 확인해 주세요." }, 400);
  const reason = typeof body.reason === "string" ? body.reason.trim() : null;
  if (body.action === "reject" && (!reason || reason.length < 10 || reason.length > 2048)) return reply({ error: "후보 제외 사유를 10~2048자로 남겨 주세요." }, 400);
  try {
    const readiness = await getChampionDatasetReadiness();
    if (!readiness.persistenceEnabled || ((body.action === "approve" || body.action === "publish") && !readyToReview(readiness))) return reply({ error: "데이터 사용 조건과 저장 준비 상태를 확인해 주세요." }, 503);
    await reviewChampionDataset({ id: body.id, action: body.action, expectedPublication: body.expectedPublication, reviewedBy: access.userId, reason });
    if (body.action === "publish" || body.action === "rollback") revalidateTag(MAYHEM_CHAMPION_DATASET_TAG, "max");
    return reply({ ok: true });
  } catch (error) {
    if (error instanceof Error && /409|conflict|publication_changed/i.test(error.message)) return reply({ error: "공개 상태가 바뀌었습니다. 최신 내용을 다시 불러와 주세요." }, 409);
    return reply({ error: "검토 또는 공개를 처리하지 못했습니다. 기존 공개본은 유지됩니다." }, 503);
  }
}
