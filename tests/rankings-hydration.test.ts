// @vitest-environment jsdom

import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RankingsClient from "@/app/rankings/RankingsClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const originalTimeZone = process.env.TZ;
const roots: Root[] = [];
vi.mock('@/components/ads/AdfitBanner', () => ({ default: () => null }));
vi.mock('@/components/ads/AdSenseBanner', () => ({ default: () => null }));

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.TZ = originalTimeZone;
  document.body.replaceChildren();
});

describe("랭킹 하이드레이션", () => {
  it("서버 UTC와 클라이언트 KST의 업데이트 시각이 달라도 텍스트 불일치가 발생하지 않는다", async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    process.env.TZ = "UTC";
    const props = {
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
      roots.push(hydrateRoot(
        container,
        createElement(RankingsClient, props),
        {
          onRecoverableError: (error) => recoverableErrors.push(error),
        }
      ));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(recoverableErrors).toHaveLength(0);
  });

  it("서버 HTML과 접속 시각이 달라도 초기 조회 표시가 빈 데이터로 바뀌지 않는다", async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const props = {
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const markup = renderToString(createElement(RankingsClient, props));
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.append(container);

    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      roots.push(hydrateRoot(container, createElement(RankingsClient, props), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(container.querySelector('[aria-label="랭킹 불러오는 중"]')).not.toBeNull();
    expect(container.textContent).not.toContain('이번 주 데이터가 없습니다');
  });
});
