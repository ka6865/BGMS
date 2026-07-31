import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { mockCreateSupabaseAdminClient, mockRpc } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockCreateSupabaseAdminClient = vi.fn(() => ({ rpc: mockRpc }));
  return { mockCreateSupabaseAdminClient, mockRpc };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateSupabaseAdminClient
}));

import { POST, OPTIONS } from "@/app/api/overwolf/session/route";
import { normalizeSessionPayload } from "@/lib/overwolf/session-payload";

function buildRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://bgms.kr/api/overwolf/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "bgms.kr", ...headers },
    body: JSON.stringify(body)
  });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "bgms-abc-123",
    match_id: "match-1",
    pseudo_match_id: "pseudo-1",
    gep_summary: {
      effective_match_id: "match-1",
      match_mode: "squad-fpp",
      phase: "landed",
      kills: 3,
      deaths: 1,
      revives: 2,
      knockdowns: 1,
      alive_players: 12,
      source: "overwolf_gep"
    },
    client_environment: { app: "BGMS Companion", source: "overwolf", version: "0.3.0" },
    ...overrides
  };
}

describe("normalizeSessionPayload", () => {
  it("허용 키만 남기고 알 수 없는 키는 버린다", () => {
    const result = normalizeSessionPayload(
      validPayload({
        gep_summary: { kills: 2, unknown_key: "x" },
        client_environment: { app: "BGMS Companion", secret_token: "leak" }
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gep_summary).toEqual({ kills: 2 });
    expect(result.value.client_environment).toEqual({ app: "BGMS Companion" });
  });

  it("정책 금지 필드가 있으면 거부한다", () => {
    const blocked = [
      { gep_summary: { damage_dealt: 120 } },
      { gep_summary: { total_damage_dealt: 300 } },
      { gep_summary: { nested: { location: { x: 1, y: 2 } } } },
      { client_environment: { team_location: "x" } }
    ];

    blocked.forEach((override) => {
      const result = normalizeSessionPayload(validPayload(override));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("blocked_field");
    });
  });

  it("session_id가 없거나 비어 있으면 거부한다", () => {
    [{ session_id: "" }, { session_id: null }, { session_id: "!!!" }].forEach((override) => {
      const result = normalizeSessionPayload(validPayload(override));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_session_id");
    });
  });

  it("player_id와 platform은 identity 정규화 규칙을 따른다", () => {
    const result = normalizeSessionPayload(validPayload({ player_id: "  MyNick  ", platform: "Steam" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.player_id).toBe("mynick");
    expect(result.value.platform).toBe("steam");
  });

  it("payload가 객체가 아니면 거부한다", () => {
    [null, "text", 12, []].forEach((body) => {
      const result = normalizeSessionPayload(body);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_payload");
    });
  });
});

describe("POST /api/overwolf/session", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  });

  it("정상 payload는 세션을 저장하고 stored=true를 반환한다", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    const response = await POST(buildRequest(validPayload()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ success: true, stored: true, duplicate: false });
    expect(mockRpc).toHaveBeenNthCalledWith(1, "consume_overwolf_session_quota", expect.objectContaining({
      p_quota_key: "bgms-abc-123"
    }));
    expect(mockRpc).toHaveBeenNthCalledWith(2, "record_overwolf_session_event", expect.objectContaining({
      p_session_id: "bgms-abc-123",
      p_match_id: "match-1"
    }));
  });

  it("중복 세션은 duplicate=true로 성공 처리한다", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    const response = await POST(buildRequest(validPayload()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ success: true, stored: false, duplicate: true });
  });

  it("쿼터를 초과하면 429를 반환하고 저장하지 않는다", async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const response = await POST(buildRequest(validPayload()));

    expect(response.status).toBe(429);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("금지 필드가 오면 422를 반환하고 DB를 호출하지 않는다", async () => {
    const response = await POST(buildRequest(validPayload({ gep_summary: { damage_dealt: 100 } })));

    expect(response.status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("session_id가 없으면 400을 반환한다", async () => {
    const response = await POST(buildRequest(validPayload({ session_id: "" })));

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("payload가 크기 제한을 넘으면 413을 반환한다", async () => {
    const response = await POST(buildRequest(validPayload(), { "content-length": String(64 * 1024) }));

    expect(response.status).toBe(413);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("Supabase 설정이 없으면 503을 반환한다", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "";

    const response = await POST(buildRequest(validPayload()));

    expect(response.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("저장 실패는 500을 반환한다", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    const response = await POST(buildRequest(validPayload()));

    expect(response.status).toBe(500);
  });

  it("OPTIONS는 CORS 헤더와 함께 204를 반환한다", async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("overwolf_gep 마이그레이션 보안 규약", () => {
  const MIGRATION = readFileSync(
    resolve("supabase/migrations/20260731070000_overwolf_gep_session_events.sql"),
    "utf8"
  );

  it("신규 테이블은 RLS를 켜고 anon/authenticated 권한을 회수한다", () => {
    ["public.overwolf_session_events", "public.overwolf_session_quota"].forEach((table) => {
      expect(MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`REVOKE ALL ON TABLE ${table} FROM anon, authenticated`);
      expect(MIGRATION).toContain(`GRANT ALL ON TABLE ${table} TO service_role`);
    });
  });

  it("세션 적재는 session_id PK와 ON CONFLICT DO NOTHING으로 idempotent하다", () => {
    expect(MIGRATION).toContain("session_id text PRIMARY KEY");
    expect(MIGRATION).toContain("ON CONFLICT (session_id) DO NOTHING");
    expect(MIGRATION).toContain("GET DIAGNOSTICS inserted_rows = ROW_COUNT");
  });

  it("모든 SECURITY DEFINER 함수가 search_path를 고정하고 service_role로 제한된다", () => {
    const definerCount = MIGRATION.match(/SECURITY DEFINER/g)?.length ?? 0;
    const searchPathCount = MIGRATION.match(/SET search_path = ''/g)?.length ?? 0;
    expect(definerCount).toBeGreaterThan(0);
    expect(searchPathCount).toBeGreaterThanOrEqual(definerCount);

    for (const fn of [
      "public.record_overwolf_session_event(text, text, text, text, text, jsonb, jsonb, text, boolean)",
      "public.consume_overwolf_session_quota(text, integer, integer)",
      "public.cleanup_overwolf_session_events(integer)"
    ]) {
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated`);
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role`);
    }
  });

  it("기존 운영 분석 테이블에 DML을 수행하지 않는다", () => {
    // 주석에서는 분리 대상 테이블명을 언급하므로 실제 DML 구문만 검사한다.
    const statements = MIGRATION.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    ["processed_match_telemetry", "match_stats_raw", "global_benchmarks"].forEach((table) => {
      ["INSERT INTO public." + table, "UPDATE public." + table, "DELETE FROM public." + table, "ALTER TABLE public." + table].forEach((dml) => {
        expect(statements).not.toContain(dml);
      });
    });
  });
});
