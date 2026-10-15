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

  it("참가자 기록에 같은 팀 공개 참가자 목록·이동 거리·최장 킬을 넣고, roster 가 없으면 팀원을 비운다", () => {
    const participants = [
      participant("p1", "Alpha"), participant("p2", "Bravo", { walkDistance: undefined }), participant("p3", "Hidden"),
      participant("p4", "Enemy"), { type: "participant", id: "p5", attributes: { stats: { name: "ai_bot", playerId: "ai.123", kills: 0, damageDealt: 0, winPlace: 3 } } },
    ];
    const privatePlayers = [{ platform: "steam", nickname: "Hidden", lower_nickname: "hidden", created_at: "2026-10-01" }];
    const records = buildOfficialParticipantMatchRecords({
      matchId: "match-1", platform: "steam", matchAttr, participants, privatePlayers,
      rosters: [roster(7, ["p1", "p2", "p3", "p5"]), roster(8, ["p4"])],
    });
    expect(records.find(row => row.player_id === "alpha")).toMatchObject({
      teammates: [{ name: "Bravo", account_id: "account.bravo" }], travel_distance: 2401, longest_kill: 64,
    });
    expect(records.find(row => row.player_id === "bravo")).toMatchObject({
      teammates: [{ name: "Alpha", account_id: "account.alpha" }], travel_distance: null,
    });
    expect(records.find(row => row.player_id === "enemy")?.teammates).toEqual([]);

    const withoutRoster = buildOfficialParticipantMatchRecords({ matchId: "match-1", platform: "steam", matchAttr, participants, privatePlayers: [] });
    expect(withoutRoster.every(row => row.teammates === null)).toBe(true);
  });

  it("저장 레코드는 형식이 맞는 팀원 목록만 보내고 조회용 팀원 이름은 보내지 않는다", () => {
    const base: PlayerMatchRecord = {
      player_id: "alpha", platform: "steam", match_id: "m", played_at: matchAttr.createdAt, game_mode: "squad",
      map_name: "Tiger_Main", kills: 1, damage: 120, win_place: 3, match_type: "official",
    };
    const teammates = [{ name: "Bravo", account_id: "account.bravo" }];
    expect(toPlayerMatchWriteRecord({ ...base, teammates, travel_distance: 2401, longest_kill: 0, teammate_names: ["Bravo"] }))
      .toEqual({ ...base, teammates, travel_distance: 2401, longest_kill: 0 });
    expect(toPlayerMatchWriteRecord({ ...base, teammates: [], travel_distance: null })).toEqual({ ...base, teammates: [] });
    expect(toPlayerMatchWriteRecord({ ...base, teammates: null, travel_distance: null, longest_kill: -1 })).toEqual(base);
    expect(toPlayerMatchWriteRecord({ ...base, teammates: [{ name: "Bot", account_id: "ai.1" }] })).toEqual(base);
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

describe("팀원 이름 고르기", () => {
  function privacyDb(privacy: unknown[] | null) {
    const settingsQuery = { select: () => settingsQuery, eq: () => settingsQuery,
      maybeSingle: async () => privacy ? ({ data: { value: JSON.stringify(privacy) }, error: null }) : ({ data: null, error: { message: "down" } }) };
    const from = vi.fn(() => settingsQuery);
    return { db: { from } as never, from };
  }

  it("저장된 팀원 중 지금 비공개인 사람(닉네임·계정 ID)을 빼고 최대 4명을 돌려준다", async () => {
    const { db } = privacyDb([
      { platform: "steam", nickname: "Renamed", lower_nickname: "renamed", account_id: "account.hidden", created_at: "2026-10-01" },
      { platform: "all", nickname: "Gone", lower_nickname: "gone", created_at: "2026-10-01" },
    ]);
    const result = await readTeammateNames(db, "steam", [
      { match_id: "m1", teammates: [
        { name: "Bravo", account_id: "account.bravo" }, { name: "OldName", account_id: "account.hidden" },
        { name: "Gone", account_id: "account.gone" }, { name: "Charlie", account_id: "account.charlie" },
      ] },
      { match_id: "m2", teammates: [] },
      { match_id: "m3", teammates: null },
    ]);
    expect(result.get("m1")).toEqual(["Bravo", "Charlie"]);
    expect(result.has("m2")).toBe(false);
    expect(result.has("m3")).toBe(false);
  });

  it("팀원이 없으면 비공개 목록을 읽지 않고, 읽기 실패는 팀원 표시만 생략한다", async () => {
    const empty = privacyDb([]);
    expect((await readTeammateNames(empty.db, "steam", [{ match_id: "m1" }])).size).toBe(0);
    expect(empty.from).not.toHaveBeenCalled();

    const failed = privacyDb(null);
    expect((await readTeammateNames(failed.db, "steam", [{ match_id: "m1", teammates: [{ name: "Bravo", account_id: "account.bravo" }] }])).size).toBe(0);
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
