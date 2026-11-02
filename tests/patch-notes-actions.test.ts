import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/patch-notes/run/route";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/server/adminGuard", () => ({ requireAdmin: mocks.requireAdmin }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_ACTIONS_TOKEN", "fixture-actions-token");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireAdmin.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("관리자 패치노트 Actions 실행", () => {
  it.each([401, 403])("권한 검증 실패 %s에서는 GitHub를 호출하지 않는다", async (status) => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, error: Response.json({ error: "denied" }, { status }) });
    expect((await POST()).status).toBe(status);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("토큰이 없으면 503이고 GitHub를 호출하지 않는다 (%s)", async (token) => {
    vi.stubEnv("GITHUB_ACTIONS_TOKEN", token);
    expect((await POST()).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([200, 204])("GitHub %s 응답은 동기화 완료가 아닌 실행 요청 접수다", async (status) => {
    mocks.fetch.mockResolvedValue(new Response(null, { status }));
    const response = await POST();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, message: expect.stringContaining("실행을 요청") });
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/ka6865/BGMS/actions/workflows/patch-notes-sync.yml/dispatches",
      expect.objectContaining({
        method: "POST", body: JSON.stringify({ ref: "main" }), redirect: "error",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Authorization: "Bearer fixture-actions-token" }),
      }),
    );
  });

  it.each([401, 403, 404, 422, 500])("GitHub 오류 %s의 본문을 노출하지 않는다", async (status) => {
    mocks.fetch.mockResolvedValue(new Response("private details fixture-actions-token", { status }));
    const response = await POST();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/private details|fixture-actions-token/);
  });

  it("통신 실패는 자동 재시도 없이 실행 내역 확인을 안내한다", async () => {
    mocks.fetch.mockRejectedValue(new Error("private details fixture-actions-token"));
    const response = await POST();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toContain("실행 내역을 확인");
    expect(body.error).not.toContain("fixture-actions-token");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

it("전용 workflow는 기존 동기화 스크립트만 main에서 실행하고 일일 실행과 겹치지 않는다", () => {
  const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
  const workflow = yaml.load(readFileSync(".github/workflows/patch-notes-sync.yml", "utf8"));
  const daily = yaml.load(readFileSync(".github/workflows/daily-tasks.yml", "utf8"));
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.concurrency).toEqual(daily.concurrency);
  expect(Object.keys(workflow.jobs)).toEqual(["sync"]);
  expect(workflow.jobs.sync.if).toContain("github.ref == 'refs/heads/main'");
  const step = workflow.jobs.sync.steps.find((step: { name: string }) => step.name === "Sync Patch Notes");
  const dailyStep = daily.jobs.maintenance.steps.find((step: { name: string }) => step.name === "Sync Patch Notes");
  expect(step.run).toBe("npx tsx scripts/sync_patch_notes.ts");
  expect(step.env).toEqual(dailyStep.env);
});
