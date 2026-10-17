import { readFileSync } from "node:fs";
import { afterEach, describe, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withOptionalAuth: vi.fn(),
  extractClientIp: vi.fn(() => "203.0.113.10"),
  checkIpBlacklist: vi.fn(async () => false),
  checkProfanity: vi.fn(() => ({ blocked: false })),
  consumeQuota: vi.fn(),
  verifyTurnstile: vi.fn(),
  genSalt: vi.fn(async () => "salt"),
  hash: vi.fn(async () => "password-hash"),
  externalFetch: vi.fn(),
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
    genSalt: mocks.genSalt,
    hash: mocks.hash,
  },
}));

import { POST as postsWritePOST } from "../app/api/posts/write/route";
import { POST as guestPostsPOST } from "../app/api/board/posts/route";

const BODY_DERIVED_SINK_CHECKLIST = [
  "title",
  "content",
  "category",
  "image_url",
  "is_notice",
  "author",
  "user_id",
  "password",
  "editingPostId",
  "discord_url",
  "discord_channel_id",
  "clan_info",
  "turnstileToken",
] as const;

function createWriteAdmin(options?: {
  role?: "user" | "admin";
  nickname?: string;
  existingPost?: boolean;
  postOwnerId?: string;
  postRevision?: number;
  postQueryError?: unknown;
  existingRefs?: unknown[];
}) {
  const insert = vi.fn(() => ({
    select: vi.fn(async () => ({
      data: [{ id: 41, title: "테스트 글" }],
      error: null,
    })),
  }));
  const update = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(async () => ({ data: [{ id: 41 }], error: null })),
    })),
  }));
  const profileSingle = vi.fn(async () => ({
    data: { role: options?.role ?? "user", nickname: options?.nickname },
    error: null,
  }));
  const existingSingle = vi.fn(async () => ({
    data: options?.existingPost === false
      ? null
      : { user_id: options?.postOwnerId ?? "user-a", revision: options?.postRevision ?? 0 },
    error: options?.postQueryError ?? (options?.existingPost === false ? null : null),
  }));
  const refs = vi.fn(async () => ({ data: options?.existingRefs ?? [], error: null }));
  const rpc = vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({
    data: [{ result_code: "ok", post_id: 41, revision: 0 }],
    error: null,
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
      if (table === "posts") {
        return {
          insert,
          update,
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ single: existingSingle, maybeSingle: existingSingle })),
          })),
        };
      }
      if (table === "board_post_image_refs") {
        return {
          select: vi.fn(() => ({
            eq: refs,
          })),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
    storage: {
      from: vi.fn(() => ({ remove: vi.fn(async () => ({ error: null })) })),
    },
  };
  return { supabaseAdmin, insert, update, rpc, existingSingle, refs };
}

function createGuestCompatibilityAdmin() {
  const single = vi.fn(async () => ({
    data: { id: 42, title: "호환 글" },
    error: null,
  }));
  const insert = vi.fn(() => ({
    select: vi.fn(() => ({ single })),
  }));
  const supabaseAdmin = {
    rpc: vi.fn(),
    from: vi.fn(() => ({ insert })),
  };
  return { supabaseAdmin, insert };
}

function makePostRequest(overrides: Record<string, unknown> = {}) {
  return new Request("https://bgms.test/api/posts/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "테스트 글",
      content: "테스트 본문",
      category: "자유",
      author: "비회원",
      password: "password",
      user_id: null,
      editingPostId: null,
      ...overrides,
    }),
  });
}

function makeCompatibilityRequest(overrides: Record<string, unknown> = {}) {
  return new Request("https://bgms.test/api/board/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "호환 글",
      content: "호환 본문",
      category: "자유",
      author: "비회원",
      password: "password",
      ...overrides,
    }),
  });
}

describe("게시글 쓰기 Turnstile 저장 경계", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractClientIp.mockReturnValue("203.0.113.10");
    mocks.checkIpBlacklist.mockResolvedValue(false);
    mocks.checkProfanity.mockReturnValue({ blocked: false });
    mocks.consumeQuota.mockResolvedValue({ ok: true });
    mocks.verifyTurnstile.mockResolvedValue({ ok: true });
    mocks.genSalt.mockResolvedValue("salt");
    mocks.hash.mockResolvedValue("password-hash");
    mocks.externalFetch.mockResolvedValue({ ok: true, json: async () => ({ guild: { id: "1486899870928470121" } }) });
    vi.stubGlobal("fetch", mocks.externalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("request body에서 구조 분해한 모든 sink 필드를 검증 체크리스트에 고정한다", () => {
    const routeSource = readFileSync(
      new URL("../app/api/posts/write/route.ts", import.meta.url),
      "utf8",
    );
    const bodyDestructure = routeSource.match(/const\s*{([\s\S]*?)}\s*=\s*body;/);
    expect(bodyDestructure).not.toBeNull();
    const destructuredFields = bodyDestructure?.[1]
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);

    expect(destructuredFields).toEqual(BODY_DERIVED_SINK_CHECKLIST);
  });

  it("잘못된 JSON은 인증과 quota 전에 400으로 거부한다", async () => {
    const response = await postsWritePOST(new Request("https://bgms.test/api/posts/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));

    expect(response.status).toBe(400);
    expect(mocks.withOptionalAuth).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["카테고리 누락", { category: " " }],
    ["카테고리 50자 초과", { category: "카".repeat(51) }],
    ["제목 50자 초과", { title: "제".repeat(51) }],
    ["본문 타입 오류", { content: 1234 }],
    ["디스코드 URL 타입 오류", { discord_url: 1234 }],
    ["디스코드 URL 길이 초과", { discord_url: `https://discord.gg/${"a".repeat(2049)}` }],
    ["수정 ID 문자열", { editingPostId: "41" }],
    ["수정 ID 0", { editingPostId: 0 }],
    ["비회원 닉네임 길이 초과", { author: "닉".repeat(21) }],
    ["비회원 비밀번호 공백", { password: "    " }],
    ["비회원 비밀번호 길이 초과", { password: "p".repeat(21) }],
    ["이미지 URL 객체", { image_url: { url: "https://example.com/image.png" } }],
    ["이미지 URL 길이 초과", { image_url: "i".repeat(2049) }],
    ["디스코드 채널 ID 배열", { discord_channel_id: ["123"] }],
    ["디스코드 채널 ID 길이 초과", { discord_channel_id: "1".repeat(65) }],
    ["클랜 정보 배열", { clan_info: [] }],
    ["클랜 정보 허용 외 key", { clan_info: {
      id: "clan-a", name: "Clan", tag: "TAG", level: 1, memberCount: 10, nested: {},
    } }],
    ["클랜 정보 문자열 타입 오류", { clan_info: {
      id: "clan-a", name: { nested: true }, tag: "TAG", level: 1, memberCount: 10,
    } }],
    ["클랜 정보 직렬화 크기 초과", { clan_info: {
      id: "clan-a", name: "c".repeat(1025), tag: "TAG", level: 1, memberCount: 10,
    } }],
    ["클랜 멤버 수 범위 초과", { clan_info: {
      id: "clan-a", name: "Clan", tag: "TAG", level: 1, memberCount: 101,
    } }],
    ["클랜 정보 prototype key", { clan_info: JSON.parse(
      '{"id":"clan-a","name":"Clan","tag":"TAG","level":1,"memberCount":10,"__proto__":{"polluted":true}}',
    ) }],
    ["공지 플래그 객체", { is_notice: { value: true } }],
    ["사용자 ID 객체", { user_id: { id: "user-a" } }],
    ["Turnstile token 객체", { turnstileToken: { token: "token" } }],
  ])("%s payload는 인증·quota·Siteverify·bcrypt·DB 전에 400으로 거부한다", async (_caseName, overrides) => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest(overrides));

    expect(response.status).toBe(400);
    expect(mocks.withOptionalAuth).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insert).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.update).not.toHaveBeenCalled();
    expect(mocks.externalFetch).not.toHaveBeenCalled();
  });

  it("비회원 신규 글은 token 없이 quota, bcrypt, insert에 도달하지 않는다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest());

    expect(response.status).toBe(400);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insert).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("guest quota 거부는 Siteverify 성공 후 저장 전에 차단한다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.consumeQuota.mockResolvedValue({
      ok: false,
      status: 429,
      error: "게시글은 1분에 한 번만 작성할 수 있습니다.",
    });

    const response = await postsWritePOST(makePostRequest({ turnstileToken: "token" }));

    expect(response.status).toBe(429);
    expect(mocks.verifyTurnstile).toHaveBeenCalledOnce();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insert).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("guest quota RPC 장애는 Siteverify 성공 후 저장 전에 503으로 fail-closed 처리한다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.consumeQuota.mockResolvedValue({
      ok: false,
      status: 503,
      error: "게시판 요청 제한을 확인하지 못했습니다.",
    });

    const response = await postsWritePOST(makePostRequest({ turnstileToken: "token" }));

    expect(response.status).toBe(503);
    expect(mocks.verifyTurnstile).toHaveBeenCalledOnce();
    expect(admin.insert).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("Turnstile 거부는 quota·bcrypt·저장 전에 400으로 차단한다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.verifyTurnstile.mockResolvedValue({
      ok: false,
      status: 400,
      error: "보안 인증에 실패했습니다. 다시 시도해주세요.",
    });

    const response = await postsWritePOST(makePostRequest({ turnstileToken: "token" }));

    expect(response.status).toBe(400);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insert).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("valid guest_post token만 비회원 원자 RPC 저장을 허용한다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({ turnstileToken: "token" }));

    expect(response.status).toBe(200);
    expect(mocks.consumeQuota).toHaveBeenCalledWith({
      supabaseAdmin: admin.supabaseAdmin,
      actor: "203.0.113.10",
      scope: "post",
    });
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({
      expectedAction: "guest_post",
      remoteIp: "203.0.113.10",
      token: "token",
    });
    expect(mocks.verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeQuota.mock.invocationCallOrder[0],
    );
    expect(mocks.consumeQuota.mock.invocationCallOrder[0]).toBeLessThan(
      admin.rpc.mock.invocationCallOrder[0],
    );
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it("모든 게시글 쓰기 응답은 서버 전용 비밀번호 해시와 IP 주소를 포함하지 않는다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({ turnstileToken: "token" }));
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(payload).not.toContain("password_hash");
    expect(payload).not.toContain("ip_address");
  });

  it("실제 client의 이미지·디스코드·클랜 payload는 허용 key만 저장한다", async () => {
    const admin = createWriteAdmin();
    const clanInfo = {
      id: "clan-a",
      name: "BGMS Clan",
      tag: "BGMS",
      level: 12,
      memberCount: 45,
    };
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({
      turnstileToken: "token",
      image_url: "https://example.com/image.png",
      discord_channel_id: "123456789012345678",
      clan_info: clanInfo,
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
      p_image_url: "https://example.com/image.png",
      p_discord_channel_id: "123456789012345678",
      p_clan_info: clanInfo,
    }));
  });

  it("회원 신규 글은 user quota를 사용하고 Turnstile을 호출하지 않는다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "user-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await postsWritePOST(makePostRequest({
      author: "회원",
      password: null,
      user_id: "user-a",
    }));

    expect(response.status).toBe(200);
    expect(mocks.consumeQuota).toHaveBeenCalledWith({
      supabaseAdmin: admin.supabaseAdmin,
      actor: "user-a",
      scope: "post",
    });
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it("회원 작성자·user ID·공지 권한은 서버 프로필을 기준으로 저장한다", async () => {
    const admin = createWriteAdmin({ nickname: "서버회원" });
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "user-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await postsWritePOST(makePostRequest({
      author: "위조작성자",
      password: null,
      user_id: "user-a",
      is_notice: true,
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
      p_author: "서버회원",
      p_user_id: "user-a",
      p_is_notice: false,
    }));
  });

  it("회원 글 수정은 quota와 Turnstile을 소비하지 않는다", async () => {
    const admin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValue({
      user: { id: "user-a" },
      supabaseAdmin: admin.supabaseAdmin,
    });

    const response = await postsWritePOST(makePostRequest({
      editingPostId: 41,
      expectedRevision: 0,
      author: "회원",
      password: null,
      user_id: "user-a",
    }));

    expect(response.status).toBe(200);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it("수정은 기존 managed v2 URL이 본문·thumbnail에 남으면 해당 ID와 usage를 RPC payload에 보존한다", async () => {
    const contentImageId = "22222222-2222-4222-8222-222222222222";
    const thumbnailImageId = "33333333-3333-4333-8333-333333333333";
    const baseUrl = "https://example.supabase.co";
    const contentUrl = `${baseUrl}/storage/v1/object/public/board-images-v2/${contentImageId}`;
    const thumbnailUrl = `${baseUrl}/storage/v1/object/public/board-images-v2/${thumbnailImageId}`;
    const admin = createWriteAdmin({
      existingRefs: [
        { image_id: contentImageId, usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: contentImageId, status: "ready" } },
        { image_id: thumbnailImageId, usage: "thumbnail", board_image_objects: { bucket_id: "board-images-v2", storage_key: thumbnailImageId, status: "ready" } },
      ],
    });
    const previousBaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });

    try {
      const response = await postsWritePOST(makePostRequest({
        editingPostId: 41,
        expectedRevision: 0,
        author: "회원",
        password: null,
        user_id: "user-a",
        content: `<p>수정</p><img src="${contentUrl}">`,
        image_url: thumbnailUrl,
        contentImageIds: ["44444444-4444-4444-8444-444444444444"],
      }));

      expect(response.status).toBe(200);
      expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
        p_content_image_ids: [contentImageId, "44444444-4444-4444-8444-444444444444"],
        p_thumbnail_image_id: thumbnailImageId,
      }));
    } finally {
      if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousBaseUrl;
    }
  });

  it("수정은 기존 managed v2 URL의 query와 hash를 제거해 ref 범위 안에서만 보존한다", async () => {
    const imageId = "22222222-2222-4222-8222-222222222222";
    const baseUrl = "https://example.supabase.co";
    const imageUrl = `${baseUrl}/storage/v1/object/public/board-images-v2/${imageId}`;
    const admin = createWriteAdmin({
      existingRefs: [{ image_id: imageId, usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: imageId, status: "ready" } }],
    });
    const previousBaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });
    try {
      const response = await postsWritePOST(makePostRequest({
        editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
        content: `<img src="${imageUrl}?v=2#preview">`, image_url: null,
      }));
      expect(response.status).toBe(200);
      expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
        p_content_image_ids: [imageId],
      }));
    } finally {
      if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousBaseUrl;
    }
  });

  it("수정은 다른 origin·bucket·key URL을 기존 managed ref로 보존하지 않는다", async () => {
    const imageId = "22222222-2222-4222-8222-222222222222";
    const baseUrl = "https://example.supabase.co";
    const admin = createWriteAdmin({
      existingRefs: [{ image_id: imageId, usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: imageId, status: "ready" } }],
    });
    const previousBaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });
    try {
      const response = await postsWritePOST(makePostRequest({
        editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
        content: `<img src="https://evil.example/storage/v1/object/public/board-images-v2/${imageId}?v=2">`, image_url: null,
      }));
      expect(response.status).toBe(200);
      expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
        p_content_image_ids: [],
      }));
    } finally {
      if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousBaseUrl;
    }
  });

  it("수정에서 기존 managed URL을 제거하면 기존 ID를 payload에 넣지 않아 RPC가 detach한다", async () => {
    const contentImageId = "22222222-2222-4222-8222-222222222222";
    const admin = createWriteAdmin({
      existingRefs: [{ image_id: contentImageId, usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: contentImageId, status: "ready" } }],
    });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({
      editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
      contentImageIds: [], content: "이미지 제거", image_url: null,
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
      p_content_image_ids: [], p_thumbnail_image_id: null,
    }));
  });

  it.each([
    ["null row", null],
    ["array row", []],
    ["nested object 누락", { image_id: "22222222-2222-4222-8222-222222222222", usage: "content" }],
    ["unknown bucket", { image_id: "22222222-2222-4222-8222-222222222222", usage: "content", board_image_objects: { bucket_id: "unknown", storage_key: "22222222-2222-4222-8222-222222222222", status: "ready" } }],
    ["key mismatch", { image_id: "22222222-2222-4222-8222-222222222222", usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: "other", status: "ready" } }],
    ["unknown status", { image_id: "22222222-2222-4222-8222-222222222222", usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: "22222222-2222-4222-8222-222222222222", status: "unexpected" } }],
  ])("수정의 기존 이미지 ref가 %s이면 fail-closed로 503 반환하고 write RPC를 호출하지 않는다", async (_label, malformedRef) => {
    const admin = createWriteAdmin({ existingRefs: [malformedRef] });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({
      editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
    }));

    expect(response.status).toBe(503);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("유효한 legacy ref는 managed ID에 병합하지 않고 수정 RPC를 진행한다", async () => {
    const legacyImageId = "22222222-2222-4222-8222-222222222222";
    const admin = createWriteAdmin({
      existingRefs: [{ image_id: legacyImageId, usage: "content", board_image_objects: { bucket_id: "images", storage_key: "legacy/path.png", status: "legacy_retained" } }],
    });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({
      editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
      p_content_image_ids: [], p_thumbnail_image_id: null,
    }));
  });

  it("기존 ref의 usage와 무관하게 실제 URL 위치에 따라 content·thumbnail usage를 전환하고 ID를 중복하지 않는다", async () => {
    const imageId = "22222222-2222-4222-8222-222222222222";
    const baseUrl = "https://example.supabase.co";
    const imageUrl = `${baseUrl}/storage/v1/object/public/board-images-v2/${imageId}`;
    const admin = createWriteAdmin({
      existingRefs: [
        { image_id: imageId, usage: "content", board_image_objects: { bucket_id: "board-images-v2", storage_key: imageId, status: "ready" } },
      ],
    });
    const previousBaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });

    try {
      const response = await postsWritePOST(makePostRequest({
        editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
        content: `<img src="${imageUrl}">`, image_url: imageUrl, contentImageIds: [], thumbnailImageId: null,
      }));

      expect(response.status).toBe(200);
      expect(admin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
        p_content_image_ids: [imageId], p_thumbnail_image_id: imageId,
      }));
    } finally {
      if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousBaseUrl;
    }
  });

  it.each([
    ["없는 글", createWriteAdmin({ existingPost: false }), 404],
    ["다른 작성자", createWriteAdmin({ postOwnerId: "other-user" }), 403],
    ["오래된 revision", createWriteAdmin({ postRevision: 1 }), 409],
  ])("수정 사전 검증은 %s에서 Discord fetch와 write RPC 전에 차단한다", async (_label, admin, status) => {
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });
    const response = await postsWritePOST(makePostRequest({
      editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
      category: "듀오/스쿼드 모집", discord_url: "https://discord.gg/test",
    }));

    expect(response.status).toBe(status);
    expect(mocks.externalFetch).not.toHaveBeenCalled();
    expect(admin.refs).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("수정 사전 게시글 조회 오류는 외부 fetch와 write RPC 전에 503으로 고정한다", async () => {
    const admin = createWriteAdmin({ postQueryError: { message: "raw-post-error" } });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });
    const response = await postsWritePOST(makePostRequest({
      editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a",
      category: "듀오/스쿼드 모집", discord_url: "https://discord.gg/test",
    }));

    expect(response.status).toBe(503);
    expect(mocks.externalFetch).not.toHaveBeenCalled();
    expect(admin.refs).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["ok", { result_code: "ok", post_id: 41, revision: 1 }, 200],
    ["revision_conflict", { result_code: "revision_conflict", post_id: 41, revision: 1 }, 409],
    ["forbidden", { result_code: "forbidden", post_id: 41, revision: 1 }, 403],
    ["not_found", { result_code: "not_found", post_id: null, revision: null }, 404],
  ])("write RPC result_code별 nullable 계약을 엄격히 해석한다", async (_code, row, status) => {
    const admin = createWriteAdmin();
    admin.rpc.mockResolvedValue({ data: [row], error: null });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });
    const response = await postsWritePOST(makePostRequest({ editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a" }));
    expect(response.status).toBe(status);
  });

  it.each([
    { result_code: "not_found", post_id: 41, revision: 1 },
    { result_code: "ok", post_id: null, revision: null },
    { result_code: "unknown", post_id: 41, revision: 1 },
  ])("write RPC의 malformed result는 503으로 fail-closed 처리한다", async (row) => {
    const admin = createWriteAdmin();
    admin.rpc.mockResolvedValue({ data: [row], error: null });
    mocks.withOptionalAuth.mockResolvedValue({ user: { id: "user-a" }, supabaseAdmin: admin.supabaseAdmin });

    const response = await postsWritePOST(makePostRequest({ editingPostId: 41, expectedRevision: 0, author: "회원", password: null, user_id: "user-a" }));

    expect(response.status).toBe(503);
  });

  it("호환 guest route는 token 누락 시 quota, bcrypt, insert 전에 거부한다", async () => {
    const admin = createGuestCompatibilityAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await guestPostsPOST(makeCompatibilityRequest());

    expect(response.status).toBe(400);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(admin.insert).not.toHaveBeenCalled();
  });

  it("호환 guest route는 타입이 잘못된 body를 인증 전에 400으로 거부한다", async () => {
    const response = await guestPostsPOST(makeCompatibilityRequest({ title: 1234 }));

    expect(response.status).toBe(400);
    expect(mocks.withOptionalAuth).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["제목 50자 초과", { title: "제".repeat(51) }],
    ["카테고리 50자 초과", { category: "카".repeat(51) }],
  ])("호환 guest route는 %s payload를 인증·quota·Siteverify·DB 전에 400으로 거부한다", async (_caseName, overrides) => {
    const admin = createGuestCompatibilityAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await guestPostsPOST(makeCompatibilityRequest(overrides));

    expect(response.status).toBe(400);
    expect(mocks.withOptionalAuth).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(admin.insert).not.toHaveBeenCalled();
  });

  it("두 게시글 route는 제목·카테고리를 trim해 저장한다", async () => {
    const writeAdmin = createWriteAdmin();
    mocks.withOptionalAuth.mockResolvedValueOnce({
      user: { id: "user-a" },
      supabaseAdmin: writeAdmin.supabaseAdmin,
    });

    const writeResponse = await postsWritePOST(makePostRequest({
      title: "  회원 글  ",
      category: "  자유  ",
      author: "회원",
      password: null,
      user_id: "user-a",
    }));

    const compatibilityAdmin = createGuestCompatibilityAdmin();
    mocks.withOptionalAuth.mockResolvedValueOnce({
      user: null,
      supabaseAdmin: compatibilityAdmin.supabaseAdmin,
    });
    const compatibilityResponse = await guestPostsPOST(makeCompatibilityRequest({
      title: "  호환 글  ",
      category: "  자유  ",
      turnstileToken: "token",
    }));

    expect(writeResponse.status).toBe(200);
    expect(writeAdmin.rpc).toHaveBeenCalledWith("write_board_post_with_images", expect.objectContaining({
      p_title: "회원 글",
      p_category: "자유",
    }));
    expect(compatibilityResponse.status).toBe(200);
    expect(compatibilityAdmin.insert).toHaveBeenCalledWith([
      expect.objectContaining({ title: "호환 글", category: "자유" }),
    ]);
  });

  it("호환 guest route는 Siteverify 성공 뒤 quota 거부 시 저장을 호출하지 않는다", async () => {
    const admin = createGuestCompatibilityAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });
    mocks.consumeQuota.mockResolvedValue({
      ok: false,
      status: 429,
      error: "게시글은 1분에 한 번만 작성할 수 있습니다.",
    });

    const response = await guestPostsPOST(makeCompatibilityRequest({ turnstileToken: "token" }));

    expect(response.status).toBe(429);
    expect(mocks.verifyTurnstile).toHaveBeenCalledOnce();
    expect(admin.insert).not.toHaveBeenCalled();
  });

  it("호환 guest route는 valid guest_post token만 insert를 허용한다", async () => {
    const admin = createGuestCompatibilityAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await guestPostsPOST(makeCompatibilityRequest({ turnstileToken: "token" }));

    expect(response.status).toBe(200);
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({
      expectedAction: "guest_post",
      remoteIp: "203.0.113.10",
      token: "token",
    });
    expect(mocks.verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeQuota.mock.invocationCallOrder[0],
    );
    expect(mocks.consumeQuota.mock.invocationCallOrder[0]).toBeLessThan(
      admin.insert.mock.invocationCallOrder[0],
    );
    expect(admin.insert).toHaveBeenCalledTimes(1);
  });

  it("호환 게시글 쓰기 응답은 서버 전용 비밀번호 해시와 IP 주소를 포함하지 않는다", async () => {
    const admin = createGuestCompatibilityAdmin();
    mocks.withOptionalAuth.mockResolvedValue({ user: null, supabaseAdmin: admin.supabaseAdmin });

    const response = await guestPostsPOST(makeCompatibilityRequest({ turnstileToken: "token" }));
    const payload = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(payload).not.toContain("password_hash");
    expect(payload).not.toContain("ip_address");
  });
});

describe("BoardWrite Turnstile client 계약", () => {
  const source = readFileSync(
    new URL("../components/board/BoardWriteClient.tsx", import.meta.url),
    "utf8",
  );
  const sessionVerificationFlag = ["turnstile", "verified"].join("_");
  const standaloneVerifyRoute = ["/api/board", "turnstile"].join("/");

  it("guest_post 위젯을 비회원 신규 작성에서만 표시한다", () => {
    expect(source).toContain("!user && !editPostId");
    expect(source).toContain("<TurnstileWidget");
    expect(source).toContain("action={TURNSTILE_ACTIONS.post}");
  });

  it("비회원 token을 메모리에 보관해 실제 저장 body에 포함한다", () => {
    expect(source).toContain("const [turnstileToken, setTurnstileToken] = useState<string | null>(null)");
    expect(source).toContain("turnstileToken: user || editPostId ? null : turnstileToken");
    expect(source).not.toContain(sessionVerificationFlag);
    expect(source).not.toContain(standaloneVerifyRoute);
    expect(source).toContain("onError={() => setTurnstileToken(null)}");
  });

  it("비회원 submit 시도 후 성공과 실패 모두 token과 widget을 초기화한다", () => {
    expect(source).toMatch(/finally\s*{[\s\S]*setTurnstileToken\(null\)[\s\S]*setTurnstileGeneration/);
  });
});
