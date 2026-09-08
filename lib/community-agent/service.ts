import { categoryFor } from "./policy";
import { collectSource } from "./sources";
import {
  CommunityAgentModelError,
  createGeminiJsonModel,
  selectTopic,
  verifyDraft,
  writeDraft,
  type GeminiJsonUsage,
} from "./editorial";
import { checkDraft, renderDraft } from "./validate";
import type { CommunityStore } from "./store";
import type { Actor } from "./auth";
import type { CollectSource, Evidence, PublishResult, RunSnapshot, Stage } from "./types";

export type RunAction =
  | { action: "start"; dryRun: boolean }
  | { action: "step"; runId: string; stage: Stage }
  | { action: "publish"; runId: string };

const COLLECT_STAGES = new Set<Stage>(["dc", "naver", "youtube"]);

function usagePayload(usage: GeminiJsonUsage | null): Record<string, unknown> {
  return usage ? { usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } } : {};
}

function terminal(error: unknown, fallback: string, usage: GeminiJsonUsage | null): Record<string, unknown> {
  const modelError = error instanceof CommunityAgentModelError ? error : null;
  return {
    terminal: {
      status: modelError?.status === "failed" ? "failed" : "deferred",
      reason: modelError?.reason ?? fallback,
    },
    ...usagePayload(usage),
  };
}

function evidenceIds(run: RunSnapshot): string[] {
  return [...new Set(run.reports.flatMap((report) => report.evidenceIds))];
}

function draftEvidenceIds(run: RunSnapshot): string[] {
  return [...new Set(run.draft?.paragraphs.flatMap((paragraph) => paragraph.evidenceIds) ?? [])];
}

function usableEvidence(items: Evidence[]): Evidence[] {
  return items.filter((item) => typeof item.excerpt === "string" && item.excerpt.trim().length > 0);
}

async function executeCollect(
  runId: string,
  stage: CollectSource,
  lease: string,
  store: CommunityStore,
): Promise<RunSnapshot> {
  const channel = stage === "youtube" ? await store.getSourceCache("youtube") : null;
  const report = await collectSource(stage, {
    fetchImpl: fetch,
    signal: new AbortController().signal,
    now: new Date(),
    env: process.env,
    channel,
  });
  const canonicalIds = await store.saveEvidence(report.items);
  return store.finishStage(runId, stage, lease, {
    state: report.state,
    reason: report.reason,
    fetchedCount: report.fetchedCount,
    retainedCount: canonicalIds.length,
    evidenceIds: canonicalIds,
    ...(report.channel ? { channel: report.channel } : {}),
  });
}

async function executeSelect(run: RunSnapshot, lease: string, store: CommunityStore): Promise<RunSnapshot> {
  const official = await store.loadOfficialEvidence();
  const officialIds = await store.saveEvidence(official);
  const items = usableEvidence(await store.loadEvidence([...new Set([...evidenceIds(run), ...officialIds])]));
  if (items.length === 0) {
    return store.finishStage(run.id, "select", lease, {
      terminal: { status: "deferred", reason: "no_usable_evidence" },
    });
  }
  let usage: GeminiJsonUsage | null = null;
  const model = createGeminiJsonModel({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    modelName: process.env.COMMUNITY_AGENT_MODEL,
    onUsage: (value) => { usage = value; },
  });
  try {
    const topic = await selectTopic(items, await store.recentPosts(7), model, new Date());
    if (!topic) {
      return store.finishStage(run.id, "select", lease, {
        terminal: { status: "deferred", reason: "no_publishable_topic" },
        ...usagePayload(usage),
      });
    }
    return store.finishStage(run.id, "select", lease, { topic, ...usagePayload(usage) });
  } catch (error) {
    return store.finishStage(run.id, "select", lease, terminal(error, "topic_selection_failed", usage));
  }
}

async function executeDraft(run: RunSnapshot, lease: string, store: CommunityStore): Promise<RunSnapshot> {
  if (!run.topic) return store.finishStage(run.id, "draft", lease, terminal(null, "persisted_topic_missing", null));
  const items = await store.loadEvidence(run.topic.evidenceIds);
  if (items.length !== run.topic.evidenceIds.length) {
    return store.finishStage(run.id, "draft", lease, terminal(null, "persisted_evidence_missing", null));
  }
  let usage: GeminiJsonUsage | null = null;
  const model = createGeminiJsonModel({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    modelName: process.env.COMMUNITY_AGENT_MODEL,
    onUsage: (value) => { usage = value; },
  });
  try {
    const draft = await writeDraft(run.topic, items, model);
    return store.finishStage(run.id, "draft", lease, { draft, ...usagePayload(usage) });
  } catch (error) {
    return store.finishStage(run.id, "draft", lease, terminal(error, "draft_generation_failed", usage));
  }
}

async function executeVerify(run: RunSnapshot, lease: string, store: CommunityStore): Promise<RunSnapshot> {
  if (!run.draft || !run.topic) return store.finishStage(run.id, "verify", lease, terminal(null, "persisted_draft_missing", null));
  const ids = draftEvidenceIds(run);
  const items = await store.loadEvidence(ids);
  if (items.length !== ids.length) {
    return store.finishStage(run.id, "verify", lease, terminal(null, "persisted_evidence_missing", null));
  }
  const checked = checkDraft(run.draft, items, new Date());
  if (!checked.passed) {
    return store.finishStage(run.id, "verify", lease, { validation: checked });
  }
  let usage: GeminiJsonUsage | null = null;
  const model = createGeminiJsonModel({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    modelName: process.env.COMMUNITY_AGENT_MODEL,
    onUsage: (value) => { usage = value; },
  });
  try {
    const semantic = await verifyDraft(run.draft, items, model, new Date());
    const validation = {
      passed: semantic.passed,
      reasons: semantic.reasons,
      contentHash: checked.contentHash,
    };
    if (!semantic.passed) {
      return store.finishStage(run.id, "verify", lease, { validation, ...usagePayload(usage) });
    }
    const rendered = renderDraft(run.draft, items);
    return store.finishStage(run.id, "verify", lease, {
      validation,
      rendered: { ...rendered, category: categoryFor(run.topic.kind) },
      ...usagePayload(usage),
    });
  } catch (error) {
    return store.finishStage(run.id, "verify", lease, terminal(error, "draft_verification_failed", usage));
  }
}

/** Execute one DB-owned state transition; all editorial inputs are reloaded from persisted run state. */
export async function executeAction(
  action: RunAction,
  actor: Actor,
  store: CommunityStore,
): Promise<RunSnapshot | PublishResult> {
  if (action.action === "start") {
    if (actor.kind === "worker" && action.dryRun) throw new Error("community_worker_dry_run_forbidden");
    await store.cleanup();
    return store.startRun(actor.userId, action.dryRun);
  }

  if (action.action === "publish") {
    const run = await store.getRun(action.runId);
    if (run.status === "published") return store.publish(action.runId);
    if (!run.draft || !run.validation?.passed) return { code: "not_ready", postId: null };
    const ids = draftEvidenceIds(run);
    const items = await store.loadEvidence(ids);
    if (items.length !== ids.length) return { code: "not_ready", postId: null };
    const checked = checkDraft(run.draft, items, new Date());
    const rendered = renderDraft(run.draft, items);
    if (!checked.passed || checked.contentHash !== run.validation.contentHash || rendered.hash !== run.validation.contentHash) {
      return { code: "not_ready", postId: null };
    }
    return store.publish(action.runId);
  }

  const claim = await store.claimStage(action.runId, action.stage);
  if (!claim.claimed || !claim.lease) return claim.run;
  if (COLLECT_STAGES.has(action.stage)) {
    return executeCollect(action.runId, action.stage as CollectSource, claim.lease, store);
  }
  if (action.stage === "select") return executeSelect(claim.run, claim.lease, store);
  if (action.stage === "draft") return executeDraft(claim.run, claim.lease, store);
  return executeVerify(claim.run, claim.lease, store);
}
