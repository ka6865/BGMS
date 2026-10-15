import { describe, expect, it, vi, beforeEach } from "vitest";
import { selectSquadAnalysisCandidates } from "@/lib/pubg-analysis/squadAnalysis";
import {
  prefetchRecentTeamMatchDetails,
  resetSquadDetailPrefetchCooldown,
  SQUAD_DETAIL_PREFETCH_MAX_MATCHES,
} from "@/lib/pubg-analysis/squadDetailPrefetch.server";

vi.mock("@/utils/supabase/server", () => ({ createClient: vi.fn() }));

const NOW = Date.parse("2026-10-16T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const observation = { version: 1, scope: "squad", teamAccountIds: ["a", "b"], status: "observed", issues: [],
  knocks: 3, revives: 1, smokeRescues: 0, tradeKills: 1, tradeLatencyTotalMs: 6000 };
const candidate = (id: string, playedDaysAgo: number, observed: boolean) => ({
  id,
  value: { match_id: id, data: { fullResult: {
    createdAt: daysAgo(playedDaysAgo),
    team: [{ accountId: "a" }, { accountId: "b" }],
    squadObservation: observed ? observation : { ...observation, status: "unsupported" },
  } } },
});

describe("스쿼드 AI 후보 선택", () => {
  it("보관 기간이 남은 경기가 있으면 만료된 경기를 빼고, 그 안에서 관측된 경기를 고른다", () => {
    const picked = selectSquadAnalysisCandidates([
      candidate("old-observed", 20, true), candidate("fresh-observed", 2, true), candidate("fresh-plain", 1, false),
    ], NOW);
    expect(picked.map(c => c.id)).toEqual(["fresh-observed"]);
  });

  it("보관 기간이 남은 경기에 관측이 없으면 그 경기들을 그대로 쓰고, 모두 만료면 전체를 쓴다", () => {
    expect(selectSquadAnalysisCandidates([candidate("old-observed", 20, true), candidate("fresh-plain", 1, false)], NOW)
      .map(c => c.id)).toEqual(["fresh-plain"]);
    expect(selectSquadAnalysisCandidates([candidate("old-a", 20, true), candidate("old-b", 30, false)], NOW)
      .map(c => c.id)).toEqual(["old-a"]);
  });
});

describe("최근 팀 경기 상세 분석 채우기", () => {
  beforeEach(() => resetSquadDetailPrefetchCooldown());

  function db(recent: { match_id: string }[], analyzed: { match_id: string }[]) {
    const calls: Record<string, unknown[]> = {};
    const chain = (table: string) => {
      const q: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in", "gte", "order"]) q[name] = (...args: unknown[]) => { (calls[`${table}.${name}`] ??= []).push(args); return q; };
      q.limit = async () => ({ data: recent, error: null });
      q.then = (resolve: (value: unknown) => unknown) => resolve({ data: analyzed, error: null });
      return q;
    };
    return { supabase: { from: (table: string) => chain(table) } as never, calls };
  }

  it("상세 분석이 없는 최근 팀 경기만 최신순으로 최대 4경기 분석하고, 같은 플레이어는 잠시 다시 하지 않는다", async () => {
    const recent = ["m1", "m2", "m3", "m4", "m5", "m6"].map(match_id => ({ match_id }));
    const { supabase, calls } = db(recent, [{ match_id: "m2" }]);
    const analyzeMatch = vi.fn(async () => true);
    const result = await prefetchRecentTeamMatchDetails({ supabase, nickname: "KangHeeSung_", platform: "steam", analyzeMatch });
    expect(result).toEqual({ status: "done", attempted: SQUAD_DETAIL_PREFETCH_MAX_MATCHES, analyzed: SQUAD_DETAIL_PREFETCH_MAX_MATCHES });
    expect(analyzeMatch.mock.calls.map(([id]) => id).sort()).toEqual(["m1", "m3", "m4", "m5"]);
    expect(calls["pubg_player_matches.in"]?.[0]).toEqual(["game_mode", ["duo", "duo-fpp", "squad", "squad-fpp"]]);

    const again = await prefetchRecentTeamMatchDetails({ supabase, nickname: "kangheesung_", platform: "steam", analyzeMatch });
    expect(again).toMatchObject({ status: "skipped", reason: "cooldown" });
    expect(analyzeMatch).toHaveBeenCalledTimes(4);
  });

  it("모두 분석돼 있으면 아무것도 하지 않고, 한 경기 실패는 나머지를 막지 않는다", async () => {
    const done = db([{ match_id: "m1" }], [{ match_id: "m1" }]);
    const analyze = vi.fn(async () => true);
    expect(await prefetchRecentTeamMatchDetails({ supabase: done.supabase, nickname: "a", platform: "steam", analyzeMatch: analyze }))
      .toMatchObject({ status: "skipped", reason: "no_candidates" });
    expect(analyze).not.toHaveBeenCalled();

    const mixed = db([{ match_id: "x1" }, { match_id: "x2" }], []);
    const flaky = vi.fn(async (id: string) => { if (id === "x1") throw new Error("boom"); return true; });
    expect(await prefetchRecentTeamMatchDetails({ supabase: mixed.supabase, nickname: "b", platform: "steam", analyzeMatch: flaky }))
      .toEqual({ status: "done", attempted: 2, analyzed: 1 });
  });
});
