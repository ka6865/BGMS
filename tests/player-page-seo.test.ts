import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeSeasonStats } from "@/lib/stats/playerSeo.server";

const state = vi.hoisted(() => ({ value: { status: "unknown" } as any }));
vi.mock("@/lib/stats/playerSeo.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPlayerSeoState: vi.fn(async () => state.value),
}));
vi.mock("@/components/stat/StatSearch", () => ({ default: () => null }));

const props = (tab?: string) => ({
  params: Promise.resolve({ platform: "steam", nickname: "Player_A" }),
  searchParams: Promise.resolve(tab ? { tab } : {}),
});

describe("플레이어 전적 페이지 검색 노출", () => {
  beforeEach(() => { state.value = { status: "unknown" }; });

  it("최근 시즌의 모든 모드를 합쳐 요약한다", () => {
    expect(summarizeSeasonStats({
      "division.bro.official.pc-2018-41": { normal: { squad: { roundsPlayed: 99, wins: 9, kills: 99, damageDealt: 9999 } } },
      "division.bro.official.pc-2018-42": {
        normal: { squad: { roundsPlayed: 10, wins: 1, kills: 12, damageDealt: 2500 }, duo: { roundsPlayed: 10, wins: 0, kills: 6, damageDealt: 1500 } },
        ranked: { squad: { roundsPlayed: 0, wins: 0, kills: 0, damageDealt: 0 } },
      },
    })).toEqual({ seasonId: "division.bro.official.pc-2018-42", rounds: 20, wins: 1, avgDamage: 200, killsPerRound: 0.9 });
    expect(summarizeSeasonStats({ "division.bro.official.pc-2018-42": {} })).toBeNull();
    expect(summarizeSeasonStats(null)).toBeNull();
  });

  it("검색된 공개 플레이어만 색인하고 탭 주소도 플레이어 주소를 정식 주소로 둔다", async () => {
    state.value = { status: "public", nickname: "Player_A", summary: { seasonId: "s", rounds: 20, wins: 1, avgDamage: 200, killsPerRound: 0.9 } };
    const { generateMetadata } = await import("@/app/stats/[platform]/[nickname]/page");
    const meta = await generateMetadata(props("squad"));
    expect(meta.robots).toBeUndefined();
    expect(meta.alternates?.canonical).toBe("https://bgms.kr/stats/steam/Player_A");
    const base = await generateMetadata(props());
    expect(base.title).toBe("Player_A 배그 전적 분석");
    expect(base.description).toContain("20경기 평균 딜량 200");
  });

  it("수집만 된 닉네임은 검색에서 제외한다", async () => {
    const { generateMetadata } = await import("@/app/stats/[platform]/[nickname]/page");
    expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: true });
  });

  it("비공개 플레이어는 검색 제외와 함께 닉네임을 메타데이터에 넣지 않는다", async () => {
    state.value = { status: "private" };
    const { generateMetadata } = await import("@/app/stats/[platform]/[nickname]/page");
    const meta = await generateMetadata(props());
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(JSON.stringify(meta)).not.toContain("Player_A");
  });
});
