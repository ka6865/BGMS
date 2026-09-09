import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunSnapshot, Stage } from "../lib/community-agent/types";
import { runCommunityCleanup, runCommunityWorker } from "../scripts/run_community_agent";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const LEASE = "22222222-2222-4222-8222-222222222222";
const STAGES = ["dc", "naver", "youtube", "select", "draft", "verify"] as const satisfies readonly Stage[];

function snapshot(
  status: RunSnapshot["status"],
  completed: readonly Stage[] = [],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    id: RUN_ID,
    day: "2026-09-09",
    status,
    stages: Object.fromEntries(completed.map((stage) => [stage, {
      status: "completed",
      lease: LEASE,
      result: {},
    }])) as RunSnapshot["stages"],
    modelCalls: completed.filter((stage) => ["select", "draft", "verify"].includes(stage)).length,
    dryRun: false,
    reports: [],
    topic: null,
    draft: null,
    validation: null,
    postId: null,
    reason: null,
    ...overrides,
  };
}

function requestBody(init?: RequestInit): Record<string, unknown> | null {
  return typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
}

describe("community agent worker", () => {
  it("runs persisted stages in order and publishes only the returned run ID", async () => {
    const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> | null }> = [];
    const completed: Stage[] = [];
    const statusAfter: Record<Stage, RunSnapshot["status"]> = {
      dc: "collecting",
      naver: "collecting",
      youtube: "collecting",
      select: "selected",
      draft: "drafted",
      verify: "ready",
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      calls.push({ url: String(url), init, body });
      if (body?.action === "start") return Response.json({ result: snapshot("collecting") });
      if (body?.action === "step") {
        const stage = body.stage as Stage;
        completed.push(stage);
        return Response.json({ result: snapshot(statusAfter[stage], completed) });
      }
      if (body?.action === "publish") return Response.json({ result: { code: "published", postId: 41 } });
      throw new Error("unexpected request");
    }) as unknown as typeof fetch;

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "published", postId: 41 });

    expect(calls.map((call) => call.body)).toEqual([
      { action: "start", dryRun: false },
      { action: "step", runId: RUN_ID, stage: "dc" },
      { action: "step", runId: RUN_ID, stage: "naver" },
      { action: "step", runId: RUN_ID, stage: "youtube" },
      { action: "step", runId: RUN_ID, stage: "select" },
      { action: "step", runId: RUN_ID, stage: "draft" },
      { action: "step", runId: RUN_ID, stage: "verify" },
      { action: "publish", runId: RUN_ID },
    ]);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer test-only");
    }
  });

  it("stops after a deferred status without invoking later stages or publish", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)!;
      calls.push(body);
      if (body.action === "start") return Response.json({ result: snapshot("collecting") });
      if (body.action === "step" && body.stage === "dc") {
        return Response.json({ result: snapshot("deferred", ["dc"], { reason: "source_paused" }) });
      }
      throw new Error("the runner must stop before this request");
    }) as unknown as typeof fetch;

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "deferred", postId: null });
    expect(calls).toEqual([
      { action: "start", dryRun: false },
      { action: "step", runId: RUN_ID, stage: "dc" },
    ]);
  });

  it("checks persisted state once after a lost stage response and never repeats that provider", async () => {
    const requests: Array<{ url: string; method: string | undefined; body: Record<string, unknown> | null }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      requests.push({ url: String(url), method: init?.method, body });
      if (body?.action === "start") return Response.json({ result: snapshot("collecting") });
      if (body?.action === "step" && body.stage === "dc") throw new TypeError("response connection lost");
      if (init?.method === "GET") return Response.json({ run: snapshot("ready", STAGES) });
      if (body?.action === "publish") return Response.json({ result: { code: "already_published", postId: 41 } });
      throw new Error("unexpected request");
    }) as unknown as typeof fetch;

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "already_published", postId: 41 });
    expect(requests).toEqual([
      { url: "https://bgms.test/api/admin/agent/community/run", method: "POST", body: { action: "start", dryRun: false } },
      { url: "https://bgms.test/api/admin/agent/community/run", method: "POST", body: { action: "step", runId: RUN_ID, stage: "dc" } },
      { url: `https://bgms.test/api/admin/agent/community/run?runId=${RUN_ID}`, method: "GET", body: null },
      { url: "https://bgms.test/api/admin/agent/community/run", method: "POST", body: { action: "publish", runId: RUN_ID } },
    ]);
  });

  it("leaves a running recovered stage alone", async () => {
    const requests: Array<Record<string, unknown> | "get"> = [];
    const running = snapshot("collecting", [], {
      stages: { dc: { status: "running", lease: LEASE, result: {} } },
    });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      if (body) requests.push(body); else requests.push("get");
      if (body?.action === "start") return Response.json({ result: snapshot("collecting") });
      if (body?.action === "step") throw new TypeError("response connection lost");
      return Response.json({ run: running });
    }) as unknown as typeof fetch;

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "collecting", postId: null });
    expect(requests).toEqual([
      { action: "start", dryRun: false },
      { action: "step", runId: RUN_ID, stage: "dc" },
      "get",
    ]);
  });

  it("returns a failed recovered run without calling another provider", async () => {
    const requests: Array<Record<string, unknown> | "get"> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      if (body) requests.push(body); else requests.push("get");
      if (body?.action === "start") return Response.json({ result: snapshot("collecting") });
      if (body?.action === "step") throw new TypeError("response connection lost");
      return Response.json({ run: snapshot("failed", [], { reason: "source_failure" }) });
    }) as unknown as typeof fetch;

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "failed", postId: null });
    expect(requests).toEqual([
      { action: "start", dryRun: false },
      { action: "step", runId: RUN_ID, stage: "dc" },
      "get",
    ]);
  });

  it("reuses an already-ready run and records a paused publish outcome", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)!;
      calls.push(body);
      if (body.action === "start") return Response.json({ result: snapshot("ready", STAGES) });
      if (body.action === "publish") return Response.json({ result: { code: "paused", postId: null } });
      throw new Error("an existing ready run must not repeat a stage");
    }) as unknown as typeof fetch;

    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "paused", postId: null });
    expect(calls).toEqual([
      { action: "start", dryRun: false },
      { action: "publish", runId: RUN_ID },
    ]);
  });

  it("rejects a non-origin URL and a missing worker secret before sending a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const baseUrl of [
      "http://localhost:3000",
      "https://worker:secret@bgms.test",
      "https://bgms.test/path",
      "https://bgms.test?query",
      "https://bgms.test#fragment",
    ]) {
      await expect(runCommunityWorker({ baseUrl, secret: "test-only", fetchImpl }))
        .rejects.toThrow("community-agent-app-url-invalid");
    }
    await expect(runCommunityWorker({ baseUrl: "https://bgms.test", secret: "", fetchImpl }))
      .rejects.toThrow("community-agent-worker-secret-missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the fixed cleanup endpoint without a request body", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("error");
      return Response.json({ result: { excerpts: 3, drafts: 2, runs: 1 } });
    }) as unknown as typeof fetch;

    await expect(runCommunityCleanup({ baseUrl: "https://bgms.test", secret: "test-only", fetchImpl }))
      .resolves.toEqual({ status: "cleaned", postId: null });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bgms.test/api/admin/agent/community/cleanup",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("community agent scheduled workflow", () => {
  it("uses only the application URL and worker secret, with cleanup while publishing is disabled", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/community-agent.yml"), "utf8");

    expect(workflow).toContain("cron: '0 0 * * *'");
    expect(workflow).toContain("COMMUNITY_AGENT_SCHEDULE_ENABLED");
    expect(workflow).toContain("scripts/run_community_agent.ts --cleanup-only");
    expect(workflow).toContain("vars.COMMUNITY_AGENT_SCHEDULE_ENABLED != 'true'");
    expect(workflow).toContain("COMMUNITY_AGENT_APP_URL: ${{ vars.APP_URL }}");
    expect(workflow).toContain("COMMUNITY_AGENT_WORKER_SECRET: ${{ secrets.COMMUNITY_AGENT_WORKER_SECRET }}");
    for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_GEMINI_API_KEY", "NAVER_SEARCH_CLIENT", "YOUTUBE_DATA_API_KEY", "DISCORD_WEBHOOK_URL"]) {
      expect(workflow).not.toContain(forbidden);
    }
  });
});
