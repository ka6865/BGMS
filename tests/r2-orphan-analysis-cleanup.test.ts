import { describe, it, expect } from "vitest";
import {
  extractMatchIdFromAnalysisKey,
  selectOrphanCandidates,
  runOrphanAnalysisCleanup,
  ORPHAN_MIN_AGE_DAYS,
  type OrphanCandidate,
} from "../scripts/cleanup_r2_orphan_analysis";

const MATCH_A = "001288d0-007c-4ca7-843b-7553c0fe4881";
const MATCH_B = "00138421-3122-4c8e-960c-17df7759bf47";

function candidate(
  matchId: string,
  ageDays: number,
  key = `${matchId}_nick_v60_analyze.json`,
): OrphanCandidate {
  return { key, matchId, sizeBytes: 3 * 1024 * 1024, ageDays };
}

describe("분석 캐시 키 파싱", () => {
  it("루트 분석 캐시에서 매치 ID 를 추출한다", () => {
    expect(extractMatchIdFromAnalysisKey(`${MATCH_A}_pk_ohu_v60_analyze.json`)).toBe(MATCH_A);
  });

  it("닉네임에 밑줄과 하이픈이 있어도 파싱한다", () => {
    expect(extractMatchIdFromAnalysisKey(`${MATCH_B}_flat-white__v60_analyze.json`)).toBe(MATCH_B);
  });

  it("대문자 매치 ID 를 소문자로 정규화한다", () => {
    expect(extractMatchIdFromAnalysisKey(`${MATCH_A.toUpperCase()}_nick_v60_analyze.json`)).toBe(MATCH_A);
  });

  it("하위 경로 객체는 대상이 아니다", () => {
    expect(extractMatchIdFromAnalysisKey(`telemetry-map/${MATCH_A}_v60.json`)).toBeNull();
    expect(extractMatchIdFromAnalysisKey("crates/11010112.webp")).toBeNull();
    expect(extractMatchIdFromAnalysisKey("weapons/ar_akm.webp")).toBeNull();
  });

  it("형태가 다른 루트 객체는 대상이 아니다", () => {
    expect(extractMatchIdFromAnalysisKey("not-a-uuid_nick_v60_analyze.json")).toBeNull();
    expect(extractMatchIdFromAnalysisKey(`${MATCH_A}_nick_v60.json`)).toBeNull();
    expect(extractMatchIdFromAnalysisKey(`${MATCH_A}.json`)).toBeNull();
  });
});

describe("고아 후보 선별", () => {
  it("DB 에 존재하는 매치는 제외한다", () => {
    const objects = [candidate(MATCH_A, 10), candidate(MATCH_B, 10)];
    const result = selectOrphanCandidates(objects, new Set([MATCH_A]));

    expect(result.map((entry) => entry.matchId)).toEqual([MATCH_B]);
  });

  it("최소 경과일을 넘지 않은 객체는 제외한다", () => {
    const objects = [
      candidate(MATCH_A, ORPHAN_MIN_AGE_DAYS - 1),
      candidate(MATCH_B, ORPHAN_MIN_AGE_DAYS),
    ];
    const result = selectOrphanCandidates(objects, new Set());

    expect(result.map((entry) => entry.matchId)).toEqual([MATCH_B]);
  });

  it("최근 생성분을 보호해 조회 직후 캐시를 지우지 않는다", () => {
    const objects = [candidate(MATCH_A, 0), candidate(MATCH_B, 1)];
    expect(selectOrphanCandidates(objects, new Set())).toEqual([]);
  });

  it("DB 참조가 없고 경과일을 넘은 객체만 남긴다", () => {
    const objects = [
      candidate(MATCH_A, 30),
      candidate(MATCH_B, 30),
      candidate(MATCH_A, 30, `${MATCH_A}_other-nick_v60_analyze.json`),
    ];
    const result = selectOrphanCandidates(objects, new Set([MATCH_B]));

    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.matchId === MATCH_A)).toBe(true);
  });

  it("최소 경과일은 안전한 하한을 지킨다", () => {
    expect(ORPHAN_MIN_AGE_DAYS).toBeGreaterThanOrEqual(1);
  });
});

describe("자격 증명 검증", () => {
  it("Supabase 자격 증명이 없으면 실행하지 않는다", async () => {
    await expect(runOrphanAnalysisCleanup({ env: {} }))
      .rejects.toThrow("r2-orphan-cleanup-supabase-credentials-missing");
  });

  it("R2 자격 증명이 없으면 실행하지 않는다", async () => {
    await expect(runOrphanAnalysisCleanup({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "key",
      },
    })).rejects.toThrow("r2-orphan-cleanup-r2-credentials-missing");
  });
});
