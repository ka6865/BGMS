import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCreateServerClient,
  mockCreateSupabaseAdminClient,
  mockAuthGetUser,
  mockProfileMaybeSingle,
  mockAnalyticsInsert,
  mockConsumeQuota
} = vi.hoisted(() => {
  const mockAuthGetUser = vi.fn();
  const mockProfileMaybeSingle = vi.fn();
  const mockAnalyticsInsert = vi.fn();
  const mockConsumeQuota = vi.fn();
  const profileChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: mockProfileMaybeSingle
  };
  const analyticsChain = {
    insert: mockAnalyticsInsert
  };
  const adminClient = {
    rpc: mockConsumeQuota,
    auth: {
      getUser: mockAuthGetUser
    },
    from: vi.fn((table: string) => {
      if (table === "profiles") return profileChain;
      if (table === "analytics_events") return analyticsChain;
      return {};
    })
  };
  const mockCreateSupabaseAdminClient = vi.fn(() => adminClient);
  const mockCreateServerClient = vi.fn(() => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null })
    }
  }));

  return {
    mockCreateServerClient,
    mockCreateSupabaseAdminClient,
    mockAuthGetUser,
    mockProfileMaybeSingle,
    mockAnalyticsInsert,
    mockConsumeQuota
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: mockCreateServerClient
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateSupabaseAdminClient
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: vi.fn().mockReturnValue([])
  })
}));

import { POST } from "../app/api/analytics/event/route";

describe("analytics event API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.VERCEL_ENV = "production";
    mockAuthGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockAnalyticsInsert.mockResolvedValue({ error: null });
    mockConsumeQuota.mockResolvedValue({ data: true, error: null });
  });

  it("비회원 이벤트는 user_id 없이 저장한다", async () => {
    const response = await POST(buildRequest());

    expect(response.status).toBe(200);
    expect(mockAnalyticsInsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
      event_name: "page_view",
      user_id: null,
      session_id: "session-1",
      page_path: "/",
      client_environment: "production",
      source_host: "bgms.test",
      is_internal: false
    })]));
  });

  it.each([undefined, "1"])("Content-Length가 %s여도 실제 32KiB 초과 본문을 거부한다", async (length) => {
    const request = new Request("https://bgms.test/api/analytics/event", {
      method: "POST", headers: length ? { "content-length": length } : {},
      body: JSON.stringify({ name: "page_view", padding: "가".repeat(11_000) })
    });
    const parse = vi.spyOn(request, "json");
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockConsumeQuota).not.toHaveBeenCalled();
    expect(mockAnalyticsInsert).not.toHaveBeenCalled();
  });

  it("상한을 넘긴 스트림은 취소하고 뒤의 청크를 읽지 않는다", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 + 1)); }, cancel
    });
    const request = new Request("https://bgms.test/api/analytics/event", {
      method: "POST", body: stream, duplex: "half"
    } as RequestInit);
    expect((await POST(request)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("정확히 32KiB인 유효한 본문은 허용한다", async () => {
    const body = await buildRequest().text();
    const request = new Request("https://bgms.test/api/analytics/event", {
      method: "POST", body: body + " ".repeat(32 * 1024 - new TextEncoder().encode(body).byteLength)
    });
    expect((await POST(request)).status).toBe(200);
    expect(mockAnalyticsInsert).toHaveBeenCalledOnce();
  });

  it("한글이 청크 사이에서 나뉘어도 UTF-8을 손상시키지 않는다", async () => {
    const body = JSON.parse(await buildRequest().text());
    body.pageTitle = "한글 화면";
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const stream = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    expect((await POST(new Request("https://bgms.test/api/analytics/event", { method: "POST", body: stream, duplex: "half" } as RequestInit))).status).toBe(200);
    expect(mockAnalyticsInsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ page_title: "한글 화면" })]));
  });

  it("잘못된 JSON이나 본문 수신 실패는 저장 전에 거부한다", async () => {
    const malformed = new Request("https://bgms.test/api/analytics/event", { method: "POST", body: "{" });
    expect((await POST(malformed)).status).toBe(400);
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("connection failed")); } });
    expect((await POST(new Request("https://bgms.test/api/analytics/event", { method: "POST", body: stream, duplex: "half" } as RequestInit))).status).toBe(400);
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("로컬 host 이벤트는 기본 저장하지 않는다", async () => {
    const response = await POST(buildRequest(undefined, "http://localhost/api/analytics/event"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skipped).toBe("local_environment");
    expect(mockAnalyticsInsert).not.toHaveBeenCalled();
  });

  it("Authorization 토큰이 있으면 검증된 user_id를 저장한다", async () => {
    mockAuthGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-1" } },
      error: null
    });
    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { id: "user-1", role: "user", nickname: "Tester", pubg_nickname: "TesterPUBG" },
      error: null
    });

    const response = await POST(buildRequest("Bearer access-token"));

    expect(response.status).toBe(200);
    expect(mockAuthGetUser).toHaveBeenCalledWith("access-token");
    expect(mockAnalyticsInsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
      user_id: "user-1"
    })]));
  });

  it("관리자 이벤트는 analytics_events에 저장하지 않는다", async () => {
    mockAuthGetUser.mockResolvedValueOnce({
      data: { user: { id: "admin-1" } },
      error: null
    });
    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { id: "admin-1", role: "admin", nickname: "Admin", pubg_nickname: null },
      error: null
    });

    const response = await POST(buildRequest("Bearer admin-token"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skipped).toBe("admin_activity");
    expect(mockAnalyticsInsert).not.toHaveBeenCalled();
  });

  it("배치 개수 상한을 넘기면 저장하지 않는다", async () => {
    const event = {
      name: "page_view", sessionId: "session-1", pagePath: "/", pageTitle: "BGMS",
    };
    const response = await POST(new Request("https://bgms.test/api/analytics/event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Array.from({ length: 26 }, () => event)),
    }));

    expect(response.status).toBe(413);
    expect(mockAnalyticsInsert).not.toHaveBeenCalled();
  });

  it("서버가 수집 출처를 결정하고 세션 쿼터를 소비한다", async () => {
    const response = await POST(new Request("https://bgms.test/api/analytics/event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "page_view", sessionId: "session-1", pagePath: "/", pageTitle: "BGMS",
        clientEnvironment: "development", sourceHost: "forged.example", isInternal: true,
      }),
    }));

    expect(response.status).toBe(200);
    expect(mockConsumeQuota).toHaveBeenCalled();
    expect(mockAnalyticsInsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
      client_environment: "production", source_host: "bgms.test", is_internal: false,
    })]));
  });
});

function buildRequest(authorization?: string, url = "https://bgms.test/api/analytics/event") {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {})
    },
    body: JSON.stringify({
      name: "page_view",
      params: { path: "/", title: "BGMS" },
      sessionId: "session-1",
      pagePath: "/",
      pageTitle: "BGMS",
      clientEnvironment: "production",
      sourceHost: "bgms.test"
    })
  });
}
