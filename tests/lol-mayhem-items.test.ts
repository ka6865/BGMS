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
    expect(result.items[0]).toEqual({ id: 3089, tier: 1, isBoots: false, name: "라바돈의 죽음모자", image: "3089.png", components: [1058, 1058].map(id => ({ id, name: "쓸데없이 큰 지팡이", image: "1058.png" })) });
    expect(result.items[1]).toEqual({ id: 1036, tier: 4, isBoots: false, name: "아이템 1036", image: null, components: [] });
    expect(JSON.stringify(result)).not.toMatch(/pickRate|winRate|purchaseOrder|builds/);
  });
  it("신발은 Boots 태그로 분류하고 기본 장화는 추천에서 제외하되 재료에 남긴다", () => {
    const parsed = { championId: 29, patch: "16.22", date: "2026-11-04", ratings: [1001,3006,223006,3175,3089,1036].map(id => ({ id, tier: 1 })) };
    const value = { data: { ...metadata.data, ...Object.fromEntries([1001,3006,223006,3175].map(id => [String(id), { name: `신발 ${id}`, tags: ["AttackSpeed", "Boots"], from: id === 3006 ? ["1001"] : [] }])) } };
    const result = withMayhemItemMetadata(parsed, "16.22.1", value);
    expect(result.items.some(item => item.id === 1001)).toBe(false);
    expect(result.items.find(item => item.id === 3006)?.components.map(item => item.id)).toEqual([1001]);
    expect(result.items.filter(item => item.isBoots).map(item => item.id).sort((a,b) => a-b)).toEqual([3006,3175,223006]);
    expect(result.items.filter(item => !item.isBoots).map(item => item.id).sort((a,b) => a-b)).toEqual([1036,3089]);
  });
  it("포로 간식은 평가 등급과 무관하게 아이템·제작 재료에서 제외한다", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      const parsed = { championId: 29, patch: "16.22", date: "2026-11-04", ratings: [{ id: 2052, tier }, { id: 220013, tier }, { id: 3089, tier: 1 }] };
      const value = { data: { ...metadata.data, "2052": { name: "포로 간식", image: { full: "2052.png" } }, "220013": { name: "포로 간식", image: { full: "220013.png" } }, "3089": { ...metadata.data["3089"], from: ["1058", "2052", "220013", "1058"] } } };
      const result = withMayhemItemMetadata(parsed, "16.22.1", value);
      expect(result.items.map(item => item.id)).toEqual([3089]);
      expect(result.items[0].components.map(item => item.id)).toEqual([1058, 1058]);
      expect(JSON.stringify(result)).not.toContain("포로 간식");
    }
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

import { filterMayhemItemComponents } from '../lib/lol/mayhemItems';
it('재료는 티어에서 제외하고 제작 재료·신발·자동 변환 완성품은 유지한다',()=>{
  const parsed={championId:29,patch:'16.22',date:'2026-11-04',ratings:[1036,3108,3089,3006,773003].map(id=>({id,tier:1}))};
  const value={data:{...metadata.data,'1036':{name:'롱소드',into:['3089']},'3108':{name:'악마의 마법서',into:['3089']},'3089':{...metadata.data['3089'],gold:{purchasable:true}},'3006':{name:'광전사의 군화',tags:['Boots'],into:['3172']},'3172':{gold:{purchasable:true}},'773003':{name:'대천사의 지팡이',into:['773040']},'773040':{gold:{purchasable:false}}}};
  const result=filterMayhemItemComponents(withMayhemItemMetadata(parsed,'16.22.1',value),value);
  expect(result.items.map(i=>i.id).sort((a,b)=>a-b)).toEqual([3006,3089,773003]);
  expect(result.items.find(i=>i.id===3089)?.components.map(i=>i.id)).toEqual([1058,1058]);
});
it('기존 승인본도 제작 관계로 재료를 제외하며 저장본 자체는 변경하지 않는다',()=>{
  const parsed={championId:29,patch:'16.22',date:'2026-11-04',ratings:[1058,3089].map(id=>({id,tier:1}))};
  const stored=withMayhemItemMetadata(parsed,'16.22.1',metadata);const result=filterMayhemItemComponents(stored,metadata);
  expect(result.items.map(i=>i.id)).toEqual([3089]);expect(stored.items).toHaveLength(2);
});
