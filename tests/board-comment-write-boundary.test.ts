import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  withOptionalAuth: vi.fn(),
  extractClientIp: vi.fn(() => "203.0.113.10"),
  checkIpBlacklist: vi.fn(async () => false),
  checkProfanity: vi.fn((value: string) => {
    void value;
    return { blocked: false };
  }),
  consumeQuota: vi.fn(),
  verifyTurnstile: vi.fn(),
  hash: vi.fn(async () => "password-hash"),
}));

vi.mock("../utils/supabase/guard", () => ({
  withOptionalAuth: mocks.withOptionalAuth,
}));

vi.mock("../lib/board/ipUtils", () => ({
  extractClientIp: mocks.extractClientIp,
  checkIpBlacklist: mocks.checkIpBlacklist,
}));

vi.mock("../lib/board/profanityFilter", () => ({
  checkProfanity: mocks.checkProfanity,
}));

vi.mock("../lib/board/writeQuota.server", () => ({
  consumeBoardWriteQuota: mocks.consumeQuota,
}));

vi.mock("../lib/board/turnstile.server", () => ({
  verifyTurnstileToken: mocks.verifyTurnstile,
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: mocks.hash,
  },
}));

import { POST as commentsPOST } from "../app/api/board/comments/route";

const commentMigration = readFileSync(
  "supabase/migrations/20260719000000_create_published_post_comment.sql",
  "utf8",
);
const draftCommentMigration = readFileSync(
  "supabase/migrations/20260922222932_allow_admin_comments_on_community_drafts.sql",
  "utf8",
);

describe("게시판 DB 쓰기 권한 경계", () => {
  it("posts와 comments의 공개 INSERT·UPDATE policy와 권한을 제거한다", () => {
    expect(commentMigration).toContain('DROP POLICY IF EXISTS "본인 ID로만 글 작성 가능" ON public.posts');
    expect(commentMigration).toContain('DROP POLICY IF EXISTS "Allow owners and admins to update posts" ON public.posts');
    expect(commentMigration).toContain('DROP POLICY IF EXISTS "본인 ID로만 댓글 작성 가능" ON public.comments');
    expect(commentMigration).toContain('DROP POLICY IF EXISTS "본인 댓글만 수정 가능" ON public.comments');
    expect(commentMigration).toContain('DROP POLICY IF EXISTS "notifications_insert_authenticated" ON public.notifications');
    expect(commentMigration).toMatch(
      /REVOKE INSERT, UPDATE ON TABLE public\.posts, public\.comments\s+FROM PUBLIC, anon, authenticated/i,
    );
    expect(commentMigration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.posts, public\.comments\s+TO service_role/i,
    );
    expect(commentMigration).toMatch(
      /REVOKE INSERT ON TABLE public\.notifications\s+FROM PUBLIC, anon, authenticated/i,
    );
    expect(commentMigration).toMatch(/GRANT INSERT ON TABLE public\.notifications TO service_role/i);
  });

  it("승격 전 댓글 RPC와 AI 답글 승인은 service role에만 열고 draft를 명시적으로 허용한다", () => {
    expect(draftCommentMigration).toContain('drop policy if exists "누구나 댓글 조회 가능" on public.comments');
    expect(draftCommentMigration).toMatch(/create policy "발행 글 댓글 또는 비공개 초안 관계자만 조회" on public\.comments[\s\S]*posts\.status = 'published'[\s\S]*posts\.user_id = \(select auth\.uid\(\)\)[\s\S]*profiles\.role = 'admin'/i);
    expect(draftCommentMigration).toMatch(/posts\.status in \('published', 'draft'\)/i);
    expect(draftCommentMigration).toMatch(/ps\.status in \('published','draft'\)/i);
    expect(draftCommentMigration).toContain("ps.status not in ('published','draft')");
    expect(draftCommentMigration).toMatch(
      /revoke all on function public\.create_reviewable_post_comment\([^)]+\)\s+from public,anon,authenticated/i,
    );
    expect(draftCommentMigration).toMatch(
      /grant execute on function public\.create_reviewable_post_comment\([^)]+\)\s+to service_role/i,
    );
  });
});

type AdminOptions = {
  profile?: { nickname: string | null; role?: string | null } | null;
  profileError?: unknown;
  parent?: {
    id: number;
    user_id: string | null;
    author: string;
    content: string;
    post_id: number;
  } | null;
  parentError?: unknown;
  post?: { id?: number; user_id: string | null; title: string; status?: "published" | "draft" | "hidden" } | null;
  postError?: unknown;
  commentError?: unknown;
  notificationError?: unknown;
  rpcResult?: { id: number; post_id: number; user_id: string | null; author: string; content: string; parent_id: number | null; created_at: string } | null;
  rpcError?: unknown;
};

function createAdmin(options: AdminOptions = {}) {
  const profileSingle = vi.fn(async () => ({
    data: options.profile === undefined ? { nickname: "서버닉네임", role: "user" } : options.profile,
    error: options.profileError ?? null,
  }));
  const parentSingle = vi.fn(async () => ({
    data: options.parent === undefined
      ? {
          id: 15,
          user_id: "parent-user",
          author: "부모작성자",
          content: "부모 댓글",
          post_id: 7,
        }
      : options.parent,
    error: options.parentError ?? null,
  }));
  const postSingle = vi.fn(async () => ({
    data: options.post === undefined
      ? { id: 7, user_id: "post-owner", title: "게시글 제목", status: "published" }
      : options.post && { id: 7, status: "published", ...options.post },
    error: options.postError ?? null,
  }));
  const commentSingle = vi.fn(async () => ({
    data: options.commentError ? null : { id: 91, post_id: 7, content: "댓글" },
    error: options.commentError ?? null,
  }));
  const insertComment = vi.fn(() => ({
    select: vi.fn(() => ({ single: commentSingle })),
  }));
  const rpc = vi.fn(async () => ({
    data: options.rpcResult === undefined ? [{
      id: 91,
      post_id: 7,
      user_id: null,
      author: "비회원",
      content: "댓글",
      parent_id: null,
      created_at: "2026-07-19T00:00:00.000Z",
    }] : options.rpcResult ? [options.rpcResult] : [],
    error: options.rpcError ?? null,
  }));
  const insertNotification = vi.fn(async () => ({
    error: options.notificationError ?? null,
  }));

  const supabaseAdmin = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ single: profileSingle })),
          })),
        };
      }
      if (table === "comments") {
        return {
          insert: insertComment,
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: parentSingle,
              maybeSingle: parentSingle,
            })),
          })),
        };
      }
      if (table === "posts") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ single: postSingle, maybeSingle: postSingle })),
          })),
        };
      }
      if (table === "notifications") {
        return { insert: insertNotification };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };

  return {
    supabaseAdmin,
    insertComment,
    insertNotification,
    profileSingle,
    parentSingle,
    postSingle,
    rpc,
  };
}

function makeCommentRequest(overrides: Record<string, unknown> = {}) {
  return new Request("https://bgms.test/api/board/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10, 198.51.100.20",
    },
    body: JSON.stringify({
      post_id: 7,
      content: "댓글 내용",
      parent_id: null,
      author: "비회원",
      password: "password",
      turnstileToken: "valid-token",
      ...overrides,
    }),
  });
}

describe("댓글 Turnstile 저장 경계", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractClientIp.mockReturnValue("203.0.113.10");
    mocks.checkIpBlacklist.mockResolvedValue(false);
    mocks.checkProfanity.mockReturnValue({ blocked: false });
    mocks.consumeQuota.mockResolvedValue({ ok: true });
    mocks.verifyTurnstile.mockResolvedValue({ ok: true });
    mocks.hash.mockResolvedValue("password-hash");
  });

  it("잘못된 JSON은 인증과 quota 전에 400으로 거부한다", async () => {
    const response = await commentsPOST(new Request("https://bgms.test/api/board/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));

    expect(response.status).toBe(400);
    expect(mocks.withOptionalAuth).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["게시글 ID 문자열", { post_id: "7" }],
    ["게시글 ID 0", { post_id: 0 }],
    ["본문 객체", { content: { text: "댓글" } }],
    ["빈 본문", { content: "   " }],
    ["본문 5,000자 초과", { content: "댓".repeat(5001) }],
    ["부모 ID 문자열", { parent_id: "1" }],
    ["부모 ID 음수", { parent_id: -1 }],
    ["작성자 객체", { author: { name: "닉네임" } }],
    ["작성자 공백", { author: "   " }],
    ["작성자 20자 초과", { author: "닉".repeat(21) }],
    ["비밀번호 배열", { password: ["password"] }],
    ["비밀번호 4자 미만", { password: "abc" }],
    ["비밀번호 공백", { password: "    " }],
    ["비밀번호 20자 초과", { password: "p".repeat(21) }],
    ["토큰 객체", { turnstileToken: { token: "token" } }],
    ["토큰 공백", { turnstileToken: "   " }],
    ["토큰 2,048자 초과", { turnstileToken: "t".repeat(2049) }],
    ["위조 user_id 객체", { user_id: { id: "victim" } }],
  ])("%s payload는 인증·quota·Siteverify·bcrypt·DB 전에 400으로 거부한다", async (_name, overrides) => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest(overrides));

    expect(response.status).toBe(400);
    expect(mocks.withOptionalAuth).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("guest comment는 token 없이 quota·Siteverify·bcrypt·insert를 호출하지 않는다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({ turnstileToken: undefined }));

    expect(response.status).toBe(400);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("guest는 guest_comment Siteverify 성공 뒤 IP quota와 bcrypt를 거쳐 insert한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest());

    expect(response.status).toBe(200);
    expect(mocks.consumeQuota).toHaveBeenCalledWith({
      supabaseAdmin: admin.supabaseAdmin,
      scope: "comment",
      actor: "203.0.113.10",
    });
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({
      token: "valid-token",
      remoteIp: "203.0.113.10",
      expectedAction: "guest_comment",
    });
    expect(mocks.hash).toHaveBeenCalledWith("password", 10);
    expect(admin.rpc).toHaveBeenCalledWith("create_published_post_comment", expect.objectContaining({
      p_post_id: 7,
      p_user_id: null,
      p_author: "비회원",
      p_password_hash: "password-hash",
      p_ip_address: "203.0.113.10",
    }));
    expect(mocks.verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeQuota.mock.invocationCallOrder[0],
    );
    expect(mocks.consumeQuota.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hash.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [null, null],
    [{ user_id: "owner", title: "비공개", status: "draft" }, null],
  ] as const)("없는 또는 비공개 게시글은 insert 전에 고정 404로 거부한다", async (post, postError) => {
    const admin = createAdmin({ post, postError });
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "게시글을 찾을 수 없습니다." });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("일반 회원은 승격 전 초안에 댓글을 작성할 수 없다", async () => {
    const admin = createAdmin({
      post: { user_id: "bot-user", title: "승인 대기 초안", status: "draft" },
      profile: { nickname: "일반회원", role: "user" },
    });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "member-a" }, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({
      author: null, password: null, turnstileToken: null,
    }));

    expect(response.status).toBe(404);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("관리자는 승격 전 초안에 테스트 댓글을 작성할 수 있다", async () => {
    const admin = createAdmin({
      post: { user_id: "bot-user", title: "승인 대기 초안", status: "draft" },
      profile: { nickname: "관리자", role: "admin" },
    });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "admin-user" }, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({
      author: null, password: null, turnstileToken: null,
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("create_reviewable_post_comment", expect.objectContaining({
      p_post_id: 7,
      p_user_id: "admin-user",
      p_author: "관리자",
    }));
  });

  it("게시글 조회 장애는 원본 오류를 노출하지 않고 저장 전에 503으로 fail-closed 처리한다", async () => {
    const admin = createAdmin({ post: null, postError: { message: "raw post lookup failure" } });
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest());
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(payload).not.toContain("raw post lookup failure");
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("원자적 RPC가 댓글과 서버 전용 필드를 분리한 DTO만 응답한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest());
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(payload).not.toContain("password_hash");
    expect(payload).not.toContain("ip_address");
  });

  it.each([
    [{ ok: false, status: 429, error: "댓글은 10초에 한 번만 작성할 수 있습니다." }, 429],
    [{ ok: false, status: 503, error: "게시판 요청 제한을 확인하지 못했습니다." }, 503],
  ] as const)("guest quota·RPC 거부는 Siteverify 성공 뒤 고정 상태로 fail-closed 처리한다", async (quotaResult, status) => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.consumeQuota.mockResolvedValue(quotaResult);

    const response = await commentsPOST(makeCommentRequest());

    expect(response.status).toBe(status);
    expect(mocks.verifyTurnstile).toHaveBeenCalledOnce();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("Turnstile 거부 시 외부 오류와 token을 노출하지 않고 저장을 중단한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.verifyTurnstile.mockResolvedValue({
      ok: false,
      status: 503,
      error: "보안 인증 서버에 연결하지 못했습니다.",
    });

    const response = await commentsPOST(makeCommentRequest({ turnstileToken: "raw-secret-token" }));
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(payload).not.toContain("raw-secret-token");
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("guest 본문 비속어는 bcrypt와 insert 전에 거부한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.checkProfanity.mockImplementation((value: string) => ({
      blocked: value === "차단 본문",
    }));

    const response = await commentsPOST(makeCommentRequest({ content: "차단 본문" }));

    expect(response.status).toBe(400);
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("cross-post parent는 Siteverify·quota 후 bcrypt·insert·notification 전에 400으로 거부한다", async () => {
    const admin = createAdmin({
      parent: {
        id: 15,
        user_id: "other-owner",
        author: "다른글작성자",
        content: "다른 게시글 댓글",
        post_id: 999,
      },
    });
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({ parent_id: 15 }));

    expect(response.status).toBe(400);
    expect(mocks.consumeQuota).toHaveBeenCalledOnce();
    expect(mocks.verifyTurnstile).toHaveBeenCalledOnce();
    expect(admin.parentSingle).toHaveBeenCalledOnce();
    expect(mocks.verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeQuota.mock.invocationCallOrder[0],
    );
    expect(mocks.consumeQuota.mock.invocationCallOrder[0]).toBeLessThan(
      admin.parentSingle.mock.invocationCallOrder[0],
    );
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
    expect(admin.insertNotification).not.toHaveBeenCalled();
  });

  it("parent 댓글이 없으면 insert 전에 고정 404를 반환한다", async () => {
    const admin = createAdmin({ parent: null });
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({ parent_id: 15 }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "부모 댓글을 찾을 수 없습니다." });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("parent 조회 오류는 원본 오류를 노출하지 않고 insert 전 503으로 fail-closed 처리한다", async () => {
    const admin = createAdmin({
      parent: null,
      parentError: { message: "raw parent lookup failure" },
    });
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({ parent_id: 15 }));
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(payload).not.toContain("raw parent lookup failure");
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("회원은 user quota와 서버 profile 닉네임을 사용하고 게시글 작성자 알림을 유지한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      author: "spoofed",
      user_id: "victim",
      password: null,
      turnstileToken: null,
    }));

    expect(response.status).toBe(200);
    expect(mocks.consumeQuota).toHaveBeenCalledWith({
      supabaseAdmin: admin.supabaseAdmin,
      scope: "comment",
      actor: "member-a",
    });
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith("create_published_post_comment", expect.objectContaining({
      p_user_id: "member-a",
      p_author: "서버닉네임",
      p_password_hash: null,
      p_ip_address: null,
    }));
    expect(admin.insertNotification).toHaveBeenCalledWith([{
      user_id: "post-owner",
      sender_id: "member-a",
      sender_name: "서버닉네임",
      type: "comment",
      post_id: 7,
      preview_text: "게시글 제목",
    }]);
  });

  it("회원 대댓글은 parent user와 content를 알림 대상·preview로 사용한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      parent_id: 15,
      author: null,
      password: null,
      turnstileToken: null,
    }));

    expect(response.status).toBe(200);
    expect(admin.parentSingle).toHaveBeenCalledOnce();
    expect(admin.parentSingle.mock.invocationCallOrder[0]).toBeLessThan(
      admin.rpc.mock.invocationCallOrder[0],
    );
    expect(admin.rpc).toHaveBeenCalledWith("create_published_post_comment", expect.objectContaining({
      p_content: "@부모작성자 댓글 내용",
    }));
    expect(admin.insertNotification).toHaveBeenCalledWith([expect.objectContaining({
      user_id: "parent-user",
      type: "reply",
      preview_text: "부모 댓글",
    })]);
  });

  it("회원 대댓글에 서버 parent author 접두어가 이미 있으면 중복 저장하지 않는다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      parent_id: 15,
      content: "@부모작성자 이미 있는 답글",
      author: null,
      password: null,
      turnstileToken: null,
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("create_published_post_comment", expect.objectContaining({
      p_content: "@부모작성자 이미 있는 답글",
    }));
  });

  it("회원 대댓글은 서버 접두어를 포함해 5,000자를 넘으면 insert 전에 거부한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      parent_id: 15,
      content: "댓".repeat(5000),
      author: null,
      password: null,
      turnstileToken: null,
    }));

    expect(response.status).toBe(400);
    expect(admin.insertComment).not.toHaveBeenCalled();
  });

  it("회원 대댓글의 parent author HTML은 서버에서 실행하지 않고 text로 그대로 저장한다", async () => {
    const admin = createAdmin({
      parent: {
        id: 15,
        user_id: "parent-user",
        author: "<script>alert(1)</script>",
        content: "부모 댓글",
        post_id: 7,
      },
    });
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      parent_id: 15,
      author: null,
      password: null,
      turnstileToken: null,
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("create_published_post_comment", expect.objectContaining({
      p_content: "@<script>alert(1)</script> 댓글 내용",
    }));
  });

  it("guest 대댓글은 기존처럼 parent author 접두어 없이 본문을 저장한다", async () => {
    const admin = createAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await commentsPOST(makeCommentRequest({ parent_id: 15 }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("create_published_post_comment", expect.objectContaining({
      p_content: "댓글 내용",
    }));
  });

  it("회원 자신이 알림 대상이면 notification을 생성하지 않는다", async () => {
    const admin = createAdmin({ post: { user_id: "member-a", title: "내 글" } });
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      author: null,
      password: null,
      turnstileToken: null,
    }));

    expect(response.status).toBe(200);
    expect(admin.insertNotification).not.toHaveBeenCalled();
  });

  it("notification 저장 실패는 댓글 성공을 되돌리지 않고 내부 오류를 응답에 노출하지 않는다", async () => {
    const admin = createAdmin({ notificationError: { message: "raw notification failure" } });
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "member-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await commentsPOST(makeCommentRequest({
      author: null,
      password: null,
      turnstileToken: null,
    }));
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(payload).not.toContain("raw notification failure");
  });
});
