/**
 * @fileoverview 보안 강화 항목을 문자열 검사가 아니라 실제 라우트 실행으로 검증합니다.
 *
 * 독립 감사에서 tests/security-hardening-boundary.test.ts 가 소스 문자열 존재만 확인해
 * 허위 통과가 가능하다는 지적을 받아 추가했습니다.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_TOKEN = "admin-secret-token-value-0001";
const CRON_TOKEN = "cron-secret-token-value-00001";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "GET", headers });
}

describe("/api/cleanup 인증 동작", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ADMIN_SECRET_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("CRON_SECRET", CRON_TOKEN);
  });

  it("헤더가 없으면 401", async () => {
    const { GET } = await import("@/app/api/cleanup/route");
    const res = await GET(req("https://bgms.kr/api/cleanup"));
    expect(res.status).toBe(401);
  });

  it("쿼리 파라미터 토큰은 더 이상 통하지 않는다 (401)", async () => {
    const { GET } = await import("@/app/api/cleanup/route");
    const res = await GET(req(`https://bgms.kr/api/cleanup?token=${ADMIN_TOKEN}`));
    expect(res.status).toBe(401);
  });

  it("잘못된 Bearer 토큰은 401", async () => {
    const { GET } = await import("@/app/api/cleanup/route");
    const res = await GET(
      req("https://bgms.kr/api/cleanup", { Authorization: "Bearer wrong-token-value-00000001" })
    );
    expect(res.status).toBe(401);
  });

  it("길이가 같은 다른 토큰도 401 (상수 시간 비교가 통과시키지 않는다)", async () => {
    const { GET } = await import("@/app/api/cleanup/route");
    const sameLengthWrong = "X".repeat(ADMIN_TOKEN.length);
    const res = await GET(
      req("https://bgms.kr/api/cleanup", { Authorization: `Bearer ${sameLengthWrong}` })
    );
    expect(res.status).toBe(401);
  });

  it("환경변수가 비어 있으면 어떤 토큰도 통과하지 못한다", async () => {
    vi.stubEnv("ADMIN_SECRET_TOKEN", "");
    vi.stubEnv("CRON_SECRET", "");
    const { GET } = await import("@/app/api/cleanup/route");
    const res = await GET(req("https://bgms.kr/api/cleanup", { Authorization: "Bearer " }));
    expect(res.status).toBe(401);
  });
});

describe("/api/cron/patch-notes 인증 동작", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("CRON_SECRET", CRON_TOKEN);
    vi.stubEnv("ADMIN_SECRET_TOKEN", ADMIN_TOKEN);
  });

  it("헤더가 없으면 401 (개발 환경에서도 우회 불가)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { GET } = await import("@/app/api/cron/patch-notes/route");
    const res = await GET(req("https://bgms.kr/api/cron/patch-notes"));
    expect(res.status).toBe(401);
  });

  it("test 환경에서도 401 (NODE_ENV 우회 없음)", async () => {
    const { GET } = await import("@/app/api/cron/patch-notes/route");
    const res = await GET(req("https://bgms.kr/api/cron/patch-notes"));
    expect(res.status).toBe(401);
  });

  it("쿼리 파라미터 secret 은 통하지 않는다 (401)", async () => {
    const { GET } = await import("@/app/api/cron/patch-notes/route");
    const res = await GET(req(`https://bgms.kr/api/cron/patch-notes?secret=${CRON_TOKEN}`));
    expect(res.status).toBe(401);
  });

  it("Bearer 접두어 없는 헤더는 401", async () => {
    const { GET } = await import("@/app/api/cron/patch-notes/route");
    const res = await GET(req("https://bgms.kr/api/cron/patch-notes", { Authorization: CRON_TOKEN }));
    expect(res.status).toBe(401);
  });
});

describe("/api/discord/room/create 인증·쿼터 동작", () => {
  const guardMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_GUILD_ID", "guild-id");
    guardMock.mockReset();
    vi.doMock("@/utils/supabase/guard", () => ({ withAuthGuard: guardMock }));
  });

  function post(body: unknown): Request {
    return new Request("https://bgms.kr/api/discord/room/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function authorized(rpc: ReturnType<typeof vi.fn>) {
    guardMock.mockResolvedValue({
      user: { id: "00000000-0000-0000-0000-000000000001" },
      supabaseAdmin: { rpc },
    });
  }

  it("미인증이면 401 이고 Discord API 를 호출하지 않는다", async () => {
    guardMock.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { POST } = await import("@/app/api/discord/room/create/route");
    const res = await POST(post({ type: "squad", author: "tester" }));

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("쿼터를 초과하면 429 이고 Discord API 를 호출하지 않는다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
    authorized(rpc);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { POST } = await import("@/app/api/discord/room/create/route");
    const res = await POST(post({ type: "duo", author: "tester" }));

    expect(res.status).toBe(429);
    expect(rpc).toHaveBeenCalledWith("consume_discord_room_quota", {
      p_user_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("쿼터 RPC 오류 시 fail-closed (503)", async () => {
    authorized(vi.fn().mockResolvedValue({ data: null, error: { message: "rpc down" } }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { POST } = await import("@/app/api/discord/room/create/route");
    const res = await POST(post({ type: "duo", author: "tester" }));

    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("허용되지 않은 type 은 400 이고 쿼터를 소비하지 않는다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    authorized(rpc);

    const { POST } = await import("@/app/api/discord/room/create/route");
    for (const type of ["raid", "", null, 5, { a: 1 }]) {
      const res = await POST(post({ type, author: "tester" }));
      expect(res.status, `type=${JSON.stringify(type)}`).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("표시명은 길이·문자 제한을 거쳐 채널 이름에 들어간다", async () => {
    authorized(vi.fn().mockResolvedValue({ data: true, error: null }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/channels") && !target.includes("/invites")) {
        return new Response(JSON.stringify({ id: "channel-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invite-1" }), { status: 200 });
    });

    const { POST } = await import("@/app/api/discord/room/create/route");
    const res = await POST(post({
      type: "squad",
      author: "@everyone `*_~|\\<>" + "가".repeat(60),
    }));

    expect(res.status).toBe(200);
    const createCall = fetchSpy.mock.calls.find(
      ([url]) => String(url).includes("/channels") && !String(url).includes("/invites")
    );
    const sentName = JSON.parse(String((createCall?.[1] as RequestInit).body)).name as string;

    expect(sentName).not.toContain("@everyone");
    expect(sentName).not.toContain("`");
    expect(sentName).not.toContain("\\");
    expect(sentName).not.toContain("<");
    expect(sentName).not.toContain(">");
    // 표시명은 24자로 잘린다. @ 와 마크다운 문자가 제거된 뒤 슬라이스된다.
    const displayName = sentName.replace("🔊 [SQUAD] ", "").replace("님의 팀", "");
    expect([...displayName]).toHaveLength(24);
    expect(sentName).toBe(`🔊 [SQUAD] ${"everyone " + "가".repeat(15)}님의 팀`);
    fetchSpy.mockRestore();
  });

  it("본문이 JSON 이 아니면 400", async () => {
    authorized(vi.fn());
    const { POST } = await import("@/app/api/discord/room/create/route");
    const res = await POST(new Request("https://bgms.kr/api/discord/room/create", {
      method: "POST",
      body: "not-json",
    }));
    expect(res.status).toBe(400);
  });
});

describe("player 라우트가 서버 전용 테이블에 anon 클라이언트로 쓰지 않는다", () => {
  it("pubg_player_cache 쓰기는 service_role 클라이언트를 사용한다", async () => {
    const source = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve("app/api/pubg/player/route.ts"),
      "utf8"
    );

    // anon 클라이언트(supabase)로 쓰기 호출이 남아 있지 않은지 확인
    expect(source).not.toMatch(/supabase\s*\.from\([^)]*\)\s*\n?\s*\.(upsert|insert|update|delete)\(/);
    expect(source).toContain("createServiceRoleClient()");
    expect(source).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // 실패를 조용히 삼키지 않고 로깅한다
    expect(source).toContain("pubg_player_cache 갱신 실패");
  });
});
