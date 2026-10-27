import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyLolItems, extractLolStatMatch, lolSkillOrder, lolStatTierFilter, lolStatWantsTimeline, type LolItemCatalog,
} from "../lib/lol/championStats";
import {
  CollectorRiotError, LOL_STAT_BUCKETS, parseCollectorArgs, runLolStatCollector, type CollectorCursor, type CollectorDeps,
} from "../scripts/lol_collect_champion_stats";

const positions = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const items: LolItemCatalog = {
  3031: { final: true, boots: false, trinket: false }, 6672: { final: true, boots: false, trinket: false },
  3078: { final: true, boots: false, trinket: false }, 3006: { final: false, boots: true, trinket: false },
  1055: { final: false, boots: false, trinket: false }, 2003: { final: false, boots: false, trinket: false },
  3340: { final: false, boots: false, trinket: true },
};
function match(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { matchId: "KR_1" },
    info: {
      gameVersion: "16.21.555.1", queueId: 420, gameType: "MATCHED_GAME", gameDuration: 1800,
      teams: [{ teamId: 100, bans: [{ championId: 55 }, { championId: -1 }] }, { teamId: 200, bans: [{ championId: 55 }, { championId: 64 }] }],
      participants: Array.from({ length: 10 }, (_, index) => ({
        participantId: index + 1, puuid: `secret-${index}`, riotIdGameName: "private", teamId: index < 5 ? 100 : 200,
        teamPosition: positions[index % 5], championId: index + 1, win: index < 5,
        kills: 3, deaths: 2, assists: 4, totalMinionsKilled: 150, neutralMinionsKilled: 10, goldEarned: 11000, totalDamageDealtToChampions: 15000,
        summoner1Id: 14, summoner2Id: 4,
        item0: 3031, item1: 6672, item2: 3006, item3: 1055, item4: 3031, item5: 0, item6: 3340,
        perks: { statPerks: { offense: 5005, flex: 5008, defense: 5001 }, styles: [
          { style: 8000, selections: [{ perk: 8008 }, { perk: 9101 }, { perk: 9104 }, { perk: 8299 }] },
          { style: 8400, selections: [{ perk: 8444 }, { perk: 8453 }] }] },
      })),
      ...overrides,
    },
  };
}
function timeline() {
  const events = [
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 1055, timestamp: 1000 },
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 2003, timestamp: 1200 },
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 3340, timestamp: 1300 },
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 6672, timestamp: 500_000 },
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 3078, timestamp: 600_000 },
    { type: "ITEM_UNDO", participantId: 1, beforeId: 3078, afterId: 0, timestamp: 600_100 },
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 3031, timestamp: 700_000 },
    { type: "ITEM_PURCHASED", participantId: 1, itemId: 3078, timestamp: 900_000 },
    { type: "ITEM_PURCHASED", participantId: 0, itemId: 3865, timestamp: 0 },
    ...[1, 3, 2, 1, 1, 4, 1, 3, 1, 3, 4, 3, 3].map((skillSlot, index) => ({ type: "SKILL_LEVEL_UP", levelUpType: "NORMAL", participantId: 1, skillSlot, timestamp: index * 60_000 })),
  ];
  const frames = Array.from({ length: 20 }, (_, minute) => ({
    events: minute === 1 ? events : [],
    participantFrames: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), { totalGold: minute * 400 + (index === 0 ? 300 : 0) }])),
  }));
  return { info: { frames } };
}

describe("챔피언 통계 경기 추출", () => {
  it("익명 기여분만 만들고 밴은 경기당 한 번만 센다", () => {
    const result = extractLolStatMatch(match(), null, items);
    expect(result.skipped).toBeNull();
    if (result.skipped) return;
    expect(result.patch).toBe("16.21");
    expect(result.hasTimeline).toBe(false);
    expect(result.payload.bans).toEqual([55, 64]);
    expect(result.payload.champions).toHaveLength(10);
    expect(JSON.stringify(result.payload)).not.toMatch(/secret|private/);
    expect(result.payload.champions[0]).toEqual({ position: "TOP", champion: 1, win: true, kills: 3, deaths: 2, assists: 4, cs: 160,
      gold: 11000, damage: 15000, duration: 1800, gd15: null });
    expect(result.payload.matchups[0]).toEqual({ position: "TOP", champion: 1, opponent: 6, win: true, gd15: null });
    const top = result.payload.builds.filter(build => build.champion === 1).map(build => `${build.kind}=${build.value}`);
    expect(top).toEqual(["keystone=8008", "runes=8000:8008,9101,9104,8299|8400:8444,8453|5005,5008,5001", "spells=4,14",
      "item=3031", "item=6672", "boots=3006"]);
  });

  it("timeline이 있으면 시작 아이템·코어 순서(되돌리기 반영)·스킬 순서·15분 골드 차이를 더한다", () => {
    const result = extractLolStatMatch(match(), timeline(), items);
    if (result.skipped) throw new Error("skipped");
    expect(result.hasTimeline).toBe(true);
    const top = result.payload.builds.filter(build => build.champion === 1 && ["start_items", "core_items", "skill_order"].includes(build.kind));
    expect(top.map(build => `${build.kind}=${build.value}`)).toEqual(["start_items=1055+2003", "core_items=6672>3031>3078", "skill_order=Q>E>W"]);
    expect(result.payload.champions[0].gd15).toBe(300);
    expect(result.payload.matchups.find(row => row.champion === 6)?.gd15).toBe(-300);
  });

  it.each([
    ["custom", { queueId: 0 }], ["queue", { queueId: 450 }], ["short", { gameDuration: 299 }], ["invalid", { gameVersion: "x" }],
  ])("%s 경기는 제외한다", (reason, overrides) => {
    expect(extractLolStatMatch(match(overrides), null, items)).toMatchObject({ skipped: reason, payload: null });
  });

  it("다시하기와 포지션이 겹친 라인은 제외하거나 상대 지표를 만들지 않는다", () => {
    const remake = match(); remake.info.participants[0] = { ...remake.info.participants[0], gameEndedInEarlySurrender: true } as never;
    expect(extractLolStatMatch(remake, null, items).skipped).toBe("remake");
    const overlap = match(); overlap.info.participants[1] = { ...overlap.info.participants[1], teamPosition: "TOP" };
    const result = extractLolStatMatch(overlap, null, items);
    if (result.skipped) throw new Error("skipped");
    expect(result.payload.matchups.some(row => row.position === "TOP")).toBe(false);
  });

  it("스킬 순서는 5레벨을 먼저 찍은 순서이며 9레벨 미만이면 만들지 않는다", () => {
    expect(lolSkillOrder([1, 2, 3, 1, 1, 4, 1, 3, 1, 3, 4, 3, 3, 2, 2])).toBe("Q>E>W");
    expect(lolSkillOrder([2, 1, 3, 2, 2, 4, 2, 1, 2])).toBe("W>Q>E");
    expect(lolSkillOrder([1, 2, 3])).toBeNull();
  });

  it("Data Dragon item.json에서 완성 아이템·신발·장신구를 구분한다", () => {
    const catalog = classifyLolItems({ data: {
      1001: { gold: { total: 300, purchasable: true }, tags: ["Boots"], into: ["3006"] },
      3006: { gold: { total: 1100, purchasable: true }, tags: ["Boots"], into: ["3172"] },
      3172: { gold: { total: 1600, purchasable: false }, tags: ["Boots"] },
      3031: { gold: { total: 3500, purchasable: true }, tags: ["Damage"] },
      3004: { gold: { total: 2900, purchasable: true }, tags: ["Mana"], into: ["3042"] },
      3042: { gold: { total: 2900, purchasable: false }, tags: ["Mana"] },
      3070: { gold: { total: 400, purchasable: true }, tags: ["Mana"], into: ["3004"] },
      2003: { gold: { total: 50, purchasable: true }, tags: ["Consumable"] },
      3340: { gold: { total: 0, purchasable: true }, tags: ["Trinket"] },
    } });
    expect(catalog[1001]).toEqual({ final: false, boots: false, trinket: false });
    expect(catalog[3006].boots).toBe(true);
    expect(catalog[3031].final).toBe(true);
    expect(catalog[3004].final).toBe(true);
    expect(catalog[3070].final).toBe(false);
    expect(catalog[3340].trinket).toBe(true);
  });

  it("timeline 호출 비율은 경기 ID마다 같은 결정을 내리고 전체 비율에 가깝다", () => {
    const ids = Array.from({ length: 4000 }, (_, index) => `KR_${7000000000 + index * 7919}`);
    const picked = ids.filter(id => lolStatWantsTimeline(id, 0.5)).length;
    expect(picked / ids.length).toBeGreaterThan(0.45);
    expect(picked / ids.length).toBeLessThan(0.55);
    expect(ids.every(id => lolStatWantsTimeline(id, 0.5) === lolStatWantsTimeline(id, 0.5))).toBe(true);
    expect(lolStatWantsTimeline("KR_1", 0)).toBe(false);
    expect(lolStatWantsTimeline("KR_1", 1)).toBe(true);
  });

  it("알 수 없는 티어 필터는 에메랄드+로 대체한다", () => {
    expect(lolStatTierFilter("diamond_plus").tiers).toEqual(["DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"]);
    expect(lolStatTierFilter("x").id).toBe("emerald_plus");
  });
});

function collectorDeps(overrides: Partial<CollectorDeps> = {}) {
  let clock = 0;
  const calls: string[] = [];
  const ingested: string[] = [];
  const saved: CollectorCursor[] = [];
  const sleeps: number[] = [];
  const deps: CollectorDeps = {
    riot: async (_host, path) => {
      calls.push(path);
      if (path.includes("/entries/")) return [{ puuid: `seed-${path}` }, { puuid: "seed-2" }];
      if (path.includes("leagues/by-queue")) return { entries: [{ puuid: "apex" }] };
      if (path.includes("/ids?")) return [`KR_${calls.length}1`, `KR_${calls.length}2`];
      if (path.endsWith("/timeline")) return timeline();
      const id = path.split("/").at(-1)!;
      return { ...match(), metadata: { matchId: id } };
    },
    loadCursor: async () => null,
    saveCursor: async cursor => { saved.push(structuredClone(cursor)); },
    filterNew: async ids => ids.filter(id => !ingested.includes(id)),
    ingest: async matchId => { ingested.push(matchId); return true; },
    items: async () => items,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    log: () => {},
    stopped: () => false,
    ...overrides,
  };
  return { deps, calls, ingested, saved, sleeps };
}
const options = (extra: Partial<ReturnType<typeof parseCollectorArgs>> = {}) =>
  ({ apply: true, per2Min: 20, timelineRatio: 0, idsPerSeed: 2, days: 7, maxMinutes: 0, maxMatches: 6, ...extra });

describe("챔피언 통계 수집기", () => {
  it("티어 구간을 번갈아 돌고, 자체 간격을 지키며, 진행 위치를 저장한다", async () => {
    const { deps, calls, ingested, saved, sleeps } = collectorDeps();
    const summary = await runLolStatCollector(deps, options());
    expect(summary).toMatchObject({ matches: 6, stopReason: "limit", byTier: { IRON: 2, BRONZE: 2, SILVER: 2 } });
    expect(ingested).toHaveLength(6);
    expect(calls[0]).toBe("/lol/league/v4/entries/RANKED_SOLO_5x5/IRON/I?page=1");
    expect(calls[1]).toMatch(/^\/lol\/match\/v5\/matches\/by-puuid\/.+\/ids\?queue=420&type=ranked&startTime=-?\d+&count=2$/);
    expect(calls.some(path => path.startsWith("/lol/league/v4/entries/RANKED_SOLO_5x5/BRONZE/I?"))).toBe(true);
    // 2분 20회면 호출 간격은 6초다.
    expect(sleeps.every(ms => ms <= 6000)).toBe(true);
    expect(sleeps.filter(ms => ms === 6000).length).toBeGreaterThan(5);
    expect(saved.at(-1)!.next).toBeGreaterThan(0);
    // 한 바퀴(40칸)에서 모든 티어가 4번씩 나온다.
    expect(LOL_STAT_BUCKETS).toHaveLength(40);
    const counts = new Map<string, number>(); LOL_STAT_BUCKETS.forEach(bucket => counts.set(bucket.tier, (counts.get(bucket.tier) ?? 0) + 1));
    expect([...counts.values()].every(count => count === 4)).toBe(true);
    expect(counts.size).toBe(10);
  });

  it("키 만료는 바로 멈추고, 호출 제한은 기다렸다가 같은 요청을 다시 보낸다", async () => {
    let limited = false;
    const base = collectorDeps();
    const retry = collectorDeps({ riot: async (host, path) => {
      if (!limited && path.includes("/ids?")) { limited = true; throw new CollectorRiotError("rate_limited", 30); }
      return base.deps.riot(host, path);
    } });
    const summary = await runLolStatCollector(retry.deps, options({ maxMatches: 2 }));
    expect(summary.matches).toBe(2);
    expect(retry.sleeps).toContain(31_000);
    const expired = collectorDeps({ riot: async () => { throw new CollectorRiotError("key_or_permission"); } });
    expect(await runLolStatCollector(expired.deps, options())).toMatchObject({ stopReason: "key_or_permission", matches: 0 });
    expect(expired.saved).toHaveLength(1);
  });

  it("dry-run은 저장하지 않고, timeline은 비율 1이면 경기마다 호출한다", async () => {
    const { deps, calls, ingested, saved } = collectorDeps();
    const summary = await runLolStatCollector(deps, options({ apply: false, timelineRatio: 1, maxMatches: 2 }));
    expect(summary).toMatchObject({ dryRun: true, matches: 2, timelines: 2 });
    expect(ingested).toEqual([]);
    expect(saved).toEqual([]);
    expect(calls.filter(path => path.endsWith("/timeline"))).toHaveLength(2);
  });

  it("이미 처리한 경기는 상세를 호출하지 않는다", async () => {
    const { deps, calls } = collectorDeps({ filterNew: async () => [] });
    const summary = await runLolStatCollector(deps, options({ maxMinutes: 1, maxMatches: 0 }));
    expect(summary.matches).toBe(0);
    expect(summary.duplicates).toBeGreaterThan(0);
    expect(calls.some(path => /\/matches\/KR_\d+$/.test(path))).toBe(false);
  });

  it("옵션과 쓰기 허용 값을 검사한다", () => {
    expect(() => parseCollectorArgs([], {})).toThrow();
    expect(() => parseCollectorArgs(["--apply"], {})).toThrow("LOL_COLLECT_ENABLED");
    expect(() => parseCollectorArgs(["--dry-run", "--per-2min=81"], {})).toThrow();
    expect(parseCollectorArgs(["--apply", "--per-2min=40", "--timeline-ratio=0.25"], { LOL_COLLECT_ENABLED: "true" }))
      .toMatchObject({ apply: true, per2Min: 40, timelineRatio: 0.25, maxMatches: 0 });
    expect(parseCollectorArgs(["--dry-run"], {})).toMatchObject({ apply: false, per2Min: 20, timelineRatio: 0.5, maxMatches: 3 });
  });
});

describe("챔피언 통계 migration", () => {
  const sql = readFileSync("supabase/migrations/20261028130000_lol_champion_stats.sql", "utf8");
  it("익명 집계·서비스 전용 권한을 유지한다", () => {
    expect(sql).not.toMatch(/puuid|riot_id|game_name|request_json/);
    expect(sql).not.toContain("security definer");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("on conflict(match_id) do nothing");
    for (const table of ["lol_stat_processed_matches", "lol_stat_totals", "lol_stat_champions", "lol_stat_bans", "lol_stat_builds", "lol_stat_matchups", "lol_stat_collector_state"]) {
      expect(sql).toContain(`'${table}'`);
    }
  });
});
