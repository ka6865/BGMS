// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchTelemetryPayloadMock } = vi.hoisted(() => ({
  fetchTelemetryPayloadMock: vi.fn(),
}));

vi.mock("../lib/pubg-analysis/fetchTelemetryPayload", () => ({
  fetchTelemetryPayload: fetchTelemetryPayloadMock,
}));

import { useTelemetry } from "../hooks/useTelemetry";
import type { TelemetryMode, TelemetryPlatform } from "../lib/pubg-analysis/telemetryIdentity";

const useTelemetryWithMode = useTelemetry as unknown as (
  matchId: string | null,
  nickname: string | null,
  platform: TelemetryPlatform | null,
  mode: TelemetryMode | null,
  mapName: string,
) => ReturnType<typeof useTelemetry>;

function telemetryPayload(matchId: string, eventName: string) {
  return {
    identity: {
      matchId,
      platform: "steam" as const,
      playerKey: "a".repeat(32),
      mode: "lite" as const,
      telemetryVersion: 60,
    },
    startTime: "2026-07-18T00:00:00.000Z",
    teammates: ["b".repeat(32)],
    teamNames: [eventName],
    events: [{
      type: "position",
      time: "2026-07-18T00:00:00.000Z",
      name: eventName,
      x: 100,
      y: 200,
      relativeTimeMs: 100,
    }],
    zoneEvents: [{ relativeTimeMs: 0 }],
    mapName: "Baltic_Main",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useTelemetry identity 전환", () => {
  beforeEach(() => {
    fetchTelemetryPayloadMock.mockReset();
  });

  it("platform이 누락되면 이전 events·team·zone·timeline을 즉시 비운다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue(telemetryPayload("match-1", "OldPlayer"));
    const { result, rerender } = renderHook(
      ({ platform }: { platform: "steam" | null }) =>
        useTelemetry("match-1", "OldPlayer", platform, "lite", "erangel"),
      { initialProps: { platform: "steam" as "steam" | null } },
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => result.current.setCurrentTimeMs(500));

    rerender({ platform: null });

    expect(result.current.events).toEqual([]);
    expect(result.current.teammates).toEqual([]);
    expect(result.current.teamNames).toEqual([]);
    expect(result.current.zoneEvents).toEqual([]);
    expect(result.current.currentTimeMs).toBe(0);
    expect(result.current.maxTimeMs).toBe(0);
  });

  it("새 identity 요청이 실패해도 이전 성공 궤적을 복원하지 않는다", async () => {
    fetchTelemetryPayloadMock
      .mockResolvedValueOnce(telemetryPayload("match-1", "OldPlayer"))
      .mockRejectedValueOnce(new Error("텔레메트리 요청에 실패했습니다."));
    const { result, rerender } = renderHook(
      ({ matchId }) => useTelemetry(matchId, "Player", "steam", "lite", "erangel"),
      { initialProps: { matchId: "match-1" } },
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    rerender({ matchId: "match-2" });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.events).toEqual([]);
    expect(result.current.teamNames).toEqual([]);
    expect(result.current.zoneEvents).toEqual([]);
    expect(result.current.maxTimeMs).toBe(0);
  });

  it("중단된 이전 identity 응답이 새 identity 상태를 덮어쓰지 못한다", async () => {
    const oldRequest = deferred<ReturnType<typeof telemetryPayload>>();
    const newRequest = deferred<ReturnType<typeof telemetryPayload>>();
    fetchTelemetryPayloadMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const { result, rerender } = renderHook(
      ({ matchId }) => useTelemetry(matchId, "Player", "steam", "lite", "erangel"),
      { initialProps: { matchId: "match-1" } },
    );

    await waitFor(() => expect(fetchTelemetryPayloadMock).toHaveBeenCalledTimes(1));
    const oldSignal = fetchTelemetryPayloadMock.mock.calls[0][1].signal as AbortSignal;
    rerender({ matchId: "match-2" });
    await waitFor(() => expect(fetchTelemetryPayloadMock).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);

    await act(async () => newRequest.resolve(telemetryPayload("match-2", "NewPlayer")));
    await waitFor(() => expect(result.current.teamNames).toEqual(["NewPlayer"]));
    await act(async () => oldRequest.resolve(telemetryPayload("match-1", "OldPlayer")));

    expect(result.current.teamNames).toEqual(["NewPlayer"]);
    expect(result.current.events[0]?.name).toBe("NewPlayer");
  });

  it("같은 컴포넌트에서 mode가 바뀌면 이전 요청을 중단하고 새 identity를 요청한다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue(telemetryPayload("match-1", "Player"));
    const { rerender } = renderHook(
      ({ mode }: { mode: TelemetryMode }) =>
        useTelemetryWithMode("match-1", "Player", "steam", mode, "erangel"),
      { initialProps: { mode: "lite" as TelemetryMode } },
    );

    await waitFor(() => expect(fetchTelemetryPayloadMock).toHaveBeenCalledTimes(1));
    const firstSignal = fetchTelemetryPayloadMock.mock.calls[0][1].signal as AbortSignal;
    expect(fetchTelemetryPayloadMock.mock.calls[0][0]).toMatchObject({ mode: "lite" });

    rerender({ mode: "full" });

    await waitFor(() => expect(fetchTelemetryPayloadMock).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(fetchTelemetryPayloadMock.mock.calls[1][0]).toMatchObject({ mode: "full" });
  });
});

describe("useTelemetry 팀 식별", () => {
  beforeEach(() => {
    fetchTelemetryPayloadMock.mockReset();
  });

  it("적 공격자가 우리 팀원을 공격한 combat 이벤트의 teamId로 우리 스쿼드에 합류하지 않는다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue({
      identity: {
        matchId: "match-1",
        platform: "steam",
        playerKey: "a".repeat(32),
        mode: "lite",
        telemetryVersion: 60,
      },
      startTime: "2026-07-18T00:00:00.000Z",
      teammates: ["b".repeat(32), "c".repeat(32), "d".repeat(32)],
      teamNames: ["Me", "MateOne", "MateTwo", "MateThree"],
      events: [{
        type: "groggy",
        time: "2026-07-18T00:01:00.000Z",
        attacker: "EnemyOne",
        victim: "MateOne",
        teamId: 999,
        isTeamAttacker: false,
        isTeamVictim: true,
        x: 100,
        y: 200,
        relativeTimeMs: 1000,
      }],
      zoneEvents: [],
      mapName: "Desert_Main",
    });

    const { result } = renderHook(() => useTelemetry("match-1", "Me", "steam", "lite", "miramar"));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => result.current.setCurrentTimeMs(1000));

    await waitFor(() => expect(result.current.currentStates.enemyone).toBeDefined());
    expect(result.current.currentStates.enemyone.teamId).not.toBe(999);
    expect(result.current.currentStates.mateone.teamId).toBe(999);
  });
});
