import { describe, it, expect } from "vitest";
import {
  extractMatchIdFromReplayKey,
  selectReplayOrphanCandidates,
  runReplayOrphanCleanup,
  REPLAY_ORPHAN_MIN_AGE_DAYS,
  REPLAY_KEY_PREFIX,
  type ReplayObject,
} from "../scripts/cleanup_r2_orphan_replay";

const MATCH_A = "0153eb50-2dbc-45d4-9233-99f8ef83f4c3";
const MATCH_B = "0261c755-6cd2-4dc4-b82c-5738509073f3";
const HASH = "c4a9485679ceaa8a808b9b5b60c97b54";

function replayKey(matchId: string, hash = HASH, mode = "lite.json"): string {
  return `${REPLAY_KEY_PREFIX}v60/kakao/${matchId}/${hash}/${mode}`;
}

function replayObject(matchId: string, ageDays: number, key = replayKey(matchId)): ReplayObject {
  return { key, matchId, sizeBytes: 700 * 1024, ageDays };
}

describe("리플레이 캐시 키 파싱", () => {
  it("정상 키에서 매치 ID 를 추출한다", () => {
    expect(extractMatchIdFromReplayKey(replayKey(MATCH_A))).toBe(MATCH_A);
  });

  it("대문자 매치 ID 를 소문자로 정규화한다", () => {
    expect(extractMatchIdFromReplayKey(replayKey(MATCH_A.toUpperCase()))).toBe(MATCH_A);
  });

  it("플랫폼과 모드가 달라도 파싱한다", () => {
    const key = `${REPLAY_KEY_PREFIX}v60/steam/${MATCH_B}/${HASH}/squad-fpp.json`;
    expect(extractMatchIdFromReplayKey(key)).toBe(MATCH_B);
  });

  it("이미지 자산과 루트 분석 캐시는 대상이 아니다", () => {
    expect(extractMatchIdFromReplayKey("crates/11010112.webp")).toBeNull();
    expect(extractMatchIdFromReplayKey("weapons/ar_akm.webp")).toBeNull();
    expect(extractMatchIdFromReplayKey(`${MATCH_A}_nick_v60_analyze.json`)).toBeNull();
  });

  it("경로 깊이가 다르면 대상이 아니다", () => {
    expect(extractMatchIdFromReplayKey(`${REPLAY_KEY_PREFIX}v60/kakao/${MATCH_A}/lite.json`)).toBeNull();
    expect(extractMatchIdFromReplayKey(`${REPLAY_KEY_PREFIX}v60/kakao/${MATCH_A}/${HASH}/extra/lite.json`)).toBeNull();
  });

  it("버전 세그먼트 형태가 다르면 대상이 아니다", () => {
    expect(extractMatchIdFromReplayKey(`${REPLAY_KEY_PREFIX}latest/kakao/${MATCH_A}/${HASH}/lite.json`)).toBeNull();
  });

  it("매치 ID 형태가 아니면 대상이 아니다", () => {
    expect(extractMatchIdFromReplayKey(`${REPLAY_KEY_PREFIX}v60/kakao/not-a-uuid/${HASH}/lite.json`)).toBeNull();
  });

  it("json 이 아닌 파일은 대상이 아니다", () => {
    expect(extractMatchIdFromReplayKey(`${REPLAY_KEY_PREFIX}v60/kakao/${MATCH_A}/${HASH}/preview.webp`)).toBeNull();
  });

  it("삭제 목록 아카이브 경로는 대상이 아니다", () => {
    expect(extractMatchIdFromReplayKey("telemetry-inventory/2026-07-31.json")).toBeNull();
  });
});

describe("리플레이 고아 후보 선별", () => {
  it("등록부에 있는 객체는 제외한다", () => {
    const object = replayObject(MATCH_A, 10);
    const result = selectReplayOrphanCandidates([object], new Set([object.key]), new Set());
    expect(result).toEqual([]);
  });

  it("DB 에 매치가 있으면 제외한다", () => {
    const object = replayObject(MATCH_A, 10);
    const result = selectReplayOrphanCandidates([object], new Set(), new Set([MATCH_A]));
    expect(result).toEqual([]);
  });

  it("최소 경과일 미달이면 제외한다", () => {
    const objects = [
      replayObject(MATCH_A, REPLAY_ORPHAN_MIN_AGE_DAYS - 1),
      replayObject(MATCH_B, REPLAY_ORPHAN_MIN_AGE_DAYS),
    ];
    const result = selectReplayOrphanCandidates(objects, new Set(), new Set());
    expect(result.map((entry) => entry.matchId)).toEqual([MATCH_B]);
  });

  it("세 조건을 모두 만족하는 객체만 남긴다", () => {
    const registered = replayObject(MATCH_A, 10);
    const alive = replayObject(MATCH_B, 10, replayKey(MATCH_B));
    const fresh = replayObject(MATCH_A, 0, replayKey(MATCH_A, "hash-fresh"));
    const target = replayObject(MATCH_A, 10, replayKey(MATCH_A, "hash-target"));

    const result = selectReplayOrphanCandidates(
      [registered, alive, fresh, target],
      new Set([registered.key]),
      new Set([MATCH_B]),
    );

    expect(result.map((entry) => entry.key)).toEqual([target.key]);
  });

  it("최소 경과일은 안전한 하한을 지킨다", () => {
    expect(REPLAY_ORPHAN_MIN_AGE_DAYS).toBeGreaterThanOrEqual(1);
  });
});

describe("자격 증명 검증", () => {
  it("Supabase 자격 증명이 없으면 실행하지 않는다", async () => {
    await expect(runReplayOrphanCleanup({ env: {} }))
      .rejects.toThrow("r2-replay-cleanup-supabase-credentials-missing");
  });

  it("R2 자격 증명이 없으면 실행하지 않는다", async () => {
    await expect(runReplayOrphanCleanup({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "key",
      },
    })).rejects.toThrow("r2-replay-cleanup-r2-credentials-missing");
  });
});
