import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterLolChampions, type LolChampion } from "../lib/lol/champions";

vi.mock("server-only", () => ({}));
vi.mock("../lib/lol/dataDragon.server", () => ({ getLolDataDragonVersion: vi.fn().mockResolvedValue("16.21.1") }));

const raw = { data: {
  Ahri: { id: "Ahri", key: "103", name: "아리", title: "구미호", tags: ["Mage", "Assassin"], image: { full: "Ahri.png" } },
  Aatrox: { id: "Aatrox", key: "266", name: "아트록스", title: "다르킨의 검", tags: ["Fighter", "Unknown"] },
  Bad: { id: "../x", key: "1", name: "깨진 값" },
  NoKey: { id: "NoKey", key: "abc", name: "키 없음" },
  MonkeyKing: { id: "MonkeyKing", key: "62", name: "오공", title: "원숭이 왕", tags: "Fighter" },
} };

beforeEach(() => { vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LoL 챔피언 목록", () => {
  it("필요한 필드만 검증해 한글 이름순으로 정리한다", async () => {
    const { parseLolChampions } = await import("../lib/lol/champions.server");
    expect(parseLolChampions(raw)).toEqual([
      { id: 103, imageId: "Ahri", name: "아리", title: "구미호", tags: ["Mage", "Assassin"] },
      { id: 266, imageId: "Aatrox", name: "아트록스", title: "다르킨의 검", tags: ["Fighter"] },
      { id: 62, imageId: "MonkeyKing", name: "오공", title: "원숭이 왕", tags: [] },
    ]);
    expect(parseLolChampions(null)).toEqual([]);
  });

  it("동시 요청도 목록을 한 번만 받아 재사용한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)));
    vi.stubGlobal("fetch", fetcher);
    const { getLolChampions } = await import("../lib/lol/champions.server");
    const [first] = await Promise.all([getLolChampions(), getLolChampions()]);
    expect(first?.version).toBe("16.21.1");
    expect(first?.champions).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://ddragon.leagueoflegends.com/cdn/16.21.1/data/ko_KR/champion.json", expect.objectContaining({ redirect: "error" }));
    expect(await getLolChampions()).toBe(first);
  });

  it("받지 못하거나 빈 목록이면 null을 돌려준다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    expect(await (await import("../lib/lol/champions.server")).getLolChampions()).toBeNull();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect(await (await import("../lib/lol/champions.server")).getLolChampions()).toBeNull();
  });

  it("이름·초성·영문 ID·역할군으로 거른다", () => {
    const list: LolChampion[] = [
      { id: 103, imageId: "Ahri", name: "아리", title: "", tags: ["Mage"] },
      { id: 22, imageId: "Ashe", name: "애쉬", title: "", tags: ["Marksman", "Support"] },
      { id: 21, imageId: "MissFortune", name: "미스 포츈", title: "", tags: ["Marksman"] },
    ];
    expect(filterLolChampions(list, "미스포", null).map(item => item.id)).toEqual([21]);
    expect(filterLolChampions(list, "ㅁㅅ", null).map(item => item.id)).toEqual([21]);
    expect(filterLolChampions(list, "ash", null).map(item => item.id)).toEqual([22]);
    expect(filterLolChampions(list, "", "Marksman").map(item => item.id)).toEqual([22, 21]);
    expect(filterLolChampions(list, "아", "Support")).toEqual([]);
  });
});

describe("LoL 챔피언 밴 집계 migration", () => {
  const sql = readFileSync("supabase/migrations/20261026030000_lol_champion_bans.sql", "utf8");
  it("벤치마크 처리 기록에 맞춰 집계하고 서비스 전용 권한을 유지한다", () => {
    expect(sql).toContain("after insert on public.lol_benchmark_processed_matches");
    expect(sql).toContain("when (new.skipped_reason is null)");
    for (const table of ["lol_champion_ban_processed_matches", "lol_champion_ban_aggregates"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).not.toContain("security definer");
    expect(sql).not.toMatch(/puuid|riot_id|game_name/);
    expect(sql).toContain("select distinct public.lol_benchmark_number(b->'championId')");
    expect(sql).toContain("where p.skipped_reason is null and m.request_json is not null order by p.match_id");
  });
});
