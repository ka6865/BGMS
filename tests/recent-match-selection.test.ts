import { describe, expect, it } from "vitest";
import {
  buildBestMatchSelectionKey,
  buildMatchSelectionKey,
  normalizeMatchId,
  normalizeBenchmarkScore,
  selectBestMatches,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "@/lib/pubg-analysis/recentMatchSelection";

function candidate(
  id: string | null,
  createdAt: string | null,
  matchType: string | null,
  gameMode: string | null,
  mapName: string | null,
  sourceIndex: number,
  score: number,
): RecentMatchCandidate<{ score: number }> {
  return { id, createdAt, matchType, gameMode, mapName, sourceIndex, value: { score } };
}

function bestCandidate(
  id: string,
  createdAt: string | null,
  sourceIndex: number,
  score?: unknown,
): RecentMatchCandidate<{ benchmark?: { score?: unknown } }> {
  return {
    id,
    createdAt,
    matchType: "official",
    gameMode: "squad",
    mapName: "Erangel_Main",
    sourceIndex,
    value: { benchmark: score === undefined ? undefined : { score } },
  };
}

describe("recent match selection", () => {
  it("최신 valid unique 10개를 score와 무관하게 선택한다", () => {
    const result = selectRecentMatches([
      candidate("shard:a", "2026-08-01T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 1),
      candidate("a", "2026-08-02T00:00:00.000Z", "competitive", "squad", "Erangel_Main", 1, 99),
      candidate("b", "2026-08-03T00:00:00.000Z", "airoyale", "squad", "Erangel_Main", 2, 100),
      candidate("c", "2026-08-04T00:00:00.000Z", "unknown", "normal-training", "Erangel_Main", 3, 100),
      candidate("d", "2026-08-05T00:00:00.000Z", "official", "squad", "SafeHouse_Main", 4, 100),
    ]);

    expect(result.selected.map(({ id }) => id)).toEqual(["a"]);
    expect(result.rejected.map(({ reason }) => reason)).toEqual(expect.arrayContaining([
      "duplicate_id",
      "match_type_excluded",
      "mode_excluded",
      "map_excluded",
    ]));
    expect(buildMatchSelectionKey(["a", "a"], result.selectionVersion)).toBe(
      buildMatchSelectionKey(["a"], result.selectionVersion),
    );
    expect(buildMatchSelectionKey(["a"], "recent-valid-10-v2")).not.toBe(
      buildMatchSelectionKey(["a"], result.selectionVersion),
    );
  });

  it("유효 후보가 10개를 넘으면 최신순 10개만 남기고 old high score를 무시한다", () => {
    const candidates = Array.from({ length: 11 }, (_, index) => candidate(
      "match-" + index,
      new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
      "official",
      "squad",
      "Erangel_Main",
      index,
      index === 0 ? 100 : 1,
    ));
    expect(selectRecentMatches(candidates).selected.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => "match-" + (10 - index)),
    );
  });

  it("공식·경쟁전·unknown·빈 matchType은 허용하고 airoyale·seasonal만 제외한다", () => {
    const result = selectRecentMatches([
      candidate("official", "2026-08-01T00:00:00.000Z", "OFFICIAL", "squad", "Erangel_Main", 0, 0),
      candidate("competitive", "2026-08-02T00:00:00.000Z", "competitive", "squad", "Erangel_Main", 1, 0),
      candidate("unknown", "2026-08-03T00:00:00.000Z", "unknown", "squad", "Erangel_Main", 2, 0),
      candidate("empty", "2026-08-04T00:00:00.000Z", "", "squad", "Erangel_Main", 3, 0),
      candidate("missing", "2026-08-05T00:00:00.000Z", null, "squad", "Erangel_Main", 4, 0),
      candidate("ai", "2026-08-06T00:00:00.000Z", "AIROYALE", "squad", "Erangel_Main", 5, 0),
      candidate("season", "2026-08-07T00:00:00.000Z", "seasonal", "squad", "Erangel_Main", 6, 0),
    ]);
    expect(result.selected.map(({ id }) => id)).toEqual([
      "missing", "empty", "unknown", "competitive", "official",
    ]);
    expect(result.rejected.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: "ai", reason: "match_type_excluded" },
      { id: "season", reason: "match_type_excluded" },
    ]);
  });

  it("matchType은 정확히 airoyale·seasonal일 때만 제외한다", () => {
    const result = selectRecentMatches([
      candidate("seasonal-variant", "2026-08-01T00:00:00.000Z", "seasonal-variant", "squad", "Erangel_Main", 0, 0),
      candidate("not-airoyale", "2026-08-02T00:00:00.000Z", "notairoyale", "squad", "Erangel_Main", 1, 0),
      candidate("seasonal", "2026-08-03T00:00:00.000Z", "seasonal", "squad", "Erangel_Main", 2, 0),
      candidate("airoyale", "2026-08-04T00:00:00.000Z", "AIROYALE", "squad", "Erangel_Main", 3, 0),
    ]);

    expect(result.selected.map(({ id }) => id)).toEqual(["not-airoyale", "seasonal-variant"]);
    expect(result.rejected.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: "seasonal", reason: "match_type_excluded" },
      { id: "airoyale", reason: "match_type_excluded" },
    ]);
  });

  it("제외 mode/map token은 대소문자를 무시하며 score와 winPlace를 보지 않는다", () => {
    const result = selectRecentMatches([
      candidate("event", "2026-08-01T00:00:00.000Z", "official", "EVENT-squad", "Erangel_Main", 0, 0),
      candidate("arcade", "2026-08-02T00:00:00.000Z", "official", "arcade-squad", "Erangel_Main", 1, 0),
      candidate("custom", "2026-08-03T00:00:00.000Z", "official", "custom-squad", "Erangel_Main", 2, 0),
      candidate("training", "2026-08-04T00:00:00.000Z", "official", "training", "Erangel_Main", 3, 0),
      candidate("safehouse", "2026-08-05T00:00:00.000Z", "official", "squad", "SAFEHOUSE_MAIN", 4, 0),
      candidate("range", "2026-08-06T00:00:00.000Z", "official", "squad", "Range_Main", 5, 0),
      candidate("map-training", "2026-08-07T00:00:00.000Z", "official", "squad", "training_ground", 6, 0),
      candidate("new", "2026-08-08T00:00:00.000Z", "official", "squad", "Erangel_Main", 7, 1_000_000),
    ]);
    expect(result.selected.map(({ id }) => id)).toEqual(["new"]);
    expect(result.rejected.map(({ reason }) => reason)).toEqual([
      "mode_excluded", "mode_excluded", "mode_excluded", "mode_excluded",
      "map_excluded", "map_excluded", "map_excluded",
    ]);
  });

  it("중복 winner는 parseable newest date, sourceIndex, canonical ID 순서로 결정하고 duplicate를 기록한다", () => {
    const result = selectRecentMatches([
      candidate("shard:same", "2026-08-01T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0),
      candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 9, 0),
      candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 1, 0),
      candidate("same", "not-a-date", "official", "squad", "Erangel_Main", -1, 0),
    ]);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ id: "same", sourceIndex: 1 });
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.every(({ reason }) => reason === "duplicate_id")).toBe(true);
  });

  it("중복 후보의 score가 바뀌어도 metadata tie가 같으면 같은 payload를 선택한다", () => {
    const first = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 10);
    const lowerScoreDuplicate = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 2);
    const higherScoreDuplicate = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 999);

    const lowerResult = selectRecentMatches([first, lowerScoreDuplicate]);
    const higherResult = selectRecentMatches([first, higherScoreDuplicate]);

    expect(lowerResult.selected[0]?.value).toEqual(first.value);
    expect(higherResult.selected[0]?.value).toEqual(first.value);
  });

  it("canonical/date/source가 같은 duplicate는 raw ID lexical tie로 입력 순서와 무관하게 선택한다", () => {
    const shardId = candidate("shard:same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 999);
    const bareId = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 2);

    const forward = selectRecentMatches([shardId, bareId]);
    const reverse = selectRecentMatches([bareId, shardId]);

    expect(forward.selected[0]?.value).toEqual(bareId.value);
    expect(reverse.selected[0]?.value).toEqual(bareId.value);
  });

  it("canonical/date/source/raw ID가 모두 같은 payload도 canonical tie로 입력 순서와 무관하게 선택한다", () => {
    const payloadA = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0) as RecentMatchCandidate<any>;
    payloadA.value = { payload: "alpha", nested: { z: 1, a: true } };
    const payloadB = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0) as RecentMatchCandidate<any>;
    payloadB.value = { nested: { a: true, z: 1 }, payload: "beta" };

    const forward = selectRecentMatches([payloadB, payloadA]);
    const reverse = selectRecentMatches([payloadA, payloadB]);

    expect(forward.selected[0]?.value).toEqual(payloadA.value);
    expect(reverse.selected[0]?.value).toEqual(payloadA.value);
  });

  it("circular·비정상 duplicate payload도 tie-break에서 예외를 일으키지 않는다", () => {
    const circularA = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0) as RecentMatchCandidate<any>;
    circularA.value = { payload: "alpha" };
    circularA.value.self = circularA.value;
    const circularB = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0) as RecentMatchCandidate<any>;
    circularB.value = { payload: "beta" };
    circularB.value.self = circularB.value;

    expect(() => selectRecentMatches([circularB, circularA])).not.toThrow();
    expect(selectRecentMatches([circularB, circularA]).selected[0]?.value.payload).toBe("alpha");
  });

  it("동일 공유 참조와 ownKeys 예외 Proxy가 있어도 canonical tie가 종료된다", () => {
    const shared = { marker: "shared" };
    const throwingProxy = new Proxy({}, {
      ownKeys: () => { throw new Error("ownKeys failed"); },
    });
    const payloadA = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0) as RecentMatchCandidate<any>;
    payloadA.value = { payload: "alpha", left: shared, right: shared, malformed: throwingProxy };
    const payloadB = candidate("same", "2026-08-02T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0) as RecentMatchCandidate<any>;
    payloadB.value = { payload: "beta", left: shared, right: shared, malformed: throwingProxy };

    expect(() => selectRecentMatches([payloadB, payloadA])).not.toThrow();
    expect(selectRecentMatches([payloadB, payloadA]).selected[0]?.value.payload).toBe("alpha");
  });

  it("invalid date는 valid date 뒤에 정렬되고 stable tie는 sourceIndex/ID를 따른다", () => {
    const result = selectRecentMatches([
      candidate("z", "not-a-date", "official", "squad", "Erangel_Main", 0, 0),
      candidate("b", "2026-08-01T00:00:00.000Z", "official", "squad", "Erangel_Main", 2, 0),
      candidate("a", "2026-08-01T00:00:00.000Z", "official", "squad", "Erangel_Main", 1, 0),
      candidate("c", null, "official", "squad", "Erangel_Main", 3, 0),
    ]);
    expect(result.selected.map(({ id }) => id)).toEqual(["a", "b", "z", "c"]);
  });

  it("missing ID는 거절하며 over_limit도 결정적 rejection으로 기록한다", () => {
    const result = selectRecentMatches([
      candidate(null, "2026-08-01T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 0),
      ...Array.from({ length: 3 }, (_, index) => candidate(
        `match-${index}`,
        new Date(Date.UTC(2026, 7, 2, index)).toISOString(),
        "official",
        "squad",
        "Erangel_Main",
        index + 1,
        0,
      )),
    ], { limit: 2 });
    expect(result.selected.map(({ id }) => id)).toEqual(["match-2", "match-1"]);
    expect(result.rejected.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: null, reason: "missing_id" },
      { id: "match-0", reason: "over_limit" },
    ]);
  });

  it("selection key는 selection version과 canonical ID dedupe lexical sort로 순서 독립적이다", () => {
    const first = buildMatchSelectionKey(["shard:b", "a", "b", "a"]);
    const second = buildMatchSelectionKey(["b", "a", "shard:a"]);
    expect(first).toBe(second);
    expect(buildMatchSelectionKey(["a"], "recent-valid-10-v2")).not.toBe(first);
    expect(normalizeMatchId("  shard:abc  ")).toBe("abc");
    expect(normalizeMatchId(42)).toBe("42");
    expect(normalizeMatchId(" ")).toBeNull();
    expect(normalizeMatchId(null)).toBeNull();
  });

  it("best5는 latest pool 안에서 finite score 내림차순, 동점은 date/source/ID 순으로 선택한다", () => {
    const sameDate = "2026-08-02T00:00:00.000Z";
    const selected = selectBestMatches([
      bestCandidate("score-high", "2026-08-01T00:00:00.000Z", 99, "4"),
      bestCandidate("tie-z", sameDate, 2, 2),
      bestCandidate("tie-b", sameDate, 1, 2),
      bestCandidate("tie-a", sameDate, 1, 2),
      bestCandidate("zero-newest", "2026-08-03T00:00:00.000Z", 8, "not-a-number"),
      bestCandidate("zero-missing", "2026-08-04T00:00:00.000Z", 7),
      bestCandidate("zero-infinity", "2026-08-05T00:00:00.000Z", 6, Infinity),
    ]);

    expect(selected.map(({ id }) => id)).toEqual([
      "score-high", "tie-a", "tie-b", "tie-z", "zero-infinity",
    ]);
    expect(normalizeBenchmarkScore("not-a-number")).toBe(0);
    expect(normalizeBenchmarkScore(Infinity)).toBe(0);
    expect(normalizeBenchmarkScore("2.5")).toBe(2.5);
  });

  it("best5 cache key는 순서와 normalized score를 identity에 포함한다", () => {
    const first = selectBestMatches([
      bestCandidate("a", "2026-08-02T00:00:00.000Z", 0, "3"),
      bestCandidate("b", "2026-08-01T00:00:00.000Z", 1, 2),
    ]);
    const sameNormalizedScore = selectBestMatches([
      bestCandidate("a", "2026-08-02T00:00:00.000Z", 0, 3),
      bestCandidate("b", "2026-08-01T00:00:00.000Z", 1, 2),
    ]);
    const changedScore = selectBestMatches([
      bestCandidate("a", "2026-08-02T00:00:00.000Z", 0, 3.1),
      bestCandidate("b", "2026-08-01T00:00:00.000Z", 1, 2),
    ]);

    expect(buildBestMatchSelectionKey(first)).toBe(buildBestMatchSelectionKey(sameNormalizedScore));
    expect(buildBestMatchSelectionKey(first)).not.toBe(buildBestMatchSelectionKey(changedScore));
    expect(buildBestMatchSelectionKey(first)).not.toBe(buildBestMatchSelectionKey([...first].reverse()));
  });
});
