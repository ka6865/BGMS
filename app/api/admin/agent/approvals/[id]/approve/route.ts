import { NextResponse } from "next/server";
import { buildApprovalPostExecution } from "@/lib/admin-agent/approval-execution";
import { deleteProcessedTelemetryIdentityTargets } from "@/lib/admin-agent/data-quality";
import { buildApprovalExecutionGate, calculateApprovalImpact } from "@/lib/admin-agent/impact";
import { redactForAgentLog } from "@/lib/admin-agent/redaction";
import { executeBoardPost, executeBoardPostUpdate } from "@/lib/admin-agent/tools";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const HIGH_RISK_APPROVAL_ACTIONS = new Set(["flush_old_cache", "flush_player_cache", "flush_match_cache", "reset_benchmarks", "repair_processed_telemetry_identity"]);

export async function POST(request: Request, context: RouteContext) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { id } = await context.params;
  const { data: approval, error } = await supabase
    .from("agent_approvals")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !approval) {
    return NextResponse.json({ error: error?.message || "승인 요청을 찾을 수 없습니다." }, { status: 404 });
  }

  if (approval.status !== "pending") {
    return NextResponse.json({ error: "이미 처리된 승인 요청입니다." }, { status: 409 });
  }

  let claimed = false;
  let actionCompleted = false;
  try {
    const body = await request.json().catch(() => ({}));
    const approvalNote = String(body.approvalNote || "").trim();
    const rawImpact = await calculateApprovalImpact(supabase, approval.action_type, approval.payload || {});
    const impact = {
      ...rawImpact,
      executionGate: buildApprovalExecutionGate(approval.action_type, approval.payload || {}, rawImpact)
    };
    if (impact.executionGate.status === "block") {
      return NextResponse.json({
        error: "승인 실행 조건을 통과하지 못했습니다.",
        impact,
        executionGate: impact.executionGate
      }, { status: 400 });
    }
    if (HIGH_RISK_APPROVAL_ACTIONS.has(approval.action_type) && body.confirmedImpact !== true) {
      return NextResponse.json({
        error: "고위험 승인 작업은 impact 확인 후 confirmedImpact=true가 필요합니다.",
        impact
      }, { status: 400 });
    }

    const { data: claimedApproval, error: claimError } = await supabase
      .from("agent_approvals")
      .update({
        status: "approved",
        approved_by: user.id,
        decided_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
    if (!claimedApproval) return NextResponse.json({ error: "이미 처리된 승인 요청입니다." }, { status: 409 });
    claimed = true;

    const executionResult = await executeApprovedAction(approval.action_type, approval.payload, supabase, user.id);
    actionCompleted = true;
    const execution = safeJsonParse(executionResult);
    const postExecution = buildApprovalPostExecution({
      actionType: approval.action_type,
      payload: approval.payload,
      execution,
      impact
    });
    const result = JSON.stringify(redactForAgentLog({
      decision: {
        approvedBy: user.id,
        approvedAt: new Date().toISOString(),
        approvalNote: approvalNote || null,
        confirmedImpact: body.confirmedImpact === true,
        highRisk: HIGH_RISK_APPROVAL_ACTIONS.has(approval.action_type)
      },
      impact,
      execution,
      postExecution
    }));

    const { data: executedApproval, error: executionWriteError } = await supabase
      .from("agent_approvals")
      .update({
        status: "executed",
        result,
        executed_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "approved")
      .eq("approved_by", user.id)
      .select("id")
      .maybeSingle();

    if (executionWriteError || !executedApproval) {
      throw new Error(executionWriteError?.message || "승인 상태가 변경되어 실행 결과를 저장할 수 없습니다.");
    }

    return NextResponse.json({ success: true, result: safeJsonParse(result) });
  } catch (err: any) {
    if (actionCompleted) {
      return NextResponse.json({
        error: "작업은 실행되었지만 결과 기록에 실패했습니다. 다시 실행하지 말고 실제 결과와 승인 상태를 확인하세요."
      }, { status: 500 });
    }

    if (claimed) {
      try {
        const { data: failedApproval, error: failureWriteError } = await supabase
          .from("agent_approvals")
          .update({
            status: "failed",
            error: redactForAgentLog(err.message || String(err)),
            executed_at: new Date().toISOString()
          })
          .eq("id", id)
          .eq("status", "approved")
          .eq("approved_by", user.id)
          .select("id")
          .maybeSingle();
        if (failureWriteError || !failedApproval) throw new Error("failure-write-failed");
      } catch {
        return NextResponse.json({
          error: "승인 작업 실행과 실패 상태 기록에 오류가 발생했습니다. 실제 결과와 승인 상태를 확인하세요."
        }, { status: 500 });
      }
    }

    return NextResponse.json({ error: err.message || "승인 작업 실행 실패" }, { status: 500 });
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function executeApprovedAction(actionType: string, payload: any, supabase: any, userId: string) {
  if (actionType === "create_board_post") {
    return executeBoardPost(payload, supabase, userId);
  }

  if (actionType === "update_board_post") {
    return executeBoardPostUpdate(payload, supabase);
  }

  if (actionType === "flush_old_cache") {
    const olderThanDays = Number(payload.olderThanDays || 14);
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("processed_match_telemetry")
      .delete({ count: "exact" })
      .lt("updated_at", cutoff);
    if (error) throw error;
    return JSON.stringify({
      success: true,
      message: `${olderThanDays}일 이상 지난 분석 데이터 캐시 ${count || 0}개가 삭제되었습니다.`,
      olderThanDays,
      cutoff
    });
  }

  if (actionType === "flush_player_cache") {
    if (!payload.nickname) throw new Error("플레이어 닉네임이 필요합니다.");
    const { count, error } = await supabase
      .from("processed_match_telemetry")
      .delete({ count: "exact" })
      .eq("player_id", String(payload.nickname).toLowerCase().trim());
    if (error) throw error;
    return JSON.stringify({ success: true, message: `${payload.nickname}님의 분석 데이터 캐시 ${count || 0}개가 삭제되었습니다.` });
  }

  if (actionType === "flush_match_cache") {
    if (!payload.matchId) throw new Error("매치 ID가 필요합니다.");
    let query = supabase
      .from("processed_match_telemetry")
      .delete({ count: "exact" })
      .eq("match_id", payload.matchId);
    if (payload.nickname) query = query.eq("player_id", String(payload.nickname).toLowerCase().trim());
    const { count, error } = await query;
    if (error) throw error;

    const { error: storageError } = await supabase.storage
      .from("telemetry")
      .remove([`${payload.matchId}.json`]);

    return JSON.stringify({
      success: true,
      message: `매치 ${payload.matchId}의 분석 결과 ${count || 0}개 삭제가 완료되었습니다.`,
      storageCleared: !storageError
    });
  }

  if (actionType === "reset_benchmarks") {
    const { count, error } = await supabase
      .from("global_benchmarks")
      .delete({ count: "exact" })
      .neq("id", -1);
    if (error) throw error;
    return JSON.stringify({ success: true, message: `벤치마크 데이터 ${count || 0}개가 초기화되었습니다.` });
  }

  if (actionType === "repair_processed_telemetry_identity") {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    if (targets.length === 0) throw new Error("identity mismatch 삭제 대상 targets가 필요합니다.");
    const result = await deleteProcessedTelemetryIdentityTargets(supabase, targets);
    return JSON.stringify({
      success: result.failed === 0,
      message: `전적 분석 identity mismatch 캐시 ${result.deleted}개 삭제, ${result.skipped}개 스킵, ${result.failed}개 실패`,
      ...result
    });
  }

  if (actionType === "save_agent_memory" || actionType === "save_agent_report") {
    const title = String(payload.title || "").trim();
    const body = String(payload.body || "").trim();
    if (!title || !body) throw new Error("저장할 memory title/body가 필요합니다.");

    const { data, error } = await supabase
      .from("agent_memories")
      .insert({
        category: String(payload.category || (actionType === "save_agent_report" ? "report" : "incident")).trim(),
        title,
        body,
        metadata: {
          ...(payload.metadata || {}),
          approvedBy: userId,
          active: payload.metadata?.active !== false
        }
      })
      .select("id")
      .single();

    if (error) throw error;
    return JSON.stringify({
      success: true,
      message: actionType === "save_agent_report"
        ? `운영 리포트 "${title}" 저장이 완료되었습니다.`
        : `운영 기억 "${title}" 저장이 완료되었습니다.`,
      memoryId: data?.id
    });
  }

  throw new Error(`지원하지 않는 승인 작업입니다: ${actionType}`);
}
