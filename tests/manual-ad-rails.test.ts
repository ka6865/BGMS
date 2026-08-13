import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("manual desktop ad rails", () => {
  it("uses the same sticky 160x600 rail contract on stats, board, rankings, and weapons", () => {
    const shell = read("components/stat/layout/StatsPageShell.tsx");
    const rail = read("components/ads/ManualAdRail.tsx");
    const statsRails = read("components/ads/StatsManualAdRails.tsx");
    const boardList = read("components/board/BoardListClient.tsx");
    const boardDetail = read("components/board/BoardDetailClient.tsx");
    const rankings = read("app/rankings/RankingsClient.tsx");
    const weapons = read("app/weapons/WeaponsClient.tsx");

    for (const source of [boardList, boardDetail, rankings, weapons]) {
      expect(source).toContain("sticky");
      expect(source).toContain("160");
      expect(source).toContain("600");
    }
    expect(rail).toContain("manual-ad-rail__inner");
    expect(rail).toContain("adHeight={600}");

    expect(shell).toContain("StatsManualAdRails");
    expect(statsRails).toContain('side="left"');
    expect(statsRails).toContain('side="right"');
    expect(rankings).toContain("left-[calc(100%+24px)]");
    expect(rankings).toContain("right-[calc(100%+24px)]");
    expect(weapons).toContain("left-[calc(100%+24px)]");
    expect(weapons).toContain("right-[calc(100%+24px)]");
  });

  it("keeps both board rails sticky and gates all desktop rails at the shared wide breakpoint", () => {
    const source = `${read("components/board/BoardListClient.tsx")}\n${read("components/board/BoardDetailClient.tsx")}\n${read("app/rankings/RankingsClient.tsx")}\n${read("app/weapons/WeaponsClient.tsx")}`;
    expect(source).toContain("min-[1880px]");
    expect(source).not.toContain("[@media(min-width:1280px)_and_(min-height:680px)]");
    expect(source).not.toMatch(/우측 레일은 고정하지 않고/);
    expect(source).not.toMatch(/xl:grid-cols-\[160px_minmax\(0,900px\)_160px\]/);
    expect(source).toContain("max-w-[1320px]");

    const css = read("app/globals.css");
    expect(css).toContain("stats-manual-ad-rail");
    expect(css).toContain("position: sticky");
    expect(css).toContain("min-width: 1880px");
  });
});
