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

import { GET } from "@/app/api/overwolf/sessions/route";
import { POST } from "@/app/api/overwolf/session/route";
import {
  buildAnalysisPath,
  buildReplayPath,
  extractTelemetryMatchId,
  formatClock,
  groupByPlaySession,
  toSessionSummaryView,
  toSessionSummaryViews
} from "@/lib/overwolf/session-view";
import { normalizeSessionPayload } from "@/lib/overwolf/session-payload";

const TIMELINE_MIGRATION = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260801080000_overwolf_gep_session_timeline.sql"),
  "utf8"
);

function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "bgms-session-1",
    match_id:
      "match.bro.official.pc-2018-01.steam.squad-fpp.as.2026.08.01.ce8d1a14-b2af-41c8-8bf4-d2a504326630",
    pseudo_match_id: "0c0ea3df-97ea-4d3a-b1f6-f8e34042251f",
    player_id: "testplayer",
    platform: "steam",
    gep_summary: {
      official_match_id:
        "match.bro.official.pc-2018-01.steam.squad-fpp.as.2026.08.01.ce8d1a14-b2af-41c8-8bf4-d2a504326630",
      map_name: "Erangel_Main",
      match_mode: "squad-fpp",
      kills: 4,
      headshots: 2,
      deaths: 1,
      revives: 1,
      knockdowns: 2,
      max_kill_distance: 212.75,
      rank_place: 7,
      rank_total: 96,
      last_killer_name: "Ace_Tullis",
      match_started_at: "2026-08-01T10:00:00.000Z",
      match_ended_at: "2026-08-01T10:24:30.000Z"
    },
    event_timeline: [
      { t: 420, kind: "kill" },
      { t: 90, kind: "knockedout" },
      { t: 1470, kind: "killer", detail: "Ace_Tullis" }
    ],
    created_at: "2026-08-01T10:25:00.000Z",
    ...overrides
  };
}

describe("세션 요약 화면 변환", () => {
  it("raw 행을 화면용 구조로 정규화한다", () => {
    const view = toSessionSummaryView(rawRow());

    expect(view).not.toBeNull();
    expect(view?.sessionId).toBe("bgms-session-1");
    expect(view?.mapName).toBe("Erangel_Main");
    expect(view?.kills).toBe(4);
    expect(view?.headshots).toBe(2);
    expect(view?.maxKillDistance).toBe(212.75);
    expect(view?.rankPlace).toBe(7);
    expect(view?.rankTotal).toBe(96);
    expect(view?.durationSeconds).toBe(1470);
    expect(view?.canOpenAnalysis).toBe(true);
  });

  it("타임라인을 경과 초 기준으로 정렬하고 허용 종류만 남긴다", () => {
    const view = toSessionSummaryView(
      rawRow({
        event_timeline: [
          { t: 500, kind: "death" },
          { t: 100, kind: "kill" },
          { t: 300, kind: "location" },
          { t: -5, kind: "revived" },
          { kind: "killer", detail: "Someone" },
          { t: 200, kind: "unknown_kind" }
        ]
      })
    );

    expect(view?.timeline.map((entry) => entry.kind)).toEqual([
      "kill",
      "death",
      "revived",
      "killer"
    ]);
    // 음수 경과 초와 누락값은 null 로 떨어지고 뒤로 밀린다.
    expect(view?.timeline[2].elapsedSeconds).toBeNull();
    expect(view?.timeline[3].elapsedSeconds).toBeNull();
  });

  it("pseudo_match_id만 있으면 분석 진입을 막는다", () => {
    const view = toSessionSummaryView(
      rawRow({
        match_id: null,
        gep_summary: { ...rawRow().gep_summary, official_match_id: null }
      })
    );

    expect(view?.canOpenAnalysis).toBe(false);
    expect(view?.officialMatchId).toBeNull();
    expect(view?.displayMatchId).toBe("0c0ea3df-97ea-4d3a-b1f6-f8e34042251f");
    expect(buildAnalysisPath(view!)).toBeNull();
  });

  it("분석 경로는 기존 전적 분석 라우트를 재사용한다", () => {
    const view = toSessionSummaryView(rawRow());

    expect(buildAnalysisPath(view!)).toBe("/stats/steam/testplayer");
  });

  it("session_id가 없으면 버린다", () => {
    expect(toSessionSummaryView({ session_id: "" })).toBeNull();
    expect(toSessionSummaryViews([{ session_id: "" }, rawRow()])).toHaveLength(1);
    expect(toSessionSummaryViews(null)).toEqual([]);
  });

  it("경과 초를 시계 표기로 바꾼다", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(3675)).toBe("1:01:15");
    expect(formatClock(null)).toBe("");
    expect(formatClock(-1)).toBe("");
  });
});

describe("GEP match_id에서 BGMS 텔레메트리 id 추출", () => {
  it("공식 문서 형식의 GEP match_id 끝 UUID를 뽑는다", () => {
    // 공식 PUBG GEP 문서의 match_id 예시값
    expect(
      extractTelemetryMatchId(
        "match.bro.official.pc-2018-03.steam.solo.eu.2019.05.07.08.ce8d1a14-b2af-41c8-8bf4-d2a504326630"
      )
    ).toBe("ce8d1a14-b2af-41c8-8bf4-d2a504326630");
  });

  it("이미 UUID만 들어오면 그대로 통과시킨다", () => {
    expect(extractTelemetryMatchId("3462da2c-8f01-468d-96df-cb00cb5cd713")).toBe(
      "3462da2c-8f01-468d-96df-cb00cb5cd713"
    );
  });

  it("대문자 UUID는 소문자로 정규화한다", () => {
    expect(extractTelemetryMatchId("match.bro.official.CE8D1A14-B2AF-41C8-8BF4-D2A504326630")).toBe(
      "ce8d1a14-b2af-41c8-8bf4-d2a504326630"
    );
  });

  it("UUID가 없으면 null을 반환해 잘못된 리플레이 진입을 막는다", () => {
    expect(extractTelemetryMatchId(null)).toBeNull();
    expect(extractTelemetryMatchId("")).toBeNull();
    expect(extractTelemetryMatchId("match.bro.official.pc-2018-03.steam.solo.eu")).toBeNull();
    expect(extractTelemetryMatchId("not-a-uuid-at-all")).toBeNull();
    // 자릿수가 부족한 값은 UUID 로 인정하지 않는다.
    expect(extractTelemetryMatchId("ce8d1a14-b2af-41c8-8bf4-d2a5043266")).toBeNull();
  });
});

describe("맵 리플레이 진입 경로", () => {
  it("텔레메트리 id와 닉네임이 있으면 기존 리플레이 경로를 재사용한다", () => {
    const view = toSessionSummaryView(rawRow());

    expect(view?.telemetryMatchId).toBe("ce8d1a14-b2af-41c8-8bf4-d2a504326630");
    expect(view?.canOpenReplay).toBe(true);

    const path = buildReplayPath(view!);

    expect(path).toContain("/replay/3d?");
    expect(path).toContain("matchId=ce8d1a14-b2af-41c8-8bf4-d2a504326630");
    expect(path).toContain("nickname=testplayer");
    expect(path).toContain("platform=steam");
    // 시점을 주지 않으면 t 파라미터를 붙이지 않는다.
    expect(path).not.toContain("t=");
  });

  it("교전 시점을 주면 t 파라미터로 진입 지점을 넘긴다", () => {
    const view = toSessionSummaryView(rawRow());

    expect(buildReplayPath(view!, 420)).toContain("t=420");
    // 소수점은 정수 초로 반올림한다.
    expect(buildReplayPath(view!, 89.6)).toContain("t=90");
    // 시각을 모르는 항목(null)이나 음수는 t 를 붙이지 않는다.
    expect(buildReplayPath(view!, null)).not.toContain("t=");
    expect(buildReplayPath(view!, -5)).not.toContain("t=");
  });

  it("UUID를 못 찾은 세션은 리플레이를 열지 않는다", () => {
    const view = toSessionSummaryView(
      rawRow({
        match_id: "match.bro.official.pc-2018-01.steam.squad-fpp.as.2026.08.01",
        gep_summary: {
          ...rawRow().gep_summary,
          official_match_id: "match.bro.official.pc-2018-01.steam.squad-fpp.as.2026.08.01"
        }
      })
    );

    expect(view?.telemetryMatchId).toBeNull();
    expect(view?.canOpenReplay).toBe(false);
    expect(buildReplayPath(view!)).toBeNull();
    // 공식 match id 자체는 있으므로 전적 분석 링크는 유지된다.
    expect(view?.canOpenAnalysis).toBe(true);
    expect(buildAnalysisPath(view!)).toBe("/stats/steam/testplayer");
  });

  it("pseudo_match_id만 있으면 리플레이도 분석도 열지 않는다", () => {
    const view = toSessionSummaryView(
      rawRow({
        match_id: null,
        gep_summary: { ...rawRow().gep_summary, official_match_id: null }
      })
    );

    expect(view?.canOpenReplay).toBe(false);
    expect(view?.canOpenAnalysis).toBe(false);
    expect(buildReplayPath(view!)).toBeNull();
    expect(buildAnalysisPath(view!)).toBeNull();
  });

  it("닉네임이 없으면 리플레이를 열지 않는다", () => {
    const view = toSessionSummaryView(rawRow({ player_id: null }));

    expect(view?.telemetryMatchId).toBe("ce8d1a14-b2af-41c8-8bf4-d2a504326630");
    expect(view?.canOpenReplay).toBe(false);
    expect(buildReplayPath(view!)).toBeNull();
  });
});

describe("타임라인 payload 검증", () => {
  it("허용 kind만 남기고 좌표/데미지 키를 버린다", () => {
    const result = normalizeSessionPayload({
      session_id: "bgms-1",
      event_timeline: [
        { t: 10, kind: "kill" },
        { t: 20, kind: "killer", detail: "Enemy_01" },
        { t: 30, kind: "location" },
        { t: 40, kind: "kill", x: 100, y: 200 }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.event_timeline).toEqual([
      { t: 10, kind: "kill" },
      { t: 20, kind: "killer", detail: "Enemy_01" },
      { t: 40, kind: "kill" }
    ]);
    // 좌표 키가 정규화 결과에 남지 않는다.
    expect(JSON.stringify(result.value.event_timeline)).not.toContain("100");
  });

  it("비정상 경과 초는 null로 떨어뜨린다", () => {
    const result = normalizeSessionPayload({
      session_id: "bgms-2",
      event_timeline: [
        { t: -10, kind: "kill" },
        { t: 999999, kind: "death" },
        { t: "abc", kind: "revived" },
        { t: 12.6, kind: "knockedout" }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.event_timeline).toEqual([
      { t: null, kind: "kill" },
      { t: null, kind: "death" },
      { t: null, kind: "revived" },
      { t: 13, kind: "knockedout" }
    ]);
  });

  it("타임라인 항목 수를 상한으로 제한한다", () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({ t: index, kind: "kill" }));
    const result = normalizeSessionPayload({ session_id: "bgms-3", event_timeline: entries });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.event_timeline).toHaveLength(40);
  });

  it("배열이 아니면 빈 타임라인으로 처리한다", () => {
    ["not-array", 42, { kind: "kill" }, null].forEach((value) => {
      const result = normalizeSessionPayload({ session_id: "bgms-4", event_timeline: value });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.event_timeline).toEqual([]);
    });
  });

  it("확장된 요약 필드를 저장 대상으로 허용한다", () => {
    const result = normalizeSessionPayload({
      session_id: "bgms-5",
      gep_summary: {
        official_match_id: "match.bro.official.abc",
        map_name: "Miramar_Main",
        headshots: 3,
        max_kill_distance: 431.5,
        rank_place: 2,
        rank_total: 95,
        unknown_field: "drop-me"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.gep_summary.official_match_id).toBe("match.bro.official.abc");
    expect(result.value.gep_summary.map_name).toBe("Miramar_Main");
    expect(result.value.gep_summary.headshots).toBe(3);
    expect(result.value.gep_summary.max_kill_distance).toBe(431.5);
    expect(result.value.gep_summary.rank_place).toBe(2);
    expect(result.value.gep_summary.rank_total).toBe(95);
    expect(result.value.gep_summary.unknown_field).toBeUndefined();
  });

  it("타임라인에 금지 필드가 있으면 payload 전체를 거부한다", () => {
    const result = normalizeSessionPayload({
      session_id: "bgms-6",
      event_timeline: [{ t: 10, kind: "kill", damage_dealt: 39.1 }]
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("blocked_field");
  });
});

describe("세션 조회 라우트", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockCreateSupabaseAdminClient.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });

  function buildGet(query: string) {
    return new Request(`https://bgms.kr/api/overwolf/sessions?${query}`, { method: "GET" });
  }

  it("닉네임으로 세션 목록을 조회한다", async () => {
    mockRpc.mockResolvedValue({ data: [rawRow()], error: null });

    const response = await GET(buildGet("player=TestPlayer&platform=steam"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("list_overwolf_sessions", {
      p_player_id: "testplayer",
      p_platform: "steam",
      p_limit: 20
    });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].canOpenAnalysis).toBe(true);
  });

  it("닉네임이 짧으면 400을 반환한다", async () => {
    const response = await GET(buildGet("player=ab"));

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("조회 상한을 넘는 limit을 제한한다", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await GET(buildGet("player=TestPlayer&limit=9999"));

    expect(mockRpc).toHaveBeenCalledWith(
      "list_overwolf_sessions",
      expect.objectContaining({ p_limit: 50 })
    );
  });

  it("sessionId로 단일 세션을 조회한다", async () => {
    mockRpc.mockResolvedValue({ data: [rawRow()], error: null });

    const response = await GET(buildGet("sessionId=bgms-session-1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("get_overwolf_session", {
      p_session_id: "bgms-session-1"
    });
    expect(body.session.sessionId).toBe("bgms-session-1");
  });

  it("없는 세션은 404를 반환한다", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const response = await GET(buildGet("sessionId=missing"));

    expect(response.status).toBe(404);
  });

  it("응답에 내부 진단 필드를 노출하지 않는다", async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...rawRow(), source_host: "bgms.kr", is_internal: false }],
      error: null
    });

    const response = await GET(buildGet("player=TestPlayer"));
    const serialized = JSON.stringify(await response.json());

    expect(serialized).not.toContain("source_host");
    expect(serialized).not.toContain("is_internal");
  });

  it("설정이 없으면 503을 반환한다", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const response = await GET(buildGet("player=TestPlayer"));

    expect(response.status).toBe(503);
  });
});

describe("적재 라우트의 타임라인 전달", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockCreateSupabaseAdminClient.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });

  it("정규화된 타임라인을 RPC 인자로 넘긴다", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    const request = new Request("https://bgms.kr/api/overwolf/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "bgms.kr" },
      body: JSON.stringify({
        session_id: "bgms-timeline-1",
        match_id: "match.bro.official.abc",
        gep_summary: { kills: 2, headshots: 1, rank_place: 5 },
        event_timeline: [
          { t: 30, kind: "kill" },
          { t: 90, kind: "location" },
          { t: 120, kind: "death" }
        ]
      })
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      "record_overwolf_session_event",
      expect.objectContaining({
        p_event_timeline: [
          { t: 30, kind: "kill" },
          { t: 120, kind: "death" }
        ]
      })
    );
  });
});

describe("타임라인 마이그레이션 안전성", () => {
  it("event_timeline 컬럼을 기본값과 함께 추가한다", () => {
    expect(TIMELINE_MIGRATION).toContain("ADD COLUMN IF NOT EXISTS event_timeline jsonb");
    expect(TIMELINE_MIGRATION).toContain("DEFAULT '[]'::jsonb");
  });

  it("조회 함수의 EXECUTE 권한을 service_role로 제한한다", () => {
    for (const fn of [
      "public.list_overwolf_sessions(text, text, integer)",
      "public.get_overwolf_session(text)"
    ]) {
      expect(TIMELINE_MIGRATION).toContain(`REVOKE ALL ON FUNCTION ${fn}\n  FROM PUBLIC, anon, authenticated`);
      expect(TIMELINE_MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role`);
    }
  });

  it("조회 함수가 내부 진단 컬럼을 반환하지 않는다", () => {
    const listBody = TIMELINE_MIGRATION.slice(
      TIMELINE_MIGRATION.indexOf("FUNCTION public.list_overwolf_sessions"),
      TIMELINE_MIGRATION.indexOf("get_overwolf_session")
    );

    expect(listBody).not.toContain("e.source_host");
    expect(listBody).not.toContain("e.is_internal,");
    // 내부 트래픽은 목록에서 제외한다.
    expect(listBody).toContain("e.is_internal = false");
  });

  it("테이블 권한 회수를 유지한다", () => {
    expect(TIMELINE_MIGRATION).toContain(
      "REVOKE ALL ON TABLE public.overwolf_session_events FROM anon, authenticated"
    );
  });

  it("기존 운영 분석 테이블에 DML을 수행하지 않는다", () => {
    const statements = TIMELINE_MIGRATION.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    ["processed_match_telemetry", "match_stats_raw", "global_benchmarks"].forEach((table) => {
      ["INSERT INTO public." + table, "UPDATE public." + table, "DELETE FROM public." + table, "ALTER TABLE public." + table].forEach((dml) => {
        expect(statements).not.toContain(dml);
      });
    });
  });
});

describe("연속 플레이 단위 묶음", () => {
  function viewAt(iso: string, overrides: Record<string, unknown> = {}) {
    return toSessionSummaryView(
      rawRow({
        session_id: "s-" + iso,
        created_at: iso,
        gep_summary: { ...rawRow().gep_summary, ...overrides }
      })
    )!;
  }

  it("간격이 기준 안이면 한 묶음으로 본다", () => {
    // 최신순 입력 (조회 RPC 가 created_at DESC 로 반환한다)
    const views = [
      viewAt("2026-08-01T12:00:00Z"),
      viewAt("2026-08-01T11:30:00Z"),
      viewAt("2026-08-01T11:00:00Z")
    ];

    const groups = groupByPlaySession(views);

    expect(groups).toHaveLength(1);
    expect(groups[0].matchCount).toBe(3);
    expect(groups[0].startedAt).toBe("2026-08-01T11:00:00Z");
    expect(groups[0].endedAt).toBe("2026-08-01T12:00:00Z");
  });

  it("90분을 넘겨 쉬면 다른 묶음으로 끊는다", () => {
    const views = [
      viewAt("2026-08-01T20:00:00Z"),
      viewAt("2026-08-01T19:40:00Z"),
      // 여기서 4시간 공백
      viewAt("2026-08-01T15:00:00Z"),
      viewAt("2026-08-01T14:30:00Z")
    ];

    const groups = groupByPlaySession(views);

    expect(groups).toHaveLength(2);
    expect(groups[0].matchCount).toBe(2);
    expect(groups[1].matchCount).toBe(2);
    expect(groups[0].endedAt).toBe("2026-08-01T20:00:00Z");
    expect(groups[1].startedAt).toBe("2026-08-01T14:30:00Z");
  });

  it("묶음 안의 수치를 합산하고 순위를 요약한다", () => {
    const views = [
      viewAt("2026-08-01T12:00:00Z", { kills: 5, headshots: 3, deaths: 1, rank_place: 3 }),
      viewAt("2026-08-01T11:30:00Z", { kills: 2, headshots: 1, deaths: 1, rank_place: 17 })
    ];

    const groups = groupByPlaySession(views);

    expect(groups[0].kills).toBe(7);
    expect(groups[0].headshots).toBe(4);
    expect(groups[0].deaths).toBe(2);
    expect(groups[0].bestPlace).toBe(3);
    expect(groups[0].averagePlace).toBe(10);
  });

  it("순위를 받지 못한 매치만 있으면 순위 요약을 비운다", () => {
    const views = [viewAt("2026-08-01T12:00:00Z", { rank_place: null })];

    const groups = groupByPlaySession(views);

    expect(groups[0].bestPlace).toBeNull();
    expect(groups[0].averagePlace).toBeNull();
  });

  it("순위가 일부만 있으면 있는 것만 평균에 넣는다", () => {
    const views = [
      viewAt("2026-08-01T12:00:00Z", { rank_place: 4 }),
      viewAt("2026-08-01T11:30:00Z", { rank_place: null })
    ];

    const groups = groupByPlaySession(views);

    expect(groups[0].matchCount).toBe(2);
    expect(groups[0].bestPlace).toBe(4);
    expect(groups[0].averagePlace).toBe(4);
  });

  it("빈 입력은 빈 배열을 반환한다", () => {
    expect(groupByPlaySession([])).toEqual([]);
  });
});
