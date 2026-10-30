import { describe, expect, it, vi } from "vitest";
import { filterLolMayhemAugments, lolAugmentIcons, preferredAugmentIcon, toLolMayhemCatalog } from "../lib/lol/augments/catalog";
import { isPng, syncLolAugmentIcons } from "../lib/lol/augments/icons";
import type { AugmentCatalog } from "../lib/lol/augments/persistence.server";

const icon = (name: string) => `assets/ux/kiwi/augments/icons/${name}.png`;
const augment = (platformId: number, rarity: "silver" | "gold" | "prismatic", name: string | null, overrides: Partial<AugmentCatalog["augments"][number]> = {}) => ({
  platformId, rarity, isInternal: false, enabled: true, inPool: true, quest: false, ability: false, state: "official_active" as const,
  iconSmallPath: null, iconLargePath: icon(`a${platformId}`),
  localizations: {
    ko_kr: { name, text: `${name} 효과`, tokens: [], displaySource: "desc" as const, notice: null },
    en_us: { name: `En ${platformId}`, text: "effect", tokens: [], displaySource: "desc" as const, notice: null },
  },
  ...overrides,
});
const catalog: AugmentCatalog = {
  clientPatch: "16.21", displayPatch: "26.21", releasedAt: "2026-10-20T18:00:00Z", notesUrlKo: "https://example.test/notes", notesUrlEn: null,
  augments: [
    augment(1, "silver", "나중"), augment(2, "prismatic", "가나다"), augment(3, "gold", "골드"),
    augment(4, "gold", "내부", { isInternal: true }), augment(5, "gold", "비활성", { enabled: false }), augment(6, "gold", "풀밖", { inPool: false }),
    augment(7, "silver", null),
  ],
  changes: [
    { platformId: 3, changeType: "added", official: true, summaryKo: "골드: 신규" },
    { platformId: null, changeType: "removed", official: true, summaryKo: "공식 노트 삭제 목록(기준 게시본 없음): 타오르는 이자, Hide on bush" },
    { platformId: 9, changeType: "removed", official: false, summaryKo: "차원 이동: 삭제" },
  ],
};

describe("증바람 도감 변환", () => {
  it("내부·비활성·풀 밖 증강을 빼고 등급·이름 순으로 정렬한다", () => {
    expect(toLolMayhemCatalog(catalog).augments.map(item => item.id)).toEqual([2, 3, 1, 7]);
  });
  it("한국어 이름이 없으면 영문 이름을 쓰고 신규 증강을 표시한다", () => {
    const { augments } = toLolMayhemCatalog(catalog);
    expect(augments.find(item => item.id === 7)?.name).toBe("En 7");
    expect(augments.filter(item => item.isNew).map(item => item.id)).toEqual([3]);
  });
  it("검토용 머리말 없이 삭제 이름만 남긴다", () => {
    expect(toLolMayhemCatalog(catalog).removed).toEqual(["타오르는 이자", "Hide on bush", "차원 이동"]);
  });
  it("이름·영문·효과와 등급·신규 조건으로 거른다", () => {
    const { augments } = toLolMayhemCatalog(catalog);
    expect(filterLolMayhemAugments(augments, " en 2 ", null, false).map(item => item.id)).toEqual([2]);
    expect(filterLolMayhemAugments(augments, "골드 효과", null, false).map(item => item.id)).toEqual([3]);
    expect(filterLolMayhemAugments(augments, "", "silver", false).map(item => item.id)).toEqual([1, 7]);
    expect(filterLolMayhemAugments(augments, "", null, true).map(item => item.id)).toEqual([3]);
  });
  it("허용 경로의 큰 아이콘을 우선하고 없으면 작은 아이콘, 둘 다 아니면 비운다", () => {
    expect(preferredAugmentIcon(icon("large"), icon("small"))).toBe(icon("large"));
    expect(preferredAugmentIcon("assets/maps/particles/kiwi/x.png", icon("small"))).toBe(icon("small"));
    expect(preferredAugmentIcon("assets/maps/particles/kiwi/x.png", null)).toBeNull();
  });
  it("아이콘 허용 목록은 중복과 허용 밖 경로를 뺀다", () => {
    expect(lolAugmentIcons([{ large: icon("a"), small: null }, { large: icon("a"), small: null }, { large: "assets/x.png", small: null }])).toEqual([icon("a")]);
  });
});

describe("증강 아이콘 수집", () => {
  const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  it("버전 고정 원본을 패치별 경로로 올린다", async () => {
    const upload = vi.fn(async () => undefined);
    const download = vi.fn(async (_url: string, _max: number, check: (body: Buffer) => void) => { check(PNG); return PNG; });
    await expect(syncLolAugmentIcons("16.21", [icon("a")], { download, upload })).resolves.toBe(1);
    expect(download.mock.calls[0][0]).toBe(`https://raw.communitydragon.org/16.21/game/${icon("a")}`);
    expect(upload).toHaveBeenCalledWith(`16.21/${icon("a")}`, PNG);
  });
  it("PNG가 아니거나 내려받기가 실패하면 예외로 수집을 멈춘다", async () => {
    const upload = vi.fn(async () => undefined);
    await expect(syncLolAugmentIcons("16.21", [icon("a")], { upload, download: async (_url, _max, check) => { const body = Buffer.from("<html>"); check(body); return body; } }))
      .rejects.toThrow("source_invalid_icon");
    await expect(syncLolAugmentIcons("16.21", [icon("a")], { upload, download: async () => { throw new Error("source_download_failed"); } }))
      .rejects.toThrow("source_download_failed");
    expect(upload).not.toHaveBeenCalled(); expect(isPng(PNG)).toBe(true);
  });
});
