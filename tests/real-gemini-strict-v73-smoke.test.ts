import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRedactedStrictSmokeReport,
  hashMatchFingerprint,
  loadStrictSmokeRows,
  runStrictGeminiV73Smoke,
  type StrictSmokeGeminiResult,
  type StrictSmokeRow,
} from "../scripts/real_gemini_strict_v73_smoke";
import { RESULT_VERSION } from "../lib/pubg-analysis/constants";

function fullResult(
  matchId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    matchId,
    player_id: "kangheesung_",
    platform: "steam",
    v: RESULT_VERSION,
    createdAt: "2026-08-30T00:00:00.000Z",
    matchType: "official",
    gameMode: "squad",
    mapName: "Erangel_Main",
    stats: {
      name: "kangheesung_",
      winPlace: 3,
      kills: 2,
      assists: 1,
      DBNOs: 2,
      processedDamageDealt: 420,
      timeSurvived: 900,
    },
    benchmark: { score: 50 },
    ...overrides,
  };
}

function row(
  matchId: string,
  overrides: Partial<StrictSmokeRow> = {},
): StrictSmokeRow {
  return {
    match_id: matchId,
    player_id: "kangheesung_",
    platform: "steam",
    updated_at: "2026-08-30T00:00:00.000Z",
    data: { fullResult: fullResult(matchId) },
    ...overrides,
  };
}

const providerResult: StrictSmokeGeminiResult = {
  text: JSON.stringify({
    coach: "매운맛 분석가",
    signature: "교전 주도자",
    signatureSub: "피해량과 교전 데이터를 바탕으로 한 칭호입니다.",
    briefFeedback: ["첫 번째 피드백", "두 번째 피드백", "세 번째 피드백"],
    finalVerdict: "수치 기반으로 다음 교전을 준비하세요.",
    actionItems: [{ icon: "🎯", title: "목표", desc: "다음 경기에서 반복하세요." }],
  }),
};

describe("strict v73 real-user Gemini smoke", () => {
  it("uses one SELECT-only processed telemetry boundary with a 25-row headroom", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    await expect(loadStrictSmokeRows(supabase)).resolves.toEqual([]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith("processed_match_telemetry");
    expect(query.select).toHaveBeenCalledWith("match_id,player_id,platform,data,updated_at,created_at");
    expect(query.eq).toHaveBeenNthCalledWith(1, "player_id", "kangheesung_");
    expect(query.eq).toHaveBeenNthCalledWith(2, "platform", "steam");
    expect(query.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(25);
  });

  it("rejects stale, mismatched, and missing embedded identities before selection", async () => {
    const rows: StrictSmokeRow[] = [
      row("current-good"),
      row("stale", { data: { fullResult: fullResult("stale", { v: RESULT_VERSION - 1 }) } }),
      row("mismatched", { data: { fullResult: fullResult("other") } }),
      row("missing-identity", { data: { fullResult: fullResult("missing-identity", { matchId: undefined }) } }),
    ];
    const generate = vi.fn().mockResolvedValue(providerResult);

    const result = await runStrictGeminiV73Smoke({
      rows,
      generate,
      now: () => "2026-08-30T12:00:00.000Z",
    });

    expect(result.acceptedCurrentRowCount).toBe(1);
    expect(result.latestCount).toBe(1);
    expect(result.bestCount).toBe(1);
    expect(result.report.pass).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-3.5-flash-lite" }));
  });

  it("selects latest ten first, then deterministic best five only from that population", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => {
      const matchId = `match-${String(index + 1).padStart(2, "0")}`;
      return row(matchId, {
        updated_at: `2026-08-${String(30 - index).padStart(2, "0")}T00:00:00.000Z`,
        data: {
          fullResult: fullResult(matchId, {
            createdAt: `2026-08-${String(30 - index).padStart(2, "0")}T00:00:00.000Z`,
            benchmark: { score: index === 11 ? 1000 : 10 + index },
          }),
        },
      });
    });
    const generate = vi.fn().mockResolvedValue(providerResult);

    const result = await runStrictGeminiV73Smoke({ rows, generate });

    expect(result.latestCount).toBe(10);
    expect(result.bestCount).toBe(5);
    expect(result.latestMatchFingerprints).toHaveLength(10);
    expect(result.bestMatchFingerprints).toHaveLength(5);
    expect(result.bestMatchFingerprints).not.toContain(result.matchFingerprint("match-12"));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one provider attempt and never retries a provider failure", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("provider failed"));

    await expect(runStrictGeminiV73Smoke({ rows: [row("only")], generate }))
      .rejects.toThrow("provider failed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("redacts sensitive-looking extra JSON keys from the report and disk", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "strict-v73-json-keys-"));
    const output = path.join(tempRoot, "report.json");
    const parsedResponse = {
      ...JSON.parse(providerResult.text),
      kangheesung_: "sensitive-value",
    };
    const generate = vi.fn().mockResolvedValue({ text: JSON.stringify(parsedResponse) });

    try {
      const result = await runStrictGeminiV73Smoke({
        rows: [row("sensitive-key")],
        generate,
        output,
      });
      const onDisk = await readFile(output, "utf8");

      expect(result.report.jsonKeys).not.toContain("kangheesung_");
      expect(result.report.jsonKeys).toEqual([
        "actionItems",
        "briefFeedback",
        "coach",
        "finalVerdict",
        "signature",
        "signatureSub",
      ]);
      expect(onDisk).not.toContain("kangheesung_");
      expect(onDisk).not.toContain("sensitive-value");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds a pending provider call, aborts its signal, and writes one-attempt failure", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "strict-v73-timeout-"));
    const output = path.join(tempRoot, "report.json");
    const seenSignals: AbortSignal[] = [];
    const generate = vi.fn(({ signal }: { signal: AbortSignal }) => {
      seenSignals.push(signal);
      return new Promise<StrictSmokeGeminiResult>(() => undefined);
    });
    const startedAt = Date.now();

    try {
      await expect(runStrictGeminiV73Smoke({
        rows: [row("timeout")],
        generate,
        timeoutMs: 20,
        output,
      })).rejects.toMatchObject({ code: "provider_timeout" });

      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]?.aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(generate).toHaveBeenCalledTimes(1);

      const report = JSON.parse(await readFile(output, "utf8"));
      expect(report).toMatchObject({
        pass: false,
        failureCode: "provider_timeout",
        geminiCallsAttempted: 1,
        remoteDatabaseWritesAttempted: 0,
        r2WritesAttempted: 0,
        cacheWritesAttempted: 0,
        usageLogWritesAttempted: 0,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a redacted report with zero remote writes and no plaintext identity", () => {
    const report = buildRedactedStrictSmokeReport({
      timestamp: "2026-08-30T12:00:00.000Z",
      model: "gemini-3.5-flash-lite",
      acceptedCurrentRowCount: 2,
      latestCount: 2,
      bestCount: 2,
      latestMatchFingerprints: ["match-a", "match-b"],
      bestMatchFingerprints: ["match-a"],
      chosenMatchFingerprint: "match-a",
      resultVersion: RESULT_VERSION,
      jsonKeys: ["coach", "signature"],
      qualitySignalNames: ["hasRawMilliseconds"],
      pass: true,
      geminiCallsAttempted: 1,
    });

    expect(report).toMatchObject({
      timestamp: "2026-08-30T12:00:00.000Z",
      model: "gemini-3.5-flash-lite",
      acceptedCurrentRowCount: 2,
      latestCount: 2,
      bestCount: 2,
      resultVersion: RESULT_VERSION,
      remoteDatabaseWritesAttempted: 0,
      r2WritesAttempted: 0,
      cacheWritesAttempted: 0,
      usageLogWritesAttempted: 0,
      geminiCallsAttempted: 1,
      pass: true,
    });
    expect(JSON.stringify(report)).not.toContain("kangheesung_");
    expect(JSON.stringify(report)).not.toContain("match-");
    expect(JSON.stringify(report)).not.toContain("https://");
    expect(report.latestMatchFingerprints).toEqual([
      hashMatchFingerprint("match-a"),
      hashMatchFingerprint("match-b"),
    ]);
  });
});
