import { NextResponse } from "next/server";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { DeathEncounterSourceError, loadDeathEncounters } from "@/lib/pubg/deathEncounters.server";
import {
  BanWatchError,
  acquireEncounterRequest,
  parseBanWatchEncounterRequest,
  requireBanWatchUserId,
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
  return NextResponse.json({ error: "경기 사망 정보를 불러오지 못했습니다.", code: "encounter_source_unavailable" }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let release: (() => void) | null = null;
  try {
    const userId = await requireBanWatchUserId();
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new BanWatchError("invalid_input", 400, "요청 본문이 올바르지 않습니다.");
    }
    const input = parseBanWatchEncounterRequest(raw);
    const quota = acquireEncounterRequest(userId);
    if (!quota.allowed) {
      const code = quota.reason === "busy" ? "encounter_busy" : "rate_limited";
      throw new BanWatchError(code, 429, "경기 상대 조회가 너무 잦습니다.", quota.retryAfterSeconds);
    }
    release = quota.release;
    const result = await loadDeathEncounters(input);
    const verifiedNickname = result.source.verifiedSubjectNicknameAtMatch?.trim();
    if (!verifiedNickname) {
      throw new BanWatchError("encounter_source_unavailable", 503, "검증된 경기 참가자 닉네임을 확인할 수 없습니다.");
    }
    if (await isPlayerPrivate(input.platform, verifiedNickname, input.subjectAccountId)) {
      return NextResponse.json({ error: "비공개 플레이어는 추적할 수 없습니다.", code: "private_player" }, { status: 403 });
    }
    const visible = await Promise.all(result.encounters.map(async (encounter) =>
      await isPlayerPrivate(input.platform, encounter.nicknameAtMatch, encounter.targetAccountId) ? null : encounter));
    return NextResponse.json({ ...result, encounters: visible.filter((encounter) => encounter !== null) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  } finally {
    release?.();
  }
}
