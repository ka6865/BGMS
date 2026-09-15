import { NextResponse } from "next/server";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { DeathEncounterSourceError, loadDeathEncounters } from "@/lib/pubg/deathEncounters.server";
import {
  BanWatchError,
  acquireEncounterRequest,
  createBanWatchItem,
  deleteBanWatchItem,
  getBanWatchAdminClient,
  listBanWatchItems,
  parseBanWatchCreateInput,
  parseBanWatchUpdateInput,
  requireBanWatchUserId,
  updateBanWatchItem,
} from "@/lib/pubg/banWatch.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 45;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof DeathEncounterSourceError) {
    return NextResponse.json({ error: error.message, code: error.code, source: error.source }, {
      status: error.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (error instanceof BanWatchError) {
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (error.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(error.retryAfterSeconds);
      headers["X-RateLimit-Reset"] = String(Math.ceil(Date.now() / 1000 + error.retryAfterSeconds));
    }
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
  }
  return NextResponse.json({ error: "제재 추적 요청을 처리하지 못했습니다.", code: "store_failed" }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BanWatchError("invalid_input", 400, "요청 본문이 올바르지 않습니다.");
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const userId = await requireBanWatchUserId();
    return NextResponse.json(await listBanWatchItems(userId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let release: (() => void) | null = null;
  try {
    const userId = await requireBanWatchUserId();
    const raw = await jsonBody(request);
    const input = parseBanWatchCreateInput(raw);
    const quota = acquireEncounterRequest(userId);
    if (!quota.allowed) {
      const code = quota.reason === "busy" ? "encounter_busy" : "rate_limited";
      throw new BanWatchError(code, 429, "경기 상대 조회가 너무 잦습니다.", quota.retryAfterSeconds);
    }
    release = quota.release;
    // Re-load the original telemetry and use only its server-verified account
    // relationship. Client supplied nickname/map/weapon fields are ignored.
    const db = getBanWatchAdminClient();
    // This service-only cache contains the same verified original relationship.
    // Retaining it lets users register older saved encounters without fetching expired assets.
    let stored: Awaited<ReturnType<typeof loadDeathEncounters>> | null = null;
    {
      const cached = await db.from("pubg_encounter_cache").select("result").eq("platform",input.platform).eq("subject_account_id",input.subjectAccountId).eq("match_id",input.matchId).eq("extractor_version",2).maybeSingle();
      const candidate = cached.data?.result;
      if (!cached.error && candidate?.source?.platform === input.platform && candidate.source.matchId === input.matchId && candidate.source.verifiedSubjectAccountId === input.subjectAccountId && Array.isArray(candidate.encounters)) stored = candidate;
    }
    const verified = stored || await loadDeathEncounters({
      platform: input.platform,
      matchId: input.matchId,
      subjectAccountId: input.subjectAccountId,
      nickname: input.subjectNicknameAtMatch || undefined,
    });
    const verifiedSubjectNickname = verified.source.verifiedSubjectNicknameAtMatch?.trim() || null;
    if (!verifiedSubjectNickname) {
      throw new BanWatchError("encounter_source_unavailable", 503, "검증된 경기 참가자 닉네임을 확인할 수 없습니다.");
    }
    if (input.subjectNicknameAtMatch && input.subjectNicknameAtMatch.trim() !== verifiedSubjectNickname) {
      throw new BanWatchError("invalid_input", 400, "경기 참가자 계정과 닉네임이 일치하지 않습니다.");
    }
    if (await isPlayerPrivate(input.platform, verifiedSubjectNickname, input.subjectAccountId)) {
      return NextResponse.json({ error: "비공개 플레이어는 추적할 수 없습니다.", code: "private_player" }, { status: 403 });
    }
    const encounter = verified.encounters.find((candidate) =>
      candidate.targetAccountId === input.targetAccountId
      && candidate.role === input.role
      && candidate.eventAt === input.eventAt
    );
    if (!encounter) throw new BanWatchError("encounter_source_unavailable", 404, "검증된 사망 상대를 찾을 수 없습니다.");
    if (await isPlayerPrivate(input.platform, encounter.nicknameAtMatch, encounter.targetAccountId)) {
      return NextResponse.json({ error: "비공개 플레이어는 추적할 수 없습니다.", code: "private_player" }, { status: 403 });
    }
    const canonical = {
      ...input,
      nicknameAtMatch: encounter.nicknameAtMatch,
      weapon: encounter.weapon,
      mapName: null,
    };
    const result = await createBanWatchItem(userId, canonical, db);
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    release?.();
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const userId = await requireBanWatchUserId();
    const input = parseBanWatchUpdateInput(await jsonBody(request));
    const item = await updateBanWatchItem(userId, input, getBanWatchAdminClient());
    return NextResponse.json({ item }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const userId = await requireBanWatchUserId();
    const id = new URL(request.url).searchParams.get("id") || "";
    await deleteBanWatchItem(userId, id, getBanWatchAdminClient());
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
