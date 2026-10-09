import { validateProcessedTelemetryIdentityTargets } from "@/lib/admin-agent/data-quality";

export type ApprovalImpact = {
  summary: string;
  risk: "low" | "medium" | "high";
  estimatedRows?: number;
  details: Record<string, unknown>;
  preview: ApprovalImpactPreview;
  checklist: ApprovalImpactChecklistItem[];
  executionGate?: ApprovalExecutionGate;
};

export type ApprovalImpactPreview = {
  headline: string;
  items: Array<{
    label: string;
    value: string;
  }>;
  bodyPreview?: string;
  diff?: {
    titleChanged: boolean;
    contentChanged: boolean;
    imageChanged: boolean;
    lengthDelta: number;
    beforeTitle?: string;
    afterTitle?: string;
    beforePreview?: string;
    afterPreview?: string;
  };
  warnings?: string[];
};

export type ApprovalImpactChecklistItem = {
  label: string;
  status: "pass" | "review" | "warning";
  message: string;
};

export type ApprovalExecutionGate = {
  status: "pass" | "review" | "block";
  label: string;
  reasons: string[];
  requiredBeforeApproval: string[];
};

const SUPPORTED_APPROVAL_ACTIONS = new Set([
  "create_board_post",
  "update_board_post",
  "flush_old_cache",
  "flush_player_cache",
  "flush_match_cache",
  "reset_benchmarks",
  "repair_processed_telemetry_identity",
  "save_agent_memory",
  "save_agent_report"
]);
const HIGH_RISK_GATE_ACTIONS = new Set(["flush_old_cache", "flush_player_cache", "flush_match_cache", "reset_benchmarks", "repair_processed_telemetry_identity"]);

export function buildApprovalExecutionGate(
  actionType: string,
  payload: Record<string, any> = {},
  impact?: ApprovalImpact
): ApprovalExecutionGate {
  const reasons: string[] = [];
  const requiredBeforeApproval: string[] = [];

  if (!SUPPORTED_APPROVAL_ACTIONS.has(actionType)) {
    reasons.push(`지원하지 않는 승인 작업입니다: ${actionType}`);
    requiredBeforeApproval.push("실행 경로를 코드에서 추가하거나 요청을 거절하세요.");
  }

  if (actionType === "create_board_post") {
    if (!String(payload.title || "").trim()) {
      reasons.push("게시글 제목이 비어 있습니다.");
      requiredBeforeApproval.push("제목이 포함된 초안 작성 요청을 다시 생성하세요.");
    }
    if (!String(payload.content || "").trim()) {
      reasons.push("게시글 본문이 비어 있습니다.");
      requiredBeforeApproval.push("본문이 포함된 초안 작성 요청을 다시 생성하세요.");
    }
  }

  if (actionType === "update_board_post") {
    if (!payload.postId) {
      reasons.push("수정 대상 게시글 ID(postId)가 없습니다.");
      requiredBeforeApproval.push("postId가 포함된 수정 요청을 다시 생성하세요.");
    }
    if (!String(payload.title || "").trim()) {
      reasons.push("수정할 제목이 비어 있습니다.");
      requiredBeforeApproval.push("제목이 포함된 수정 요청을 다시 생성하세요.");
    }
    if (!String(payload.content || "").trim()) {
      reasons.push("수정할 본문이 비어 있습니다.");
      requiredBeforeApproval.push("본문이 포함된 수정 요청을 다시 생성하세요.");
    }
  }

  if (actionType === "flush_player_cache" && !String(payload.nickname || "").trim()) {
    reasons.push("플레이어 캐시 삭제 대상 nickname이 없습니다.");
    requiredBeforeApproval.push("대상 player를 지정한 캐시 삭제 요청을 다시 생성하세요.");
  }

  if (actionType === "flush_match_cache" && !String(payload.matchId || "").trim()) {
    reasons.push("매치 캐시 삭제 대상 matchId가 없습니다.");
    requiredBeforeApproval.push("대상 matchId를 지정한 캐시 삭제 요청을 다시 생성하세요.");
  }

  if (actionType === "repair_processed_telemetry_identity") {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    if (targets.length === 0) {
      reasons.push("identity mismatch 삭제 대상 targets가 없습니다.");
      requiredBeforeApproval.push("Agent monitor를 다시 실행해 targets가 포함된 요청을 생성하세요.");
    }
    if (targets.some((target: any) => !target.match_id || !target.platform || !target.player_id)) {
      reasons.push("targets 중 match_id/platform/player_id가 누락된 항목이 있습니다.");
      requiredBeforeApproval.push("필수 식별자가 포함된 요청으로 다시 생성하세요.");
    }
  }

  if ((actionType === "save_agent_memory" || actionType === "save_agent_report")) {
    if (!String(payload.title || "").trim()) {
      reasons.push("저장할 title이 비어 있습니다.");
      requiredBeforeApproval.push("title이 포함된 저장 요청을 다시 생성하세요.");
    }
    if (!String(payload.body || "").trim()) {
      reasons.push("저장할 body가 비어 있습니다.");
      requiredBeforeApproval.push("body가 포함된 저장 요청을 다시 생성하세요.");
    }
  }

  if ((impact?.checklist || []).some((item) => item.status === "warning")) {
    reasons.push("impact checklist에 warning 항목이 있습니다.");
  }

  if (reasons.length && requiredBeforeApproval.length) {
    return {
      status: "block",
      label: "승인 차단",
      reasons,
      requiredBeforeApproval
    };
  }

  if (reasons.length || impact?.risk === "high" || HIGH_RISK_GATE_ACTIONS.has(actionType)) {
    return {
      status: "review",
      label: "승인 전 재확인",
      reasons: reasons.length ? reasons : ["고위험 작업은 실행 직전 impact와 대상 범위를 다시 확인해야 합니다."],
      requiredBeforeApproval: [
        "승인 메모에 실행 사유를 남기세요.",
        "대상 범위와 예상 영향 row를 다시 확인하세요."
      ]
    };
  }

  return {
    status: "pass",
    label: "승인 가능",
    reasons: ["필수 실행 조건을 통과했습니다."],
    requiredBeforeApproval: []
  };
}

export async function calculateApprovalImpact(
  supabase: any,
  actionType: string,
  payload: Record<string, any> = {}
): Promise<ApprovalImpact> {
  if (actionType === "create_board_post") {
    const content = String(payload.content || "");
    const hasImage = /<img[^>]+src\s*=/i.test(content);
    const draftContent = String(payload.draft?.contentHtml || "");
    const draftTitle = String(payload.draft?.title || "");
    const draftHasImage = /<img[^>]+src\s*=/i.test(draftContent);
    const diff = draftTitle || draftContent
      ? {
        titleChanged: Boolean(draftTitle && draftTitle !== String(payload.title || "")),
        contentChanged: Boolean(draftContent && normalizeText(draftContent) !== normalizeText(content)),
        imageChanged: Boolean(draftContent && draftHasImage !== hasImage),
        lengthDelta: content.length - draftContent.length,
        beforeTitle: draftTitle || undefined,
        afterTitle: String(payload.title || "제목 없음"),
        beforePreview: draftContent ? htmlToPlainText(draftContent) : undefined,
        afterPreview: htmlToPlainText(content)
      }
      : undefined;
    return {
      risk: "medium",
      summary: `게시글 "${payload.title || "제목 없음"}" 비공개 초안 작성 대기`,
      details: {
        title: payload.title || null,
        category: payload.category || "자유",
        contentLength: content.length,
        hasImage,
        draftType: payload.draft?.draftType || null,
        seoTitle: payload.draft?.seoTitle || null
      },
      preview: {
        headline: "비공개 게시글 초안 미리보기",
        items: [
          { label: "제목", value: String(payload.title || "제목 없음") },
          { label: "게시판", value: String(payload.category || "자유") },
          { label: "본문 길이", value: `${content.length.toLocaleString("ko-KR")}자` },
          { label: "이미지", value: hasImage ? "포함" : "없음" },
          ...(payload.draft?.seoTitle ? [{ label: "SEO 제목", value: String(payload.draft.seoTitle) }] : [])
        ],
        bodyPreview: htmlToPlainText(content),
        diff,
        warnings: [
          "승인하면 비공개 초안으로 저장됩니다. 공개 발행은 별도 확인이 필요합니다.",
          ...(diff?.titleChanged || diff?.contentChanged ? ["원본 초안과 최종 발행안이 다릅니다. 변경 요약을 확인하세요."] : []),
          ...(hasImage ? [] : ["이미지 없는 게시글입니다. 공지 목적이 아니라면 시각 자료를 확인하세요."])
        ]
      },
      checklist: [
        {
          label: "제목 확인",
          status: payload.title ? "pass" : "warning",
          message: payload.title ? `제목: ${payload.title}` : "제목이 비어 있습니다."
        },
        {
          label: "본문 길이",
          status: content.length >= 80 ? "pass" : "review",
          message: `${content.length.toLocaleString("ko-KR")}자. 너무 짧으면 공지/게시글 품질을 다시 확인하세요.`
        },
        {
          label: "이미지 포함",
          status: hasImage ? "pass" : "review",
          message: hasImage ? "본문에 이미지가 포함되어 있습니다." : "이미지 없는 텍스트 게시글입니다."
        },
        {
          label: "공개 전 확인",
          status: "review",
          message: `${payload.category || "자유"} 게시판의 비공개 초안으로 저장됩니다.`
        }
      ]
    };
  }

  if (actionType === "update_board_post") {
    const content = String(payload.content || "");
    const hasImage = /<img[^>]+src\s*=/i.test(content);
    const beforeTitle = payload.beforeTitle ? String(payload.beforeTitle) : undefined;
    const beforeContent = payload.beforeContent ? String(payload.beforeContent) : undefined;
    const beforeHasImage = beforeContent ? /<img[^>]+src\s*=/i.test(beforeContent) : undefined;
    const diff = beforeTitle !== undefined || beforeContent !== undefined
      ? {
        titleChanged: Boolean(beforeTitle && beforeTitle !== String(payload.title || "")),
        contentChanged: Boolean(beforeContent && normalizeText(beforeContent) !== normalizeText(content)),
        imageChanged: Boolean(beforeContent !== undefined && beforeHasImage !== hasImage),
        lengthDelta: beforeContent !== undefined ? content.length - beforeContent.length : 0,
        beforeTitle,
        afterTitle: String(payload.title || ""),
        beforePreview: beforeContent ? htmlToPlainText(beforeContent) : undefined,
        afterPreview: htmlToPlainText(content)
      }
      : undefined;
    return {
      risk: "medium",
      summary: `게시글 #${payload.postId} "${payload.title || "제목 없음"}" 비공개 수정 초안 저장 대기`,
      details: {
        postId: payload.postId,
        title: payload.title || null,
        contentLength: content.length,
        hasImage,
        beforeTitle: beforeTitle || null,
        beforeContentLength: beforeContent?.length || null
      },
      preview: {
        headline: "비공개 수정 초안 미리보기",
        items: [
          { label: "게시글 ID", value: String(payload.postId) },
          { label: "수정 제목", value: String(payload.title || "제목 없음") },
          { label: "본문 길이", value: `${content.length.toLocaleString("ko-KR")}자` },
          { label: "이미지", value: hasImage ? "포함" : "없음" },
          ...(beforeTitle ? [{ label: "기존 제목", value: beforeTitle }] : [])
        ],
        bodyPreview: htmlToPlainText(content),
        diff,
        warnings: [
          "승인하면 비공개 수정 초안이 저장됩니다. 원본 반영은 초안 확인 후 별도 발행이 필요합니다.",
          ...(diff?.titleChanged ? ["수정 초안의 제목이 달라집니다. 변경 전후를 확인하세요."] : []),
          ...(diff?.imageChanged ? ["요청 본문의 이미지 포함 여부가 다릅니다. 저장된 수정 초안에서 이미지 보존 상태를 확인하세요."] : [])
        ]
      },
      checklist: [
        {
          label: "대상 게시글",
          status: payload.postId ? "pass" : "warning",
          message: payload.postId ? `게시글 #${payload.postId}` : "postId가 비어 있습니다."
        },
        {
          label: "제목 확인",
          status: payload.title ? "pass" : "warning",
          message: payload.title ? `수정 제목: ${payload.title}` : "제목이 비어 있습니다."
        },
        {
          label: "본문 길이",
          status: content.length >= 80 ? "pass" : "review",
          message: `${content.length.toLocaleString("ko-KR")}자. 너무 짧으면 게시글 품질을 다시 확인하세요.`
        },
        {
          label: "원본 반영",
          status: "review",
          message: `게시글 #${payload.postId}의 원본 반영은 수정 초안 확인 후 별도 발행이 필요합니다.`
        }
      ]
    };
  }

  if (actionType === "flush_old_cache") {
    const olderThanDays = Number(payload.olderThanDays || 14);
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await countRows(supabase, "processed_match_telemetry", "updated_at", cutoff, "lt");
    return {
      risk: "high",
      estimatedRows: rows.count,
      summary: `${olderThanDays}일 이상 지난 processed_match_telemetry 캐시 ${rows.count}개 삭제 예상`,
      details: { olderThanDays, cutoff, ...rows },
      preview: {
        headline: "오래된 분석 캐시 삭제 미리보기",
        items: [
          { label: "대상", value: "processed_match_telemetry" },
          { label: "조건", value: `updated_at < ${cutoff}` },
          { label: "기준", value: `${olderThanDays}일 이상 경과` },
          { label: "예상 row", value: `${rows.count.toLocaleString("ko-KR")}개` }
        ],
        warnings: [
          "승인 직전 impact를 다시 계산합니다.",
          "삭제 후 해당 분석은 재요청 시 다시 생성됩니다."
        ]
      },
      checklist: cacheChecklist([
        `${olderThanDays}일 이상 지난 데이터만 삭제 대상입니다.`,
        rows.error ? `영향 계산 오류: ${rows.error}` : `삭제 예상 row: ${rows.count.toLocaleString("ko-KR")}개`,
        "승인 직전 impact를 다시 계산합니다."
      ], rows.error)
    };
  }

  if (actionType === "flush_player_cache") {
    const nickname = String(payload.nickname || "").toLowerCase().trim();
    const rows = nickname
      ? await countRows(supabase, "processed_match_telemetry", "player_id", nickname)
      : { count: 0, error: "nickname is missing" };
    return {
      risk: "high",
      estimatedRows: rows.count,
      summary: `${nickname || "unknown"} 플레이어 캐시 ${rows.count}개 삭제 예상`,
      details: { playerId: nickname || null, ...rows },
      preview: {
        headline: "플레이어 분석 캐시 삭제 미리보기",
        items: [
          { label: "대상 player", value: nickname || "미지정" },
          { label: "테이블", value: "processed_match_telemetry" },
          { label: "조건", value: nickname ? `player_id = ${nickname}` : "player_id 미지정" },
          { label: "예상 row", value: `${rows.count.toLocaleString("ko-KR")}개` }
        ],
        warnings: [
          ...(nickname ? [] : ["대상 player가 비어 있습니다. 승인하지 말고 재요청하세요."]),
          "해당 플레이어 분석 캐시만 정리합니다."
        ]
      },
      checklist: cacheChecklist([
        nickname ? `대상 player_id: ${nickname}` : "대상 player가 비어 있습니다.",
        rows.error ? `영향 계산 오류: ${rows.error}` : `삭제 예상 row: ${rows.count.toLocaleString("ko-KR")}개`,
        "해당 플레이어 분석 캐시만 정리합니다."
      ], rows.error || !nickname)
    };
  }

  if (actionType === "flush_match_cache") {
    const matchId = String(payload.matchId || "").trim();
    const nickname = payload.nickname ? String(payload.nickname).toLowerCase().trim() : null;
    const rows = matchId
      ? await countMatchCacheRows(supabase, matchId, nickname)
      : { count: 0, error: "matchId is missing" };
    return {
      risk: "high",
      estimatedRows: rows.count,
      summary: `${matchId || "unknown"} 매치 캐시 ${rows.count}개 및 telemetry/${matchId || "unknown"}.json 삭제 예상`,
      details: {
        matchId: matchId || null,
        playerId: nickname,
        storageObject: matchId ? `${matchId}.json` : null,
        ...rows
      },
      preview: {
        headline: "매치 분석 캐시 삭제 미리보기",
        items: [
          { label: "대상 match", value: matchId || "미지정" },
          { label: "대상 player", value: nickname || "전체 매치" },
          { label: "예상 row", value: `${rows.count.toLocaleString("ko-KR")}개` },
          { label: "Storage 파일", value: matchId ? `telemetry/${matchId}.json` : "계산 불가" }
        ],
        warnings: [
          ...(matchId ? [] : ["대상 matchId가 비어 있습니다. 승인하지 말고 재요청하세요."]),
          "Storage 파일과 DB 캐시가 함께 정리될 수 있습니다."
        ]
      },
      checklist: cacheChecklist([
        matchId ? `대상 match_id: ${matchId}` : "대상 matchId가 비어 있습니다.",
        nickname ? `대상 player_id: ${nickname}` : "전체 매치 캐시 기준입니다.",
        rows.error ? `영향 계산 오류: ${rows.error}` : `삭제 예상 row: ${rows.count.toLocaleString("ko-KR")}개`,
        matchId ? `R2 telemetry object 후보: ${matchId}.json` : "R2 파일명 계산 불가"
      ], rows.error || !matchId)
    };
  }

  if (actionType === "reset_benchmarks") {
    const rows = await countRows(supabase, "global_benchmarks");
    return {
      risk: "high",
      estimatedRows: rows.count,
      summary: `global_benchmarks ${rows.count}개 초기화 예상`,
      details: rows,
      preview: {
        headline: "벤치마크 초기화 미리보기",
        items: [
          { label: "대상", value: "global_benchmarks" },
          { label: "예상 row", value: `${rows.count.toLocaleString("ko-KR")}개` },
          { label: "영향", value: "재계산 전까지 통계 기준값에 영향" }
        ],
        warnings: [
          "트래픽이 낮은 시간대 실행을 권장합니다.",
          "초기화 직후 일부 통계 비교값이 일시적으로 비어 보일 수 있습니다."
        ]
      },
      checklist: cacheChecklist([
        rows.error ? `영향 계산 오류: ${rows.error}` : `초기화 예상 benchmark row: ${rows.count.toLocaleString("ko-KR")}개`,
        "벤치마크는 재계산 전까지 통계 기준값에 영향을 줄 수 있습니다.",
        "서비스 트래픽이 낮은 시간대 실행을 권장합니다."
      ], rows.error)
    };
  }

  if (actionType === "repair_processed_telemetry_identity") {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const validation = targets.length
      ? await validateProcessedTelemetryIdentityTargets(supabase, targets)
      : { valid: [], skipped: [] };
    const validCount = validation.valid.length;
    const skippedCount = validation.skipped.length;
    return {
      risk: "high",
      estimatedRows: validCount,
      summary: `processed_match_telemetry identity mismatch ${validCount}개 삭제 예상`,
      details: {
        auditWindowDays: payload.auditWindowDays || null,
        requestedTargets: targets.length,
        validTargets: validCount,
        skippedTargets: skippedCount,
        mismatchCountAtAudit: payload.mismatchCount || null,
        deletionCandidateCountAtAudit: payload.deletionCandidateCount || null,
        skipped: validation.skipped.slice(0, 10)
      },
      preview: {
        headline: "전적 분석 identity mismatch 정리 미리보기",
        items: [
          { label: "대상", value: "processed_match_telemetry" },
          { label: "조건", value: "match_id + platform + player_id 대상 row 재검증 후 삭제" },
          { label: "요청 targets", value: `${targets.length.toLocaleString("ko-KR")}개` },
          { label: "현재 삭제 가능", value: `${validCount.toLocaleString("ko-KR")}개` },
          { label: "스킵 예정", value: `${skippedCount.toLocaleString("ko-KR")}개` }
        ],
        bodyPreview: trimText(JSON.stringify({
          samples: payload.samples || [],
          targets: targets.slice(0, 10),
          skipped: validation.skipped.slice(0, 5)
        }, null, 2), 1200),
        warnings: [
          "원본 match_master_telemetry와 R2 텔레메트리는 삭제하지 않습니다.",
          "승인 직전에도 현재 row가 identity mismatch인지 다시 검증합니다.",
          "연막/회복 집계값 오염 가능성은 이 작업으로 삭제하지 않습니다.",
          ...(validCount === 0 ? ["현재 삭제 가능한 mismatch target이 없습니다. 승인하지 말고 거절하세요."] : [])
        ]
      },
      checklist: cacheChecklist([
        targets.length ? `요청 targets: ${targets.length.toLocaleString("ko-KR")}개` : "삭제 대상 targets가 없습니다.",
        `현재 재검증된 mismatch target: ${validCount.toLocaleString("ko-KR")}개`,
        skippedCount ? `스킵 예정 target: ${skippedCount.toLocaleString("ko-KR")}개` : "스킵 예정 target 없음",
        "삭제는 processed_match_telemetry 캐시 row에만 제한됩니다."
      ], targets.length === 0 || validCount === 0)
    };
  }

  if (actionType === "save_agent_memory") {
    const body = String(payload.body || "");
    return {
      risk: "medium",
      summary: `운영 기억 "${payload.title || "제목 없음"}" 저장 대기`,
      details: {
        category: payload.category || "incident",
        title: payload.title || null,
        bodyLength: body.length,
        tags: payload.metadata?.tags || []
      },
      preview: {
        headline: "운영 기억 저장 미리보기",
        items: [
          { label: "제목", value: String(payload.title || "제목 없음") },
          { label: "카테고리", value: String(payload.category || "incident") },
          { label: "본문 길이", value: `${body.length.toLocaleString("ko-KR")}자` },
          { label: "태그", value: payload.metadata?.tags?.length ? payload.metadata.tags.join(", ") : "없음" }
        ],
        bodyPreview: trimText(body, 500),
        warnings: payload.metadata?.tags?.length ? [] : ["태그가 없으면 이후 검색성이 낮아질 수 있습니다."]
      },
      checklist: [
        {
          label: "분류",
          status: "pass",
          message: `${payload.category || "incident"} memory로 저장됩니다.`
        },
        {
          label: "본문",
          status: body.length >= 20 ? "pass" : "review",
          message: `${body.length.toLocaleString("ko-KR")}자. 너무 짧으면 나중에 재사용하기 어렵습니다.`
        },
        {
          label: "검색성",
          status: payload.metadata?.tags?.length ? "pass" : "review",
          message: payload.metadata?.tags?.length ? `tags: ${payload.metadata.tags.join(", ")}` : "태그가 없으면 검색성이 낮아질 수 있습니다."
        }
      ]
    };
  }

  if (actionType === "save_agent_report") {
    const body = String(payload.body || "");
    const report = buildReportImpactContext(payload, body);
    return {
      risk: "low",
      summary: `${report.sourceLabel} "${payload.title || "제목 없음"}" 저장 대기 (${report.severity})`,
      details: {
        category: payload.category || "report",
        title: payload.title || null,
        bodyLength: body.length,
        source: report.source,
        sourceLabel: report.sourceLabel,
        severity: report.severity,
        windowHours: report.windowHours,
        summary: report.summary
      },
      preview: {
        headline: `${report.sourceLabel} 저장 미리보기`,
        items: [
          { label: "제목", value: String(payload.title || "제목 없음") },
          { label: "종류", value: report.sourceLabel },
          { label: "심각도", value: String(report.severity) },
          { label: "점검 범위", value: report.windowHours ? `${report.windowHours}시간` : "unknown" },
          { label: "본문 길이", value: `${body.length.toLocaleString("ko-KR")}자` },
          ...report.items
        ],
        bodyPreview: trimText(body, 500),
        warnings: report.warnings
      },
      checklist: [
        {
          label: "리포트 종류",
          status: "pass",
          message: `${report.sourceLabel}로 저장됩니다.`
        },
        {
          label: "심각도",
          status: report.severity === "critical" ? "warning" : report.severity === "warn" ? "review" : "pass",
          message: `severity: ${report.severity}`
        },
        {
          label: "본문",
          status: body.length >= 20 ? "pass" : "review",
          message: `${body.length.toLocaleString("ko-KR")}자. 너무 짧으면 기록 가치가 낮아질 수 있습니다.`
        },
        {
          label: "저장 위치",
          status: "pass",
          message: "agent_memories report 카테고리에 저장됩니다."
        }
      ]
    };
  }

  return {
    risk: "medium",
    summary: `${actionType} 작업은 관리자 승인이 필요합니다.`,
    details: { payload },
    preview: {
      headline: "알 수 없는 승인 작업",
      items: [
        { label: "Action", value: actionType },
        { label: "Payload keys", value: Object.keys(payload || {}).join(", ") || "없음" }
      ],
      bodyPreview: trimText(JSON.stringify(payload || {}, null, 2), 500),
      warnings: ["실행 경로와 payload를 수동으로 확인한 뒤 승인하세요."]
    },
    checklist: [
      {
        label: "수동 검토",
        status: "review",
        message: "알 수 없는 승인 작업입니다. payload와 실행 경로를 확인한 뒤 승인하세요."
      }
    ]
  };
}

function buildReportImpactContext(payload: Record<string, any>, body: string) {
  const metadata = payload.metadata || {};
  const source = String(
    metadata.source
      || (metadata.commandCenter ? "command-center-digest" : metadata.handoff ? "handoff-packet" : metadata.timeline ? "incident-timeline" : metadata.snapshot ? "manual-monitor-snapshot" : "briefing-api")
  );
  const briefing = metadata.briefing || {};
  const snapshot = metadata.snapshot || {};
  const timeline = metadata.timeline || {};
  const handoff = metadata.handoff || {};
  const commandCenter = metadata.commandCenter || {};
  const hasCommandCenter = Boolean(metadata.commandCenter);
  const sourceLabel = getReportSourceLabel(source);
  const severity = String(
    handoff.severity
      || timeline.severity
      || snapshot.severity
      || commandCenter.severity
      || briefing.severity
      || "unknown"
  );
  const windowHours = Number(
    handoff.windowHours
      || timeline.windowHours
      || snapshot.windowHours
      || briefing.windowHours
      || 0
  ) || null;
  const summary = hasCommandCenter ? commandCenter : handoff.incidentSummary || timeline.summary || briefing.summary || snapshot.summary || null;
  const items = buildReportSourceItems(source, { snapshot, timeline, handoff, commandCenter, briefing, summary });
  const warnings = [
    ...(severity === "critical" ? ["critical 리포트입니다. 후속 조치 기록까지 함께 남기는 것을 권장합니다."] : []),
    ...(source === "incident-timeline" ? ["사고 타임라인은 승인 후 report memory로 남습니다. 외부 공유 전 민감한 내부 링크를 확인하세요."] : []),
    ...(source === "handoff-packet" ? ["운영 인수인계는 승인 후 report memory로 남습니다. 교대 담당자가 바로 이어 볼 수 있는지 확인하세요."] : []),
    ...(source === "command-center-digest" || source === "command-center-summary" ? ["운영 커맨드센터 snapshot은 승인 후 report memory로 남습니다. 공유 전 내부 수치를 확인하세요."] : []),
    ...(body.length < 20 ? ["본문이 짧습니다. 기록으로 남길 가치가 충분한지 확인하세요."] : [])
  ];

  return {
    source,
    sourceLabel,
    severity,
    windowHours,
    summary,
    items,
    warnings
  };
}

function getReportSourceLabel(source: string) {
  if (source === "manual-monitor-snapshot") return "수동 운영 점검 리포트";
  if (source === "incident-timeline") return "사고 타임라인 리포트";
  if (source === "handoff-packet") return "운영 인수인계 리포트";
  if (source === "command-center-digest") return "일일 운영 Digest 리포트";
  if (source === "command-center-summary") return "운영 커맨드센터 리포트";
  if (source === "briefing-api") return "운영 브리핑 리포트";
  return "운영 리포트";
}

function buildReportSourceItems(
  source: string,
  input: {
    snapshot: Record<string, any>;
    timeline: Record<string, any>;
    handoff: Record<string, any>;
    commandCenter: Record<string, any>;
    briefing: Record<string, any>;
    summary: Record<string, any> | null;
  }
) {
  if (source === "manual-monitor-snapshot") {
    const alerts = Array.isArray(input.snapshot.alerts) ? input.snapshot.alerts.length : 0;
    const recommendations = Array.isArray(input.snapshot.recommendations) ? input.snapshot.recommendations.length : 0;
    const gates = input.snapshot.approvalGateSummary || {};
    const checkout = input.snapshot.dailyCheckout || {};
    const topAction = Array.isArray(input.snapshot.nextActions) ? input.snapshot.nextActions[0] || {} : {};
    return [
      { label: "Alert", value: `${alerts.toLocaleString("ko-KR")}건` },
      { label: "권장 조치", value: `${recommendations.toLocaleString("ko-KR")}건` },
      { label: "Gate pass/review/block", value: `${Number(gates.passCount || 0).toLocaleString("ko-KR")}/${Number(gates.reviewCount || 0).toLocaleString("ko-KR")}/${Number(gates.blockCount || 0).toLocaleString("ko-KR")}` },
      { label: "Daily Checkout", value: `${checkout.label || checkout.status || "unknown"} (${Number(checkout.score || 0).toLocaleString("ko-KR")}/100)` },
      { label: "Top Action", value: String(topAction.title || topAction.id || "없음") }
    ];
  }

  if (source === "incident-timeline") {
    const summary = input.timeline.summary || input.summary || {};
    return [
      { label: "이벤트", value: `${Number(summary.totalEvents || 0).toLocaleString("ko-KR")}건` },
      { label: "Critical/Warn", value: `${Number(summary.criticalEvents || 0).toLocaleString("ko-KR")}/${Number(summary.warnEvents || 0).toLocaleString("ko-KR")}` },
      { label: "실패 run/step", value: `${Number(summary.failedRuns || 0).toLocaleString("ko-KR")}/${Number(summary.failedSteps || 0).toLocaleString("ko-KR")}` },
      { label: "PUBG API 에러", value: `${Number(summary.apiErrors || 0).toLocaleString("ko-KR")}건` },
      { label: "관련 승인", value: `${Number(summary.approvals || 0).toLocaleString("ko-KR")}건` }
    ];
  }

  if (source === "handoff-packet") {
    const pending = input.handoff.pendingApprovals || {};
    const incident = input.handoff.incidentSummary || input.summary || {};
    return [
      { label: "승인 대기", value: `${Number(pending.count || 0).toLocaleString("ko-KR")}건` },
      { label: "고위험/오래됨", value: `${Number(pending.highRiskCount || 0).toLocaleString("ko-KR")}/${Number(pending.staleCount || 0).toLocaleString("ko-KR")}` },
      { label: "사고 이벤트", value: `${Number(incident.totalEvents || 0).toLocaleString("ko-KR")}건` },
      { label: "Critical/Warn", value: `${Number(incident.criticalEvents || 0).toLocaleString("ko-KR")}/${Number(incident.warnEvents || 0).toLocaleString("ko-KR")}` }
    ];
  }

  if (source === "command-center-digest" || source === "command-center-summary") {
    const pending = input.commandCenter.pendingApprovals || {};
    const gates = input.commandCenter.approvalGateSummary || {};
    const mode = input.commandCenter.operatingMode || {};
    const improvement = input.commandCenter.improvementBacklog || {};
    const capability = input.commandCenter.capabilityMatrix || {};
    const operatorValue = input.commandCenter.operatorValue || {};
    const growthRoadmap = input.commandCenter.growthRoadmap || {};
    const ownerBrief = input.commandCenter.ownerBrief || {};
    const checkout = input.commandCenter.dailyCheckout || {};
    const actionBoard = input.commandCenter.todayActionBoard || {};
    const monitor = input.commandCenter.latestMonitorSnapshot || {};
    const monitorGates = monitor.approvalGateSummary || {};
    return [
      { label: "운영 모드", value: String(mode.label || mode.mode || "unknown") },
      { label: "Attention", value: `${Number(mode.score || 0).toLocaleString("ko-KR")}/100` },
      { label: "Maturity", value: `${Number(improvement.score || 0).toLocaleString("ko-KR")}/100 (${improvement.label || "unknown"})` },
      { label: "Capability", value: `${Number(capability.score || 0).toLocaleString("ko-KR")}/100 (${capability.label || "unknown"})` },
      { label: "Operator Value", value: `${Number(operatorValue.score || 0).toLocaleString("ko-KR")}/100 (${operatorValue.label || "unknown"})` },
      { label: "Growth Roadmap", value: `${growthRoadmap.status || "unknown"} / ${growthRoadmap.primaryPrompt || "-"}` },
      { label: "Owner Brief", value: `${ownerBrief.status || "unknown"} / ${ownerBrief.doNow?.title || "-"}` },
      { label: "Daily Checkout", value: `${checkout.label || checkout.status || "unknown"} (${Number(checkout.score || 0).toLocaleString("ko-KR")}/100)` },
      { label: "Today Action Board", value: `${actionBoard.status || "unknown"} / do now ${Number(actionBoard.doNowCount || 0).toLocaleString("ko-KR")} / review ${Number(actionBoard.reviewCount || 0).toLocaleString("ko-KR")}` },
      { label: "Latest Monitor", value: `${monitor.severity || "unknown"} / alerts ${Number(monitor.alertCount || 0).toLocaleString("ko-KR")}건 / gate block ${Number(monitorGates.blockCount || 0).toLocaleString("ko-KR")}` },
      { label: "승인 대기", value: `${Number(pending.count || 0).toLocaleString("ko-KR")}건` },
      { label: "Gate pass/review/block", value: `${Number(gates.passCount || 0).toLocaleString("ko-KR")}/${Number(gates.reviewCount || 0).toLocaleString("ko-KR")}/${Number(gates.blockCount || 0).toLocaleString("ko-KR")}` }
    ];
  }

  return [
    { label: "브리핑 데이터", value: input.briefing ? "포함" : "없음" }
  ];
}

function htmlToPlainText(value: string) {
  return trimText(
    normalizeText(value),
    500
  );
}

function normalizeText(value: string) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function cacheChecklist(messages: string[], hasWarning?: unknown): ApprovalImpactChecklistItem[] {
  return messages.map((message, index) => ({
    label: index === 0 ? "대상 확인" : index === 1 ? "영향 범위" : "실행 주의",
    status: hasWarning && index < 2 ? "warning" : index === 0 ? "review" : "pass",
    message
  }));
}

async function countRows(
  supabase: any,
  table: string,
  column?: string,
  value?: string,
  operator: "eq" | "lt" = "eq"
) {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (column && value !== undefined) query = operator === "lt" ? query.lt(column, value) : query.eq(column, value);

  const { count, error } = await query;
  if (error) return { count: 0, error: error.message };
  return { count: count || 0 };
}

async function countMatchCacheRows(supabase: any, matchId: string, nickname: string | null) {
  let query = supabase
    .from("processed_match_telemetry")
    .select("*", { count: "exact", head: true })
    .eq("match_id", matchId);
  if (nickname) query = query.eq("player_id", nickname);

  const { count, error } = await query;
  if (error) return { count: 0, error: error.message };
  return { count: count || 0 };
}
