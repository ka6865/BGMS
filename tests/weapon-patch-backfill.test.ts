import { describe, expect, it, vi } from "vitest";
import { identifyCategory, shouldExtractWeaponChanges } from "@/lib/patch-notes/categorize";
import {
  detectSource,
  extractSourceUrlFromContent,
  fetchPatchNoteSourceText,
} from "@/lib/patch-notes/patchNoteSourceFetch";
import { backfillWeaponPatchProposals } from "@/lib/patch-notes/weaponProposalBackfill";
import { decideProposalChanges } from "@/lib/patch-notes/weaponProposalQuery";

/** posts / weapon_patch_proposals 두 테이블만 흉내내는 최소 Supabase 스텁입니다. */
function createSupabaseStub(options: {
  posts: { id: number; title: string; content: string | null }[];
  proposedPostIds?: number[];
}) {
  return {
    from(table: string) {
      if (table === "posts") {
        const builder: Record<string, unknown> = {};
        const result = { data: options.posts, error: null };
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.order = () => builder;
        builder.limit = () => result;
        builder.in = () => result;
        return builder;
      }
      if (table === "weapon_patch_proposals") {
        return {
          select: () => ({
            data: (options.proposedPostIds ?? []).map((id) => ({ source_post_id: id })),
            error: null,
          }),
        };
      }
      throw new Error(`예상하지 않은 테이블 접근: ${table}`);
    },
  } as never;
}

const PATCH_POST_CONTENT =
  '<div><a href="https://pubg.com/ko/news/10179" target="_blank">원문 보러가기</a></div>';

describe("원문 링크 추출", () => {
  it("게시글 본문의 원문 링크를 찾는다", () => {
    expect(extractSourceUrlFromContent(PATCH_POST_CONTENT)).toBe(
      "https://pubg.com/ko/news/10179"
    );
  });

  it("패치노트 도메인이 아닌 링크만 있으면 null 을 반환한다", () => {
    expect(extractSourceUrlFromContent('<a href="https://example.com/x">링크</a>')).toBeNull();
  });

  it("본문이 없으면 null 을 반환한다", () => {
    expect(extractSourceUrlFromContent(null)).toBeNull();
  });

  it("공식·카카오 도메인을 구분한다", () => {
    expect(detectSource("https://pubg.com/ko/news/1")).toBe("pubg");
    expect(detectSource("https://bbs.pubg.game.daum.net/x")).toBe("kakao");
    expect(detectSource("https://example.com")).toBe("unknown");
  });
});

describe("카카오 무점검 패치 분류", () => {
  it("무점검 패치 공지를 패치노트로 판정한다", () => {
    const category = identifyCategory(
      "[카카오] [완료] 4월 15일(수) 무점검 패치 안내",
      "https://bbs.pubg.game.daum.net/gaia/do/pubg/notice/read?articleId=4168&bbsId=PN001"
    );
    expect(category).toBe("PATCH_NOTE");
    expect(shouldExtractWeaponChanges(category)).toBe(true);
  });

  it("상점 안내는 여전히 패치노트가 아니다", () => {
    expect(identifyCategory("2026년 6월 상점 안내", "https://pubg.com/ko/news/1")).toBe(
      "STORE_INFO"
    );
  });
});

describe("삭제된 원문 판정", () => {
  it("NOT_FOUND_POST 리다이렉트를 원문 삭제로 보고한다", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://pubg.com/ko/news?error=NOT_FOUND_POST" },
      })
    );

    const result = await fetchPatchNoteSourceText("https://pubg.com/ko/news/9891", {
      fetchImpl: fetchImpl as never,
    });

    expect(result.ok).toBe(false);
    expect(result.gone).toBe(true);
  });

  it("404 도 원문 삭제로 본다", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const result = await fetchPatchNoteSourceText("https://pubg.com/ko/news/1", {
      fetchImpl: fetchImpl as never,
    });
    expect(result.gone).toBe(true);
  });

  it("본문을 담은 정상 응답은 텍스트를 반환한다", async () => {
    const body = `<html><body><div class="post-detail__content">${"패치 본문 ".repeat(
      40
    )}</div></body></html>`;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));

    const result = await fetchPatchNoteSourceText("https://pubg.com/ko/news/1", {
      fetchImpl: fetchImpl as never,
    });

    expect(result.ok).toBe(true);
    expect(result.sourceText.length).toBeGreaterThan(100);
  });
});

describe("과거 패치노트 백필", () => {
  it("패치노트가 아닌 글은 후보에서 제외한다", async () => {
    const summary = await backfillWeaponPatchProposals({
      supabaseAdmin: createSupabaseStub({
        posts: [
          { id: 1, title: "2026년 6월 상점 안내", content: PATCH_POST_CONTENT },
          { id: 2, title: "[개발일지] 블루존 개편", content: PATCH_POST_CONTENT },
        ],
      }),
      dryRun: true,
    });

    expect(summary.candidates).toBe(0);
    expect(summary.results).toHaveLength(0);
  });

  it("이미 제안이 있는 글은 AI 를 호출하지 않고 중복으로 처리한다", async () => {
    const createDeps = vi.fn();

    const summary = await backfillWeaponPatchProposals({
      supabaseAdmin: createSupabaseStub({
        posts: [{ id: 10, title: "패치 노트 - 업데이트 42.1", content: PATCH_POST_CONTENT }],
        proposedPostIds: [10],
      }),
      createDeps: createDeps as never,
    });

    expect(summary.duplicate).toBe(1);
    expect(summary.processed).toBe(0);
    expect(createDeps).not.toHaveBeenCalled();
  });

  it("처리 상한을 넘는 글은 건너뛴다", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `<html><body><div class="post-detail__content">${"패치 본문 ".repeat(
            40
          )}</div></body></html>`,
          { status: 200 }
        )
    );

    const summary = await backfillWeaponPatchProposals({
      supabaseAdmin: createSupabaseStub({
        posts: [
          { id: 1, title: "패치 노트 - 업데이트 40.1", content: PATCH_POST_CONTENT },
          { id: 2, title: "패치 노트 - 업데이트 41.1", content: PATCH_POST_CONTENT },
        ],
      }),
      limit: 1,
      dryRun: true,
      fetchDeps: { fetchImpl: fetchImpl as never },
    });

    expect(summary.candidates).toBe(2);
    expect(summary.processed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("원문 링크가 없는 글은 건너뛴다", async () => {
    const summary = await backfillWeaponPatchProposals({
      supabaseAdmin: createSupabaseStub({
        posts: [{ id: 5, title: "패치 노트 - 업데이트 42.2", content: "<p>본문만 있음</p>" }],
      }),
      dryRun: true,
    });

    expect(summary.skipped).toBe(1);
    expect(summary.results[0].reason).toContain("원문 링크");
  });

  it("삭제된 원문은 실패가 아니라 source_gone 으로 구분한다", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://pubg.com/ko/news?error=NOT_FOUND_POST" },
        })
    );

    const summary = await backfillWeaponPatchProposals({
      supabaseAdmin: createSupabaseStub({
        posts: [{ id: 7, title: "패치 노트 - 업데이트 41.1", content: PATCH_POST_CONTENT }],
      }),
      fetchDeps: { fetchImpl: fetchImpl as never },
    });

    expect(summary.sourceGone).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("오래된 글부터 순서대로 처리한다", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(
        `<html><body><div class="post-detail__content">${"패치 본문 ".repeat(
          40
        )}</div></body></html>`,
        { status: 200 }
      );
    });

    await backfillWeaponPatchProposals({
      supabaseAdmin: createSupabaseStub({
        posts: [
          {
            id: 30,
            title: "패치 노트 - 업데이트 42.2",
            content: '<a href="https://pubg.com/ko/news/30">원문</a>',
          },
          {
            id: 10,
            title: "패치 노트 - 업데이트 40.1",
            content: '<a href="https://pubg.com/ko/news/10">원문</a>',
          },
        ],
      }),
      dryRun: true,
      fetchDeps: { fetchImpl: fetchImpl as never },
    });

    expect(seen).toEqual(["https://pubg.com/ko/news/10", "https://pubg.com/ko/news/30"]);
  });
});
/**
 * decideProposalChanges 의 상태 재계산 경로를 검증하기 위한 스텁입니다.
 * 변경 항목 조회, 결정 갱신, 제안 상태 갱신을 순서대로 기록합니다.
 */
function createDecideStub(options: {
  changes: { id: string; validation_state: string }[];
  decisionsAfterUpdate: string[];
  proposalStatus?: string;
}) {
  const proposalUpdates: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === "weapon_patch_proposal_changes") {
        return {
          select: (columns: string) => {
            // 결정 갱신 후의 상태 재계산 조회
            if (columns === "decision") {
              return {
                eq: async () => ({
                  data: options.decisionsAfterUpdate.map((decision) => ({ decision })),
                  error: null,
                }),
              };
            }
            return {
              eq: () => ({
                in: async () => ({ data: options.changes, error: null }),
              }),
            };
          },
          update: () => ({
            eq: () => ({
              in: async () => ({ error: null }),
            }),
          }),
        };
      }
      if (table === "weapon_patch_proposals") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { status: options.proposalStatus ?? "pending" },
                error: null,
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => {
            proposalUpdates.push(values);
            return {
              eq: () => ({
                eq: async () => ({ error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`예상하지 않은 테이블 접근: ${table}`);
    },
  };

  return { client: client as never, proposalUpdates };
}

describe("거부 후 제안 상태 재계산", () => {
  it("모든 항목이 거부되면 제안을 rejected 로 종료한다", async () => {
    const stub = createDecideStub({
      changes: [{ id: "change-1", validation_state: "ok" }],
      decisionsAfterUpdate: ["rejected"],
    });

    const result = await decideProposalChanges(
      stub.client,
      "proposal-1",
      ["change-1"],
      "rejected",
      "admin-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposalStatus).toBe("rejected");
    expect(stub.proposalUpdates[0]?.status).toBe("rejected");
  });

  it("미결정 항목이 남아 있으면 pending 을 유지한다", async () => {
    const stub = createDecideStub({
      changes: [{ id: "change-1", validation_state: "ok" }],
      decisionsAfterUpdate: ["rejected", "pending"],
    });

    const result = await decideProposalChanges(
      stub.client,
      "proposal-1",
      ["change-1"],
      "rejected",
      "admin-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposalStatus).toBe("pending");
    expect(stub.proposalUpdates).toHaveLength(0);
  });

  it("승인된 항목이 있으면 DB 반영 전이므로 pending 을 유지한다", async () => {
    const stub = createDecideStub({
      changes: [{ id: "change-1", validation_state: "ok" }],
      decisionsAfterUpdate: ["rejected", "accepted"],
    });

    const result = await decideProposalChanges(
      stub.client,
      "proposal-1",
      ["change-1"],
      "rejected",
      "admin-1"
    );

    if (result.ok) expect(result.proposalStatus).toBe("pending");
    expect(stub.proposalUpdates).toHaveLength(0);
  });

  it("이미 반영된 제안의 상태는 덮어쓰지 않는다", async () => {
    const stub = createDecideStub({
      changes: [{ id: "change-1", validation_state: "ok" }],
      decisionsAfterUpdate: ["rejected"],
      proposalStatus: "applied",
    });

    const result = await decideProposalChanges(
      stub.client,
      "proposal-1",
      ["change-1"],
      "rejected",
      "admin-1"
    );

    if (result.ok) expect(result.proposalStatus).toBe("applied");
    expect(stub.proposalUpdates).toHaveLength(0);
  });
});
