import { NextResponse } from "next/server";
import { redactForAgentLog } from "./redaction";
import type { AgentSafetyLevel, AgentToolStatus } from "./types";

export async function verifyAdminRole(supabase: any, userId: string) {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[ADMIN-AGENT] Admin role lookup failed:", error.message || error);
    return NextResponse.json({ error: "관리자 권한 확인 중 오류가 발생했습니다." }, { status: 500 });
  }

  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "관리자 권한이 없습니다." }, { status: 403 });
  }

  return null;
}

export async function createAgentRun(
  supabase: any,
  input: { userId?: string | null; message: string; systemPrompt?: string }
) {
  try {
    const { data, error } = await supabase
      .from("agent_runs")
      .insert({
        user_id: input.userId || null,
        message: redactForAgentLog(input.message),
        system_prompt: input.systemPrompt ? redactForAgentLog(input.systemPrompt) : null,
        status: "running"
      })
      .select("id")
      .single();

    if (error) throw error;
    return data?.id || null;
  } catch (error: any) {
    console.warn("[ADMIN-AGENT] Failed to create run log:", error.message || error);
    return null;
  }
}

export async function completeAgentRun(
  supabase: any,
  runId: string | null | undefined,
  input: { status: "completed" | "failed"; summary?: string; error?: string }
) {
  if (!runId) return;
  try {
    await supabase
      .from("agent_runs")
      .update({
        status: input.status,
        summary: input.summary ? redactForAgentLog(input.summary) : null,
        error: input.error ? redactForAgentLog(input.error) : null,
        completed_at: new Date().toISOString()
      })
      .eq("id", runId);
  } catch (error: any) {
    console.warn("[ADMIN-AGENT] Failed to complete run log:", error.message || error);
  }
}

export async function createAgentStep(
  supabase: any,
  input: {
    runId?: string | null;
    toolName: string;
    safetyLevel: AgentSafetyLevel;
    params: Record<string, unknown>;
  }
) {
  if (!input.runId) return null;
  try {
    const { data, error } = await supabase
      .from("agent_steps")
      .insert({
        run_id: input.runId,
        tool_name: input.toolName,
        safety_level: input.safetyLevel,
        params: redactForAgentLog(input.params || {}),
        status: "running"
      })
      .select("id")
      .single();

    if (error) throw error;
    return data?.id || null;
  } catch (error: any) {
    console.warn("[ADMIN-AGENT] Failed to create step log:", error.message || error);
    return null;
  }
}

export async function completeAgentStep(
  supabase: any,
  stepId: string | null | undefined,
  input: { status: AgentToolStatus; result?: string; error?: string }
) {
  if (!stepId) return;
  try {
    await supabase
      .from("agent_steps")
      .update({
        status: input.status,
        result: input.result ? redactForAgentLog(input.result) : null,
        error: input.error ? redactForAgentLog(input.error) : null,
        completed_at: new Date().toISOString()
      })
      .eq("id", stepId);
  } catch (error: any) {
    console.warn("[ADMIN-AGENT] Failed to complete step log:", error.message || error);
  }
}

export async function createApprovalRequest(
  supabase: any,
  input: {
    runId?: string | null;
    stepId?: string | null;
    requestedBy?: string | null;
    toolName: string;
    actionType: string;
    payload: Record<string, unknown>;
  }
) {
  try {
    const { data, error } = await supabase
      .from("agent_approvals")
      .insert({
        run_id: input.runId || null,
        step_id: input.stepId || null,
        requested_by: input.requestedBy || null,
        tool_name: input.toolName,
        action_type: input.actionType,
        payload: redactForAgentLog(input.payload || {}),
        status: "pending"
      })
      .select("id")
      .single();

    if (error) throw error;
    return data?.id || null;
  } catch (error: any) {
    console.warn("[ADMIN-AGENT] Failed to create approval request:", error.message || error);
    return null;
  }
}

/**
 * createApprovalRequest 가 null 을 반환했을 때 route 가 돌려줄 응답입니다.
 * 승인 대기열에 행이 없으므로 success/approvalId 를 내려주지 않는다.
 */
export function approvalCreationFailedResponse(label: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    {
      ...extra,
      success: false,
      approvalId: null,
      error: `${label} 승인 요청을 승인 대기열에 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.`
    },
    { status: 500 }
  );
}
