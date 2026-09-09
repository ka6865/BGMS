import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, Evidence, Policy, RunSnapshot, Stage, Topic, Validation } from "../lib/community-agent/types";
import { checkDraft, renderDraft } from "../lib/community-agent/validate";
import { koreanDay } from "../lib/community-agent/policy";
import { runCommunityWorker } from "../scripts/run_community_agent";

const RUN_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-09-09T01:00:00.000Z");

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  modelCalls: 0,
  providerFetch: vi.fn(),
  commentInsert: vi.fn(),
}));

vi.mock("@/lib/community-agent/auth", () => ({
  resolveCommunityActor: vi.fn(async (request: Request) => request.headers.has("authorization")
    ? { kind: "worker", userId: null }
    : { kind: "admin", userId: "admin-user" }),
  createCommunityStore: () => ({ client: {}, store: mocks.store }),
  prepareCommunityBot: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
  SchemaType: { STRING: "string", BOOLEAN: "boolean", ARRAY: "array", OBJECT: "object" },
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        generateContent: vi.fn(async (payload: string) => {
          mocks.modelCalls += 1;
          const data = JSON.parse(payload) as Record<string, unknown>;
          let output: unknown;
          if (Array.isArray(data.candidateGroups)) {
            const evidence = data.evidence as Array<Record<string, unknown>>;
            const selected = evidence.find((item) => item.source === "dc") ?? evidence[0];
            output = {
              kind: "question", title: "패치 뒤 매칭 질문 살펴보기", topicKey: "matching-question",
              evidenceIds: [selected.id], reason: "본문을 확인한 개별 질문입니다.", officialUpdate: false,
            };
          } else if (data.topic) {
            const evidence = data.evidence as Array<Record<string, unknown>>;
            output = {
              title: "패치 뒤 매칭 질문 살펴보기",
              paragraphs: [{
                text: "한 자료에서 패치 이후 매칭에 관한 질문을 확인했습니다.",
                kind: "observed_opinion", evidenceIds: [evidence[0].id], recentWindow: "24h",
              }],
              question: "여러분은 비슷한 상황을 겪으셨나요?",
            };
          } else {
            output = { passed: true, reasons: [] };
          }
          return {
            response: {
              text: () => JSON.stringify(output),
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
            },
          };
        }),
      };
    }
  },
}));

import { POST as configurePOST } from "../app/api/admin/agent/community/route";
import { GET as runGET, POST as runPOST } from "../app/api/admin/agent/community/run/route";

type ApprovedDraft = { title: string; html: string; category: "배그 소식" | "자유"; hash: string };

class FlowStore {
  policy: Policy = {
    enabled: true,
    publishingEnabled: false,
    botUserId: "00000000-0000-4000-8000-000000000901",
    categories: ["배그 소식", "자유"],
    dailyPostLimit: 1,
    sourceEnabled: { dc: true, naver: true, youtube: false },
  };
  run: RunSnapshot | null = null;
  evidence = new Map<string, Evidence>();
  posts: Array<{ id: number; title: string; html: string }> = [];
  approved: ApprovedDraft | null = null;

  async cleanup() { return { excerpts: 0, drafts: 0, runs: 0 }; }

  async getPolicy() { return this.policy; }

  async updatePolicy(patch: Partial<Policy>) {
    const enablingPublication = !this.policy.publishingEnabled && patch.publishingEnabled === true;
    this.policy = { ...this.policy, ...patch };
    if (enablingPublication && this.policy.enabled && this.policy.publishingEnabled && this.run?.dryRun
      && this.run.status === "ready" && this.run.day === koreanDay(new Date()) && this.run.draft
      && this.run.validation?.passed && this.approved) {
      const ids = [...new Set(this.run.draft.paragraphs.flatMap((paragraph) => paragraph.evidenceIds))];
      const evidence = ids.flatMap((id) => this.evidence.has(id) ? [this.evidence.get(id)!] : []);
      const checked = checkDraft(this.run.draft, evidence, new Date());
      const rendered = renderDraft(this.run.draft, evidence);
      if (ids.length > 0 && evidence.length === ids.length && checked.passed
        && checked.contentHash === this.run.validation.contentHash
        && rendered.hash === this.approved.hash) {
        this.run.dryRun = false;
      }
    }
    return this.policy;
  }

  async startRun(_actorId: string | null, dryRun: boolean) {
    if (!this.run) {
      this.run = {
        id: RUN_ID, day: koreanDay(new Date()), status: "collecting", stages: {}, modelCalls: 0,
        reports: [], topic: null, draft: null, validation: null, dryRun, postId: null, reason: null,
      };
    }
    return this.run;
  }

  async getRun() {
    if (!this.run) throw new Error("missing run");
    return this.run;
  }

  async claimStage(_id: string, stage: Stage) {
    const run = await this.getRun();
    if (run.stages[stage] || ["ready", "deferred", "failed", "published"].includes(run.status)) {
      return { claimed: false, lease: null, run };
    }
    const lease = `lease-${stage}`;
    if (["select", "draft", "verify"].includes(stage)) run.modelCalls += 1;
    run.stages[stage] = { status: "running", lease, result: {} };
    return { claimed: true, lease, run };
  }

  async finishStage(_id: string, stage: Stage, lease: string, result: Record<string, unknown>) {
    const run = await this.getRun();
    run.stages[stage] = { status: "completed", lease, result };
    if (stage === "dc" || stage === "naver" || stage === "youtube") {
      run.reports.push({ source: stage, ...result } as RunSnapshot["reports"][number]);
    } else if (stage === "select") {
      run.topic = result.topic as Topic;
      run.status = "selected";
    } else if (stage === "draft") {
      run.draft = result.draft as Draft;
      run.status = "drafted";
    } else {
      run.validation = result.validation as Validation;
      if (run.validation.passed) {
        const rendered = result.rendered as ApprovedDraft;
        this.approved = { ...rendered, hash: run.validation.contentHash };
        run.status = "ready";
      } else {
        run.status = "deferred";
        run.reason = "validation_failed";
      }
    }
    return run;
  }

  async saveEvidence(items: Evidence[]) {
    for (const item of items) this.evidence.set(item.id, item);
    return items.map((item) => item.id);
  }

  async loadEvidence(ids: string[]) {
    return ids.flatMap((id) => this.evidence.has(id) ? [this.evidence.get(id)!] : []);
  }

  async loadOfficialEvidence() { return []; }
  async recentPosts() { return []; }
  async getSourceCache() { return null; }

  async publish() {
    const run = await this.getRun();
    if (run.status === "published") return { code: "already_published" as const, postId: run.postId };
    if (run.dryRun) return { code: "not_ready" as const, postId: null };
    if (!this.policy.enabled || !this.policy.publishingEnabled) return { code: "paused" as const, postId: null };
    if (run.day !== koreanDay(new Date())) return { code: "expired" as const, postId: null };
    if (run.status !== "ready" || !this.approved) return { code: "not_ready" as const, postId: null };
    const postId = this.posts.length + 1;
    this.posts.push({ id: postId, title: this.approved.title, html: this.approved.html });
    run.status = "published";
    run.postId = postId;
    return { code: "published" as const, postId };
  }
}

function response(body: unknown, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function providerResponse(url: RequestInfo | URL): Response {
  const parsed = new URL(String(url));
  if (parsed.hostname === "gall.dcinside.com" && parsed.pathname === "/board/lists/") {
    return response('<table class="gall_list"><tr class="ub-content"><td class="gall_num">901</td><td><a href="/board/view/?id=battlegrounds&no=901">패치 뒤 매칭 질문</a></td><td class="gall_date" title="2026-09-09 09:30:00">09:30</td></tr></table>');
  }
  if (parsed.hostname === "gall.dcinside.com" && parsed.pathname === "/board/view/") {
    return response('<div class="write_div">패치 이후 매칭 방식이 달라졌는지 궁금합니다.</div>');
  }
  if (parsed.hostname === "naverapihub.apigw.ntruss.com" && parsed.pathname === "/search/v1/cafearticle") {
    return response({ items: [{
      title: "매칭 질문", link: "https://cafe.naver.com/playbattlegrounds/901",
      cafeurl: "https://cafe.naver.com/playbattlegrounds", description: "매칭 관련 공개 검색 요약",
    }] });
  }
  if (parsed.pathname === "/youtube/v3/channels") {
    return response({ items: [{ id: "channel-1", contentDetails: { relatedPlaylists: { uploads: "uploads-1" } } }] });
  }
  if (parsed.pathname === "/youtube/v3/playlistItems") {
    return response({ items: [{ snippet: {
      resourceId: { videoId: "video-1" }, title: "공식 업데이트", description: "공식 영상 설명",
      publishedAt: "2026-09-08T12:00:00Z",
    } }] });
  }
  if (parsed.pathname === "/youtube/v3/commentThreads") return response({ items: [] });
  throw new Error(`unexpected provider URL ${parsed.origin}${parsed.pathname}`);
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function configure(patch: Partial<Policy>) {
  const response = await configurePOST(jsonRequest("https://bgms.test/api/admin/agent/community", { action: "configure", patch }));
  expect(response.status).toBe(200);
}

async function beginDryRun() {
  await configure({ sourceEnabled: { dc: true, naver: true, youtube: true } });
  const response = await runPOST(jsonRequest("https://bgms.test/api/admin/agent/community/run", { action: "start", dryRun: true }));
  expect(response.status).toBe(200);
}

const routeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(String(url), init);
  return request.method === "GET" ? runGET(request) : runPOST(request);
}) as unknown as typeof fetch;

describe("community agent provider-mocked lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mocks.modelCalls = 0;
    mocks.commentInsert.mockClear();
    mocks.providerFetch.mockReset().mockImplementation(providerResponse);
    vi.stubGlobal("fetch", mocks.providerFetch);
    mocks.store = new FlowStore();
    process.env.GOOGLE_GEMINI_API_KEY = "fixture-key";
    process.env.NAVER_SEARCH_CLIENT_ID = "fixture-id";
    process.env.NAVER_SEARCH_CLIENT_SECRET = "fixture-secret";
    process.env.YOUTUBE_DATA_API_KEY = "fixture-youtube-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("collects three providers, promotes one verified dry run, and keeps same-day retries idempotent", async () => {
    const store = mocks.store as FlowStore;
    await beginDryRun();

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "worker-secret", fetchImpl: routeFetch }))
      .resolves.toEqual({ status: "not_ready", postId: null });
    expect(store.run?.status).toBe("ready");
    expect(store.run?.dryRun).toBe(true);
    expect(store.posts).toHaveLength(0);
    expect(mocks.modelCalls).toBe(3);
    expect(new Set(mocks.providerFetch.mock.calls.map(([url]) => new URL(String(url)).hostname))).toEqual(new Set([
      "gall.dcinside.com", "naverapihub.apigw.ntruss.com", "www.googleapis.com",
    ]));

    await configure({ publishingEnabled: true });
    expect(store.run?.dryRun).toBe(false);
    expect(store.posts).toHaveLength(0);

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "worker-secret", fetchImpl: routeFetch }))
      .resolves.toEqual({ status: "published", postId: 1 });
    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "worker-secret", fetchImpl: routeFetch }))
      .resolves.toEqual({ status: "published", postId: 1 });
    expect(store.posts).toHaveLength(1);
    expect(store.run?.modelCalls).toBeLessThanOrEqual(3);
    expect(mocks.commentInsert).not.toHaveBeenCalled();
  });

  it("respects an administrator pause immediately after verification", async () => {
    const store = mocks.store as FlowStore;
    await beginDryRun();
    await runCommunityWorker({ baseUrl: "https://bgms.test", secret: "worker-secret", fetchImpl: routeFetch });
    await configure({ publishingEnabled: true });
    await configure({ publishingEnabled: false });

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "worker-secret", fetchImpl: routeFetch }))
      .resolves.toEqual({ status: "paused", postId: null });
    expect(store.posts).toHaveLength(0);
    expect(store.run?.modelCalls).toBe(3);
    expect(mocks.commentInsert).not.toHaveBeenCalled();
  });
});
