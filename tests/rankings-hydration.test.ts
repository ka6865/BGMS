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
});
