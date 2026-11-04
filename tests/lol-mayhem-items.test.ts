import { describe, expect, it } from "vitest";
import { parseMayhemItemRatings, withMayhemItemMetadata } from "../lib/lol/mayhemItems";
const source = () => ({ meta: { query: "aram_mayhem_champion", game: "lol" }, data: [{ champion_id: "29", patch: "16.22", dt: "2026-11-04", data: { items: { "3089": { tier: 1, pickRate: 0.99 }, "1036": { tier: 4 } } } }] });
const metadata = { data: { "3089": { name: "라바돈의 죽음모자", image: { full: "3089.png" }, from: ["1058", "1058"] }, "1058": { name: "쓸데없이 큰 지팡이", image: { full: "1058.png" } } } };
describe("증바람 전용 아이템 자료", () => {
  it("증바람 챔피언 평가만 읽고 제공하지 않는 선택률·구매 순서를 만들지 않는다", () => {
    const parsed = parseMayhemItemRatings(source(), 29)!;
    expect(parsed.ratings).toEqual([{ id: 1036, tier: 4 }, { id: 3089, tier: 1 }]);
    const result = withMayhemItemMetadata(parsed, "16.22.1", metadata);
    expect(result).toMatchObject({ championId: 29, patch: "16.22", version: "16.22.1", date: "2026-11-04" });
    expect(result.items[0]).toEqual({ id: 3089, tier: 1, name: "라바돈의 죽음모자", image: "3089.png", components: [1058, 1058].map(id => ({ id, name: "쓸데없이 큰 지팡이", image: "1058.png" })) });
    expect(result.items[1]).toEqual({ id: 1036, tier: 4, name: "아이템 1036", image: null, components: [] });
    expect(JSON.stringify(result)).not.toMatch(/pickRate|winRate|purchaseOrder|builds/);
  });
  it("일반 칼바람 query·다른 챔피언·다른 게임은 거절한다", () => {
    const ordinary = source(); ordinary.meta.query = "aram_champion";
    expect(() => parseMayhemItemRatings(ordinary, 29)).toThrow();
    expect(() => parseMayhemItemRatings(source(), 17)).toThrow();
    const game = source(); game.meta.game = "tft"; expect(() => parseMayhemItemRatings(game, 29)).toThrow();
  });
  it("없는 자료와 빈 아이템 목록을 구분한다", () => {
    expect(parseMayhemItemRatings({ ...source(), data: [] }, 29)).toBeNull();
    const empty = source(); empty.data[0].data.items = {} as typeof empty.data[0]["data"]["items"];
    expect(parseMayhemItemRatings(empty, 29)?.ratings).toEqual([]);
  });
  it.each([0, 6, 1.5, "1", null])("잘못된 평가 등급 %s를 거절한다", tier => {
    const value = source(); (value.data[0].data.items["3089"] as {tier: unknown}).tier = tier;
    expect(() => parseMayhemItemRatings(value, 29)).toThrow();
  });
  it("잘못된 날짜·패치·아이템 ID·과도한 항목은 거절한다", () => {
    for (const [key, value] of [["dt", "2026-02-30"], ["patch", "16.22/../../"]]) {
      const raw = source(); Object.assign(raw.data[0], { [key]: value }); expect(() => parseMayhemItemRatings(raw, 29)).toThrow();
    }
    const raw = source(); Object.assign(raw.data[0].data.items, { "../1036": { tier: 1 } }); expect(() => parseMayhemItemRatings(raw, 29)).toThrow();
    raw.data[0].data.items = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i + 1), { tier: 1 }])) as typeof raw.data[0]["data"]["items"];
    expect(() => parseMayhemItemRatings(raw, 29)).toThrow();
  });
  it("같은 패치의 메타데이터만 연결하고 외부 이미지 경로를 차단한다", () => {
    const parsed = parseMayhemItemRatings(source(), 29)!;
    expect(() => withMayhemItemMetadata(parsed, "16.21.1", metadata)).toThrow();
    const malicious = { data: { "3089": { name: " ", image: { full: "https://example.test/a.png" }, from: ["../1058", "1058"] } } };
    expect(withMayhemItemMetadata(parsed, "16.22.1", malicious).items[0]).toMatchObject({ name: "아이템 3089", image: null, components: [{ id: 1058 }] });
  });
});
