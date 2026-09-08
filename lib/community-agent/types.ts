export type SourceId = "dc" | "naver" | "youtube" | "official";

export type CollectSource = Exclude<SourceId, "official">;

export type SourceState =
  | "ok"
  | "partial"
  | "empty"
  | "needs_setup"
  | "blocked"
  | "failed"
  | "disabled";

export type Stage = CollectSource | "select" | "draft" | "verify";

export type Evidence = {
  id: string;
  source: SourceId;
  externalId: string;
  url: string;
  title: string;
  excerpt: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  access: "body" | "snippet" | "description" | "comment";
  contentHash: string;
  official: boolean;
};

export type SourceReport = {
  source: CollectSource;
  state: SourceState;
  items: Evidence[];
  reason: string | null;
  fetchedCount: number;
  retainedCount: number;
  channel?: { id: string; uploads: string };
};

export type Policy = {
  enabled: boolean;
  publishingEnabled: boolean;
  botUserId: string | null;
  categories: Array<"배그 소식" | "자유">;
  dailyPostLimit: 0 | 1;
  sourceEnabled: Record<CollectSource, boolean>;
};

export type Topic = {
  kind: "news" | "tip" | "question";
  title: string;
  topicKey: string;
  evidenceIds: string[];
  reason: string;
  officialUpdate: boolean;
};

export type Claim = {
  text: string;
  evidenceIds: string[];
  kind: "official_fact" | "observed_opinion" | "suggestion";
  recentWindow: "24h" | "7d" | null;
};

export type Draft = {
  title: string;
  paragraphs: Claim[];
  question: string;
};

export type Validation = {
  passed: boolean;
  reasons: string[];
  contentHash: string;
};

export type StageState = {
  status: "running" | "completed" | "failed";
  lease: string;
  result: Record<string, unknown>;
};

export type RunSnapshot = {
  id: string;
  day: string;
  status:
    | "collecting"
    | "selected"
    | "drafted"
    | "ready"
    | "deferred"
    | "failed"
    | "published";
  stages: Partial<Record<Stage, StageState>>;
  modelCalls: number;
  reports: Array<Omit<SourceReport, "items"> & { evidenceIds: string[] }>;
  topic: Topic | null;
  draft: Draft | null;
  validation: Validation | null;
  postId: number | null;
  reason: string | null;
};

export type PublishResult = {
  code:
    | "published"
    | "already_published"
    | "paused"
    | "not_ready"
    | "expired"
    | "limit"
    | "invalid_bot";
  postId: number | null;
};
