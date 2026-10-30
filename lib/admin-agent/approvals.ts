import { getAgentThresholds } from "@/lib/admin-agent/thresholds";
import { buildApprovalExecutionGate, type ApprovalExecutionGate } from "@/lib/admin-agent/impact";

export type ApprovalPriority = "low" | "medium" | "high";

export type ApprovalQueueItem = {
  id: string;
  action_type: string;
  status: string;
  created_at?: string | null;
  payload?: Record<string, any> | null;
  priority: ApprovalPriority;
  ageHours: number;
  isStale: boolean;
};

export type ApprovalQueueSummary = {
  count: number;
  highRiskCount: number;
  staleCount: number;
  oldestAgeHours: number;
  oldest: ApprovalQueueItem | null;
  items: ApprovalQueueItem[];
  error?: string;
};

export type ApprovalGateSummary = {
  sampledCount: number;
  passCount: number;
  reviewCount: number;
  blockCount: number;
  items: Array<{
    id: string;
    actionType: string;
    title: string;
    gate: ApprovalExecutionGate;
  }>;
  error?: string;
};

const HIGH_RISK_ACTIONS = new Set(["repair_processed_telemetry_identity"]);
const MEDIUM_RISK_ACTIONS = new Set(["create_board_post", "update_board_post", "save_agent_memory"]);

/** 승인 대기열을 조회하지 못했을 때 쓰는 빈 요약입니다. */
export function emptyApprovalQueueSummary(error: string): ApprovalQueueSummary {
  return { count: 0, highRiskCount: 0, staleCount: 0, oldestAgeHours: 0, oldest: null, items: [], error };
}

/** Execution Gate 표본을 조회하지 못했을 때 쓰는 빈 요약입니다. */
export function emptyApprovalGateSummary(error: string): ApprovalGateSummary {
  return { sampledCount: 0, passCount: 0, reviewCount: 0, blockCount: 0, items: [], error };
}

export async function fetchApprovalQueueSummary(supabase: any, limit = 50): Promise<ApprovalQueueSummary> {
  const { data, error } = await supabase
    .from("agent_approvals")
    .select("id, action_type, status, payload, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (error) {
    return {
      count: 0,
      highRiskCount: 0,
      staleCount: 0,
      oldestAgeHours: 0,
      oldest: null,
      items: [],
      error: error.message
    };
  }

  const items = (data || []).map(normalizeApproval);
  return summarizeApprovalQueue(items);
}

export async function fetchApprovalGateSummary(supabase: any, limit = 25): Promise<ApprovalGateSummary> {
  const { data, error } = await supabase
    .from("agent_approvals")
    .select("id, action_type, payload")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 50));

  if (error) {
    return {
      sampledCount: 0,
      passCount: 0,
      reviewCount: 0,
      blockCount: 0,
      items: [],
      error: error.message
    };
  }

  const items: ApprovalGateSummary["items"] = (data || []).map((approval: any) => {
    const payload = approval.payload || {};
    return {
      id: approval.id,
      actionType: approval.action_type,
      title: payload.title || payload.cleanupType || approval.action_type,
      gate: buildApprovalExecutionGate(approval.action_type, payload)
    };
  });

  return {
    sampledCount: items.length,
    passCount: items.filter((item) => item.gate.status === "pass").length,
    reviewCount: items.filter((item) => item.gate.status === "review").length,
    blockCount: items.filter((item) => item.gate.status === "block").length,
    items
  };
}

export function normalizeApproval(approval: any): ApprovalQueueItem {
  const ageHours = getAgeHours(approval.created_at);
  const thresholds = getAgentThresholds();
  return {
    id: approval.id,
    action_type: approval.action_type,
    status: approval.status,
    created_at: approval.created_at,
    payload: approval.payload || {},
    priority: getApprovalPriority(approval.action_type),
    ageHours,
    isStale: ageHours >= thresholds.approvalStaleHours
  };
}

export function summarizeApprovalQueue(items: ApprovalQueueItem[]): ApprovalQueueSummary {
  const oldest = items.reduce<ApprovalQueueItem | null>((current, item) => {
    if (!current || item.ageHours > current.ageHours) return item;
    return current;
  }, null);

  return {
    count: items.length,
    highRiskCount: items.filter((item) => item.priority === "high").length,
    staleCount: items.filter((item) => item.isStale).length,
    oldestAgeHours: oldest?.ageHours || 0,
    oldest,
    items
  };
}

export function getApprovalPriority(actionType: string): ApprovalPriority {
  if (HIGH_RISK_ACTIONS.has(actionType)) return "high";
  if (MEDIUM_RISK_ACTIONS.has(actionType)) return "medium";
  return "low";
}

function getAgeHours(value?: string | null) {
  if (!value) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3600000));
}
