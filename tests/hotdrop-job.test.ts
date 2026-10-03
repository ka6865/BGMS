import { describe, expect, it, vi } from "vitest";
import {
  parseHotdropConfig,
  runHotdropCollection,
  type HotdropDependencies,
} from "../lib/hotdrop/runHotdropCollection";

const defaultConfig = parseHotdropConfig({});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function createSupabaseMock() {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const neq = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({
    delete: vi.fn(() => ({ neq })),
    upsert,
  }));
  return { adapter: { rpc, from }, rpc, from, neq, upsert };
}

function createSuccessfulFetchSequence(telemetryResponse: Response) {
  return vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      data: [{ id: "season-1", attributes: { isCurrentSeason: true } }],
    }))
    .mockResolvedValueOnce(jsonResponse({
      data: { relationships: { players: { data: [{ id: "account-1" }] } } },
    }))
    .mockResolvedValueOnce(jsonResponse({
      data: { relationships: { matches: { data: [{ id: "match-1" }] } } },
    }))
    .mockResolvedValueOnce(jsonResponse({
      data: { attributes: { mapName: "Baltic_Main" } },
      included: [{ type: "asset", attributes: { URL: "https://telemetry.test/1" } }],
    }))
    .mockResolvedValueOnce(telemetryResponse);
}

describe("Hotdrop 수집 작업", () => {
  it("현재 시즌이 없으면 DB 작업 전에 실패한다", async () => {
    const db = createSupabaseMock();
    const dependencies: HotdropDependencies = {
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ data: [] })),
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    };

    await expect(runHotdropCollection("pubg-key", defaultConfig, dependencies))
      .rejects.toThrow("현재 PUBG 시즌을 확인할 수 없습니다.");
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("PUBG 요청이 응답하지 않아도 제한 시간에 취소되어 DB 작업 전에 실패한다", async () => {
    const db = createSupabaseMock();
    const createTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => createTimeout(10));
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing request deadline"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    try {
      await expect(runHotdropCollection("pubg-key", defaultConfig, {
        fetchFn,
        supabase: db.adapter,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => "2026-10-04T00:00:00.000Z",
      })).rejects.toMatchObject({ name: "TimeoutError" });
      expect(timeout).toHaveBeenCalledWith(8_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(db.from).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    ["HOTDROP_MAX_RANKERS", "0"],
    ["HOTDROP_MAX_RANKERS", "21"],
    ["HOTDROP_MAX_MATCHES_PER_RUN", "NaN"],
    ["HOTDROP_RATE_LIMIT_MS", "6499"],
    ["HOTDROP_MAX_TELEMETRY_DECOMPRESSED_BYTES", "209715201"],
  ])("잘못된 설정 %s=%s을 거부한다", (key, value) => {
    expect(() => parseHotdropConfig({ [key]: value })).toThrow(key);
  });

  it("leaderboard 매치의 landing을 grid RPC payload로 저장한다", async () => {
    const db = createSupabaseMock();
    const fetchFn = createSuccessfulFetchSequence(jsonResponse([
      { _T: "LogParachuteLanding", character: { location: { x: 409600, y: 409600 } } },
    ]));

    const result = await runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn,
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      season: "season-1",
      source: "leaderboard",
      totalLandings: 1,
      processedMatches: 1,
      skippedMatches: 0,
    });
    expect(db.rpc).toHaveBeenCalledWith("upsert_hotdrop_counts", {
      rows: expect.stringContaining('"grid_x":128'),
    });
    expect(db.neq).toHaveBeenCalledWith("season", "season-1");
  });

  it.each([401, 403, 429].flatMap((status) => (
    ["leaderboard", "player", "match"].map((stage) => [status, stage] as const)
  )))("%s 응답이 %s 수집에서 나오면 후속 호출과 정상 완료를 막는다", async (status, stage) => {
    const db = createSupabaseMock();
    const fixtures = [
      { data: [{ id: "season-1", attributes: { isCurrentSeason: true } }] },
      { data: { relationships: { players: { data: [{ id: "account-1" }, { id: "account-2" }] } } } },
      { data: { relationships: { matches: { data: [{ id: "match-1" }, { id: "match-2" }] } } } },
    ];
    const failureIndex = stage === "leaderboard" ? 1 : stage === "player" ? 2 : 3;
    const fetchFn = vi.fn();
    for (const fixture of fixtures.slice(0, failureIndex)) {
      fetchFn.mockResolvedValueOnce(jsonResponse(fixture));
    }
    fetchFn.mockResolvedValue(jsonResponse({ error: "blocked" }, { status }));

    await expect(runHotdropCollection("pubg-key", {
      ...defaultConfig,
      maxRankers: stage === "player" ? 2 : 1,
    }, {
      fetchFn,
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-10-04T00:00:00.000Z",
    })).rejects.toThrow(`PUBG API error ${status}`);
    expect(fetchFn).toHaveBeenCalledTimes(failureIndex + 1);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("leaderboard 실패 시 samples 매치로 fallback한다", async () => {
    const db = createSupabaseMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "season-1", attributes: { isCurrentSeason: true } }],
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "leaderboard failed" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({
        data: { relationships: { matches: { data: [{ id: "sample-match-1" }] } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { attributes: { mapName: "Desert_Main" } },
        included: [{ type: "asset", attributes: { URL: "https://telemetry.test/sample" } }],
      }))
      .mockResolvedValueOnce(jsonResponse([
        { _T: "LogParachuteLanding", character: { location: { x: 100, y: 100 } } },
      ]));

    const result = await runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn,
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      source: "samples",
      processedMatches: 1,
      skippedMatches: 0,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/samples"),
      expect.any(Object),
    );
  });

  it("leaderboard player 조회가 모두 실패하면 samples로 fallback한다", async () => {
    const db = createSupabaseMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "season-1", attributes: { isCurrentSeason: true } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { relationships: { players: { data: [{ id: "account-1" }] } } },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "player failed" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({
        data: { relationships: { matches: { data: [] } } },
      }));

    const result = await runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn,
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({ source: "samples", processedMatches: 0 });
    expect(fetchFn).toHaveBeenLastCalledWith(
      expect.stringContaining("/samples"),
      expect.any(Object),
    );
  });

  it("leaderboard player에 유효한 match 관계가 없으면 samples로 fallback한다", async () => {
    const db = createSupabaseMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "season-1", attributes: { isCurrentSeason: true } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { relationships: { players: { data: [{ id: "account-1" }] } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { relationships: { matches: { data: [{ id: "   " }, {}] } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { relationships: { matches: { data: [] } } },
      }));

    const result = await runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn,
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({ source: "samples", processedMatches: 0 });
    expect(fetchFn).toHaveBeenLastCalledWith(
      expect.stringContaining("/samples"),
      expect.any(Object),
    );
  });

  it("Content-Length가 compressed 상한을 넘으면 body를 읽지 않고 매치를 건너뛴다", async () => {
    const db = createSupabaseMock();
    const telemetry = jsonResponse([], {
      headers: {
        "content-length": String(defaultConfig.maxTelemetryCompressedBytes + 1),
      },
    });
    const arrayBuffer = vi.spyOn(telemetry, "arrayBuffer");

    const result = await runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn: createSuccessfulFetchSequence(telemetry),
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({ processedMatches: 1, skippedMatches: 1 });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("Content-Length 없는 stream이 compressed 상한을 넘으면 즉시 취소한다", async () => {
    const db = createSupabaseMock();
    let pullCount = 0;
    const cancel = vi.fn();
    const telemetry = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        if (pullCount === 6) controller.close();
      },
      cancel,
    }, { highWaterMark: 0 }), { status: 200 });

    const result = await runHotdropCollection("pubg-key", {
      ...defaultConfig,
      maxTelemetryCompressedBytes: 10,
    }, {
      fetchFn: createSuccessfulFetchSequence(telemetry),
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({ processedMatches: 1, skippedMatches: 1 });
    expect(pullCount).toBe(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("gzip 해제 결과가 decompressed 상한을 넘으면 매치를 건너뛴다", async () => {
    const { gzipSync } = await import("node:zlib");
    const db = createSupabaseMock();
    const oversizedEvents = [{
      _T: "IgnoredEvent",
      payload: "x".repeat(1024 * 1024 + 1),
    }];
    const telemetry = new Response(gzipSync(JSON.stringify(oversizedEvents)), {
      status: 200,
    });

    const result = await runHotdropCollection("pubg-key", {
      ...defaultConfig,
      maxTelemetryDecompressedBytes: 1024 * 1024,
    }, {
      fetchFn: createSuccessfulFetchSequence(telemetry),
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result.skippedMatches).toBe(1);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("RPC와 fallback upsert가 모두 실패하면 작업을 실패시킨다", async () => {
    const db = createSupabaseMock();
    db.rpc.mockResolvedValue({ error: { message: "rpc failed" } });
    db.upsert.mockResolvedValue({ error: { message: "row failed" } });
    const telemetry = jsonResponse([
      { _T: "LogParachuteLanding", character: { location: { x: 100, y: 100 } } },
    ]);

    await expect(runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn: createSuccessfulFetchSequence(telemetry),
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    })).rejects.toThrow("hotdrop-fallback-upsert-failed");
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });

  it("시즌 정리 실패를 성공으로 숨기지 않는다", async () => {
    const db = createSupabaseMock();
    db.neq.mockResolvedValue({ error: { message: "cleanup failed" } });
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [{ id: "season-1", attributes: { isCurrentSeason: true } }],
    }));

    await expect(runHotdropCollection("pubg-key", defaultConfig, {
      fetchFn,
      supabase: db.adapter,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-07-15T00:00:00.000Z",
    })).rejects.toThrow("hotdrop-season-cleanup-failed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
