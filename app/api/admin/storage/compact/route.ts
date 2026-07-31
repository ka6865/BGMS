import { NextResponse } from "next/server";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";
import { RECLAIM_TARGETS, type ReclaimTarget } from "@/lib/admin-agent/storage-health";

/**
 * @fileoverview 저장 용량 정리 API (관리자 전용)
 *
 * 기존 /api/admin/system 은 요청이 오면 곧바로 삭제합니다. 이 경로는 되돌릴 수
 * 없는 작업 앞에 dry-run 관문을 둡니다.
 *
 *   1. apply 없이 호출  -> 삭제 대상 건수만 계산하고 아무것도 지우지 않는다
 *   2. apply: true      -> 그때만 실제로 삭제한다
 *
 * 삭제는 RPC 안에서 배치로 수행되므로 한 번 호출이 테이블 전체를 잠그지 않습니다.
 * 남은 대상이 있으면 응답의 hasRemaining 이 true 이고, 다시 호출하면 이어서
 * 정리합니다.
 */

// 한 번 요청에서 처리할 배치 수. 1,000 * 20 = 20,000행이다.
// 관리자가 버튼 한 번으로 28만 행을 지우지 못하게 제한한다.
//
// 배치 크기가 5,000 이면 Supabase 무료 플랜의 statement timeout 을 넘긴다.
// 2026-08-01 실측에서 5,000 은 8.7초에 취소되고 1,000 은 1.25초였다.
//
// Vercel 함수 실행 시간도 고려해 요청당 배치 수를 워크플로(30회)보다 낮춘다.
// 배치당 약 1.3초이므로 20회는 26초 수준이다.
const MAX_BATCHES_PER_REQUEST = 20;
const BATCH_LIMIT = 1_000;

// scripts/cleanup_telemetry.ts 와 같은 값을 쓴다.
const PLAYER_CACHE_RETENTION_DAYS = 90;
const PLAYER_CACHE_KEEP_RECENT = 150_000;

type CompactionOutcome = {
  candidateCount: number;
  deletedCount: number;
  remainingCount: number;
  totalCount: number | null;
};

function isReclaimTarget(value: unknown): value is ReclaimTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RECLAIM_TARGETS, value);
}

function buildRpcArgs(target: ReclaimTarget, apply: boolean): Record<string, unknown> {
  if (target === "pubg_player_cache") {
    return {
      p_retention_days: PLAYER_CACHE_RETENTION_DAYS,
      p_apply: apply,
      p_batch_limit: BATCH_LIMIT,
      p_keep_recent: PLAYER_CACHE_KEEP_RECENT,
    };
  }
  return { p_apply: apply, p_batch_limit: BATCH_LIMIT };
}

function parseOutcome(value: unknown): CompactionOutcome {
  if (!value || typeof value !== "object") {
    throw new Error("정리 결과를 해석할 수 없습니다.");
  }
  const result = value as Record<string, unknown>;
  for (const field of ["candidate_count", "deleted_count", "remaining_count"]) {
    const parsed = Number(result[field]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("정리 결과를 해석할 수 없습니다.");
    }
  }
  const totalCount = Number(result.total_count);
  return {
    candidateCount: Number(result.candidate_count),
    deletedCount: Number(result.deleted_count),
    remainingCount: Number(result.remaining_count),
    totalCount: Number.isInteger(totalCount) ? totalCount : null,
  };
}

export async function POST(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const adminError = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
    if (adminError) return adminError;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
    }

    const { target, apply } = (body ?? {}) as { target?: unknown; apply?: unknown };
    if (!isReclaimTarget(target)) {
      return NextResponse.json({ error: "지원하지 않는 정리 대상입니다." }, { status: 400 });
    }
    // apply 는 명시적으로 true 여야 삭제한다. 문자열 "true" 같은 값은 받지 않는다.
    const shouldApply = apply === true;
    const config = RECLAIM_TARGETS[target];

    // dry-run 은 한 번만 호출해 대상 건수를 보고한다.
    if (!shouldApply) {
      const { data, error } = await auth.supabaseAdmin.rpc(config.rpc, buildRpcArgs(target, false));
      if (error) throw new Error(error.message);
      const outcome = parseOutcome(data);

      return NextResponse.json({
        target,
        label: config.label,
        detail: config.detail,
        dryRun: true,
        candidateCount: outcome.candidateCount,
        deletedCount: 0,
        totalCount: outcome.totalCount,
        hasRemaining: outcome.candidateCount > 0,
        message: outcome.candidateCount > 0
          ? `${outcome.candidateCount.toLocaleString()}건이 정리 대상입니다. 실행하면 되돌릴 수 없습니다.`
          : "정리할 대상이 없습니다.",
      });
    }

    // 실제 삭제. 배치를 반복하되 요청당 상한을 둔다.
    const preview = parseOutcome(
      (await auth.supabaseAdmin.rpc(config.rpc, buildRpcArgs(target, false))).data,
    );

    let deletedCount = 0;
    let remainingCount = preview.candidateCount;
    for (let batch = 0; batch < MAX_BATCHES_PER_REQUEST && remainingCount > 0; batch += 1) {
      const { data, error } = await auth.supabaseAdmin.rpc(config.rpc, buildRpcArgs(target, true));
      if (error) throw new Error(error.message);
      const outcome = parseOutcome(data);
      deletedCount += outcome.deletedCount;
      remainingCount = outcome.remainingCount;
      // 대상이 남았다고 보고되어도 삭제가 0이면 더 진행할 수 없다.
      if (outcome.deletedCount === 0) break;
    }

    return NextResponse.json({
      target,
      label: config.label,
      detail: config.detail,
      dryRun: false,
      candidateCount: preview.candidateCount,
      deletedCount,
      remainingCount,
      totalCount: preview.totalCount,
      hasRemaining: remainingCount > 0,
      message: remainingCount > 0
        ? `${deletedCount.toLocaleString()}건을 정리했습니다. ${remainingCount.toLocaleString()}건이 남아 다시 실행하면 이어서 정리합니다.`
        : `${deletedCount.toLocaleString()}건을 정리했습니다. 디스크 파일 크기까지 줄이려면 유지보수 시간에 VACUUM (FULL) 이 필요합니다.`,
    });
  } catch (error: any) {
    console.error("[Admin Storage Compact] error:", error);
    return NextResponse.json(
      { error: error?.message || "정리 작업에 실패했습니다." },
      { status: 500 },
    );
  }
}
