export interface ToolExecution {
  toolName: string;
  status: "running" | "success" | "failed" | "approval_required";
  safetyLevel?: "read" | "write" | "dangerous";
  approvalId?: string;
  params?: any;
  error?: string;
}

export interface AgentApproval {
  id: string;
  run_id?: string | null;
  step_id?: string | null;
  tool_name: string;
  action_type: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  payload: Record<string, any>;
  result?: string | null;
  error?: string | null;
  postExecution?: {
    status: "completed" | "needs_review";
    title: string;
    outcome: string;
    metrics: Array<{
      label: string;
      value: string;
    }>;
    followUp: string[];
    audit: {
      approvalPanel: string;
      runTimeline?: string | null;
      relatedResource?: string | null;
    };
  };
  queue?: {
    priority: "low" | "medium" | "high";
    ageHours: number;
    isStale: boolean;
  };
  impact?: {
    summary: string;
    risk: "low" | "medium" | "high";
    estimatedRows?: number;
    details: Record<string, any>;
    preview?: {
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
    checklist?: Array<{
      label: string;
      status: "pass" | "review" | "warning";
      message: string;
    }>;
    executionGate?: {
      status: "pass" | "review" | "block";
      label: string;
      reasons: string[];
      requiredBeforeApproval: string[];
    };
  };
  created_at: string;
  decided_at?: string | null;
  executed_at?: string | null;
}

export interface AgentApprovalSummary {
  count: number;
  highRiskCount: number;
  staleCount: number;
  oldestAgeHours: number;
}

export interface AgentRun {
  id: string;
  user_id?: string | null;
  status: "running" | "completed" | "failed";
  message: string;
  summary?: string | null;
  error?: string | null;
  started_at: string;
  completed_at?: string | null;
}

export interface AgentStep {
  id: string;
  run_id: string;
  tool_name: string;
  safety_level: "read" | "write" | "dangerous";
  status: "running" | "success" | "failed" | "approval_required";
  params: Record<string, any>;
  result?: string | null;
  error?: string | null;
  started_at: string;
  completed_at?: string | null;
}

export interface AgentCommandCenter {
  generatedAt: string;
  severity: "ok" | "warn" | "critical";
  /** 읽지 못해 기본값(0 등)으로 대체한 집계 목록. 이 항목의 0은 정상이 아니라 확인 불가다. */
  degradedSources?: Array<{ source: string; message: string }>;
  operatingMode?: {
    mode: "normal" | "watch" | "incident" | "approval_review" | "deploy_guard";
    label: string;
    score: number;
    summary: string;
    reasons: string[];
    primaryAction: {
      label: string;
      prompt: string;
    };
    guardrails: string[];
  };
  dailyCheckout?: {
    status: "clear" | "attention" | "blocked";
    label: string;
    score: number;
    summary: string;
    completedSignals: string[];
    openRisks: string[];
    tomorrowFocus: string[];
    handoffPrompt: string;
  };
  todayActionBoard?: {
    generatedAt: string;
    status: "clear" | "attention" | "blocked";
    summary: string;
    primaryPrompt: string;
    lanes: {
      doNow: AgentTodayActionBoardItem[];
      review: AgentTodayActionBoardItem[];
      watch: AgentTodayActionBoardItem[];
      save: AgentTodayActionBoardItem[];
    };
  };
  latestRun?: AgentRun | null;
  latestMonitorSnapshot?: {
    item: (AgentMonitorSnapshot & {
      runId?: string;
      runMessage?: string;
      runStartedAt?: string;
      runCompletedAt?: string;
    }) | null;
    error?: string;
  };
  monitorTrend?: {
    generatedAt: string;
    direction: "improving" | "stable" | "worsening" | "insufficient_data";
    label: string;
    sampleSize: number;
    summary: string;
    latest?: {
      generatedAt: string;
      completedAt?: string | null;
      severity: "ok" | "warn" | "critical";
      alertCount: number;
      gateBlockCount: number;
      checkoutScore?: number | null;
    } | null;
    previous?: {
      generatedAt: string;
      completedAt?: string | null;
      severity: "ok" | "warn" | "critical";
      alertCount: number;
      gateBlockCount: number;
      checkoutScore?: number | null;
    } | null;
    deltas: {
      severityScore: number;
      alertCount: number;
      gateBlockCount: number;
      checkoutScore: number;
    };
    recommendation: string;
    error?: string;
  };
  pendingApprovals: {
    count: number;
    highRiskCount?: number;
    staleCount?: number;
    oldestAgeHours?: number;
    error?: string;
  };
  approvalGateSummary?: {
    sampledCount: number;
    passCount: number;
    reviewCount: number;
    blockCount: number;
    items: Array<{
      id: string;
      actionType: string;
      title: string;
      gate: {
        status: "pass" | "review" | "block";
        label: string;
        reasons: string[];
        requiredBeforeApproval: string[];
      };
    }>;
    error?: string;
  };
  failedRuns: { count: number; error?: string };
  apiErrors: { total: number; latest: any[]; error?: string };
  aiUsage: { totalRequests: number; totalCostUsd: number; error?: string };
  memories?: {
    items: AgentMemory[];
    error?: string;
  };
  latestReport?: {
    item: AgentReport | null;
    error?: string;
  };
  rollout?: AgentRolloutReadinessSummary;
  deploymentHealth?: AgentDeploymentHealth;
  contentPerformance?: AgentContentPerformanceSummary;
  trafficSummary?: AgentTrafficSummary;
  trafficSummary7d?: AgentTrafficSummary;
  thresholds?: AgentThresholds;
  toolCatalog?: AgentToolCatalog;
  readiness?: AgentReadiness;
  playbooks?: AgentPlaybook[];
  nextActions?: AgentNextAction[];
  relatedMemories?: {
    query: string;
    reason: string;
    items: AgentMemory[];
  };
  memorySuggestions?: AgentMemorySuggestion[];
  improvementBacklog?: {
    score: number;
    label: "excellent" | "stable" | "needs_attention" | "at_risk";
    summary: string;
    items: Array<{
      id: string;
      priority: "low" | "medium" | "high";
      title: string;
      reason: string;
      action: string;
      owner: "admin" | "agent" | "developer";
    }>;
  };
  capabilityMatrix?: {
    generatedAt: string;
    score: number;
    label: "excellent" | "stable" | "needs_attention" | "at_risk";
    summary: string;
    items: Array<{
      id: "observe" | "diagnose" | "approve" | "monitor" | "learn" | "content" | "security" | "free_plan";
      label: string;
      status: "ready" | "partial" | "blocked";
      score: number;
      evidence: string[];
      nextStep: string;
    }>;
  };
  operatorValue?: {
    generatedAt: string;
    score: number;
    label: "excellent" | "useful" | "warming_up" | "needs_attention";
    summary: string;
    metrics: Array<{
      id: "time_saved" | "risk_prevented" | "automation_coverage" | "learning_loop" | "content_leverage";
      label: string;
      value: string;
      detail: string;
      score: number;
    }>;
    wins: string[];
    nextLeverage: Array<{
      title: string;
      reason: string;
      prompt: string;
    }>;
  };
  growthRoadmap?: {
    generatedAt: string;
    status: "on_track" | "needs_focus" | "blocked";
    summary: string;
    lanes: {
      now: AgentGrowthRoadmapItem[];
      thisWeek: AgentGrowthRoadmapItem[];
      later: AgentGrowthRoadmapItem[];
    };
    primaryPrompt: string;
  };
  ownerBrief?: {
    generatedAt: string;
    status: "calm" | "watch" | "act_now";
    headline: string;
    summary: string;
    doNow: {
      title: string;
      reason: string;
      prompt: string;
    };
    delegateToAgent: Array<{
      title: string;
      reason: string;
      prompt: string;
    }>;
    needsOwnerReview: Array<{
      title: string;
      reason: string;
      location: string;
    }>;
    confidence: number;
  };
  automationContracts?: {
    generatedAt: string;
    freePlanMode: boolean;
    summary: string;
    counts: Record<"active" | "ready" | "manual" | "external", number>;
    guardrails: string[];
    contracts: Array<{
      id: string;
      title: string;
      status: "active" | "ready" | "manual" | "external";
      cadence: string;
      owner: "agent" | "admin" | "github_actions" | "vercel";
      risk: "safe" | "approval_required" | "manual_only";
      whatRuns: string;
      guardrail: string;
      whereToCheck: string;
      prompt?: string;
    }>;
  };
  operatingSop?: {
    generatedAt: string;
    status: "normal" | "watch" | "incident" | "blocked";
    title: string;
    summary: string;
    primaryPrompt: string;
    checkLocation: string;
    guardrails: string[];
    procedures: Array<{
      id: string;
      title: string;
      severity: "ok" | "warn" | "critical";
      risk: "read" | "approval_required" | "manual_check";
      trigger: string;
      why: string;
      steps: Array<{
        id: string;
        label: string;
        owner: "agent" | "admin" | "github_actions" | "manual";
        risk: "read" | "approval_required" | "manual_check";
        action: string;
        prompt?: string;
      }>;
      doneWhen: string[];
      nextPrompt: string;
    }>;
  };
  riskRadar?: {
    generatedAt: string;
    status: "clear" | "watch" | "act";
    score: number;
    summary: string;
    primaryPrompt: string;
    items: Array<{
      id: string;
      category: "approval" | "stability" | "cost" | "deploy" | "readiness" | "content" | "memory";
      severity: "low" | "medium" | "high" | "critical";
      likelihood: number;
      impact: number;
      score: number;
      horizon: "now" | "today" | "this_week";
      title: string;
      why: string;
      evidence: string[];
      prevention: string;
      prompt: string;
    }>;
  };
  decisionTrace?: {
    generatedAt: string;
    confidence: "high" | "medium" | "low";
    summary: string;
    observations: Array<{
      id: string;
      label: string;
      value: string;
      source: string;
      weight: "high" | "medium" | "low";
    }>;
    decisions: Array<{
      id: string;
      title: string;
      conclusion: string;
      basedOn: string[];
      confidence: "high" | "medium" | "low";
      nextCheck: string;
      prompt: string;
    }>;
    blindSpots: string[];
    verifyNext: string[];
  };
  safetyAudit?: {
    generatedAt: string;
    status: "pass" | "watch" | "block";
    score: number;
    summary: string;
    invariants: Array<{
      id: string;
      label: string;
      status: "ok" | "warn" | "critical";
      evidence: string;
      risk: string;
      action: string;
    }>;
    requiredFixes: string[];
    recommendedChecks: string[];
    primaryPrompt: string;
  };
  approvalAdvisor?: {
    generatedAt: string;
    status: "clear" | "review" | "blocked";
    summary: string;
    counts: Record<"approve" | "reject" | "defer", number>;
    items: Array<{
      id: string;
      actionType: string;
      title: string;
      priority: "low" | "medium" | "high";
      decision: "approve" | "reject" | "defer";
      confidence: "high" | "medium" | "low";
      reason: string;
      checklist: string[];
      riskFlags: string[];
      prompt: string;
    }>;
    primaryPrompt: string;
  };
  missionControl?: {
    generatedAt: string;
    status: "clear" | "focus" | "urgent";
    summary: string;
    firstCommand: string;
    phases: Record<"stabilize" | "decide" | "delegate" | "verify" | "record", number>;
    items: Array<{
      id: string;
      phase: "stabilize" | "decide" | "delegate" | "verify" | "record";
      priority: "low" | "medium" | "high";
      title: string;
      reason: string;
      command: string;
      owner: "admin" | "agent" | "github_actions" | "manual";
      expectedOutcome: string;
      source: string;
      guardrail: string;
    }>;
  };
  ownerInbox?: {
    generatedAt: string;
    status: "empty" | "review" | "attention";
    summary: string;
    primaryAction: string;
    counts: Record<"decide" | "approve" | "delegate" | "watch", number>;
    lanes: Record<"decide" | "approve" | "delegate" | "watch", Array<{
      id: string;
      lane: "decide" | "approve" | "delegate" | "watch";
      priority: "low" | "medium" | "high";
      title: string;
      reason: string;
      action: string;
      location: string;
      owner: "admin" | "agent" | "system";
      source: string;
    }>>;
  };
  outcomeReview?: {
    generatedAt: string;
    status: "closed" | "watch" | "follow_up";
    score: number;
    summary: string;
    primaryPrompt: string;
    items: Array<{
      id: string;
      status: "improved" | "watch" | "unresolved";
      priority: "low" | "medium" | "high";
      title: string;
      evidence: string;
      nextCheck: string;
      prompt: string;
    }>;
  };
  operatorCoach?: {
    generatedAt: string;
    mode: "recover" | "focus" | "grow";
    summary: string;
    topPrompt: string;
    items: Array<{
      id: string;
      priority: "low" | "medium" | "high";
      title: string;
      reason: string;
      prompt: string;
      expectedValue: string;
      source: string;
    }>;
  };
  launchKit?: {
    generatedAt: string;
    status: "ready" | "watch" | "blocked";
    summary: string;
    firstPrompt: string;
    routines: Array<{
      id: string;
      title: string;
      cadence: "daily" | "incident" | "approval" | "growth";
      owner: "admin" | "agent" | "github_actions";
      why: string;
      steps: Array<{
        label: string;
        prompt?: string;
        location: string;
        guardrail: string;
      }>;
    }>;
    guardrails: string[];
    successSignals: string[];
  };
  finalReadiness?: {
    generatedAt: string;
    status: "ready" | "watch" | "blocked";
    score: number;
    summary: string;
    items: Array<{
      id: "security" | "approval" | "diagnostics" | "automation" | "usability" | "learning" | "content" | "verification";
      title: string;
      status: "pass" | "watch" | "block";
      score: number;
      proof: string[];
      gap: string;
      prompt: string;
    }>;
    remainingWork: string[];
    proofPrompts: string[];
  };
  quickPrompts: string[];
}

export interface AgentGrowthRoadmapItem {
  id: string;
  horizon: "now" | "this_week" | "later";
  priority: "low" | "medium" | "high";
  title: string;
  reason: string;
  expectedValue: string;
  prompt: string;
  owner: "admin" | "agent" | "developer";
}

export interface AgentMonitorSnapshot {
  generatedAt: string;
  windowHours: number;
  severity: "ok" | "warn" | "critical";
  alerts: Array<{
    type: string;
    severity: "ok" | "warn" | "critical";
    message: string;
    value?: any;
  }>;
  recommendations: string[];
  trafficSummary?: AgentTrafficSummary;
  approvalGateSummary?: {
    sampledCount: number;
    passCount: number;
    reviewCount: number;
    blockCount: number;
  };
  dailyCheckout?: {
    status: "clear" | "attention" | "blocked";
    label: string;
    score: number;
    summary: string;
    openRisks: string[];
    tomorrowFocus: string[];
    handoffPrompt: string;
  };
  nextActions?: AgentNextAction[];
  notification?: {
    provider: string;
    configured: boolean;
    sent: boolean;
    reason: string;
    error?: string;
    cooldownMinutes?: number;
    lastSentAt?: string | null;
  };
}

export interface AgentTrafficSummary {
  generatedAt: string;
  status: "ready" | "empty" | "unavailable";
  windowHours: number;
  current: AgentTrafficSummaryWindow;
  previous: AgentTrafficSummaryWindow;
  changes: {
    uniqueSessions: number | null;
    pageViews: number | null;
    totalEvents: number | null;
    statsSearches: number | null;
    aiFeatureUses: number | null;
    boardActions: number | null;
    crateOpens: number | null;
    replayOpens: number | null;
  };
  highlights: string[];
  error?: string;
}

export interface AgentTrafficSummaryWindow {
  uniqueSessions: number;
  uniqueUsers: number;
  guestSessions: number;
  memberSessions: number;
  pageViews: number;
  totalEvents: number;
  topPages: Array<{ label: string; count: number }>;
  topEvents: Array<{ label: string; count: number }>;
  topFeatures: Array<{ label: string; count: number }>;
  topUsers: Array<{
    userId: string;
    label: string;
    nickname: string | null;
    pubgNickname: string | null;
    eventCount: number;
    pageViews: number;
    statsSearches: number;
    aiFeatureUses: number;
  }>;
  statsSearches: number;
  aiFeatureUses: number;
  boardActions: number;
  crateOpens: number;
  replayOpens: number;
}

export interface AgentMemory {
  id: string;
  category: string;
  title: string;
  body: string;
  metadata: Record<string, any>;
  created_at?: string;
  updated_at: string;
}

export interface AgentMemorySummary {
  total: number;
  active: number;
  inactive: number;
  byCategory: Record<string, number>;
  latestUpdatedAt: string | null;
}

export interface AgentMemorySuggestion {
  id: string;
  priority: "low" | "medium" | "high";
  category: "incident" | "policy" | "operations" | "content";
  title: string;
  reason: string;
  prompt: string;
  tags: string[];
  evidence: string[];
}

export interface AgentPlaybook {
  id: string;
  title: string;
  severity: "ok" | "warn" | "critical";
  trigger: string;
  nextAction: string;
  riskLevel: "read" | "approval_required" | "manual_check";
}

export interface AgentNextAction {
  id: string;
  priority: "low" | "medium" | "high";
  category?: "stability" | "approval" | "cost" | "deploy" | "content" | "readiness" | "report";
  urgencyScore?: number;
  title: string;
  reason: string;
  prompt: string;
  expectedOutcome: string;
  checklist?: string[];
}

export interface AgentTodayActionBoardItem {
  id: string;
  lane: "do_now" | "review" | "watch" | "save";
  priority: "low" | "medium" | "high";
  title: string;
  reason: string;
  prompt: string;
  expectedOutcome: string;
  checklist: string[];
  score: number;
  source: "next_action" | "checkout" | "approval_gate" | "report";
}

export interface AgentReport {
  id: string;
  title: string;
  body: string;
  metadata: Record<string, any>;
  updated_at: string;
}

export interface AgentReadiness {
  generatedAt: string;
  status: "ok" | "warn" | "critical";
  toolCount: number;
  checks: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "critical";
    message: string;
    count?: number;
  }>;
}

export interface AgentRolloutReadinessSummary {
  status: "pass" | "warn" | "fail";
  checks: Array<{
    id: string;
    label: string;
    status: "pass" | "warn" | "fail";
    message: string;
    action: string;
  }>;
}

export interface AgentDeploymentHealth {
  provider: "vercel";
  configured: boolean;
  severity: "ok" | "warn" | "critical";
  latest: {
    uid: string;
    url?: string;
    state: string;
    creator?: string;
    createdAt?: string;
    ageMinutes?: number;
  } | null;
  recentFailures: Array<{
    uid: string;
    url?: string;
    state: string;
    creator?: string;
    createdAt?: string;
    ageMinutes?: number;
  }>;
  message: string;
  error?: string;
}

export interface AgentContentPerformanceSummary {
  totalPosts: number;
  totalViews: number;
  averageEngagementRate: number;
  momentum?: {
    score: number;
    label: "no_data" | "quiet" | "steady" | "strong";
    reason: string;
  };
  topPost: {
    id: string | number;
    title: string;
    category?: string | null;
    views: number;
    likes: number;
    comments: number;
    engagementRate: number;
    created_at?: string;
  } | null;
  topCategory?: {
    category: string;
    posts: number;
    views: number;
    likes: number;
    comments: number;
    engagementRate: number;
  } | null;
  lowEffortWins?: string[];
  weeklyPlan?: Array<{
    day: string;
    title: string;
    angle: string;
    source: string;
  }>;
  recommendations: string[];
  error?: string;
}

export interface AgentThresholds {
  windowHours: number;
  apiErrorsCritical: number;
  aiCostWarnUsd: number;
  aiCostCriticalUsd: number;
  pubgQuotaWarnRemaining: number;
  pubgQuotaCriticalRemaining: number;
  approvalStaleHours: number;
}

export interface AgentToolCatalog {
  generatedAt: string;
  total: number;
  counts: {
    read: number;
    write: number;
    dangerous: number;
  };
  tools: Array<{
    name: string;
    safetyLevel: "read" | "write" | "dangerous";
    description: string;
    parameters: string[];
    approvalRequired: boolean;
  }>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "model" | "system";
  content: string;
  timestamp: string;
  toolsUsed?: ToolExecution[];
}

export interface BotSettings {
  botName: string;
  systemPrompt: string;
}
