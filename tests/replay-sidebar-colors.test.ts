// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TelemetrySidebar } from "@/components/map/telemetry/TelemetrySidebar";
import { SQUAD_COLORS, squadColor } from "@/lib/replay/squadColors";
import type { PlayerState } from "@/hooks/useTelemetry";

afterEach(cleanup);

const player = (name: string, teamId: number, extra: Partial<PlayerState> = {}): PlayerState => ({
  name, teamId, x: 0, y: 0, health: 100, kills: 0, assists: 0, isDead: false, isGroggy: false, isInVehicle: false, isEnemy: true, ...extra,
});

describe("아군 색", () => {
  it("teamNames 순서대로 색을 주고 대소문자를 구분하지 않는다", () => {
    const team = ["Me", "Mate", "Third"];
    expect(squadColor(team, "me")).toBe(SQUAD_COLORS[0]);
    expect(squadColor(team, " MATE ")).toBe(SQUAD_COLORS[1]);
    expect(squadColor(team, "Unknown")).toBe(SQUAD_COLORS[0]);
  });
});

describe("리플레이 선수 목록", () => {
  it("아군 → 교전 중 → 생존 → 전멸 순으로 팀을 정렬하고 체력과 상태를 보여준다", () => {
    const states = {
      dead1: player("Dead1", 2, { isDead: true }),
      calm: player("Calm", 3, { health: 40 }),
      foe: player("Foe", 9, { isGroggy: true }),
      me: player("Me", 1, { isEnemy: false }),
    };
    render(React.createElement(TelemetrySidebar, { currentStates: states, engagedOpponents: new Set(["foe"]), followPlayer: "me" }));

    const teamLabels = screen.getAllByText(/^팀 \d+$/).map((node) => node.textContent);
    expect(teamLabels).toEqual(["팀 1", "팀 9", "팀 3", "팀 2"]);
    expect(screen.getByText("내 스쿼드")).toBeTruthy();
    expect(screen.getByText("교전 중")).toBeTruthy();
    expect(screen.getByText("전멸")).toBeTruthy();
    expect(screen.getByText("기절")).toBeTruthy();

    const calmRow = screen.getByText("Calm").closest("div.px-3") as HTMLElement;
    const bar = calmRow.querySelector('[aria-hidden="true"] > div') as HTMLElement;
    expect(bar.style.width).toBe("40%");
    expect(within(screen.getByText("Dead1").closest("div.px-3") as HTMLElement).queryByText("기절")).toBeNull();
    expect(screen.getByText("Dead1").closest("div.px-3")?.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
