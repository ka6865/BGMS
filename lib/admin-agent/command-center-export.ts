export function buildCommandCenterMarkdown(commandCenter: any) {
  const lines = [
    "# BGMS Agent Command Center",
    "",
    `- Generated: ${formatDate(commandCenter.generatedAt)}`,
    `- Severity: ${commandCenter.severity}`,
    `- Pending approvals: ${commandCenter.pendingApprovals?.count || 0}`,
    `- High/Stale approvals: ${commandCenter.pendingApprovals?.highRiskCount || 0}/${commandCenter.pendingApprovals?.staleCount || 0}`,
    `- Approval gates pass/review/block: ${commandCenter.approvalGateSummary?.passCount || 0}/${commandCenter.approvalGateSummary?.reviewCount || 0}/${commandCenter.approvalGateSummary?.blockCount || 0}`,
    `- Failed runs: ${commandCenter.failedRuns?.count || 0}`,
    `- PUBG API errors: ${commandCenter.apiErrors?.total || 0}`,
    `- AI cost: $${Number(commandCenter.aiUsage?.totalCostUsd || 0).toFixed(6)}`,
    `- Deployment: ${commandCenter.deploymentHealth?.message || "not checked"}`,
    `- Capability: ${commandCenter.capabilityMatrix?.score ?? 0}/100 (${commandCenter.capabilityMatrix?.label || "unknown"})`,
    `- Operator value: ${commandCenter.operatorValue?.score ?? 0}/100 (${commandCenter.operatorValue?.label || "unknown"})`,
    `- Growth roadmap: ${commandCenter.growthRoadmap?.status || "unknown"}`,
    `- Owner brief: ${commandCenter.ownerBrief?.status || "unknown"} / ${commandCenter.ownerBrief?.headline || "none"}`,
    `- Automation: ${commandCenter.automationContracts?.summary || "not mapped"}`,
    `- Operating SOP: ${commandCenter.operatingSop?.status || "unknown"} / ${commandCenter.operatingSop?.title || "none"}`,
    `- Risk radar: ${commandCenter.riskRadar?.status || "unknown"} / ${commandCenter.riskRadar?.score ?? 0}/100`,
    `- Decision trace: ${commandCenter.decisionTrace?.confidence || "unknown"} / ${commandCenter.decisionTrace?.summary || "none"}`,
    `- Safety audit: ${commandCenter.safetyAudit?.status || "unknown"} / ${commandCenter.safetyAudit?.score ?? 0}/100`,
    `- Approval advisor: ${commandCenter.approvalAdvisor?.status || "unknown"} / approve ${commandCenter.approvalAdvisor?.counts?.approve ?? 0}, defer ${commandCenter.approvalAdvisor?.counts?.defer ?? 0}, reject ${commandCenter.approvalAdvisor?.counts?.reject ?? 0}`,
    `- Mission control: ${commandCenter.missionControl?.status || "unknown"} / ${commandCenter.missionControl?.summary || "none"}`,
    `- Owner inbox: ${commandCenter.ownerInbox?.status || "unknown"} / ${commandCenter.ownerInbox?.summary || "none"}`,
    `- Outcome review: ${commandCenter.outcomeReview?.status || "unknown"} / ${commandCenter.outcomeReview?.score ?? 0}/100`,
    `- Operator coach: ${commandCenter.operatorCoach?.mode || "unknown"} / ${commandCenter.operatorCoach?.summary || "none"}`,
    `- Launch kit: ${commandCenter.launchKit?.status || "unknown"} / ${commandCenter.launchKit?.summary || "none"}`,
    `- Final readiness: ${commandCenter.finalReadiness?.status || "unknown"} / ${commandCenter.finalReadiness?.score ?? 0}/100`,
    `- Monitor trend: ${commandCenter.monitorTrend?.label || "unknown"} / ${commandCenter.monitorTrend?.summary || "none"}`,
    `- Latest report: ${getLatestReportTitle(commandCenter.latestReport?.item)}`,
    "",
    "## Owner Brief",
    ...formatOwnerBrief(commandCenter.ownerBrief),
    "",
    "## Operating Mode",
    ...formatOperatingMode(commandCenter.operatingMode),
    "",
    "## Daily Checkout",
    ...formatDailyCheckout(commandCenter.dailyCheckout),
    "",
    "## Today Action Board",
    ...formatTodayActionBoard(commandCenter.todayActionBoard),
    "",
    "## Thresholds",
    ...formatThresholds(commandCenter.thresholds),
    "",
    "## Latest Agent Run",
    ...formatLatestRun(commandCenter.latestRun),
    "",
    "## Latest Monitor Snapshot",
    ...formatLatestMonitorSnapshot(commandCenter.latestMonitorSnapshot),
    "",
    "## Monitor Trend",
    ...formatMonitorTrend(commandCenter.monitorTrend),
    "",
    "## Approval Queue",
    ...(commandCenter.pendingApprovals?.items?.length
      ? commandCenter.pendingApprovals.items.slice(0, 5).map((approval: any) => {
        const label = approval.payload?.title || approval.payload?.cleanupType || approval.action_type;
        const stale = approval.isStale ? ", stale" : "";
        return `- [${approval.priority}${stale}] ${approval.action_type}: ${label} (${approval.ageHours || 0}h old)`;
      })
      : ["- No pending approvals."]),
    ...(commandCenter.approvalGateSummary?.blockCount
      ? [
        "- Blocked approval gates:",
        ...commandCenter.approvalGateSummary.items
          .filter((item: any) => item.gate?.status === "block")
          .slice(0, 5)
          .map((item: any) => `  - ${item.actionType}: ${item.title} / ${item.gate.reasons.join(", ")}`)
      ]
      : []),
    "",
    "## Current Signals",
    `- API errors: ${commandCenter.apiErrors?.total || 0}`,
    `- Failed agent runs: ${commandCenter.failedRuns?.count || 0}`,
    `- AI requests/cost: ${commandCenter.aiUsage?.totalRequests || 0} / $${Number(commandCenter.aiUsage?.totalCostUsd || 0).toFixed(6)}`,
    `- Content: ${commandCenter.contentPerformance?.totalPosts || 0} posts, ${commandCenter.contentPerformance?.totalViews || 0} views`,
    `- Top content: ${commandCenter.contentPerformance?.topPost?.title || "none"}`,
    "",
    "## Next Best Actions",
    ...(commandCenter.nextActions?.length
      ? commandCenter.nextActions.map((action: any) => {
        const score = typeof action.urgencyScore === "number" ? ` score ${action.urgencyScore}` : "";
        const category = action.category ? ` / ${action.category}` : "";
        const checklist = action.checklist?.length
          ? `\n  - Check: ${action.checklist.slice(0, 2).join(" / ")}`
          : "";
        return `- [${action.priority}${score}${category}] ${action.title}: ${action.reason}\n  - Prompt: ${action.prompt}${checklist}`;
      })
      : ["- No recommended action."]),
    "",
    "## Agent Improvement Backlog",
    ...formatImprovementBacklog(commandCenter.improvementBacklog),
    "",
    "## Operator Value Scorecard",
    ...formatOperatorValue(commandCenter.operatorValue),
    "",
    "## Agent Growth Roadmap",
    ...formatGrowthRoadmap(commandCenter.growthRoadmap),
    "",
    "## Automation Contract",
    ...formatAutomationContracts(commandCenter.automationContracts),
    "",
    "## Operating SOP",
    ...formatOperatingSop(commandCenter.operatingSop),
    "",
    "## Risk Radar",
    ...formatRiskRadar(commandCenter.riskRadar),
    "",
    "## Decision Trace",
    ...formatDecisionTrace(commandCenter.decisionTrace),
    "",
    "## Safety Audit",
    ...formatSafetyAudit(commandCenter.safetyAudit),
    "",
    "## Approval Decision Advisor",
    ...formatApprovalAdvisor(commandCenter.approvalAdvisor),
    "",
    "## Mission Control",
    ...formatMissionControl(commandCenter.missionControl),
    "",
    "## Owner Inbox",
    ...formatOwnerInbox(commandCenter.ownerInbox),
    "",
    "## Outcome Review",
    ...formatOutcomeReview(commandCenter.outcomeReview),
    "",
    "## Operator Coach",
    ...formatOperatorCoach(commandCenter.operatorCoach),
    "",
    "## Agent Launch Kit",
    ...formatLaunchKit(commandCenter.launchKit),
    "",
    "## Final Readiness",
    ...formatFinalReadiness(commandCenter.finalReadiness),
    "",
    "## Capability Matrix",
    ...formatCapabilityMatrix(commandCenter.capabilityMatrix),
    "",
    "## Playbooks",
    ...(commandCenter.playbooks?.length
      ? commandCenter.playbooks.map((playbook: any) => `- ${playbook.title}: ${playbook.nextAction}`)
      : ["- No matched playbook."]),
    "",
    "## Latest Report",
    ...(commandCenter.latestReport?.item
      ? [
        `- ${getLatestReportTitle(commandCenter.latestReport.item)}`,
        `- Updated: ${formatDate(commandCenter.latestReport.item.updated_at)}`,
        `- Preview: ${truncateText(commandCenter.latestReport.item.body, 220)}`
      ]
      : ["- No saved report."]),
    "",
    "## Related Memories",
    ...(commandCenter.relatedMemories?.items?.length
      ? commandCenter.relatedMemories.items.map((memory: any) => `- ${memory.title} (${memory.category}): ${truncateText(memory.body, 120)}`)
      : ["- No related memory."]),
    "",
    "## Memory Suggestions",
    ...(commandCenter.memorySuggestions?.length
      ? commandCenter.memorySuggestions.map((item: any) => `- [${item.priority}] ${item.title}: ${item.reason}\n  - Prompt: ${item.prompt}`)
      : ["- No memory suggestion."]),
    "",
    "## Quick Prompts",
    ...(commandCenter.quickPrompts?.length
      ? commandCenter.quickPrompts.slice(0, 6).map((prompt: string) => `- ${prompt}`)
      : ["- No quick prompt."]),
    "",
    "## Readiness",
    `- Agent: ${commandCenter.readiness?.status || "unknown"}`,
    `- Rollout: ${commandCenter.rollout?.status || "unknown"}`,
    ...formatReadinessIssues(commandCenter.readiness, commandCenter.rollout),
    "",
    "확인 위치: `/admin/dashboard`"
  ];

  return lines.join("\n");
}

export function buildDailyDigestMarkdown(commandCenter: any) {
  const topAction = commandCenter.nextActions?.[0];
  const topBoardItem = commandCenter.todayActionBoard?.lanes?.doNow?.[0]
    || commandCenter.todayActionBoard?.lanes?.review?.[0]
    || null;
  const topImprovement = commandCenter.improvementBacklog?.items?.[0];
  const topSop = commandCenter.operatingSop?.procedures?.[0];
  const topRisk = commandCenter.riskRadar?.items?.[0];
  const topDecision = commandCenter.decisionTrace?.decisions?.[0];
  const topSafety = commandCenter.safetyAudit?.invariants?.find((item: any) => item.status !== "ok") || commandCenter.safetyAudit?.invariants?.[0];
  const topApprovalAdvice = commandCenter.approvalAdvisor?.items?.[0];
  const topMissionItem = commandCenter.missionControl?.items?.[0];
  const topInboxItem = commandCenter.ownerInbox?.lanes?.decide?.[0]
    || commandCenter.ownerInbox?.lanes?.approve?.[0]
    || commandCenter.ownerInbox?.lanes?.delegate?.[0]
    || commandCenter.ownerInbox?.lanes?.watch?.[0];
  const topOutcomeItem = commandCenter.outcomeReview?.items?.[0];
  const topCoachItem = commandCenter.operatorCoach?.items?.[0];
  const topLaunchRoutine = commandCenter.launchKit?.routines?.[0];
  const topFinalItem = commandCenter.finalReadiness?.items?.find((item: any) => item.status !== "pass") || commandCenter.finalReadiness?.items?.[0];
  const blockedGateCount = commandCenter.approvalGateSummary?.blockCount || 0;
  const lines = [
    "# BGMS Daily Ops Digest",
    "",
    `- Generated: ${formatDate(commandCenter.generatedAt)}`,
    `- Status: ${commandCenter.severity} / ${commandCenter.operatingMode?.label || "unknown"}`,
    `- Attention: ${commandCenter.operatingMode?.score ?? 0}/100`,
    `- Maturity: ${commandCenter.improvementBacklog?.score ?? 0}/100 (${commandCenter.improvementBacklog?.label || "unknown"})`,
    `- Capability: ${commandCenter.capabilityMatrix?.score ?? 0}/100 (${commandCenter.capabilityMatrix?.label || "unknown"})`,
    `- Operator value: ${commandCenter.operatorValue?.score ?? 0}/100 (${commandCenter.operatorValue?.label || "unknown"})`,
    `- Roadmap: ${commandCenter.growthRoadmap?.status || "unknown"} / ${commandCenter.growthRoadmap?.summary || "none"}`,
    `- Owner brief: ${commandCenter.ownerBrief?.headline || "none"}`,
    `- Automation: ${commandCenter.automationContracts?.summary || "not mapped"}`,
    `- SOP: ${commandCenter.operatingSop?.title || "none"}`,
    `- Risk radar: ${commandCenter.riskRadar?.status || "unknown"} (${commandCenter.riskRadar?.score ?? 0}/100)`,
    `- Decision trace: ${commandCenter.decisionTrace?.confidence || "unknown"}`,
    `- Safety audit: ${commandCenter.safetyAudit?.status || "unknown"} (${commandCenter.safetyAudit?.score ?? 0}/100)`,
    `- Approval advisor: ${commandCenter.approvalAdvisor?.status || "unknown"} (${commandCenter.approvalAdvisor?.summary || "none"})`,
    `- Mission control: ${commandCenter.missionControl?.status || "unknown"} (${commandCenter.missionControl?.summary || "none"})`,
    `- Owner inbox: ${commandCenter.ownerInbox?.status || "unknown"} (${commandCenter.ownerInbox?.summary || "none"})`,
    `- Outcome review: ${commandCenter.outcomeReview?.status || "unknown"} (${commandCenter.outcomeReview?.score ?? 0}/100)`,
    `- Operator coach: ${commandCenter.operatorCoach?.mode || "unknown"} (${commandCenter.operatorCoach?.summary || "none"})`,
    `- Launch kit: ${commandCenter.launchKit?.status || "unknown"} (${commandCenter.launchKit?.firstPrompt || "no first prompt"})`,
    `- Final readiness: ${commandCenter.finalReadiness?.status || "unknown"} (${commandCenter.finalReadiness?.score ?? 0}/100)`,
    `- Monitor trend: ${commandCenter.monitorTrend?.label || "unknown"} / ${commandCenter.monitorTrend?.summary || "none"}`,
    `- Checkout: ${commandCenter.dailyCheckout?.label || "unknown"} (${commandCenter.dailyCheckout?.score ?? 0}/100)`,
    `- Action board: ${commandCenter.todayActionBoard?.summary || "none"}`,
    "",
    "## Snapshot",
    `- Approvals: ${commandCenter.pendingApprovals?.count || 0} pending, high ${commandCenter.pendingApprovals?.highRiskCount || 0}, stale ${commandCenter.pendingApprovals?.staleCount || 0}, gate block ${blockedGateCount}`,
    `- Incidents: API errors ${commandCenter.apiErrors?.total || 0}, failed agent runs ${commandCenter.failedRuns?.count || 0}`,
    `- AI: ${commandCenter.aiUsage?.totalRequests || 0} requests / $${Number(commandCenter.aiUsage?.totalCostUsd || 0).toFixed(6)}`,
    `- Deploy: ${commandCenter.deploymentHealth?.message || "not checked"}`,
    `- Latest monitor: ${formatMonitorDigest(commandCenter.latestMonitorSnapshot)}`,
    `- Content: ${commandCenter.contentPerformance?.totalPosts || 0} posts, top "${commandCenter.contentPerformance?.topPost?.title || "none"}"`,
    "",
    "## Do First",
    topBoardItem
      ? `- Board: [${topBoardItem.priority} score ${topBoardItem.score}] ${topBoardItem.title}: ${topBoardItem.reason}`
      : "- Board: No immediate board item.",
    commandCenter.ownerBrief?.doNow
      ? `- Owner: ${commandCenter.ownerBrief.doNow.title}: ${commandCenter.ownerBrief.doNow.prompt}`
      : "",
    topAction
      ? `- [${topAction.priority}${typeof topAction.urgencyScore === "number" ? ` score ${topAction.urgencyScore}` : ""}] ${topAction.title}: ${topAction.reason}`
      : "- No immediate action.",
    ...(topAction?.checklist?.length ? topAction.checklist.slice(0, 2).map((item: string) => `  - Check: ${item}`) : []),
    topAction?.prompt ? `- Prompt: ${topAction.prompt}` : "",
    topSop
      ? `- SOP: [${topSop.severity}/${topSop.risk}] ${topSop.title}: ${topSop.nextPrompt}`
      : "- SOP: No procedure.",
    topRisk
      ? `- Risk: [${topRisk.severity} score ${topRisk.score}] ${topRisk.title}: ${topRisk.prompt}`
      : "- Risk: No risk radar item.",
    topDecision
      ? `- Decision: [${topDecision.confidence}] ${topDecision.title}: ${topDecision.prompt}`
      : "- Decision: No trace decision.",
    topSafety
      ? `- Safety: [${topSafety.status}] ${topSafety.label}: ${topSafety.action}`
      : "- Safety: No safety invariant.",
    topApprovalAdvice
      ? `- Approval advice: [${topApprovalAdvice.decision}/${topApprovalAdvice.priority}] ${topApprovalAdvice.title}: ${topApprovalAdvice.prompt}`
      : "- Approval advice: No pending approval.",
    topMissionItem
      ? `- Mission: [${topMissionItem.phase}/${topMissionItem.priority}] ${topMissionItem.title}: ${topMissionItem.command}`
      : "- Mission: No mission control item.",
    topInboxItem
      ? `- Inbox: [${topInboxItem.lane}/${topInboxItem.priority}] ${topInboxItem.title}: ${topInboxItem.action}`
      : "- Inbox: No owner inbox item.",
    topOutcomeItem
      ? `- Outcome: [${topOutcomeItem.status}/${topOutcomeItem.priority}] ${topOutcomeItem.title}: ${topOutcomeItem.prompt}`
      : "- Outcome: No outcome review item.",
    topCoachItem
      ? `- Coach: [${topCoachItem.priority}] ${topCoachItem.title}: ${topCoachItem.prompt}`
      : "- Coach: No coach item.",
    commandCenter.launchKit?.firstPrompt
      ? `- Launch: ${commandCenter.launchKit.firstPrompt}`
      : "- Launch: No launch kit prompt.",
    topFinalItem
      ? `- Final readiness: [${topFinalItem.status}/${topFinalItem.score}] ${topFinalItem.title}: ${topFinalItem.prompt}`
      : "- Final readiness: No readiness item.",
    commandCenter.dailyCheckout?.summary ? `- Checkout: ${commandCenter.dailyCheckout.summary}` : "",
    "",
    "## Improve Next",
    topImprovement
      ? `- [${topImprovement.priority}] ${topImprovement.title}: ${topImprovement.action}`
      : "- No improvement item.",
    commandCenter.capabilityMatrix?.items?.find((item: any) => item.status !== "ready")
      ? `- Capability: ${commandCenter.capabilityMatrix.items.find((item: any) => item.status !== "ready").label}: ${commandCenter.capabilityMatrix.items.find((item: any) => item.status !== "ready").nextStep}`
      : "- Capability: all tracked capabilities ready.",
    commandCenter.operatorValue?.nextLeverage?.[0]
      ? `- Operator value: ${commandCenter.operatorValue.nextLeverage[0].title}: ${commandCenter.operatorValue.nextLeverage[0].prompt}`
      : "- Operator value: no leverage item.",
    commandCenter.growthRoadmap?.primaryPrompt
      ? `- Roadmap: ${commandCenter.growthRoadmap.primaryPrompt}`
      : "- Roadmap: no primary prompt.",
    commandCenter.automationContracts?.contracts?.[0]
      ? `- Automation: ${commandCenter.automationContracts.contracts[0].title}: ${commandCenter.automationContracts.contracts[0].guardrail}`
      : "- Automation: no contract data.",
    commandCenter.operatingSop?.primaryPrompt
      ? `- SOP: ${commandCenter.operatingSop.primaryPrompt}`
      : "- SOP: no primary prompt.",
    commandCenter.riskRadar?.primaryPrompt
      ? `- Risk radar: ${commandCenter.riskRadar.primaryPrompt}`
      : "- Risk radar: no primary prompt.",
    commandCenter.decisionTrace?.verifyNext?.[0]
      ? `- Decision trace: ${commandCenter.decisionTrace.verifyNext[0]}`
      : "- Decision trace: no verify prompt.",
    commandCenter.safetyAudit?.primaryPrompt
      ? `- Safety audit: ${commandCenter.safetyAudit.primaryPrompt}`
      : "- Safety audit: no primary prompt.",
    commandCenter.approvalAdvisor?.primaryPrompt
      ? `- Approval advisor: ${commandCenter.approvalAdvisor.primaryPrompt}`
      : "- Approval advisor: no primary prompt.",
    commandCenter.missionControl?.firstCommand
      ? `- Mission control: ${commandCenter.missionControl.firstCommand}`
      : "- Mission control: no first command.",
    commandCenter.ownerInbox?.primaryAction
      ? `- Owner inbox: ${commandCenter.ownerInbox.primaryAction}`
      : "- Owner inbox: no primary action.",
    commandCenter.outcomeReview?.primaryPrompt
      ? `- Outcome review: ${commandCenter.outcomeReview.primaryPrompt}`
      : "- Outcome review: no primary prompt.",
    commandCenter.operatorCoach?.topPrompt
      ? `- Operator coach: ${commandCenter.operatorCoach.topPrompt}`
      : "- Operator coach: no top prompt.",
    topLaunchRoutine
      ? `- Launch routine: ${topLaunchRoutine.title}: ${topLaunchRoutine.steps?.[0]?.prompt || topLaunchRoutine.steps?.[0]?.label || topLaunchRoutine.why}`
      : "- Launch routine: no launch routine.",
    commandCenter.finalReadiness?.remainingWork?.[0]
      ? `- Final gap: ${commandCenter.finalReadiness.remainingWork[0]}`
      : "- Final gap: no remaining work listed.",
    commandCenter.monitorTrend
      ? `- Trend: ${commandCenter.monitorTrend.recommendation}`
      : "- Trend: no monitor trend data.",
    "",
    "## Notes",
    ...(blockedGateCount > 0 ? ["- Execution Gate block 요청은 승인하지 말고 필수 대상값을 채워 재생성하세요."] : []),
    ...(commandCenter.relatedMemories?.items?.[0] ? [`- Related memory: ${commandCenter.relatedMemories.items[0].title}`] : []),
    ...(commandCenter.memorySuggestions?.[0] ? [`- Memory suggestion: ${commandCenter.memorySuggestions[0].title}`] : []),
    `- 확인 위치: /admin/dashboard`
  ].filter(Boolean);

  return lines.join("\n");
}

export function buildFinalReadinessMarkdown(commandCenter: any) {
  const lines = [
    "# BGMS Admin Agent Final Readiness Report",
    "",
    `- Generated: ${formatDate(commandCenter.generatedAt)}`,
    `- Final status: ${commandCenter.finalReadiness?.status || "unknown"} (${commandCenter.finalReadiness?.score ?? 0}/100)`,
    `- Summary: ${commandCenter.finalReadiness?.summary || "none"}`,
    `- Launch status: ${commandCenter.launchKit?.status || "unknown"}`,
    `- First prompt: ${commandCenter.launchKit?.firstPrompt || "none"}`,
    `- Safety audit: ${commandCenter.safetyAudit?.status || "unknown"} (${commandCenter.safetyAudit?.score ?? 0}/100)`,
    `- Approval advisor: ${commandCenter.approvalAdvisor?.status || "unknown"}`,
    `- Capability: ${commandCenter.capabilityMatrix?.score ?? 0}/100 (${commandCenter.capabilityMatrix?.label || "unknown"})`,
    `- Monitor trend: ${commandCenter.monitorTrend?.label || "unknown"} / ${commandCenter.monitorTrend?.summary || "none"}`,
    "",
    "## Final Readiness Evidence",
    ...formatFinalReadiness(commandCenter.finalReadiness),
    "",
    "## Launch Kit",
    ...formatLaunchKit(commandCenter.launchKit),
    "",
    "## Safety Proof",
    ...formatSafetyAudit(commandCenter.safetyAudit),
    "",
    "## Approval Proof",
    ...formatApprovalAdvisor(commandCenter.approvalAdvisor),
    "",
    "## Capability Proof",
    ...formatCapabilityMatrix(commandCenter.capabilityMatrix),
    "",
    "## Automation Guardrails",
    ...formatAutomationContracts(commandCenter.automationContracts),
    "",
    "## Operator Value",
    ...formatOperatorValue(commandCenter.operatorValue),
    "",
    "## Recommended Proof Prompts",
    ...(commandCenter.finalReadiness?.proofPrompts?.length
      ? commandCenter.finalReadiness.proofPrompts.map((prompt: string) => `- ${prompt}`)
      : ["- No proof prompt."]),
    "",
    "확인 위치: `/admin/dashboard`"
  ];

  return lines.join("\n");
}

function formatImprovementBacklog(backlog?: any) {
  if (!backlog) return ["- No improvement backlog data."];
  return [
    `- Score: ${backlog.score}/100 (${backlog.label})`,
    `- Summary: ${backlog.summary}`,
    ...(backlog.items?.length
      ? backlog.items.map((item: any) => `- [${item.priority}] ${item.title} (${item.owner}): ${item.reason}\n  - Action: ${item.action}`)
      : ["- No backlog item."])
  ];
}

function formatOwnerBrief(brief?: any) {
  if (!brief) return ["- No owner brief data."];
  return [
    `- Status: ${brief.status || "unknown"} / confidence ${brief.confidence ?? 0}%`,
    `- Headline: ${brief.headline || "-"}`,
    `- Summary: ${brief.summary || "-"}`,
    `- Do now: ${brief.doNow?.title || "-"} / ${brief.doNow?.prompt || "-"}`,
    ...(brief.needsOwnerReview?.length
      ? [
        "- Owner review:",
        ...brief.needsOwnerReview.map((item: any) => `  - ${item.title}: ${item.reason} (${item.location})`)
      ]
      : ["- Owner review: none"]),
    ...(brief.delegateToAgent?.length
      ? [
        "- Delegate to agent:",
        ...brief.delegateToAgent.map((item: any) => `  - ${item.title}: ${item.prompt}`)
      ]
      : [])
  ];
}

function formatCapabilityMatrix(matrix?: any) {
  if (!matrix) return ["- No capability matrix data."];
  return [
    `- Score: ${matrix.score}/100 (${matrix.label})`,
    `- Summary: ${matrix.summary}`,
    ...(matrix.items?.length
      ? matrix.items.map((item: any) => `- [${item.status} ${item.score}/100] ${item.label}: ${item.nextStep}`)
      : ["- No capability item."])
  ];
}

function formatOperatorValue(scorecard?: any) {
  if (!scorecard) return ["- No operator value scorecard data."];
  return [
    `- Score: ${scorecard.score}/100 (${scorecard.label})`,
    `- Summary: ${scorecard.summary}`,
    ...(scorecard.metrics?.length
      ? scorecard.metrics.map((metric: any) => `- ${metric.label}: ${metric.value} (${metric.score}/100) - ${metric.detail}`)
      : ["- No scorecard metric."]),
    ...(scorecard.nextLeverage?.[0]
      ? [`- Next leverage: ${scorecard.nextLeverage[0].title} / ${scorecard.nextLeverage[0].prompt}`]
      : [])
  ];
}

function formatGrowthRoadmap(roadmap?: any) {
  if (!roadmap) return ["- No growth roadmap data."];
  return [
    `- Status: ${roadmap.status || "unknown"}`,
    `- Summary: ${roadmap.summary || "-"}`,
    `- Primary prompt: ${roadmap.primaryPrompt || "-"}`,
    ...formatRoadmapLane("Now", roadmap.lanes?.now),
    ...formatRoadmapLane("This week", roadmap.lanes?.thisWeek),
    ...formatRoadmapLane("Later", roadmap.lanes?.later)
  ];
}

function formatAutomationContracts(contracts?: any) {
  if (!contracts) return ["- No automation contract data."];
  return [
    `- Summary: ${contracts.summary}`,
    `- Free plan mode: ${contracts.freePlanMode ? "yes" : "no"}`,
    ...(contracts.guardrails?.length
      ? [
        "- Guardrails:",
        ...contracts.guardrails.map((guardrail: string) => `  - ${guardrail}`)
      ]
      : []),
    ...(contracts.contracts?.length
      ? [
        "- Contracts:",
        ...contracts.contracts.map((contract: any) => `  - [${contract.status}/${contract.risk}] ${contract.title}: ${contract.whatRuns} (${contract.whereToCheck})`)
      ]
      : ["- No tracked automation."])
  ];
}

function formatOperatingSop(sop?: any) {
  if (!sop) return ["- No operating SOP data."];
  return [
    `- Status: ${sop.status || "unknown"}`,
    `- Title: ${sop.title || "-"}`,
    `- Summary: ${sop.summary || "-"}`,
    `- Primary prompt: ${sop.primaryPrompt || "-"}`,
    ...(sop.guardrails?.length
      ? [
        "- Guardrails:",
        ...sop.guardrails.map((guardrail: string) => `  - ${guardrail}`)
      ]
      : []),
    ...(sop.procedures?.length
      ? [
        "- Procedures:",
        ...sop.procedures.map((procedure: any) => {
          const steps = procedure.steps?.length
            ? `\n  - Steps: ${procedure.steps.slice(0, 3).map((step: any) => `${step.label}(${step.owner}/${step.risk})`).join(" -> ")}`
            : "";
          const done = procedure.doneWhen?.length
            ? `\n  - Done: ${procedure.doneWhen.slice(0, 2).join(" / ")}`
            : "";
          return `  - [${procedure.severity}/${procedure.risk}] ${procedure.title}: ${procedure.why}\n  - Prompt: ${procedure.nextPrompt}${steps}${done}`;
        })
      ]
      : ["- Procedures: none"])
  ];
}

function formatRiskRadar(radar?: any) {
  if (!radar) return ["- No risk radar data."];
  return [
    `- Status: ${radar.status || "unknown"}`,
    `- Score: ${radar.score ?? 0}/100`,
    `- Summary: ${radar.summary || "-"}`,
    `- Primary prompt: ${radar.primaryPrompt || "-"}`,
    ...(radar.items?.length
      ? [
        "- Risks:",
        ...radar.items.map((risk: any) => `  - [${risk.severity} score ${risk.score}/${risk.category}/${risk.horizon}] ${risk.title}: ${risk.why}\n    - Prevention: ${risk.prevention}\n    - Prompt: ${risk.prompt}`)
      ]
      : ["- Risks: none"])
  ];
}

function formatDecisionTrace(trace?: any) {
  if (!trace) return ["- No decision trace data."];
  return [
    `- Confidence: ${trace.confidence || "unknown"}`,
    `- Summary: ${trace.summary || "-"}`,
    ...(trace.observations?.length
      ? [
        "- Observations:",
        ...trace.observations.slice(0, 8).map((item: any) => `  - [${item.weight}] ${item.label}: ${item.value} (${item.source})`)
      ]
      : ["- Observations: none"]),
    ...(trace.decisions?.length
      ? [
        "- Decisions:",
        ...trace.decisions.map((item: any) => `  - [${item.confidence}] ${item.title}: ${item.conclusion}\n    - Based on: ${(item.basedOn || []).join(", ")}\n    - Prompt: ${item.prompt}`)
      ]
      : ["- Decisions: none"]),
    ...(trace.blindSpots?.length
      ? [
        "- Blind spots:",
        ...trace.blindSpots.map((item: string) => `  - ${item}`)
      ]
      : []),
    ...(trace.verifyNext?.length
      ? [
        "- Verify next:",
        ...trace.verifyNext.map((item: string) => `  - ${item}`)
      ]
      : [])
  ];
}

function formatSafetyAudit(audit?: any) {
  if (!audit) return ["- No safety audit data."];
  return [
    `- Status: ${audit.status || "unknown"}`,
    `- Score: ${audit.score ?? 0}/100`,
    `- Summary: ${audit.summary || "-"}`,
    `- Primary prompt: ${audit.primaryPrompt || "-"}`,
    ...(audit.invariants?.length
      ? [
        "- Invariants:",
        ...audit.invariants.map((item: any) => `  - [${item.status}] ${item.label}: ${item.evidence}\n    - Risk: ${item.risk}\n    - Action: ${item.action}`)
      ]
      : ["- Invariants: none"]),
    ...(audit.requiredFixes?.length
      ? [
        "- Required fixes:",
        ...audit.requiredFixes.map((item: string) => `  - ${item}`)
      ]
      : []),
    ...(audit.recommendedChecks?.length
      ? [
        "- Recommended checks:",
        ...audit.recommendedChecks.map((item: string) => `  - ${item}`)
      ]
      : [])
  ];
}

function formatApprovalAdvisor(advisor?: any) {
  if (!advisor) return ["- No approval advisor data."];
  return [
    `- Status: ${advisor.status || "unknown"}`,
    `- Summary: ${advisor.summary || "-"}`,
    `- Counts: approve ${advisor.counts?.approve ?? 0}, defer ${advisor.counts?.defer ?? 0}, reject ${advisor.counts?.reject ?? 0}`,
    `- Primary prompt: ${advisor.primaryPrompt || "-"}`,
    ...(advisor.items?.length
      ? [
        "- Advice:",
        ...advisor.items.map((item: any) => `  - [${item.decision}/${item.priority}/${item.confidence}] ${item.actionType}: ${item.title}\n    - Reason: ${item.reason}\n    - Flags: ${(item.riskFlags || []).join(", ") || "none"}\n    - Prompt: ${item.prompt}`)
      ]
      : ["- Advice: no pending approvals."])
  ];
}

function formatMissionControl(mission?: any) {
  if (!mission) return ["- No mission control data."];
  return [
    `- Status: ${mission.status || "unknown"}`,
    `- Summary: ${mission.summary || "-"}`,
    `- First command: ${mission.firstCommand || "-"}`,
    `- Phases: stabilize ${mission.phases?.stabilize ?? 0}, decide ${mission.phases?.decide ?? 0}, delegate ${mission.phases?.delegate ?? 0}, verify ${mission.phases?.verify ?? 0}, record ${mission.phases?.record ?? 0}`,
    ...(mission.items?.length
      ? [
        "- Run order:",
        ...mission.items.map((item: any) => `  - [${item.phase}/${item.priority}/${item.owner}] ${item.title}\n    - Reason: ${item.reason}\n    - Command: ${item.command}\n    - Guardrail: ${item.guardrail}`)
      ]
      : ["- Run order: no mission items."])
  ];
}

function formatOwnerInbox(inbox?: any) {
  if (!inbox) return ["- No owner inbox data."];
  const lanes = ["decide", "approve", "delegate", "watch"];
  return [
    `- Status: ${inbox.status || "unknown"}`,
    `- Summary: ${inbox.summary || "-"}`,
    `- Primary action: ${inbox.primaryAction || "-"}`,
    `- Counts: decide ${inbox.counts?.decide ?? 0}, approve ${inbox.counts?.approve ?? 0}, delegate ${inbox.counts?.delegate ?? 0}, watch ${inbox.counts?.watch ?? 0}`,
    ...lanes.flatMap((lane) => {
      const items = inbox.lanes?.[lane] || [];
      if (!items.length) return [`- ${lane}: none`];
      return [
        `- ${lane}:`,
        ...items.map((item: any) => `  - [${item.priority}/${item.owner}] ${item.title}\n    - Reason: ${item.reason}\n    - Action: ${item.action}\n    - Location: ${item.location}`)
      ];
    })
  ];
}

function formatOutcomeReview(review?: any) {
  if (!review) return ["- No outcome review data."];
  return [
    `- Status: ${review.status || "unknown"}`,
    `- Score: ${review.score ?? 0}/100`,
    `- Summary: ${review.summary || "-"}`,
    `- Primary prompt: ${review.primaryPrompt || "-"}`,
    ...(review.items?.length
      ? [
        "- Items:",
        ...review.items.map((item: any) => `  - [${item.status}/${item.priority}] ${item.title}\n    - Evidence: ${item.evidence}\n    - Next check: ${item.nextCheck}\n    - Prompt: ${item.prompt}`)
      ]
      : ["- Items: none"])
  ];
}

function formatOperatorCoach(coach?: any) {
  if (!coach) return ["- No operator coach data."];
  return [
    `- Mode: ${coach.mode || "unknown"}`,
    `- Summary: ${coach.summary || "-"}`,
    `- Top prompt: ${coach.topPrompt || "-"}`,
    ...(coach.items?.length
      ? [
        "- Recommended prompts:",
        ...coach.items.map((item: any) => `  - [${item.priority}] ${item.title}\n    - Reason: ${item.reason}\n    - Prompt: ${item.prompt}\n    - Expected value: ${item.expectedValue}`)
      ]
      : ["- Recommended prompts: none"])
  ];
}

function formatLaunchKit(launchKit?: any) {
  if (!launchKit) return ["- No launch kit data."];
  return [
    `- Status: ${launchKit.status || "unknown"}`,
    `- Summary: ${launchKit.summary || "-"}`,
    `- First prompt: ${launchKit.firstPrompt || "-"}`,
    ...(launchKit.routines?.length
      ? [
        "- Routines:",
        ...launchKit.routines.map((routine: any) => {
          const steps = routine.steps?.length
            ? routine.steps.map((step: any) => `    - ${step.label}: ${step.prompt || step.location} (${step.guardrail})`).join("\n")
            : "    - No steps.";
          return `  - [${routine.cadence}/${routine.owner}] ${routine.title}\n    - Why: ${routine.why}\n${steps}`;
        })
      ]
      : ["- Routines: none"]),
    ...(launchKit.guardrails?.length
      ? ["- Guardrails:", ...launchKit.guardrails.map((item: string) => `  - ${item}`)]
      : ["- Guardrails: none"]),
    ...(launchKit.successSignals?.length
      ? ["- Success signals:", ...launchKit.successSignals.map((item: string) => `  - ${item}`)]
      : ["- Success signals: none"])
  ];
}

function formatFinalReadiness(finalReadiness?: any) {
  if (!finalReadiness) return ["- No final readiness data."];
  return [
    `- Status: ${finalReadiness.status || "unknown"}`,
    `- Score: ${finalReadiness.score ?? 0}/100`,
    `- Summary: ${finalReadiness.summary || "-"}`,
    ...(finalReadiness.items?.length
      ? [
        "- Evidence:",
        ...finalReadiness.items.map((item: any) => {
          const proof = item.proof?.length ? item.proof.map((line: string) => `    - ${line}`).join("\n") : "    - No proof.";
          return `  - [${item.status}/${item.score}] ${item.title}\n${proof}\n    - Gap: ${item.gap}\n    - Prompt: ${item.prompt}`;
        })
      ]
      : ["- Evidence: none"]),
    ...(finalReadiness.remainingWork?.length
      ? ["- Remaining work:", ...finalReadiness.remainingWork.map((item: string) => `  - ${item}`)]
      : ["- Remaining work: none"]),
    ...(finalReadiness.proofPrompts?.length
      ? ["- Proof prompts:", ...finalReadiness.proofPrompts.map((item: string) => `  - ${item}`)]
      : ["- Proof prompts: none"])
  ];
}

function formatMonitorTrend(trend?: any) {
  if (!trend) return ["- No monitor trend data."];
  return [
    `- Direction: ${trend.label || trend.direction}`,
    `- Samples: ${trend.sampleSize || 0}`,
    `- Summary: ${trend.summary || "-"}`,
    `- Delta: severity ${trend.deltas?.severityScore ?? 0}, alerts ${trend.deltas?.alertCount ?? 0}, gate block ${trend.deltas?.gateBlockCount ?? 0}, checkout ${trend.deltas?.checkoutScore ?? 0}`,
    `- Recommendation: ${trend.recommendation || "-"}`
  ];
}

function formatRoadmapLane(label: string, items?: any[]) {
  if (!items?.length) return [`- ${label}: none`];
  return [
    `- ${label}:`,
    ...items.map((item) => `  - [${item.priority}/${item.owner}] ${item.title}: ${item.expectedValue}\n    - Prompt: ${item.prompt}`)
  ];
}

function formatOperatingMode(mode?: any) {
  if (!mode) return ["- No operating mode data."];
  return [
    `- ${mode.label || mode.mode || "unknown"} (${mode.score ?? 0}/100)`,
    `- Summary: ${mode.summary || "-"}`,
    `- Primary action: ${mode.primaryAction?.label || "-"} / ${mode.primaryAction?.prompt || "-"}`,
    ...(mode.reasons?.length ? [`- Reasons: ${mode.reasons.join(", ")}`] : []),
    ...(mode.guardrails?.length ? [`- Guardrails: ${mode.guardrails.join(" / ")}`] : [])
  ];
}

function formatDailyCheckout(checkout?: any) {
  if (!checkout) return ["- No checkout data."];
  return [
    `- ${checkout.label || checkout.status || "unknown"} (${checkout.score ?? 0}/100)`,
    `- Summary: ${checkout.summary || "-"}`,
    ...(checkout.openRisks?.length ? [`- Open risks: ${checkout.openRisks.join(" / ")}`] : []),
    ...(checkout.tomorrowFocus?.length ? [`- Tomorrow focus: ${checkout.tomorrowFocus.join(" / ")}`] : []),
    `- Handoff prompt: ${checkout.handoffPrompt || "-"}`
  ];
}

function formatTodayActionBoard(board?: any) {
  if (!board) return ["- No action board data."];
  return [
    `- Status: ${board.status || "unknown"}`,
    `- Summary: ${board.summary || "-"}`,
    `- Primary prompt: ${board.primaryPrompt || "-"}`,
    ...formatBoardLane("Do now", board.lanes?.doNow),
    ...formatBoardLane("Review", board.lanes?.review),
    ...formatBoardLane("Watch", board.lanes?.watch),
    ...formatBoardLane("Save", board.lanes?.save)
  ];
}

function formatBoardLane(label: string, items?: any[]) {
  if (!items?.length) return [`- ${label}: none`];
  return [
    `- ${label}:`,
    ...items.map((item) => `  - [${item.priority} score ${item.score}] ${item.title}: ${item.reason}\n    - Prompt: ${item.prompt}`)
  ];
}

function formatLatestMonitorSnapshot(latest?: any) {
  const item = latest?.item;
  if (!item) return [latest?.error ? `- Error: ${latest.error}` : "- No monitor snapshot."];
  return [
    `- Severity: ${item.severity || "unknown"}`,
    `- Run: ${item.runId || "-"} / ${formatDate(item.runCompletedAt || item.generatedAt)}`,
    `- Alerts: ${Array.isArray(item.alerts) ? item.alerts.length : 0}`,
    `- Gate pass/review/block: ${Number(item.approvalGateSummary?.passCount || 0)}/${Number(item.approvalGateSummary?.reviewCount || 0)}/${Number(item.approvalGateSummary?.blockCount || 0)}`,
    `- Checkout: ${item.dailyCheckout?.label || item.dailyCheckout?.status || "unknown"} (${Number(item.dailyCheckout?.score || 0)}/100)`,
    ...(item.alerts?.[0]?.message ? [`- Top alert: ${item.alerts[0].message}`] : [])
  ];
}

function formatMonitorDigest(latest?: any) {
  const item = latest?.item;
  if (!item) return latest?.error ? `error ${latest.error}` : "none";
  return `${item.severity || "unknown"}, alerts ${Array.isArray(item.alerts) ? item.alerts.length : 0}, gate block ${Number(item.approvalGateSummary?.blockCount || 0)}, checkout ${item.dailyCheckout?.label || item.dailyCheckout?.status || "unknown"}`;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function truncateText(value?: string | null, maxLength = 160) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "-";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function getLatestReportTitle(report?: any) {
  return report?.title || "none";
}

function formatThresholds(thresholds?: any) {
  if (!thresholds) return ["- No threshold data."];
  return [
    `- Window: ${thresholds.windowHours}h`,
    `- API errors critical: ${thresholds.apiErrorsCritical}`,
    `- AI cost warn/critical: $${thresholds.aiCostWarnUsd} / $${thresholds.aiCostCriticalUsd}`,
    `- PUBG quota warn/critical: ${thresholds.pubgQuotaWarnRemaining} / ${thresholds.pubgQuotaCriticalRemaining}`,
    `- Approval stale: ${thresholds.approvalStaleHours}h`
  ];
}

function formatLatestRun(run?: any) {
  if (!run) return ["- No recent agent run."];
  if (run.error && !run.id) return [`- Error: ${run.error}`];
  return [
    `- Status: ${run.status || "unknown"}`,
    `- Message: ${truncateText(run.message, 180)}`,
    `- Started: ${formatDate(run.started_at)}`,
    `- Completed: ${formatDate(run.completed_at)}`,
    `- Summary: ${truncateText(run.summary || run.error, 220)}`
  ];
}

function formatReadinessIssues(readiness?: any, rollout?: any) {
  const readinessIssues = (readiness?.checks || [])
    .filter((check: any) => check.status && check.status !== "ok")
    .slice(0, 5)
    .map((check: any) => `- Agent issue [${check.status}] ${check.label}: ${check.message}`);

  const rolloutIssues = (rollout?.checks || [])
    .filter((check: any) => check.status && check.status !== "pass")
    .slice(0, 5)
    .map((check: any) => `- Rollout issue [${check.status}] ${check.label}: ${check.message}${check.action ? ` Action: ${check.action}` : ""}`);

  if (!readinessIssues.length && !rolloutIssues.length) {
    return ["- No readiness issues."];
  }

  return [
    ...(readinessIssues.length ? ["- Agent readiness issues:"] : []),
    ...readinessIssues,
    ...(rolloutIssues.length ? ["- Rollout readiness issues:"] : []),
    ...rolloutIssues
  ];
}
