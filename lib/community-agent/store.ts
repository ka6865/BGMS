import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CollectSource,
  Evidence,
  Policy,
  PublishResult,
  RunSnapshot,
  SourceStatus,
  Stage,
} from "./types";

type DatabaseClient = SupabaseClient<any, any, any>;
type UnknownRow = Record<string, unknown>;

const SOURCE_IDS = ["dc", "naver", "youtube"] as const satisfies readonly CollectSource[];
const CATEGORIES = ["배그 소식", "자유"] as const;
const EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`community-store-${message}`);
}

function row(value: unknown, context: string): UnknownRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid-${context}`);
  return value as UnknownRow;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string") fail(`invalid-${context}`);
  return value;
}

function nullableText(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, context);
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") fail(`invalid-${context}`);
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizePolicy(value: unknown): Policy {
  const source = row(value, "policy");
  const sourceEnabled = row(source.source_enabled ?? source.sourceEnabled, "policy-sources");
  const categories = source.categories;
  if (!Array.isArray(categories) || categories.length === 0 || categories.some(
    (category) => typeof category !== "string" || !CATEGORIES.includes(category as (typeof CATEGORIES)[number]),
  )) {
    fail("invalid-policy-categories");
  }
  const typedCategories = categories as Policy["categories"];
  if (new Set(typedCategories).size !== typedCategories.length) fail("invalid-policy-categories");
  const enabledSources = Object.fromEntries(SOURCE_IDS.map((sourceId) => [
    sourceId,
    boolean(sourceEnabled[sourceId], `policy-source-${sourceId}`),
  ])) as Policy["sourceEnabled"];
  if (Object.keys(sourceEnabled).some((key) => !SOURCE_IDS.includes(key as CollectSource))) {
    fail("invalid-policy-sources");
  }
  const limit = source.daily_post_limit ?? source.dailyPostLimit;
  if (limit !== 0 && limit !== 1) fail("invalid-policy-limit");
  return {
    enabled: boolean(source.enabled, "policy-enabled"),
    publishingEnabled: boolean(source.publishing_enabled ?? source.publishingEnabled, "policy-publishing-enabled"),
    botUserId: nullableText(source.bot_user_id ?? source.botUserId, "policy-bot-user"),
    categories: typedCategories,
    dailyPostLimit: limit,
    sourceEnabled: enabledSources,
  };
}

function normalizeSnapshot(value: unknown): RunSnapshot {
  const source = row(value, "run");
  const status = text(source.status, "run-status") as RunSnapshot["status"];
  if (!(["collecting", "selected", "drafted", "ready", "deferred", "failed", "published"] as const).includes(status)) {
    fail("invalid-run-status");
  }
  const modelCalls = source.model_calls ?? source.modelCalls;
  if (typeof modelCalls !== "number" || !Number.isInteger(modelCalls) || modelCalls < 0 || modelCalls > 3) {
    fail("invalid-run-model-calls");
  }
  const reports = source.reports;
  if (!Array.isArray(reports)) fail("invalid-run-reports");
  const postId = source.post_id ?? source.postId;
  if (postId !== null && postId !== undefined && (typeof postId !== "number" || !Number.isInteger(postId) || postId < 0)) {
    fail("invalid-run-post-id");
  }
  return {
    id: text(source.run_id ?? source.id, "run-id"),
    day: text(source.day, "run-day"),
    status,
    stages: asObject(source.stages) as RunSnapshot["stages"],
    modelCalls,
    reports: reports as RunSnapshot["reports"],
    topic: (source.topic ?? null) as RunSnapshot["topic"],
    draft: (source.draft ?? null) as RunSnapshot["draft"],
    validation: (source.validation ?? null) as RunSnapshot["validation"],
    dryRun: boolean(source.dry_run ?? source.dryRun, "run-dry-run"),
    postId: (postId ?? null) as number | null,
    reason: nullableText(source.reason, "run-reason"),
  };
}

function normalizeEvidence(value: unknown): Evidence {
  const source = row(value, "evidence");
  const sourceId = text(source.source, "evidence-source");
  if (!(["dc", "naver", "youtube", "official"] as const).includes(sourceId as Evidence["source"])) {
    fail("invalid-evidence-source");
  }
  const access = text(source.access, "evidence-access");
  if (!(["body", "snippet", "description", "comment"] as const).includes(access as Evidence["access"])) {
    fail("invalid-evidence-access");
  }
  return {
    id: text(source.id, "evidence-id"),
    source: sourceId as Evidence["source"],
    externalId: text(source.external_id ?? source.externalId, "evidence-external-id"),
    url: text(source.url, "evidence-url"),
    title: text(source.title, "evidence-title"),
    excerpt: nullableText(source.excerpt, "evidence-excerpt"),
    publishedAt: nullableText(source.published_at ?? source.publishedAt, "evidence-published-at"),
    fetchedAt: text(source.fetched_at ?? source.fetchedAt, "evidence-fetched-at"),
    access: access as Evidence["access"],
    contentHash: text(source.content_hash ?? source.contentHash, "evidence-hash"),
    official: boolean(source.official, "evidence-official"),
  };
}

function normalizeSourceStatus(value: unknown): SourceStatus {
  const source = row(value, "source-status");
  const id = text(source.id, "source-status-id") as CollectSource;
  if (!SOURCE_IDS.includes(id)) fail("invalid-source-status-id");
  const state = text(source.state, "source-status-state") as SourceStatus["state"];
  if (!("ok partial empty needs_setup blocked failed disabled".split(" ") as SourceStatus["state"][]).includes(state)) {
    fail("invalid-source-status-state");
  }
  const channelId = nullableText(source.resolved_channel_id, "source-channel-id");
  const uploads = nullableText(source.uploads_playlist_id, "source-uploads-id");
  return {
    id,
    state,
    reason: nullableText(source.reason, "source-status-reason"),
    lastSuccessAt: nullableText(source.last_success_at, "source-last-success"),
    updatedAt: text(source.updated_at, "source-updated-at"),
    channel: channelId && uploads ? { id: channelId, uploads } : null,
  };
}

function requireSuccess(result: { error?: { message?: string } | null }, operation: string): void {
  if (result.error) throw new Error(`community-store-${operation}-failed: ${result.error.message || String(result.error)}`);
}

function assertEvidence(item: Evidence): void {
  if (!item.id || !item.externalId || !item.url || !item.title || !SHA256.test(item.contentHash)) {
    fail("invalid-evidence-input");
  }
  if (item.excerpt !== null && item.excerpt.length > 500) fail("evidence-excerpt-too-long");
  if (!Number.isFinite(Date.parse(item.fetchedAt))) fail("invalid-evidence-fetched-at");
  if (item.publishedAt !== null && !Number.isFinite(Date.parse(item.publishedAt))) fail("invalid-evidence-published-at");
}

/** Service-role repository for the DB-owned community run state machine. */
export class CommunityStore {
  constructor(private readonly client: DatabaseClient) {}

  async getPolicy(): Promise<Policy> {
    const { data, error } = await (this.client as any)
      .from("community_agent_policy")
      .select("enabled,publishing_enabled,bot_user_id,categories,daily_post_limit,source_enabled")
      .eq("singleton", true)
      .single();
    requireSuccess({ error }, "get-policy");
    return normalizePolicy(data);
  }

  async updatePolicy(patch: Partial<Policy>): Promise<Policy> {
    const input = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (Object.keys(input).length === 0) return this.getPolicy();
    const { data, error } = await this.client.rpc("configure_community_agent_policy", { p_patch: input });
    requireSuccess({ error }, "configure-policy");
    return normalizePolicy(data);
  }

  async getSources(): Promise<SourceStatus[]> {
    const { data, error } = await (this.client as any)
      .from("community_agent_sources")
      .select("id,state,reason,last_success_at,updated_at,resolved_channel_id,uploads_playlist_id")
      .order("id", { ascending: true });
    requireSuccess({ error }, "get-sources");
    return (data ?? []).map(normalizeSourceStatus);
  }

  async getSourceCache(source: CollectSource): Promise<{ id: string; uploads: string } | null> {
    if (!SOURCE_IDS.includes(source)) fail("invalid-source-cache-id");
    const { data, error } = await (this.client as any)
      .from("community_agent_sources")
      .select("resolved_channel_id,uploads_playlist_id")
      .eq("id", source)
      .single();
    requireSuccess({ error }, "get-source-cache");
    const sourceRow = row(data, "source-cache");
    const id = nullableText(sourceRow.resolved_channel_id, "source-cache-channel");
    const uploads = nullableText(sourceRow.uploads_playlist_id, "source-cache-uploads");
    return id && uploads ? { id, uploads } : null;
  }

  async recentRuns(days: number): Promise<RunSnapshot[]> {
    if (!Number.isInteger(days) || days < 1 || days > 30) fail("invalid-recent-run-days");
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await (this.client as any)
      .from("community_agent_runs")
      .select("run_id,day,status,stages,reports,topic,draft,validation,model_calls,dry_run,post_id,reason")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(31);
    requireSuccess({ error }, "recent-runs");
    return (data ?? []).map(normalizeSnapshot);
  }

  async startRun(actorId: string | null, dryRun: boolean): Promise<RunSnapshot> {
    const { data, error } = await this.client.rpc("start_community_run", {
      p_actor_id: actorId, p_dry_run: dryRun,
    });
    requireSuccess({ error }, "start-run");
    return normalizeSnapshot(data);
  }

  async getRun(id: string): Promise<RunSnapshot> {
    const { data, error } = await this.client.rpc("get_community_run", { p_run_id: id });
    requireSuccess({ error }, "get-run");
    return normalizeSnapshot(data);
  }

  async claimStage(id: string, stage: Stage): Promise<{ claimed: boolean; lease: string | null; run: RunSnapshot }> {
    const { data, error } = await this.client.rpc("claim_community_stage", { p_run_id: id, p_stage: stage });
    requireSuccess({ error }, "claim-stage");
    const result = row(data, "claim-stage");
    return {
      claimed: boolean(result.claimed, "claim-stage-claimed"),
      lease: nullableText(result.lease, "claim-stage-lease"),
      run: normalizeSnapshot(result.run),
    };
  }

  async finishStage(id: string, stage: Stage, lease: string, result: Record<string, unknown>): Promise<RunSnapshot> {
    const { data, error } = await this.client.rpc("finish_community_stage", {
      p_run_id: id, p_stage: stage, p_lease: lease, p_result: result,
    });
    requireSuccess({ error }, "finish-stage");
    return normalizeSnapshot(data);
  }

  async saveEvidence(items: Evidence[]): Promise<string[]> {
    if (items.length === 0) return [];
    for (const item of items) assertEvidence(item);
    const ids = new Map<string, string>();
    for (const source of new Set(items.map((item) => item.source))) {
      const group = items.filter((item) => item.source === source);
      const rows = group.map((item) => ({
        id: item.id, source: item.source, external_id: item.externalId, url: item.url, title: item.title,
        excerpt: item.excerpt, published_at: item.publishedAt, fetched_at: item.fetchedAt,
        access: item.access, content_hash: item.contentHash, official: item.official,
        expires_at: new Date(Date.parse(item.fetchedAt) + EVIDENCE_TTL_MS).toISOString(),
      }));
      // DO NOTHING on conflict preserves the original ID, fetch time, and excerpt expiry.
      const { error: writeError } = await (this.client as any)
        .from("community_agent_evidence")
        .upsert(rows, { onConflict: "source,external_id", ignoreDuplicates: true });
      requireSuccess({ error: writeError }, "save-evidence");
      const { data, error } = await (this.client as any)
        .from("community_agent_evidence")
        .select("id,source,external_id")
        .eq("source", source)
        .in("external_id", group.map((item) => item.externalId));
      requireSuccess({ error }, "load-saved-evidence");
      for (const saved of (data ?? [])) {
        const savedRow = row(saved, "saved-evidence");
        ids.set(`${text(savedRow.source, "saved-evidence-source")}:${text(savedRow.external_id, "saved-evidence-external-id")}`,
          text(savedRow.id, "saved-evidence-id"));
      }
    }
    return items.map((item) => {
      const id = ids.get(`${item.source}:${item.externalId}`);
      if (!id) fail("saved-evidence-not-found");
      return id;
    });
  }

  async loadEvidence(ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const { data, error } = await (this.client as any)
      .from("community_agent_evidence")
      .select("id,source,external_id,url,title,excerpt,published_at,fetched_at,access,content_hash,official")
      .in("id", ids);
    requireSuccess({ error }, "load-evidence");
    const loaded = new Map<string, Evidence>((data ?? []).map((item: unknown) => {
      const evidence = normalizeEvidence(item);
      return [evidence.id, evidence] as const;
    }));
    return ids.flatMap((id) => loaded.has(id) ? [loaded.get(id)!] : []);
  }

  async recentPosts(days: number): Promise<Array<{ title: string; topicKey: string | null; createdAt: string }>> {
    if (!Number.isInteger(days) || days < 1 || days > 90) fail("invalid-recent-post-days");
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const [{ data: postRows, error: postError }, { data: runRows, error: runError }] = await Promise.all([
      (this.client as any).from("posts").select("id,title,created_at").eq("status", "published").gte("created_at", cutoff).order("created_at", { ascending: false }),
      (this.client as any).from("community_agent_runs").select("post_id,topic").gte("created_at", cutoff),
    ]);
    requireSuccess({ error: postError }, "recent-posts");
    requireSuccess({ error: runError }, "recent-community-runs");
    const topicByPostId = new Map<number, string>();
    for (const run of runRows ?? []) {
      const runRow = row(run, "recent-community-run");
      const topic = asObject(runRow.topic);
      if (Number.isInteger(runRow.post_id) && typeof topic.topicKey === "string") topicByPostId.set(runRow.post_id as number, topic.topicKey);
    }
    return (postRows ?? []).map((post: unknown) => {
      const postRow = row(post, "recent-post");
      const id = postRow.id;
      return {
        title: text(postRow.title, "recent-post-title"),
        topicKey: Number.isInteger(id) ? topicByPostId.get(id as number) ?? null : null,
        createdAt: text(postRow.created_at, "recent-post-created-at"),
      };
    });
  }

  /** Local news bodies have no producer-owned provenance and cannot become official evidence. */
  async loadOfficialEvidence(): Promise<Evidence[]> {
    return [];
  }

  async publish(id: string): Promise<PublishResult> {
    const { data, error } = await this.client.rpc("publish_community_post", { p_run_id: id });
    requireSuccess({ error }, "publish");
    const result = row(data, "publish-result");
    const code = text(result.code, "publish-code") as PublishResult["code"];
    if (!(["published", "already_published", "paused", "not_ready", "expired", "limit", "invalid_bot"] as const).includes(code)) {
      fail("invalid-publish-code");
    }
    const postId = result.postId ?? result.post_id ?? null;
    if (postId !== null && (typeof postId !== "number" || !Number.isInteger(postId) || postId < 0)) {
      fail("invalid-publish-post-id");
    }
    return { code, postId: postId as number | null };
  }

  async cleanup(): Promise<{ excerpts: number; drafts: number; runs: number }> {
    const { data, error } = await this.client.rpc("cleanup_community_agent");
    requireSuccess({ error }, "cleanup");
    const result = row(data, "cleanup-result");
    for (const key of ["excerpts", "drafts", "runs"] as const) {
      if (typeof result[key] !== "number" || !Number.isInteger(result[key]) || result[key] < 0) {
        fail(`invalid-cleanup-${key}`);
      }
    }
    return result as { excerpts: number; drafts: number; runs: number };
  }
}
