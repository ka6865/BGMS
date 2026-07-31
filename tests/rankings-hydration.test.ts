// @vitest-environment jsdom

import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RankingsClient from "@/app/rankings/RankingsClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const originalTimeZone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTimeZone;
  document.body.replaceChildren();
});

describe("랭킹 하이드레이션", () => {
  it("서버 UTC와 클라이언트 KST의 업데이트 시각이 달라도 텍스트 불일치가 발생하지 않는다", async () => {
    process.env.TZ = "UTC";
    const props = {
      initialDamage: [],
      initialKills: [],
      initialTier: [],
      updatedAt: "2026-07-31T15:39:00.000Z",
    };
    const markup = renderToString(
      createElement(RankingsClient, props)
    );
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.append(container);

    process.env.TZ = "Asia/Seoul";
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      hydrateRoot(
        container,
        createElement(RankingsClient, props),
        {
          onRecoverableError: (error) => recoverableErrors.push(error),
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(recoverableErrors).toHaveLength(0);
  });

  it("캐시된 서버 HTML과 접속 시각이 달라도 상대 시간 텍스트 불일치가 발생하지 않는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const entry = {
      rank: 1,
      player_id: "hydration-player",
      nickname: "HydrationPlayer",
      value: 1500,
      secondary: 5,
      game_mode: "스쿼드",
      map_name: "에란겔",
      tier: "A",
      created_at: "2026-07-31T00:01:00.000Z",
    };
    const props = {
      initialDamage: [entry],
      initialKills: [],
      initialTier: [],
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const markup = renderToString(createElement(RankingsClient, props));
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.append(container);

    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      hydrateRoot(container, createElement(RankingsClient, props), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await vi.runAllTimersAsync();
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(container.textContent).toContain("23시간 전");
  });
});
