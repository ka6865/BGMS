// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLatestTelemetryRequest } from "../hooks/useLatestTelemetryRequest";
import type { TelemetryRequestToken } from "../hooks/useLatestTelemetryRequest";
import { resolveReplay3DRequest, parseReplayStartMs, resolveReplaySeekMs } from "../lib/pubg-analysis/replay3dRequest";

describe("3D latest telemetry request 경계", () => {
  it("새 요청은 이전 요청을 abort하고 이전 cleanup은 최신 요청을 취소하지 못한다", () => {
    const { result } = renderHook(() => useLatestTelemetryRequest());
    let first!: TelemetryRequestToken;
    let second!: TelemetryRequestToken;
    act(() => { first = result.current.begin(); });
    act(() => { second = result.current.begin(); });

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);

    act(() => result.current.cancel(first));
    expect(second.controller.signal.aborted).toBe(false);
    act(() => result.current.cancel(second));
    expect(second.controller.signal.aborted).toBe(true);
  });

  it("unmount 시 현재 요청을 abort한다", () => {
    const { result, unmount } = renderHook(() => useLatestTelemetryRequest());
    let request!: TelemetryRequestToken;
    act(() => { request = result.current.begin(); });

    unmount();

    expect(request.controller.signal.aborted).toBe(true);
  });
});

describe("3D query 경계", () => {
  it("완전 무쿼리만 Steam 데모로 해석한다", () => {
    expect(resolveReplay3DRequest({
      matchId: null,
      nickname: null,
      platform: null,
    })).toMatchObject({ platform: "steam", isDemo: true });
  });

  it("matchId·nickname·platform이 전부 있으면 해당 identity를 유지한다", () => {
    expect(resolveReplay3DRequest({
      matchId: "match-kakao",
      nickname: "Player",
      platform: "kakao",
    })).toEqual({
      matchId: "match-kakao",
      nickname: "Player",
      platform: "kakao",
      isDemo: false,
    });
  });

  it("일부 query 누락과 미지원 platform은 fail-closed한다", () => {
    for (const query of [
      { matchId: "match-1", nickname: "Player", platform: null },
      { matchId: "match-1", nickname: null, platform: "steam" },
      { matchId: null, nickname: "Player", platform: "steam" },
      { matchId: "match-1", nickname: "Player", platform: "xbox" },
    ]) {
      expect(() => resolveReplay3DRequest(query)).toThrow(
        "3D 리플레이 query가 누락되었거나 지원되지 않습니다.",
      );
    }
  });
});

describe("parseReplayStartMs", () => {
  it("초 단위 문자열을 밀리초로 바꾼다", () => {
    expect(parseReplayStartMs("420")).toBe(420000);
    expect(parseReplayStartMs("0")).toBe(0);
    // 소수점은 밀리초로 반올림한다.
    expect(parseReplayStartMs("89.6")).toBe(89600);
  });

  it("값이 없거나 해석할 수 없으면 null을 반환한다", () => {
    expect(parseReplayStartMs(null)).toBeNull();
    expect(parseReplayStartMs("")).toBeNull();
    expect(parseReplayStartMs("   ")).toBeNull();
    expect(parseReplayStartMs("abc")).toBeNull();
    expect(parseReplayStartMs("NaN")).toBeNull();
  });

  it("음수와 24시간 초과는 신뢰하지 않는다", () => {
    expect(parseReplayStartMs("-1")).toBeNull();
    expect(parseReplayStartMs("86401")).toBeNull();
    expect(parseReplayStartMs("86400")).toBe(86400000);
  });
});

describe("resolveReplaySeekMs", () => {
  const base = { requestedStartMs: 420000, maxTimeMs: 1800000, playerCount: 64 };

  it("요청 시점이 재생 구간 안이면 그대로 쓴다", () => {
    expect(resolveReplaySeekMs(base)).toBe(420000);
  });

  it("매치 길이를 넘는 요청은 끝으로 맞춘다", () => {
    expect(resolveReplaySeekMs({ ...base, requestedStartMs: 9999000 })).toBe(1800000);
  });

  it("요청 시점이 없으면 재생 위치를 건드리지 않는다", () => {
    expect(resolveReplaySeekMs({ ...base, requestedStartMs: null })).toBeNull();
  });

  it("텔레메트리가 아직 로드되지 않으면 적용하지 않는다", () => {
    // 재생 구간이 정해지지 않은 상태
    expect(resolveReplaySeekMs({ ...base, maxTimeMs: 0 })).toBeNull();
    // 플레이어 파싱 전
    expect(resolveReplaySeekMs({ ...base, playerCount: 0 })).toBeNull();
  });

  it("0초 요청도 유효한 시점으로 취급한다", () => {
    expect(resolveReplaySeekMs({ ...base, requestedStartMs: 0 })).toBe(0);
  });
});
