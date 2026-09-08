import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../lib/community-agent/types";

const mocks = vi.hoisted(() => ({
  sourceFetch: vi.fn(),
  createClient: vi.fn(),
  withAuthGuard: vi.fn(),
  verifyAdminRole: vi.fn(),
  selectTopic: vi.fn(),
  writeDraft: vi.fn(),
  verifyDraft: vi.fn(),
  createGeminiJsonModel: vi.fn(() => vi.fn()),
}));

vi.mock("../lib/community-agent/sources", async () => {
  const actual = await vi.importActual<typeof import("../lib/community-agent/sources")>("../lib/community-agent/sources");
  return { ...actual, collectSource: mocks.sourceFetch };
});

vi.mock("../lib/community-agent/editorial", async () => {
  const actual = await vi.importActual<typeof import("../lib/community-agent/editorial")>("../lib/community-agent/editorial");
  return {
    ...actual,
    createGeminiJsonModel: mocks.createGeminiJsonModel,
    selectTopic: mocks.selectTopic,
    writeDraft: mocks.writeDraft,
    verifyDraft: mocks.verifyDraft,
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("../utils/supabase/guard", () => ({ withAuthGuard: mocks.withAuthGuard }));
vi.mock("../lib/admin-agent/logging", () => ({ verifyAdminRole: mocks.verifyAdminRole }));

import { POST as runPOST } from "../app/api/admin/agent/community/run/route";
import { POST as communityPOST } from "../app/api/admin/agent/community/route";
import { POST as cleanupPOST } from "../app/api/admin/agent/community/cleanup/route";
import { executeAction } from "../lib/community-agent/service";
import { prepareCommunityBot } from "../lib/community-agent/auth";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const LEASE = "11111111-1111-4111-8111-111111111111";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN_ID,
    day: "2026-09-09",
    status: "collecting",
    stages: {},
    modelCalls: 0,
    reports: [],
    topic: null,
    draft: null,
    validation: null,
    postId: null,
    reason: null,
    ...overrides,
  };
}

function request(body: unknown, token?: string, url = "https://bgms.test/api/admin/agent/community/run") {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function cleanupRequest(token?: string, body?: unknown) {
  return new Request("https://bgms.test/api/admin/agent/community/cleanup", {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("community agent API authentication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMMUNITY_AGENT_WORKER_SECRET;
    process.env.ADMIN_AGENT_CRON_SECRET = "other-cron-token";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    mocks.withAuthGuard.mockResolvedValue({
      error: Response.json({ code: "unauthorized" }, { status: 401 }),
    });
    mocks.verifyAdminRole.mockResolvedValue(null);
  });

  it.each([
    ["worker secret missing", undefined, "https://bgms.test/api/admin/agent/community/run"],
    ["empty worker secret", "", "https://bgms.test/api/admin/agent/community/run"],
    ["query secret", undefined, "https://bgms.test/api/admin/agent/community/run?secret=worker-token"],
    ["different cron token", "other-cron-token", "https://bgms.test/api/admin/agent/community/run"],
  ])("rejects %s before assistant state or source access", async (_name, token, url) => {
    if (_name !== "worker secret missing") process.env.COMMUNITY_AGENT_WORKER_SECRET = _name === "empty worker secret" ? "" : "worker-token";

    const response = await runPOST(request({ action: "start", dryRun: false }, token, url));

    expect(response.status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.sourceFetch).not.toHaveBeenCalled();
  });

  it("rejects a signed-in ordinary user before assistant state or source access", async () => {
    mocks.withAuthGuard.mockResolvedValue({ user: { id: "ordinary-user" }, supabaseAdmin: { from: vi.fn() } });
    mocks.verifyAdminRole.mockResolvedValue(Response.json({ code: "forbidden" }, { status: 403 }));

    const response = await runPOST(request({ action: "start", dryRun: false }));

    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.sourceFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown action", { action: "erase" }],
    ["arbitrary stage", { action: "step", runId: RUN_ID, stage: "publish" }],
    ["publish body injection", { action: "publish", runId: RUN_ID, content: "attacker supplied" }],
  ])("returns 400 for %s without source access", async (_name, body) => {
    process.env.COMMUNITY_AGENT_WORKER_SECRET = "worker-token";
    const response = await runPOST(request(body, "worker-token"));
    expect(response.status).toBe(400);
    expect(mocks.sourceFetch).not.toHaveBeenCalled();
  });

  it("forbids worker dry-run starts", async () => {
    process.env.COMMUNITY_AGENT_WORKER_SECRET = "worker-token";
    const response = await runPOST(request({ action: "start", dryRun: true }, "worker-token"));
    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects non-JSON and bodies over 16KB", async () => {
    process.env.COMMUNITY_AGENT_WORKER_SECRET = "worker-token";
    const wrongType = await runPOST(new Request("https://bgms.test/api/admin/agent/community/run", {
      method: "POST", headers: { authorization: "Bearer worker-token", "content-type": "text/plain" }, body: "{}",
    }));
    const tooLarge = await runPOST(new Request("https://bgms.test/api/admin/agent/community/run", {
      method: "POST", headers: { authorization: "Bearer worker-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", runId: RUN_ID, padding: "x".repeat(17_000) }),
    }));
    expect(wrongType.status).toBe(400);
    expect(tooLarge.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("does not let a worker reach configuration or bot preparation", async () => {
    process.env.COMMUNITY_AGENT_WORKER_SECRET = "worker-token";
    for (const body of [{ action: "configure", patch: { enabled: true } }, { action: "prepare_bot" }]) {
      const response = await communityPOST(request(body, "worker-token", "https://bgms.test/api/admin/agent/community"));
      expect(response.status).toBe(403);
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("limits cleanup to an authenticated no-body admin or dedicated worker request", async () => {
    process.env.COMMUNITY_AGENT_WORKER_SECRET = "worker-token";

    const unauthorized = await cleanupPOST(cleanupRequest());
    const injected = await cleanupPOST(cleanupRequest("worker-token", { action: "publish", runId: RUN_ID }));

    expect(unauthorized.status).toBe(401);
    expect(injected.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.sourceFetch).not.toHaveBeenCalled();

    const rpc = vi.fn().mockResolvedValue({ data: { excerpts: 3, drafts: 2, runs: 1 }, error: null });
    mocks.createClient.mockReturnValue({ rpc });
    const response = await cleanupPOST(cleanupRequest("worker-token"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { excerpts: 3, drafts: 2, runs: 1 } });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("cleanup_community_agent");
    expect(mocks.sourceFetch).not.toHaveBeenCalled();

    const adminRpc = vi.fn().mockResolvedValue({ data: { excerpts: 0, drafts: 0, runs: 0 }, error: null });
    mocks.createClient.mockReturnValue({ rpc: adminRpc });
    mocks.withAuthGuard.mockResolvedValue({ user: { id: "admin-user" }, supabaseAdmin: {} });
    const adminResponse = await cleanupPOST(cleanupRequest());

    expect(adminResponse.status).toBe(200);
    expect(adminRpc).toHaveBeenCalledWith("cleanup_community_agent");
  });
});

describe("executeAction state boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists a collect report with canonical evidence IDs under the claimed lease", async () => {
    const evidence = {
      id: "33333333-3333-4333-8333-333333333333", source: "dc" as const, externalId: "10",
      url: "https://gall.dcinside.com/board/view/?id=battlegrounds&no=10", title: "question", excerpt: "body",
      publishedAt: null, fetchedAt: "2026-09-09T00:00:00.000Z", access: "body" as const,
      contentHash: "a".repeat(64), official: false,
    };
    mocks.sourceFetch.mockResolvedValue({ source: "dc", state: "ok", items: [evidence], reason: null, fetchedCount: 1, retainedCount: 1 });
    const store = {
      claimStage: vi.fn().mockResolvedValue({ claimed: true, lease: LEASE, run: snapshot() }),
      getPolicy: vi.fn().mockResolvedValue({ sourceEnabled: { dc: true, naver: true, youtube: true } }),
      saveEvidence: vi.fn().mockResolvedValue(["44444444-4444-4444-8444-444444444444"]),
      finishStage: vi.fn().mockResolvedValue(snapshot()),
    };

    await executeAction({ action: "step", runId: RUN_ID, stage: "dc" }, { kind: "worker", userId: null }, store as never);

    expect(store.finishStage).toHaveBeenCalledWith(RUN_ID, "dc", LEASE, {
      state: "ok", reason: null, fetchedCount: 1, retainedCount: 1,
      evidenceIds: ["44444444-4444-4444-8444-444444444444"],
    });
  });

  it("finishes select as deferred without calling a model when there is no usable evidence", async () => {
    const run = snapshot({ reports: [
      { source: "dc", state: "empty", reason: "none", fetchedCount: 0, retainedCount: 0, evidenceIds: [] },
      { source: "naver", state: "failed", reason: "timeout", fetchedCount: 0, retainedCount: 0, evidenceIds: [] },
      { source: "youtube", state: "needs_setup", reason: "missing", fetchedCount: 0, retainedCount: 0, evidenceIds: [] },
    ] });
    const store = {
      claimStage: vi.fn().mockResolvedValue({ claimed: true, lease: LEASE, run }),
      loadOfficialEvidence: vi.fn().mockResolvedValue([]),
      saveEvidence: vi.fn().mockResolvedValue([]),
      loadEvidence: vi.fn().mockResolvedValue([]),
      finishStage: vi.fn().mockResolvedValue(snapshot({ status: "deferred", reason: "no_usable_evidence" })),
    };

    const result = await executeAction({ action: "step", runId: RUN_ID, stage: "select" }, { kind: "worker", userId: null }, store as never);

    expect(mocks.selectTopic).not.toHaveBeenCalled();
    expect(store.finishStage).toHaveBeenCalledWith(RUN_ID, "select", LEASE, {
      terminal: { status: "deferred", reason: "no_usable_evidence" },
    });
    expect(result).toEqual(expect.objectContaining({ status: "deferred" }));
  });

  it("returns the stored run and does no work when a stage was already claimed or completed", async () => {
    const run = snapshot({ status: "selected" });
    const store = { claimStage: vi.fn().mockResolvedValue({ claimed: false, lease: null, run }) };

    await expect(executeAction(
      { action: "step", runId: RUN_ID, stage: "select" }, { kind: "worker", userId: null }, store as never,
    )).resolves.toEqual(run);
    expect(mocks.selectTopic).not.toHaveBeenCalled();
  });

  it("preserves RPC idempotency for an already-published run after its draft is gone", async () => {
    const publish = vi.fn().mockResolvedValue({ code: "already_published", postId: 41 });
    const store = {
      getRun: vi.fn().mockResolvedValue(snapshot({ status: "published", draft: null, postId: 41 })),
      publish,
      loadEvidence: vi.fn(),
    };

    await expect(executeAction(
      { action: "publish", runId: RUN_ID }, { kind: "worker", userId: null }, store as never,
    )).resolves.toEqual({ code: "already_published", postId: 41 });
    expect(publish).toHaveBeenCalledWith(RUN_ID);
    expect(store.loadEvidence).not.toHaveBeenCalled();
  });
});

describe("reserved community bot identity", () => {
  it("does not adopt an existing reserved email without the server marker", async () => {
    const createUser = vi.fn();
    const client = {
      auth: { admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [{
          id: "user-collision",
          email: "bgms-community-agent@users.invalid",
          app_metadata: {},
          user_metadata: { nickname: "BGMS AI 비서" },
        }] }, error: null }),
        createUser,
      } },
    };
    const store = {
      getPolicy: vi.fn().mockResolvedValue({ botUserId: null }),
      updatePolicy: vi.fn(),
    };

    await expect(prepareCommunityBot(client as never, store as never)).resolves.toEqual({
      code: "conflict", reason: "reserved_identity_conflict",
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(store.updatePolicy).not.toHaveBeenCalled();
  });

  it("recovers a lost create response by exact email and marker without creating twice", async () => {
    const recovered = {
      id: "55555555-5555-4555-8555-555555555555",
      email: "bgms-community-agent@users.invalid",
      app_metadata: { community_agent: true },
      user_metadata: { nickname: "BGMS AI 비서" },
    };
    const listUsers = vi.fn()
      .mockResolvedValueOnce({ data: { users: [] }, error: null })
      .mockResolvedValueOnce({ data: { users: [recovered] }, error: null });
    const createUser = vi.fn().mockResolvedValue({ data: { user: null }, error: { message: "response lost" } });
    const client = {
      auth: { admin: { listUsers, createUser } },
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: { role: "user", nickname: "BGMS AI 비서" }, error: null,
        }) }) }),
      })),
    };
    const store = {
      getPolicy: vi.fn().mockResolvedValue({ botUserId: null }),
      updatePolicy: vi.fn().mockResolvedValue({}),
    };

    await expect(prepareCommunityBot(client as never, store as never)).resolves.toEqual({
      code: "reused", userId: recovered.id,
    });
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(store.updatePolicy).toHaveBeenCalledWith({ botUserId: recovered.id });
    const createInput = createUser.mock.calls[0][0];
    expect(createInput).toMatchObject({
      email: "bgms-community-agent@users.invalid", email_confirm: true,
      user_metadata: { nickname: "BGMS AI 비서" }, app_metadata: { community_agent: true },
    });
    expect(createInput.password).toHaveLength(64);
  });
});
