import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  cleanupAnalyticsTables,
  runAnalyticsCleanup,
  ANALYTICS_EVENT_RETENTION_DAYS,
  ANALYTICS_RATE_LIMIT_RETENTION_DAYS,
  ANALYTICS_EVENT_BATCH_LIMIT,
  ANALYTICS_EVENT_MAX_BATCHES,
} from "../scripts/cleanup_analytics_events";

// js-yaml 은 타입 선언이 없어 기존 워크플로 테스트와 동일한 방식으로 로드한다.
const loadYaml = (createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
}).load;

type RpcCall = [string, Record<string, unknown> | undefined];

function makeClient(eventDeletions: number[], rateLimitDeleted = 3) {
  const calls: RpcCall[] = [];
  let eventIndex = 0;
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === "cleanup_analytics_events") {
      const value = eventDeletions[eventIndex] ?? 0;
      eventIndex += 1;
      return { data: value, error: null };
    }
    if (name === "cleanup_analytics_event_rate_limits") {
      return { data: rateLimitDeleted, error: null };
    }
    return { data: null, error: null };
  });
  return { client: { rpc } as never, calls, rpc };
}

describe("analytics 정리: 보존 기간 기반 삭제", () => {
  it("보존 기간과 배치 한도를 RPC 인자로 전달한다", async () => {
    const { client, calls } = makeClient([10]);
    await cleanupAnalyticsTables(client);

    expect(calls[0]).toEqual([
      "cleanup_analytics_events",
      {
        p_retention_days: ANALYTICS_EVENT_RETENTION_DAYS,
        p_batch_limit: ANALYTICS_EVENT_BATCH_LIMIT,
      },
    ]);
    expect(calls.at(-1)).toEqual([
      "cleanup_analytics_event_rate_limits",
      { p_retention_days: ANALYTICS_RATE_LIMIT_RETENTION_DAYS },
    ]);
  });

  it("삭제 행이 배치 한도보다 적으면 반복을 중단한다", async () => {
    const { client, calls } = makeClient([120]);
    const result = await cleanupAnalyticsTables(client);

    const eventCalls = calls.filter(([name]) => name === "cleanup_analytics_events");
    expect(eventCalls).toHaveLength(1);
    expect(result.deletedEventRows).toBe(120);
    expect(result.hasRemaining).toBe(false);
  });

  it("배치가 가득 차면 다음 배치를 이어서 처리한다", async () => {
    const { client, calls } = makeClient([
      ANALYTICS_EVENT_BATCH_LIMIT,
      ANALYTICS_EVENT_BATCH_LIMIT,
      42,
    ]);
    const result = await cleanupAnalyticsTables(client);

    const eventCalls = calls.filter(([name]) => name === "cleanup_analytics_events");
    expect(eventCalls).toHaveLength(3);
    expect(result.deletedEventRows).toBe(ANALYTICS_EVENT_BATCH_LIMIT * 2 + 42);
    expect(result.hasRemaining).toBe(false);
  });

  it("최대 배치 수를 초과하지 않고 backlog 를 보고한다", async () => {
    const alwaysFull = Array.from(
      { length: ANALYTICS_EVENT_MAX_BATCHES + 5 },
      () => ANALYTICS_EVENT_BATCH_LIMIT,
    );
    const { client, calls } = makeClient(alwaysFull);
    const result = await cleanupAnalyticsTables(client);

    const eventCalls = calls.filter(([name]) => name === "cleanup_analytics_events");
    expect(eventCalls).toHaveLength(ANALYTICS_EVENT_MAX_BATCHES);
    expect(result.hasRemaining).toBe(true);
  });

  it("rate limit 삭제 행 수를 결과에 담는다", async () => {
    const { client } = makeClient([0], 7);
    const result = await cleanupAnalyticsTables(client);
    expect(result.deletedRateLimitRows).toBe(7);
  });

  it("RPC 오류는 원인을 담아 예외로 전달한다", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    await expect(cleanupAnalyticsTables({ rpc } as never)).rejects.toThrow(
      "cleanup_analytics_events 실패: permission denied",
    );
  });

  it("자격 증명이 없으면 실행하지 않는다", async () => {
    await expect(runAnalyticsCleanup({})).rejects.toThrow("analytics-cleanup-credentials-missing");
  });

  it("보존 기간이 안전한 하한을 지킨다", () => {
    // 지나치게 짧은 보존은 분석 자체를 불가능하게 만든다.
    expect(ANALYTICS_EVENT_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
    expect(ANALYTICS_RATE_LIMIT_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });
});

describe("analytics 정리: 일일 유지보수 워크플로 연결", () => {
  const workflow = loadYaml(
    readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] }> };

  const steps = workflow.jobs.maintenance.steps ?? [];
  const cleanupStep = steps.find((step) => step.run === "npx tsx scripts/cleanup_analytics_events.ts");

  it("정리 step 이 한 번만 등록되어 있다", () => {
    const matches = steps.filter((step) => step.run === "npx tsx scripts/cleanup_analytics_events.ts");
    expect(matches).toHaveLength(1);
    expect(cleanupStep?.name).toBe("Run Analytics Events Cleanup");
  });

  it("앞 step 실패와 무관하게 실행된다", () => {
    expect(cleanupStep?.if).toContain("steps.install.outcome == 'success'");
  });

  it("service role 자격 증명만 사용한다", () => {
    expect(cleanupStep?.env).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
      SUPABASE_SERVICE_ROLE_KEY: "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
    });
  });

  it("maintenance 마지막 step 순서를 바꾸지 않는다", () => {
    expect(steps.at(-1)?.name).toBe("Run Hotdrop Collection");
  });
});
