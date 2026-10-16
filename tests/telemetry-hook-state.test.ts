// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchTelemetryPayloadMock, TelemetryFetchErrorMock } = vi.hoisted(() => ({
  fetchTelemetryPayloadMock: vi.fn(),
  TelemetryFetchErrorMock: class TelemetryFetchErrorMock extends Error {
    status: number;
    errorCode: string | null;
    retryable: boolean;
    constructor(message: string, details: { status?: number; errorCode?: string | null; retryable?: boolean } = {}) {
      super(message);
      this.status = details.status ?? 0;
      this.errorCode = details.errorCode ?? null;
      this.retryable = details.retryable === true;
    }
  },
}));

vi.mock("../lib/pubg-analysis/fetchTelemetryPayload", () => ({
  fetchTelemetryPayload: fetchTelemetryPayloadMock,
  TelemetryFetchError: TelemetryFetchErrorMock,
}));

import { useTelemetry } from "../hooks/useTelemetry";
import type { TelemetryMode, TelemetryPlatform } from "../lib/pubg-analysis/telemetryIdentity";
import { TelemetryFetchError } from "../lib/pubg-analysis/fetchTelemetryPayload";

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

  it("14일 초과가 요약에서 확인되면 리플레이 요청 없이 만료 상태가 된다", async () => {
    const { result } = renderHook(() => useTelemetry(
      "match-old", "Player", "steam", "lite", "erangel", null, undefined, "2026-07-20T00:00:00.000Z",
    ));

    await waitFor(() => expect(result.current.errorKind).toBe("expired"));
    expect(result.current.errorCode).toBe("PUBG_MATCH_DETAIL_EXPIRED");
    expect(fetchTelemetryPayloadMock).not.toHaveBeenCalled();
    expect(result.current.events).toEqual([]);
  });

  it("매치 날짜가 없으면 통신 실패와 구분하고 서버의 명시적 410 만료 코드를 보존한다", async () => {
    fetchTelemetryPayloadMock.mockRejectedValue(new TelemetryFetchError("기간 만료", {
      status: 410,
      errorCode: "PUBG_MATCH_DETAIL_EXPIRED",
      retryable: false,
    }));
    const { result } = renderHook(() => useTelemetry("match-unknown", "Player", "steam", "lite", "erangel"));

    await waitFor(() => expect(result.current.errorKind).toBe("expired"));
    expect(result.current.errorCode).toBe("PUBG_MATCH_DETAIL_EXPIRED");
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

describe("useTelemetry 재생 상태 보간", () => {
  beforeEach(() => {
    fetchTelemetryPayloadMock.mockReset();
  });

  function positionAt(relativeTimeMs: number, x: number, health: number) {
    return {
      type: "position",
      time: "2026-07-18T00:00:00.000Z",
      name: "Me",
      x,
      y: 200,
      health,
      relativeTimeMs,
    };
  }

  it("위치는 보간하고 체력은 다음 관측 전까지 마지막 관측값을 유지한다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue({
      ...telemetryPayload("match-1", "Me"),
      events: [positionAt(0, 100, 100), positionAt(10_000, 300, 40)],
    });

    const { result } = renderHook(() => useTelemetry("match-1", "Me", "steam", "lite", "miramar"));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    act(() => result.current.setCurrentTimeMs(5_000));

    await waitFor(() => expect(result.current.currentStates.me?.x).toBe(200));
    expect(result.current.currentStates.me.health).toBe(100);
  });

  it("다음 관측 체력이 0이어도 100으로 바꿔 보간하지 않는다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue({
      ...telemetryPayload("match-1", "Me"),
      events: [positionAt(0, 100, 20), positionAt(10_000, 300, 0)],
    });

    const { result } = renderHook(() => useTelemetry("match-1", "Me", "steam", "lite", "miramar"));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    act(() => result.current.setCurrentTimeMs(5_000));

    await waitFor(() => expect(result.current.currentStates.me?.x).toBe(200));
    expect(result.current.currentStates.me.health).toBe(20);
  });
});

describe("useTelemetry 긴 좌표 공백", () => {
  beforeEach(() => {
    fetchTelemetryPayloadMock.mockReset();
  });

  it("재배치처럼 긴 공백 사이는 보간하지 않고 마지막 위치를 유지한다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue({
      ...telemetryPayload("match-1", "Me"),
      events: [
        { type: "position", time: "2026-07-18T00:00:00.000Z", name: "Me", x: 100, y: 200, health: 100, relativeTimeMs: 0 },
        { type: "position", time: "2026-07-18T00:07:00.000Z", name: "Me", x: 7000, y: 200, health: 100, relativeTimeMs: 420_000 },
      ],
    });

    const { result } = renderHook(() => useTelemetry("match-1", "Me", "steam", "lite", "miramar"));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    act(() => result.current.setCurrentTimeMs(210_000));

    await waitFor(() => expect(result.current.currentStates.me).toBeDefined());
    expect(result.current.currentStates.me.x).toBe(100);
  });
});

describe("useTelemetry 재생 루프", () => {
  let frames: FrameRequestCallback[] = [];
  let now = 1_000_000;

  beforeEach(() => {
    fetchTelemetryPayloadMock.mockReset();
    frames = [];
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function runFrame(elapsedMs: number) {
    now += elapsedMs;
    const pending = frames;
    frames = [];
    act(() => pending.forEach((callback) => callback(now)));
  }

  it("매 프레임 playheadRef만 진행하고 React 시간은 250ms 간격과 정지 시점에만 반영한다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue({
      ...telemetryPayload("match-1", "Me"),
      events: [
        { type: "position", time: "2026-07-18T00:00:00.000Z", name: "Me", x: 100, y: 200, health: 100, relativeTimeMs: 0 },
        { type: "position", time: "2026-07-18T00:01:00.000Z", name: "Me", x: 700, y: 200, health: 100, relativeTimeMs: 60_000 },
      ],
    });

    const { result } = renderHook(() => useTelemetry("match-1", "Me", "steam", "lite", "miramar"));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    act(() => result.current.setIsPlaying(true));
    runFrame(100);
    const committed = result.current.currentTimeMs;
    expect(committed).toBe(100);

    runFrame(100);
    runFrame(100);
    expect(result.current.playheadRef.current.timeMs).toBe(300);
    expect(result.current.currentTimeMs).toBe(committed);
    expect(result.current.playheadRef.current.states.me.x).toBe(103);

    runFrame(100);
    expect(result.current.currentTimeMs).toBe(400);

    runFrame(50);
    act(() => result.current.setIsPlaying(false));
    expect(result.current.currentTimeMs).toBe(450);
    expect(result.current.currentStates.me.x).toBe(104.5);
  });

  it("탐색하면 playheadRef와 React 시간을 함께 옮긴다", async () => {
    fetchTelemetryPayloadMock.mockResolvedValue({
      ...telemetryPayload("match-1", "Me"),
      events: [
        { type: "position", time: "2026-07-18T00:00:00.000Z", name: "Me", x: 100, y: 200, health: 100, relativeTimeMs: 0 },
        { type: "position", time: "2026-07-18T00:01:00.000Z", name: "Me", x: 700, y: 200, health: 100, relativeTimeMs: 60_000 },
      ],
    });

    const { result } = renderHook(() => useTelemetry("match-1", "Me", "steam", "lite", "miramar"));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    act(() => result.current.setCurrentTimeMs(30_000));
    expect(result.current.currentTimeMs).toBe(30_000);
    expect(result.current.playheadRef.current.timeMs).toBe(30_000);
    expect(result.current.playheadRef.current.states.me.x).toBe(400);
  });
});
