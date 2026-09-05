import { describe, expect, it } from "vitest";
import {
  matchDebateStatPairs,
  normalizeAiSummaryDebatePayload,
  normalizeAiSummaryFinalJson,
  sanitizeAiSummaryDebateQuestion,
  sanitizeUnsupportedAiSummaryBenchmarkLanguage,
} from "../lib/pubg-analysis/aiSummaryDebate";

function createDebateIssue(overrides: Record<string, unknown> = {}) {
  return {
    topic: "기본 주제",
    question: "기본 질문",
    kindOpinion: "순한 의견",
    spicyOpinion: "매운 의견",
    winner: "kind",
    reason: "기본 근거",
    evaluation: "기본 평가",
    userStats: [],
    benchmarkStats: [],
    ...overrides,
  };
}

function createValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    signature: "검증된 칭호",
    signatureSub: "검증된 칭호의 이유",
    finalVerdict: "유효한 최종 판정",
    debateIssues: [createDebateIssue(), createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })],
    actionItems: [{ icon: "target", title: "목표", desc: "설명" }],
    ...overrides,
  };
}

describe("AI summary debate stat pairing", () => {
  it("preserves a natural debate question instead of replacing it with a generic notice", () => {
    const question = "상위권과 비교했을 때 화력은 충분한가?";
    const duelQuestion = "상위권과 비교했을 때 1:1 결정력은 충분한가?";
    const canonicalEvidence = {
      damage_average: {
        user: { label: "평균 화력", value: "320" },
        benchmark: { label: "동일 티어 평균 화력", value: "300" },
      },
    };

    expect(sanitizeAiSummaryDebateQuestion(
      question,
      "화력",
      canonicalEvidence,
      { hasBenchmarkEvidence: true },
    )).toBe(question);
    expect(sanitizeAiSummaryDebateQuestion(
      duelQuestion,
      "1:1 결정력",
      canonicalEvidence,
      { hasBenchmarkEvidence: true },
    )).toBe(duelQuestion);
  });

  it.each(["화력", "1:1 결정력", "유틸리티 활용"])(
    "turns a previously cached generic notice into a topic-specific %s debate question",
    (topic) => {
      expect(sanitizeAiSummaryDebateQuestion(
        "검증된 경기 지표를 바탕으로 분석합니다.",
        topic,
      )).toBe(`${topic}에 대한 두 코치의 평가는?`);
    },
  );

  it("does not restore unsafe numbers or unsupported benchmark questions", () => {
    const canonicalEvidence = {
      damage_average: {
        user: { label: "평균 화력", value: "320" },
        benchmark: { label: "동일 티어 평균 화력", value: "300" },
      },
    };

    expect(sanitizeAiSummaryDebateQuestion(
      "상위권 비밀 지표 999가 충분한가?",
      "화력",
      canonicalEvidence,
      { hasBenchmarkEvidence: true },
    )).toBe("화력에 대한 두 코치의 평가는?");
    expect(sanitizeAiSummaryDebateQuestion(
      "상위권과 비교했을 때 유틸리티 활용은 충분한가?",
      "유틸리티 활용",
      canonicalEvidence,
      { hasBenchmarkEvidence: false },
    )).toBe("유틸리티 활용에 대한 두 코치의 평가는?");
  });

  it("does not preserve provider-fabricated numbers in supported benchmark prose", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "상위권 평균 화력 999 대비 내 평균 화력 999가 좋습니다.",
      {
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).toBe("검증된 경기 지표를 바탕으로 분석합니다.");
    expect(sanitized).not.toContain("999");
  });

  it("keeps an explicitly provable higher-is-better comparison", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "상위권 평균 화력 999 대비 내 평균 화력 888이 높습니다.",
      {
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).not.toMatch(/999|888/);
    expect(sanitized).toContain("320");
    expect(sanitized).toContain("300");
    expect(sanitized).toContain("높습니다");
  });

  it("fails closed when a supported comparison still contains an unverified direction", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "상위권 평균 화력 999 대비 내 평균 화력 888이 좋습니다.",
      {
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).toBe("검증된 경기 지표를 바탕으로 분석합니다.");
    expect(sanitized).not.toMatch(/999|888|좋습니다|상위권|벤치마크/);
  });

  it("canonicalizes parenthesized user metrics in benchmark prose", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "1:1 교전에서의 괴물 같은 결정력(79%)과 평균 화력(298)은 벤치마크를 압도합니다.",
      {
        duel_win_rate: {
          user: { label: "1:1 교전 승률", value: "67%" },
          benchmark: { label: "동일 티어 평균 1:1 교전 승률", value: "61%" },
        },
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).not.toMatch(/79|298/);
    expect(sanitized).toContain("67%");
    expect(sanitized).toContain("320");
  });

  it("neutralizes provider directional claims after canonicalizing supported metrics", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "1:1 교전에서의 괴물 같은 결정력(999%)과 평균 화력(998)은 벤치마크를 압도합니다.",
      {
        duel_win_rate: {
          user: { label: "1:1 교전 승률", value: "72%" },
          benchmark: { label: "동일 티어 평균 1:1 교전 승률", value: "61%" },
        },
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).not.toMatch(/999|998/);
    expect(sanitized).not.toContain("벤치마크를 압도");
    expect(sanitized).toContain("검증된 경기 지표를 바탕으로 분석합니다");
  });

  it("canonicalizes an explicitly user-owned metric without a benchmark qualifier", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "내 평균 화력 999를 기준으로 훈련하세요.",
      {
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).not.toContain("999");
    expect(sanitized).toContain("320");
  });

  it.each([
    "내 화력 999를 기준으로 훈련하세요.",
    "평균 화력 999는 상위권 평균 300보다 좋습니다.",
    "상위권 평균 화력은 777입니다.",
    "평균 화력은 상위권 수준입니다.",
    "현재 기록은 999%입니다.",
    "평균 화력 320과 비밀 지표 777은 상위권보다 좋습니다.",
  ])("drops unverifiable measured/benchmark clause: %s", (input) => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(input, {
      damage_average: {
        user: { label: "평균 화력", value: "320" },
        benchmark: { label: "동일 티어 평균 화력", value: "300" },
      },
    });

    expect(sanitized).toBe("검증된 경기 지표를 바탕으로 분석합니다.");
    expect(sanitized).not.toMatch(/999|777|300|상위권|벤치마크|좋습니다/);
  });

  it("canonicalizes duration units while preserving unrelated counts", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "상위권 평균 백업 속도 12000ms 대비 내 백업 속도 8790ms로 최근 3판을 점검했습니다.",
      {
        backup_latency: {
          user: { label: "백업 속도", value: "8.79s" },
          benchmark: { label: "동일 티어 평균 백업 속도", value: "12s" },
        },
      },
    );

    expect(sanitized).not.toContain("12000");
    expect(sanitized).not.toContain("8790");
    expect(sanitized).toContain("12s");
    expect(sanitized).toContain("8.79s");
    expect(sanitized).toContain("최근 3판");
  });

  it("does not let a sample-window count exempt an unrelated measured number", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "최근 3판에서 999킬을 기록했습니다.",
      {},
    );

    expect(sanitized).toBe("검증된 경기 지표를 바탕으로 분석합니다.");
    expect(sanitized).not.toContain("999");
  });

  it("drops ambiguous supported comparisons instead of retaining fabricated numbers", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "상위권 평균 화력 999 대비 동일 티어 평균 화력 998을 비교했습니다.",
      {
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    );

    expect(sanitized).not.toMatch(/999|998|997/);
  });

  it("removes unknown benchmark claims while keeping an unrelated user count", () => {
    const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
      "엘리트 평균 비밀 지표 777은 참고하지 않습니다. 최근 5판을 분석했습니다.",
      {},
    );

    expect(sanitized).not.toContain("777");
    expect(sanitized).toContain("최근 5판");
  });

  it("drops the reproduced total-throws versus smoke-rescue-rate mismatch", () => {
    const pairs = matchDebateStatPairs(
      [{ label: "총 투척 횟수", value: "22회" }],
      [{ label: "아군 기절 대비 연막 구출률", value: "11%" }],
    );

    expect(pairs).toEqual([]);
    expect(normalizeAiSummaryDebatePayload(createValidPayload({
      finalVerdict: "텍스트 코칭은 유지합니다.",
      debateIssues: [createDebateIssue({
        topic: "1:1 결정력",
        question: "교전 결정력이 충분한가?",
        kindOpinion: "수치상 안정적입니다.",
        spicyOpinion: "더 날카로워질 여지가 있습니다.",
        winner: "kind",
        userStats: [{ label: "총 투척 횟수", value: "22회" }],
        benchmarkStats: [{ label: "아군 기절 대비 연막 구출률", value: "11%" }],
      }), createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })],
    }))?.debateIssues).toEqual([{
      topic: "1:1 결정력",
      question: "교전 결정력이 충분한가?",
      kindOpinion: "수치상 안정적입니다.",
      spicyOpinion: "더 날카로워질 여지가 있습니다.",
      winner: "kind",
      reason: "기본 근거",
      evaluation: "기본 평가",
      userStats: [],
      benchmarkStats: [],
    }, createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })]);
  });

  it("keeps same-label metrics and pairs only by metric identity, not array index", () => {
    const pairs = matchDebateStatPairs(
      [
        { label: "1:1 교전 승률", value: "79%" },
        { label: "총 투척 횟수", value: "22회" },
      ],
      [
        { label: "아군 기절 대비 연막 구출률", value: "11%" },
        { label: "상위권 1:1 승률", value: "61%" },
      ],
    );

    expect(pairs).toEqual([{
      user: { label: "1:1 교전 승률", value: "79%" },
      benchmark: { label: "상위권 1:1 승률", value: "61%" },
    }]);
  });

  it("never aliases smoke-attempt success with teammate-knock opportunity rate", () => {
    expect(matchDebateStatPairs(
      [{ label: "내 연막 구출 성공률", value: "0%" }],
      [{ label: "아군 기절 대비 연막 구출률", value: "11%" }],
    )).toEqual([]);
    expect(matchDebateStatPairs(
      [{ label: "총 투척 횟수", value: "22회" }],
      [{ label: "아군 기절 대비 연막 구출률", value: "11%" }],
    )).toEqual([]);
  });

  it.each([
    ["평균 화력", "평균 화력", "298", "237"],
    ["대응 사격 속도", "대응 사격 속도", "3.00s", "2.01s"],
    ["백업 속도", "백업 속도", "8.79s", "13.08s"],
    ["복수 성공률", "복수 성공률", "25%", "18%"],
    ["1:1 교전 승률", "1:1 교전 승률", "79%", "61%"],
    ["아군 백업 속도", "백업 속도", "8.79s", "13.08s"],
    ["평균 화력", "동일 티어 평균 딜량", "298", "237"],
    ["평균 백업 속도", "상위권 평균 백업 속도", "8.79s", "8790ms"],
    ["복수 성공률", "상위권 평균 복수 성공률", "25%", "18%"],
    ["1:1 교전 승률", "동일 티어 1:1 승률", "79%", "61%"],
  ])("accepts the explicitly equivalent %s/%s alias pair", (userLabel, benchmarkLabel, userValue, benchmarkValue) => {
    expect(matchDebateStatPairs(
      [{ label: userLabel, value: userValue }],
      [{ label: benchmarkLabel, value: benchmarkValue }],
    )).toHaveLength(1);
  });

  it.each([
    ["주도권 성공률", "상위권 선제 공격 성공률", "70%", "61%"],
    ["선제 공격 성공률", "동일 티어 평균 주도권 성공률", "70%", "61%"],
    ["평균 주도권 성공률", "상위권 평균 선제 공격 성공률", "70%", "61%"],
    ["평균 압박 지수", "상위권 압박 지수", "3.0", "2.5"],
    ["압박 지수", "동일 티어 평균 압박 지수", "3.0", "2.5"],
    ["솔로 비중", "상위권 솔로 킬 비중", "62%", "55%"],
    ["솔로 킬 비중", "동일 티어 평균 솔로 비중", "62%", "55%"],
    ["평균 사망 페이즈", "상위권 사망 페이즈", "6.0", "5.5"],
    ["사망 페이즈", "동일 티어 평균 사망 페이즈", "6.0", "5.5"],
    ["대응 사격 속도", "상위권 대응 사격 속도", "3.00s", "2.01s"],
    ["아군 기절 대비 연막 구출률", "상위권 기회 대비 평균 연막 구출률", "60%", "41%"],
  ])("accepts each prompt-backed canonical metric alias pair (%s/%s)", (userLabel, benchmarkLabel, userValue, benchmarkValue) => {
    expect(matchDebateStatPairs(
      [{ label: userLabel, value: userValue }],
      [{ label: benchmarkLabel, value: benchmarkValue }],
    )).toHaveLength(1);
  });

  it.each([
    ["주도권 성공률", "상위권 선제 공격 성공률", "70", "61"],
    ["평균 압박 지수", "상위권 압박 지수", "3%", "2%"],
    ["평균 사망 페이즈", "상위권 사망 페이즈", "6%", "5%"],
    ["내 소생률", "상위권 소생 성공률", "80", "75"],
  ])("keeps dimensions correct for newly canonical metrics (%s/%s)", (userLabel, benchmarkLabel, userValue, benchmarkValue) => {
    expect(matchDebateStatPairs(
      [{ label: userLabel, value: userValue }],
      [{ label: benchmarkLabel, value: benchmarkValue }],
    )).toEqual([]);
  });

  it("drops duplicate metric rows fail-closed", () => {
    expect(matchDebateStatPairs(
      [
        { label: "평균 화력", value: "298" },
        { label: "평균 화력", value: "300" },
      ],
      [
        { label: "상위권 평균 화력", value: "237" },
        { label: "상위권 평균 화력", value: "240" },
      ],
    )).toEqual([]);
  });

  it("fails closed when only one side repeats a canonical metric", () => {
    expect(matchDebateStatPairs(
      [{ label: "평균 화력", value: "298" }, { label: "평균 딜량", value: "300" }],
      [{ label: "동일 티어 평균 딜량", value: "237" }],
    )).toEqual([]);
    expect(matchDebateStatPairs(
      [{ label: "평균 화력", value: "298" }],
      [{ label: "동일 티어 평균 딜량", value: "237" }, { label: "상위권 평균 화력", value: "240" }],
    )).toEqual([]);
  });

  it("fails closed when a duplicate canonical label has an invalid value", () => {
    expect(matchDebateStatPairs(
      [
        { label: "평균 화력", value: "298" },
        { label: "평균 딜량", value: null },
      ],
      [{ label: "상위권 평균 화력", value: "237" }],
    )).toEqual([]);
  });

  it.each([
    ["총 투척 횟수", "총 투척 횟수", "22회", "22%"],
    ["대응 사격 속도", "대응 사격 속도", "3.00s", "3.00m"],
    ["평균 화력", "동일 티어 평균 딜량", "298", "237회"],
    ["1:1 교전 승률", "동일 티어 1:1 승률", "79%", "61회"],
  ])("drops same-label rows when value units differ (%s/%s)", (userLabel, benchmarkLabel, userValue, benchmarkValue) => {
    expect(matchDebateStatPairs(
      [{ label: userLabel, value: userValue }],
      [{ label: benchmarkLabel, value: benchmarkValue }],
    )).toEqual([]);
  });

  it("converts seconds and milliseconds only for duration metrics", () => {
    expect(matchDebateStatPairs(
      [{ label: "대응 사격 속도", value: "1s" }],
      [{ label: "상위권 평균 대응 사격 속도", value: "1000ms" }],
    )).toHaveLength(1);
    expect(matchDebateStatPairs(
      [{ label: "대응 사격 속도", value: "1s" }],
      [{ label: "상위권 평균 대응 사격 속도", value: "1m" }],
    )).toEqual([]);
  });

  it("removes benchmark orphans and malformed stat rows while preserving issue text", () => {
    const normalized = normalizeAiSummaryDebatePayload(createValidPayload({
      finalVerdict: "최종 판정",
      debateIssues: [createDebateIssue({
        topic: "화력",
        question: "질문",
        kindOpinion: "착한맛",
        spicyOpinion: "매운맛",
        winner: "kind",
        reason: "근거",
        evaluation: "평가",
        userStats: [{ label: "평균 화력", value: "298" }, { label: "", value: "bad" }],
        benchmarkStats: [{ label: "상위권 평균 화력", value: "237" }, { label: "1:1 승률", value: "61%" }],
      }), createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })],
    }));

    expect(normalized).toMatchObject({ finalVerdict: "최종 판정" });
    expect((normalized?.debateIssues as any[])?.[0]).toMatchObject({
      topic: "화력",
      question: "질문",
      kindOpinion: "착한맛",
      spicyOpinion: "매운맛",
      userStats: [{ label: "평균 화력", value: "298" }],
      benchmarkStats: [{ label: "상위권 평균 화력", value: "237" }],
    });
  });

  it("replaces provider evidence with route-owned canonical values and drops unavailable metrics", () => {
    const payload = createValidPayload({
      debateIssues: [
        createDebateIssue({
          topic: "화력",
          userStats: [{ label: "평균 화력", value: "999" }],
          benchmarkStats: [{ label: "상위권 평균 화력", value: "999" }],
        }),
        createDebateIssue({
          topic: "교전 주도권",
          userStats: [{ label: "주도권 성공률", value: "999%" }],
          benchmarkStats: [{ label: "상위권 선제 공격 성공률", value: "999%" }],
        }),
        createDebateIssue({
          topic: "1:1 결정력",
          userStats: [{ label: "1:1 교전 승률", value: "999%" }],
          benchmarkStats: [{ label: "상위권 1:1 승률", value: "999%" }],
        }),
      ],
    });

    const normalized = normalizeAiSummaryDebatePayload(payload, {
      canonicalEvidence: {
        damage_average: {
          user: { label: "평균 화력", value: "320" },
          benchmark: { label: "동일 티어 평균 화력", value: "300" },
        },
      },
    });

    expect(normalized?.debateIssues).toMatchObject([
      {
        userStats: [{ label: "평균 화력", value: "320" }],
        benchmarkStats: [{ label: "동일 티어 평균 화력", value: "300" }],
      },
      { userStats: [], benchmarkStats: [] },
      { userStats: [], benchmarkStats: [] },
    ]);
  });

  it("canonical duration evidence keeps the server value when provider switches seconds and milliseconds", () => {
    const normalized = normalizeAiSummaryDebatePayload(createValidPayload({
      debateIssues: [createDebateIssue({
        topic: "백업",
        userStats: [{ label: "백업 속도", value: "999s" }],
        benchmarkStats: [{ label: "상위권 평균 백업 속도", value: "1000ms" }],
      }), createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })],
    }), {
      canonicalEvidence: {
        backup_latency: {
          user: { label: "백업 속도", value: "8.79s" },
          benchmark: { label: "동일 티어 평균 백업 속도", value: "12s" },
        },
      },
    });

    expect((normalized?.debateIssues as any[])?.[0]).toMatchObject({
      userStats: [{ label: "백업 속도", value: "8.79s" }],
      benchmarkStats: [{ label: "동일 티어 평균 백업 속도", value: "12s" }],
    });
  });

  it("rejects debate issues that do not satisfy the required payload shape", () => {
    expect(normalizeAiSummaryDebatePayload({
      finalVerdict: "ok",
      debateIssues: [{ winner: 42 }],
    })).toBeNull();
    expect(normalizeAiSummaryDebatePayload({
      finalVerdict: "ok",
      debateIssues: [],
    })).toBeNull();
    expect(normalizeAiSummaryDebatePayload({
      finalVerdict: "ok",
      debateIssues: [{
        topic: "주제",
        question: "질문",
        kindOpinion: "착한맛",
        spicyOpinion: "매운맛",
        winner: "Kind",
        userStats: [],
        benchmarkStats: [],
      }],
    })).toBeNull();
  });

  it("preserves a fully valid debate issue and its optional evidence text", () => {
    const payload = createValidPayload({
      finalVerdict: "ok",
      debateIssues: [createDebateIssue({
        topic: "압박",
        question: "압박 지수가 충분한가?",
        kindOpinion: "안정적입니다.",
        spicyOpinion: "더 압박해야 합니다.",
        winner: "spicy",
        reason: "벤치마크 대비 격차",
        evaluation: "보완 필요",
        userStats: [{ label: "평균 압박 지수", value: "3.0" }],
        benchmarkStats: [{ label: "상위권 압박 지수", value: "2.5" }],
      }), createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })],
      actionItems: [{ icon: "target", title: "압박 훈련", desc: "교전 압박을 유지하세요." }],
    });

    expect(normalizeAiSummaryDebatePayload(payload)).toEqual(payload);
  });

  it("requires non-empty signatures and strips provider-owned arbitrary fields", () => {
    const normalized = normalizeAiSummaryDebatePayload(createValidPayload({
      providerVisuals: { forged: true },
      visuals: { forged: true },
      arbitrary: "drop me",
      debateIssues: [createDebateIssue({ arbitrary: "drop me" }), createDebateIssue({ topic: "두 번째 주제" }), createDebateIssue({ topic: "세 번째 주제" })],
      actionItems: [{ icon: "target", title: "목표", desc: "설명", arbitrary: "drop me" }],
    }));

    expect(normalized).not.toHaveProperty("providerVisuals");
    expect(normalized).not.toHaveProperty("visuals");
    expect(normalized).not.toHaveProperty("arbitrary");
    expect((normalized?.debateIssues as any[])?.[0]).not.toHaveProperty("arbitrary");
    expect((normalized?.actionItems as any[])?.[0]).not.toHaveProperty("arbitrary");
    expect(normalized).toMatchObject({ signature: "검증된 칭호", signatureSub: "검증된 칭호의 이유" });
  });

  it.each([
    { signature: "", signatureSub: "이유" },
    { signature: "칭호", signatureSub: "   " },
    { signature: undefined, signatureSub: "이유" },
  ])("rejects missing or empty signatures", (overrides) => {
    expect(normalizeAiSummaryDebatePayload(createValidPayload(overrides))).toBeNull();
  });

  it("rejects malformed action items instead of exposing them to RecentAISummary", () => {
    expect(normalizeAiSummaryDebatePayload({
      finalVerdict: "ok",
      actionItems: [{ icon: "target", title: "", desc: "설명" }],
    })).toBeNull();
    expect(normalizeAiSummaryDebatePayload({
      finalVerdict: "ok",
      actionItems: "not-an-array",
    })).toBeNull();
  });

  it("does not fuzzy-match generic benchmark labels", () => {
    expect(matchDebateStatPairs(
      [{ label: "딜량", value: "320" }],
      [{ label: "상위권", value: "300" }],
    )).toEqual([]);

    expect(matchDebateStatPairs(
      [{ label: "11 승률", value: "79%" }],
      [{ label: "1:1 승률", value: "61%" }],
    )).toEqual([]);

    expect(matchDebateStatPairs(
      [{ label: "항목", value: "79%" }],
      [{ label: "항목", value: "61%" }],
    )).toEqual([]);
  });

  it.each([
    ["N/A", "측정 불가"],
    ["Benchmark N/A", "11%"],
    ["undefined", "11%"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["임의 텍스트", "다른 임의 텍스트"],
  ])("rejects non-measured values (%s ↔ %s)", (userValue, benchmarkValue) => {
    expect(matchDebateStatPairs(
      [{ label: "1:1 교전 승률", value: userValue }],
      [{ label: "상위권 1:1 승률", value: benchmarkValue }],
    )).toEqual([]);
  });

  it("rejects invalid JSON and empty final verdicts", () => {
    expect(normalizeAiSummaryFinalJson("not json")).toBeNull();
    expect(normalizeAiSummaryFinalJson('{"finalVerdict":"ok",}')).toBeNull();
    expect(normalizeAiSummaryFinalJson('{"finalVerdict":"ok"} trailing prose')).toBeNull();
    expect(normalizeAiSummaryFinalJson(JSON.stringify({ finalVerdict: "  " }))).toBeNull();
    expect(normalizeAiSummaryFinalJson(JSON.stringify({ finalVerdict: 42 }))).toBeNull();
    expect(normalizeAiSummaryFinalJson(JSON.stringify({ signature: "칭호", signatureSub: "이유", finalVerdict: "ok" }))).toBeNull();
    expect(normalizeAiSummaryFinalJson(JSON.stringify({ finalVerdict: "ok", debateIssues: null }))).toBeNull();
    expect(normalizeAiSummaryFinalJson(JSON.stringify({ finalVerdict: "ok", debateIssues: [null] }))).toBeNull();
    expect(normalizeAiSummaryFinalJson(JSON.stringify(createValidPayload()))).toBe(JSON.stringify(createValidPayload()));
  });
});
