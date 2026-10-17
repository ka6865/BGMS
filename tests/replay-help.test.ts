// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TelemetryPlayer from "@/components/map/TelemetryPlayer";
import { ReplayHelpDialog } from "@/components/map/telemetry/ReplayHelpDialog";
import { REPLAY_HELP_SEEN_KEY } from "@/lib/replay/replayShortcuts";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const noop = () => {};
const playerProps = {
  events: [], teamNames: ["Me"], isPlaying: false, setIsPlaying: noop, playbackSpeed: 1, setPlaybackSpeed: noop,
  currentTimeMs: 0, setCurrentTimeMs: noop, maxTimeMs: 60_000, loading: false, error: null,
  showZone: true, onToggleZone: noop, showCombatDots: true, onToggleCombatDots: noop, showShotDots: true, onToggleShotDots: noop,
  hiddenPlayers: [], onTogglePlayer: noop, showPlayerNames: false, onTogglePlayerNames: noop, showFlightPath: true, onToggleFlightPath: noop,
  showVision: false, onToggleVision: noop, autoZoom: true, onToggleAutoZoom: noop,
  followPlayer: null, onFollowPlayerChange: noop, nextFightMs: null, onNextFight: noop, onClose: noop,
};

// 이 실행 환경의 jsdom localStorage는 쓸 수 없어 테스트용 저장소로 바꾼다.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("리플레이 사용법 창", () => {
  it("열리면 닫기 버튼에 포커스를 두고 Esc·바깥 클릭으로 닫힌다", () => {
    const onClose = vi.fn();
    render(React.createElement(ReplayHelpDialog, { open: true, onClose }));
    const dialog = screen.getByRole("dialog", { name: "리플레이 사용법" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "사용법 닫기" }));
    expect(dialog.textContent).toContain("150m");
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("닫혀 있으면 그리지 않는다", () => {
    render(React.createElement(ReplayHelpDialog, { open: false, onClose: noop }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("재생 패널의 사용법 진입", () => {
  it("처음에는 안내를 띄우고, ? 키로 열면 다시 띄우지 않는다", () => {
    vi.useFakeTimers();
    const view = render(React.createElement(TelemetryPlayer, playerProps));
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText("여기를 눌러 리플레이 사용법 보기")).toBeTruthy();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "리플레이 사용법" })).toBeTruthy();
    expect(screen.queryByText("여기를 눌러 리플레이 사용법 보기")).toBeNull();
    expect(localStorage.getItem(REPLAY_HELP_SEEN_KEY)).toBe("1");
    view.unmount();
    render(React.createElement(TelemetryPlayer, playerProps));
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("여기를 눌러 리플레이 사용법 보기")).toBeNull();
  });

  it("입력 칸에서 누른 ?는 사용법을 열지 않는다", () => {
    render(React.createElement(TelemetryPlayer, playerProps));
    const input = document.createElement("input"); document.body.append(input);
    fireEvent.keyDown(input, { key: "?" });
    expect(screen.queryByRole("dialog")).toBeNull();
    input.remove();
  });

  it("안내는 10초 뒤 저절로 사라진다", () => {
    vi.useFakeTimers();
    render(React.createElement(TelemetryPlayer, playerProps));
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText("여기를 눌러 리플레이 사용법 보기")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.queryByText("여기를 눌러 리플레이 사용법 보기")).toBeNull();
  });
});
