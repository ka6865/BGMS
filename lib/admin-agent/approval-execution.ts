type ApprovalImpactLike = {
  risk?: string;
  estimatedRows?: number;
  summary?: string;
};

type ApprovalPostExecutionInput = {
  actionType: string;
  payload?: Record<string, any> | null;
  execution?: any;
  impact?: ApprovalImpactLike | null;
};

export function buildApprovalPostExecution(input: ApprovalPostExecutionInput) {
  const { actionType, payload = {}, execution = {}, impact } = input;
  const success = execution?.success !== false;
  const title = getActionTitle(actionType);
  const metrics = buildMetrics(actionType, payload || {}, execution, impact || null);
  const followUp = buildFollowUp(actionType, payload || {}, execution, impact || null);

  return {
    status: success ? "completed" : "needs_review",
    title,
    outcome: execution?.message || `${title} 실행 결과를 확인하세요.`,
    metrics,
    followUp,
    audit: {
      approvalPanel: "/admin/bot",
      runTimeline: payload?.runId ? `/admin/bot?run=${payload.runId}` : null,
      relatedResource: getRelatedResource(actionType, payload || {}, execution)
    }
  };
}

function getActionTitle(actionType: string) {
  if (actionType === "create_board_post") return "게시글 초안 작성";
  if (actionType === "flush_old_cache") return "오래된 캐시 삭제";
  if (actionType === "flush_player_cache") return "플레이어 캐시 삭제";
  if (actionType === "flush_match_cache") return "매치 캐시 삭제";
  if (actionType === "reset_benchmarks") return "벤치마크 초기화";
  if (actionType === "repair_processed_telemetry_identity") return "전적 분석 identity mismatch 정리";
  if (actionType === "update_board_post") return "게시글 수정 초안";
  if (actionType === "save_agent_report") return "운영 리포트 저장";
  if (actionType === "save_agent_memory") return "운영 기억 저장";
  return actionType;
}

function buildMetrics(actionType: string, payload: Record<string, any>, execution: any, impact: ApprovalImpactLike | null) {
  const metrics: Array<{ label: string; value: string }> = [];
  if (impact?.risk) metrics.push({ label: "Risk", value: impact.risk });
  if (typeof impact?.estimatedRows === "number") metrics.push({ label: "Estimated rows", value: impact.estimatedRows.toLocaleString("ko-KR") });

  if (actionType === "create_board_post") {
    metrics.push({ label: "Category", value: String(payload.category || "자유") });
    if (execution?.postId) metrics.push({ label: "Post ID", value: String(execution.postId) });
  }
  if (actionType === "update_board_post") {
    if (payload.postId) metrics.push({ label: "Post ID", value: String(payload.postId) });
    if (execution?.removedImages) metrics.push({ label: "Removed images", value: String(execution.removedImages) });
  }
  if (actionType === "flush_old_cache") {
    metrics.push({ label: "Older than", value: `${Number(payload.olderThanDays || 14)}일` });
  }
  if (actionType === "flush_player_cache" && payload.nickname) {
    metrics.push({ label: "Player", value: String(payload.nickname) });
  }
  if (actionType === "flush_match_cache") {
    if (payload.matchId) metrics.push({ label: "Match", value: String(payload.matchId) });
    if (payload.nickname) metrics.push({ label: "Player", value: String(payload.nickname) });
    if (typeof execution?.storageCleared === "boolean") metrics.push({ label: "Storage cleared", value: execution.storageCleared ? "yes" : "check required" });
  }
  if (actionType === "repair_processed_telemetry_identity") {
    metrics.push({ label: "Requested targets", value: Number(payload.targets?.length || 0).toLocaleString("ko-KR") });
    if (typeof execution?.deleted === "number") metrics.push({ label: "Deleted", value: execution.deleted.toLocaleString("ko-KR") });
    if (typeof execution?.skipped === "number") metrics.push({ label: "Skipped", value: execution.skipped.toLocaleString("ko-KR") });
    if (typeof execution?.failed === "number") metrics.push({ label: "Failed", value: execution.failed.toLocaleString("ko-KR") });
  }
  if ((actionType === "save_agent_report" || actionType === "save_agent_memory") && execution?.memoryId) {
    metrics.push({ label: "Memory ID", value: String(execution.memoryId) });
  }

  return metrics;
}

function buildFollowUp(actionType: string, payload: Record<string, any>, execution: any, impact: ApprovalImpactLike | null) {
  if (actionType === "create_board_post") {
    return [
      "게시판의 어드민 검증 탭에서 비공개 초안의 제목/본문/이미지를 확인하세요.",
      "공개하려면 초안 확인 후 별도로 발행하세요."
    ];
  }
  if (actionType === "update_board_post") {
    return [
      "게시판의 어드민 검증 탭에서 비공개 수정 초안의 제목/본문/이미지를 확인하세요.",
      "원본에 반영하려면 수정 초안 확인 후 별도로 발행하세요."
    ];
  }
  if (actionType === "flush_old_cache" || actionType === "flush_player_cache" || actionType === "flush_match_cache") {
    return [
      "수동 점검을 실행해 processed telemetry row 수와 cache 상태를 다시 확인하세요.",
      "동일 증상이 반복되면 사고 타임라인 리포트로 원인과 승인 이력을 묶어 저장하세요."
    ];
  }
  if (actionType === "reset_benchmarks") {
    return [
      "다음 통계 분석 요청에서 benchmark 재생성 여부를 확인하세요.",
      "랭킹/통계 페이지가 정상 응답하는지 배포 후 한 번 점검하세요."
    ];
  }
  if (actionType === "repair_processed_telemetry_identity") {
    return [
      "수동 점검 또는 다음 Agent monitor에서 identity mismatch 수가 줄었는지 확인하세요.",
      "삭제된 캐시는 유저 재분석 시 새 identity 기준으로 다시 생성됩니다.",
      "연막/회복 집계값 오염 가능성은 별도 재분석 후보로만 다루고 자동 삭제하지 마세요."
    ];
  }
  if (actionType === "save_agent_report" || actionType === "save_agent_memory") {
    return [
      "운영 기억 패널에서 저장된 항목이 active 상태인지 확인하세요.",
      "비슷한 이슈가 재발하면 관련 memory를 기준으로 대응하세요."
    ];
  }

  return [
    impact?.summary ? `Impact 재확인: ${impact.summary}` : "승인 결과와 실행 로그를 확인하세요.",
    execution?.message ? "필요하면 결과 메시지를 운영 리포트에 남기세요." : "수동 점검으로 후속 상태를 확인하세요."
  ];
}

function getRelatedResource(actionType: string, payload: Record<string, any>, execution: any) {
  if (actionType === "create_board_post" && execution?.postId) return `/board/${execution.postId}`;
  if (actionType === "update_board_post" && (execution?.postId || payload.postId)) return `/board/${execution?.postId || payload.postId}`;
  if (actionType === "flush_match_cache" && payload.matchId) return `match:${payload.matchId}`;
  if (actionType === "repair_processed_telemetry_identity") return "processed_match_telemetry";
  if (actionType === "flush_player_cache" && payload.nickname) return `player:${payload.nickname}`;
  if ((actionType === "save_agent_report" || actionType === "save_agent_memory") && execution?.memoryId) return `memory:${execution.memoryId}`;
  return null;
}
