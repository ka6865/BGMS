import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_ROUTE_REASON_MAX_LENGTH,
  AI_ROUTE_TIMING_KIND,
  createAiRouteTimer,
  formatAiRouteReasons,
} from "@/lib/pubg-analysis/aiRouteTiming";
import { AI_GENERATION_DISABLED_ERROR_CODE, isAiGenerationDisabled } from "@/lib/pubg-analysis/aiGenerationSwitch";

function fakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

describe("ai route timing log", () => {
  it("emits one structured line with the contract keys and no request identity beyond requestId", () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const timer = createAiRouteTimer({
      route: "summary",
      requestId: "req-1",
      startedAt: clock.now(),
      now: clock.now,
      log: (line) => lines.push(line),
    });
    timer.stage("auth", 3);
    timer.setStage("cacheLookup", { ms: 4, result: "miss" });
    timer.setStage("persist", { ms: 5, status: "failed" });
    timer.attempt({ model: "gemini-3.5-flash-lite", outcome: "first_part_timeout", ms: 8000 });
    timer.attempt({ model: "gemini-3.1-flash-lite", outcome: "ok", ms: 900 });
    clock.advance(1234);

    const record = timer.emit({ outcome: "success", reasons: ["a:prose", "a:prose", "b:conclusion"] });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(record);
    expect(parsed).toMatchObject({
      kind: AI_ROUTE_TIMING_KIND,
      route: "summary",
      requestId: "req-1",
      outcome: "success",
      reasons: "a:prose,b:conclusion",
      stages: {
        auth: 3,
        cacheLookup: { ms: 4, result: "miss" },
        persist: { ms: 5, status: "failed" },
        total: 1234,
      },
      attempts: [
        { model: "gemini-3.5-flash-lite", outcome: "first_part_timeout", ms: 8000 },
        { model: "gemini-3.1-flash-lite", outcome: "ok", ms: 900 },
      ],
    });
    expect(Object.keys(parsed).sort()).toEqual(["attempts", "kind", "outcome", "reasons", "requestId", "route", "stages"]);
  });

  it("emits at most once per request and ignores later emits", () => {
    const lines: string[] = [];
    const timer = createAiRouteTimer({ route: "analyze", requestId: "req-2", startedAt: 0, now: () => 10, log: (line) => lines.push(line) });
    expect(timer.emit({ outcome: "error" })).not.toBeNull();
    expect(timer.emit({ outcome: "success" })).toBeNull();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ outcome: "error" });
  });

  it("re-labels the last attempt when the outcome is only known after the first part", () => {
    const timer = createAiRouteTimer({ route: "summary", requestId: "req-3", startedAt: 0, now: () => 0, log: () => undefined });
    timer.attempt({ model: "gemini-3.5-flash-lite", outcome: "ok", ms: 120 });
    timer.settleLastAttempt("stream_deadline");
    expect(timer.describeAttempts()).toBe("gemini-3.5-flash-lite=stream_deadline");
  });

  it("describes attempts as model and outcome pairs only, and empty when no attempt ran", () => {
    const timer = createAiRouteTimer({ route: "summary", requestId: "req-4", startedAt: 0, now: () => 0, log: () => undefined });
    expect(timer.describeAttempts()).toBe("");
    timer.attempt({ model: "gemini-3.5-flash-lite", outcome: "first_part_timeout", ms: 1 });
    timer.attempt({ model: "gemini-3.1-flash-lite", outcome: "rate_limited", ms: 2 });
    expect(timer.describeAttempts()).toBe("gemini-3.5-flash-lite=first_part_timeout,gemini-3.1-flash-lite=rate_limited");
  });

  it("caps and de-duplicates reason strings for logs and error_message", () => {
    expect(formatAiRouteReasons(["x:prose", "x:prose", "y:conclusion"])).toBe("x:prose,y:conclusion");
    const long = Array.from({ length: 200 }, (_, index) => `topic${index}:prose:kind:inference:id`);
    expect(formatAiRouteReasons(long).length).toBe(AI_ROUTE_REASON_MAX_LENGTH);
  });

  it("keeps the summary route wired to every contract stage", () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/pubg/ai-summary/route.ts"), "utf8");
    expect(source).toContain('createAiRouteTimer({ route: "summary", requestId, startedAt })');
    for (const stage of ["auth", "privateGuard", "processedLookup", "canonicalFallback", "benchmark", "promptBuild", "cacheLookup", "geminiFirstPart", "geminiTotal", "persist"]) {
      expect(source).toMatch(new RegExp(`timing\\.(?:stage|setStage)\\("${stage}"`));
    }
    expect(source).toContain('timingOutcome: "first_part_timeout"');
    expect(source).toContain('`stream_deadline: ${selectedModelName || "unselected"}`');
    expect(source).toContain('console.error("[AI-SUMMARY] Failed to write cache to DB:"');
  });
});

describe("AI generation switch", () => {
  it("is on only for the exact string true", () => {
    expect(isAiGenerationDisabled({ PUBG_AI_GENERATION_DISABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", " true"]) {
      expect(isAiGenerationDisabled({ PUBG_AI_GENERATION_DISABLED: value })).toBe(false);
    }
    expect(isAiGenerationDisabled({})).toBe(false);
    expect(AI_GENERATION_DISABLED_ERROR_CODE).toBe("PUBG_AI_GENERATION_DISABLED");
  });
});
