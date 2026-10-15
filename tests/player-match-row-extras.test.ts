import { describe, expect, it, vi } from "vitest";
import {
  buildOfficialParticipantMatchRecords,
  buildParticipantTeamIds,
  observedLongestKill,
  observedTravelDistance,
} from "@/lib/pubg/playerMatchesIngest";
import { toPlayerMatchWriteRecord, type PlayerMatchRecord } from "@/lib/pubg/playerMatches";
import { readTeammateNames } from "@/lib/pubg/playerMatchTeammates";
import { buildBasicMatchSummary, buildMatchSummary, getObservedMovementStat } from "@/lib/pubg-analysis/matchSummary";
import { buildRecentTeammateOverview } from "@/lib/stats/recentTeammateOverview";

const matchAttr = { createdAt: "2026-10-15T10:00:00Z", gameMode: "squad", mapName: "Tiger_Main", matchType: "official", shardId: "steam" };

function participant(id: string, name: string, stats: Record<string, unknown> = {}) {
  return {
    type: "participant",
    id,
    attributes: { stats: {
      name, playerId: `account.${name.toLowerCase()}`, kills: 1, damageDealt: 120.6, winPlace: 3,
      DBNOs: 1, timeSurvived: 900, walkDistance: 1500.4, rideDistance: 900.2, swimDistance: 0, longestKill: 63.6,
      ...stats,
    } },
  };
}

function roster(teamId: unknown, ids: string[]) {
  return { type: "roster", attributes: { stats: { teamId } }, relationships: { participants: { data: ids.map(id => ({ type: "participant", id })) } } };
}

describe("기본 전적 보조 값 관측", () => {
  it("이동 거리는 세 거리가 모두 관측될 때만 m 정수로 합산한다", () => {
    expect(observedTravelDistance({ walkDistance: 1500.4, rideDistance: 900.2, swimDistance: 0 })).toBe(2401);
    expect(observedTravelDistance({ walkDistance: 1500.4, rideDistance: 900.2 })).toBeNull();
    expect(observedTravelDistance({ walkDistance: -1, rideDistance: 0, swimDistance: 0 })).toBeNull();
  });

  it("최장 킬은 공식 0 을 보존하고 잘못된 값은 버린다", () => {
    expect(observedLongestKill({ longestKill: 0 })).toBe(0);
    expect(observedLongestKill({ longestKill: 183.4 })).toBe(183);
    expect(observedLongestKill({ longestKill: "183" })).toBeNull();
  });

  it("roster 의 teamId 를 참가자에 연결하고 중복 소속은 제외한다", () => {
    const teams = buildParticipantTeamIds([
      roster(7, ["p1", "p2"]),
      roster(8, ["p3", "p2"]),
      roster(40000, ["p4"]),
      { type: "participant" },
    ]);
    expect(teams.get("p1")).toBe(7);
    expect(teams.get("p3")).toBe(8);
    expect(teams.has("p2")).toBe(false);
    expect(teams.has("p4")).toBe(false);
  });

  it("참가자 기록에 팀 번호·이동 거리·최장 킬을 넣고, roster 가 없으면 팀 번호를 비운다", () => {
    const participants = [participant("p1", "Alpha"), participant("p2", "Bravo", { walkDistance: undefined })];
    const records = buildOfficialParticipantMatchRecords({
      matchId: "match-1", platform: "steam", matchAttr, participants, privatePlayers: [], rosters: [roster(7, ["p1", "p2"])],
    });
    expect(records.find(row => row.player_id === "alpha")).toMatchObject({ team_id: 7, travel_distance: 2401, longest_kill: 64 });
    expect(records.find(row => row.player_id === "bravo")).toMatchObject({ team_id: 7, travel_distance: null, longest_kill: 64 });

    const withoutRoster = buildOfficialParticipantMatchRecords({ matchId: "match-1", platform: "steam", matchAttr, participants, privatePlayers: [] });
    expect(withoutRoster.every(row => row.team_id === null)).toBe(true);
  });

  it("저장 레코드는 관측된 보조 값만 보내고 조회용 팀원 이름은 보내지 않는다", () => {
    const base: PlayerMatchRecord = {
      player_id: "alpha", platform: "steam", match_id: "m", played_at: matchAttr.createdAt, game_mode: "squad",
      map_name: "Tiger_Main", kills: 1, damage: 120, win_place: 3, match_type: "official",
    };
    expect(toPlayerMatchWriteRecord({ ...base, team_id: 7, travel_distance: 2401, longest_kill: 0, teammate_names: ["bravo"] }))
      .toEqual({ ...base, team_id: 7, travel_distance: 2401, longest_kill: 0 });
    expect(toPlayerMatchWriteRecord({ ...base, team_id: null, travel_distance: null, longest_kill: -1 })).toEqual(base);
  });
});

describe("전적 요약의 보조 값", () => {
  const row = {
    match_id: "m1", player_id: "alpha", platform: "steam", played_at: matchAttr.createdAt, game_mode: "squad",
    map_name: "Tiger_Main", kills: 1, damage: 120, win_place: 3, match_type: "official",
  };

  it("기본 전적은 저장된 이동 거리·최장 킬과 팀원 이름을 그대로 쓴다", () => {
    const summary = buildBasicMatchSummary({ ...row, travel_distance: 7210, longest_kill: 64, teammate_names: ["bravo", "charlie"] });
    expect(getObservedMovementStat(summary, "travelDistance")).toBe(7210);
    expect(getObservedMovementStat(summary, "longestKill")).toBe(64);
    expect(summary.teammateNames).toEqual(["bravo", "charlie"]);

    const legacy = buildBasicMatchSummary(row);
    expect(getObservedMovementStat(legacy, "travelDistance")).toBeNull();
    expect(getObservedMovementStat(legacy, "longestKill")).toBeNull();
    expect(legacy.teammateNames).toBeUndefined();
  });

  it("분석 결과 요약은 공식 참가자 통계와 팀 구성에서 값을 만든다", () => {
    const summary = buildMatchSummary({
      matchId: "m2", matchType: "official",
      stats: { name: "Alpha", kills: 2, damageDealt: 300, winPlace: 1, walkDistance: 2000, rideDistance: 500, swimDistance: 10, longestKill: 120.4 },
      team: [{ name: "Alpha" }, { name: "Bravo" }, { name: "Charlie" }],
    });
    expect(summary && getObservedMovementStat(summary, "travelDistance")).toBe(2510);
    expect(summary && getObservedMovementStat(summary, "longestKill")).toBe(120);
    expect(summary?.teammateNames).toEqual(["Bravo", "Charlie"]);
  });
});

describe("팀원 조회", () => {
  function teammateDb(rows: unknown[], privacy: unknown[] = [], error: unknown = null) {
    const calls: { or?: string } = {};
    const matchQuery = {
      select: () => matchQuery, eq: () => matchQuery,
      or: (filter: string) => { calls.or = filter; return matchQuery; },
      limit: async () => ({ data: error ? null : rows, error }),
    };
    const settingsQuery = { select: () => settingsQuery, eq: () => settingsQuery,
      maybeSingle: async () => ({ data: { value: JSON.stringify(privacy) }, error: null }) };
    const from = vi.fn((table: string) => table === "system_settings" ? settingsQuery : matchQuery);
    return { db: { from } as never, calls, from };
  }

  it("같은 경기·같은 팀의 다른 참가자만 이름순으로 돌려주고 비공개 플레이어는 뺀다", async () => {
    const { db, calls } = teammateDb([
      { match_id: "m1", team_id: 7, player_id: "alpha", account_id: "account.alpha" },
      { match_id: "m1", team_id: 7, player_id: "charlie", account_id: "account.charlie" },
      { match_id: "m1", team_id: 7, player_id: "bravo", account_id: "account.bravo" },
      { match_id: "m1", team_id: 7, player_id: "hidden", account_id: "account.hidden" },
      { match_id: "m1", team_id: 8, player_id: "enemy", account_id: "account.enemy" },
    ], [{ nickname: "hidden", platform: "steam" }]);
    const result = await readTeammateNames(db, "steam", [
      { match_id: "m1", team_id: 7, player_id: "alpha", account_id: "account.alpha" },
      { match_id: "m2", team_id: null, player_id: "alpha", account_id: "account.alpha" },
    ]);
    expect(calls.or).toBe("and(match_id.eq.m1,team_id.eq.7)");
    expect(result.get("m1")).toEqual(["bravo", "charlie"]);
    expect(result.has("m2")).toBe(false);
  });

  it("팀 번호가 없으면 조회하지 않고, 조회 실패는 빈 결과로 끝낸다", async () => {
    const empty = teammateDb([]);
    expect((await readTeammateNames(empty.db, "steam", [{ match_id: "m1", player_id: "alpha" }])).size).toBe(0);
    expect(empty.from).not.toHaveBeenCalled();

    const failed = teammateDb([], [], { message: "timeout" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await readTeammateNames(failed.db, "steam", [{ match_id: "m1", team_id: 1, player_id: "alpha" }])).size).toBe(0);
    errorSpy.mockRestore();
  });
});

describe("함께한 팀원 카드 집계", () => {
  function summary(id: string, teammates: string[] | undefined, winPlace: number | null) {
    return {
      ...buildBasicMatchSummary({ match_id: id, player_id: "alpha", platform: "steam", played_at: matchAttr.createdAt,
        game_mode: "squad", map_name: "Tiger_Main", kills: 0, damage: 0, win_place: winPlace ?? undefined, match_type: "official",
        teammate_names: teammates }),
    };
  }

  it("2경기 이상 함께한 팀원만 경기 수 순으로 최대 5명 보여 준다", () => {
    const summaries = {
      a: summary("a", ["bravo", "charlie"], 2),
      b: summary("b", ["bravo"], 10),
      c: summary("c", ["bravo", "charlie", "delta"], null),
      d: summary("d", undefined, 5),
      e: { ...summary("e", undefined, 4), teammateNames: ["Bravo"] },
    };
    const rows = buildRecentTeammateOverview({ matchIds: ["a", "b", "c", "d", "e"], summaries, summaryStatus: "ready" });
    expect(rows).toEqual([
      { name: "bravo", games: 4, averageRank: "5.3" },
      { name: "charlie", games: 2, averageRank: "2.0" },
    ]);
  });
});
