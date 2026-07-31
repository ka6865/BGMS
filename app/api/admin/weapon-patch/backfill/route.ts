/**
 * @fileoverview 과거 패치노트에 대한 무기도감 갱신 제안을 소급 생성하는 관리자 API 입니다.
 *
 * 이 라우트는 제안 테이블에만 기록합니다. 서비스 테이블 반영은 기존과 동일하게
 * 관리자가 검토 화면에서 승인한 뒤 apply_weapon_patch_proposal RPC 가 수행합니다.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import {
  backfillWeaponPatchProposals,
  DEFAULT_BACKFILL_LIMIT,
} from "@/lib/patch-notes/weaponProposalBackfill";

/** 원문 수집과 AI 호출이 순차로 일어나므로 기본 타임아웃보다 길게 잡습니다. */
export const maxDuration = 300;

/** 한 번의 요청에서 허용할 최대 처리 건수. AI 호출 비용 폭주를 막습니다. */
const MAX_LIMIT = 10;

function parseLimit(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_BACKFILL_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return null;
  return parsed;
}

function parsePostIds(value: unknown): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const ids: number[] = [];
  for (const raw of value) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    ids.push(parsed);
  }
  return ids;
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // 본문 없이 호출하면 기본값으로 동작한다.
  }

  const limit = parseLimit(body.limit);
  if (limit === null) {
    return NextResponse.json(
      { error: `limit 은 1 이상 ${MAX_LIMIT} 이하의 정수여야 합니다.` },
      { status: 400 }
    );
  }

  const postIds = parsePostIds(body.postIds);
  if (postIds === null) {
    return NextResponse.json(
      { error: "postIds 는 양의 정수 배열이어야 합니다." },
      { status: 400 }
    );
  }

  const dryRun = body.dryRun === true;

  try {
    const summary = await backfillWeaponPatchProposals({
      supabaseAdmin: admin.supabaseAdmin,
      limit,
      postIds,
      dryRun,
    });
    return NextResponse.json({ success: true, dryRun, summary });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "백필 실행에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
