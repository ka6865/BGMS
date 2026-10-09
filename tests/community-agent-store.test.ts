import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommunityStore } from "../lib/community-agent/store";

const HASH = "a".repeat(64);
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function query(response: { data?: unknown; error?: unknown }) {
  const value: Record<string, unknown> = {};
  for (const name of ["eq", "in", "gte", "order", "limit", "not"]) {
    value[name] = () => value;
  }
  value.single = async () => response;
  value.maybeSingle = async () => response;
  value.then = (resolvePromise: (result: unknown) => unknown) => Promise.resolve(response).then(resolvePromise);
  return value;
}

describe("CommunityStore", () => {
  it("loads rejected evidence and fails closed on storage errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ["rejected-source"], error: null });
    const store = new CommunityStore({ rpc } as never);
    await expect(store.rejectedEvidenceIds()).resolves.toEqual(["rejected-source"]);
    expect(rpc).toHaveBeenCalledWith("community_rejected_evidence_ids");
    rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    await expect(store.rejectedEvidenceIds()).rejects.toThrow();
  });

  it("partial policy updates do not resend a stale enabled value", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        enabled: false, publishing_enabled: false, bot_user_id: null,
        categories: ["배그 소식", "자유"], daily_post_limit: 0,
        source_enabled: { dc: true, naver: true, youtube: false },
      }, error: null,
    });
    const store = new CommunityStore({ rpc } as never);

    await store.updatePolicy({ dailyPostLimit: 0 });

    expect(rpc).toHaveBeenCalledWith("configure_community_agent_policy", {
      p_patch: { dailyPostLimit: 0 },
    });
  });

  it("RPC 오류를 숨기지 않고 start 호출을 중단한다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "denied" } });
    const store = new CommunityStore({ rpc } as never);

    await expect(store.startRun(null, false)).rejects.toThrow("denied");
  });

  it("manual retry RPC 결과를 shared run contract로 변환한다", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        run_id: RUN_ID,
        day: "2026-09-09",
        status: "collecting",
        stages: {},
        model_calls: 0,
        reports: [],
        topic: null,
        draft: null,
        validation: null,
        dry_run: true,
        post_id: null,
        reason: null,
      },
      error: null,
    });
    const store = new CommunityStore({ rpc } as never);

    await expect(store.retryRun("admin-user", RUN_ID)).resolves.toEqual(expect.objectContaining({
      id: RUN_ID,
      day: "2026-09-09",
      status: "collecting",
      modelCalls: 0,
      dryRun: true,
      postId: null,
    }));
    expect(rpc).toHaveBeenCalledWith("retry_community_run", {
      p_actor_id: "admin-user",
      p_previous_run_id: RUN_ID,
    });
  });

  it("manual retry RPC 오류를 숨기지 않는다", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "community_retry_not_available" },
    });
    const store = new CommunityStore({ rpc } as never);

    await expect(store.retryRun("admin-user", RUN_ID)).rejects.toThrow(
      "community-store-retry-run-failed: community_retry_not_available",
    );
    expect(rpc).toHaveBeenCalledWith("retry_community_run", {
      p_actor_id: "admin-user",
      p_previous_run_id: RUN_ID,
    });
  });

  it("stage RPC 결과를 shared run contract로 변환한다", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        claimed: true,
        lease: "11111111-1111-4111-8111-111111111111",
        run: {
          id: "22222222-2222-4222-8222-222222222222",
          day: "2026-09-08",
          status: "collecting",
          stages: {}, modelCalls: 0, reports: [], topic: null, draft: null,
          validation: null, dryRun: false, postId: null, reason: null,
        },
      }, error: null,
    });
    const store = new CommunityStore({ rpc } as never);

    await expect(store.claimStage("22222222-2222-4222-8222-222222222222", "dc")).resolves.toEqual({
      claimed: true,
      lease: "11111111-1111-4111-8111-111111111111",
      run: expect.objectContaining({ id: "22222222-2222-4222-8222-222222222222", modelCalls: 0 }),
    });
  });

  it("evidence upsert keeps the database ID selected by source/external ID", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
      if (table === "community_agent_evidence") {
        return {
          upsert,
          select: () => query({ data: [{ id: "existing-id", source: "dc", external_id: "42" }], error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    const store = new CommunityStore({ from } as never);

    await expect(store.saveEvidence([{
      id: "new-random-id", source: "dc", externalId: "42", url: "https://gall.dcinside.com/board/view/?id=battlegrounds&no=42",
      title: "question", excerpt: "short", publishedAt: null, fetchedAt: "2026-09-08T00:00:00.000Z",
      access: "body", contentHash: HASH, official: false,
    }])).resolves.toEqual(["existing-id"]);
    expect(upsert).toHaveBeenCalledWith(expect.any(Array), {
      onConflict: "source,external_id", ignoreDuplicates: true,
    });
  });

  it("만료된 자료를 다시 읽으면 기존 ID로 최신 본문을 복원하며 오래된 수집은 덮어쓰지 않는다", async () => {
    let saved = {
      id: "existing-id", source: "dc", external_id: "42", excerpt: null as string | null,
      title: "old", url: "https://gall.dcinside.com/board/view/?id=battlegrounds&no=42",
      published_at: null, fetched_at: "2026-09-01T00:00:00.000Z", access: "body",
      content_hash: HASH, official: false, expires_at: "2026-09-08T00:00:00.000Z",
    };
    const update = vi.fn((fields: Partial<typeof saved>) => ({
      eq: (_field: string, id: string) => ({ lte: async (_column: string, cutoff: string) => {
        if (saved.id === id && Date.parse(saved.fetched_at) <= Date.parse(cutoff)) saved = { ...saved, ...fields };
        return { error: null };
      } }),
    }));
    const from = vi.fn(() => ({
      upsert: vi.fn().mockResolvedValue({ error: null }), update,
      select: () => query({ data: [saved], error: null }),
    }));
    const store = new CommunityStore({ from } as never);
    const fresh = {
      id: "new-random-id", source: "dc" as const, externalId: "42", url: saved.url,
      title: "최신 질문", excerpt: "실제로 다시 읽은 본문", publishedAt: null,
      fetchedAt: "2026-09-09T00:00:00.000Z", access: "body" as const,
      contentHash: "b".repeat(64), official: false,
    };
    await expect(store.saveEvidence([fresh])).resolves.toEqual(["existing-id"]);
    await expect(store.loadEvidence(["existing-id"])).resolves.toEqual([expect.objectContaining({
      id: "existing-id", title: fresh.title, excerpt: fresh.excerpt, fetchedAt: fresh.fetchedAt,
      contentHash: fresh.contentHash,
    })]);
    expect(saved.expires_at).toBe("2026-09-16T00:00:00.000Z");
    expect(update.mock.calls[0][0]).not.toHaveProperty("id");
    await store.saveEvidence([{ ...fresh, excerpt: "오래된 요청", fetchedAt: "2026-09-08T00:00:00.000Z" }]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(saved.excerpt).toBe(fresh.excerpt);
  });

  it("재수집 자료의 DB 갱신 실패를 성공으로 숨기지 않는다", async () => {
    const store = new CommunityStore({ from: () => ({
      upsert: vi.fn().mockResolvedValue({ error: null }),
      select: () => query({ data: [{ id: "existing-id", source: "dc", external_id: "42", fetched_at: "2026-09-01T00:00:00Z" }], error: null }),
      update: () => ({ eq: () => ({ lte: async () => ({ error: { message: "write failed" } }) }) }),
    }) } as never);
    await expect(store.saveEvidence([{
      id: "fresh-id", source: "dc", externalId: "42", url: "https://gall.dcinside.com/board/view/?id=battlegrounds&no=42",
      title: "question", excerpt: "fresh", publishedAt: null, fetchedAt: "2026-09-09T00:00:00Z",
      access: "body", contentHash: HASH, official: false,
    }])).rejects.toThrow("write failed");
  });

  it("trusted URL이 복사된 사용자 소식 본문을 공식 근거로 승격하지 않는다", async () => {
    const from = vi.fn(() => {
      throw new Error("local news must not be queried for official evidence");
    });
    const store = new CommunityStore({ from } as never);

    await expect(store.loadOfficialEvidence()).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("does not contain a direct posts insert bypass", () => {
    const source = readFileSync(resolve(process.cwd(), "lib/community-agent/store.ts"), "utf8");
    expect(source).not.toMatch(/from\(["']posts["']\)\.insert/);
    expect(source).toContain('"publish_community_post"');
  });
});
