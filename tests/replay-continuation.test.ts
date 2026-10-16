import { describe, expect, it } from "vitest";
import {
  FULL_MATCH_WARMUP_PROGRESS,
  LITE_WIPE_TAIL_MS,
  findSquadWipeMs,
  liteReplayEndMs,
  shouldOfferFullMatch,
  shouldWarmFullMatch,
} from "@/lib/replay/replayContinuation";

const kill = (victim: string, relativeTimeMs: number) => ({ type: "kill", victim, relativeTimeMs });
const create = (name: string, relativeTimeMs: number) => ({ type: "create", name, relativeTimeMs });

describe("lite 리플레이 이어 보기", () => {
  it("아군 전원이 마지막으로 사망한 시각을 전멸 시각으로 본다", () => {
    expect(findSquadWipeMs([kill("Me", 100), kill("mate", 200)], ["me", "Mate"])).toBe(200);
    expect(findSquadWipeMs([kill("Me", 100)], ["me", "Mate"])).toBeNull();
    expect(findSquadWipeMs([], [])).toBeNull();
  });

  it("사망 뒤 블루칩 재배치(create)가 있으면 살아난 것으로 본다", () => {
    expect(findSquadWipeMs([create("Me", 0), kill("Me", 100), create("Me", 200), kill("Mate", 300)], ["me", "mate"])).toBeNull();
    expect(findSquadWipeMs([create("Me", 0), kill("Me", 100), create("Me", 200), kill("Me", 400), kill("Mate", 300)], ["me", "mate"])).toBe(400);
  });

  it("lite의 끝은 전멸 + 30초다. 다른 선수 부활 이벤트로 길어진 데이터 끝은 쓰지 않는다", () => {
    // 실제 경기(2026-10-15 에란겔 듀오 29등): 4:39 전멸, lite 데이터는 24:07까지 남는다.
    expect(liteReplayEndMs("lite", 279_000, 1_447_641)).toBe(279_000 + LITE_WIPE_TAIL_MS);
    expect(liteReplayEndMs("lite", null, 1_447_641)).toBe(1_447_641);
    expect(liteReplayEndMs("full", 279_000, 1_642_000)).toBe(1_642_000);
  });

  it("lite에서 전멸한 경기가 lite 끝에 도달하면 제안한다", () => {
    const base = { mode: "lite", squadWipeMs: 279_000, currentTimeMs: 309_000, maxTimeMs: 1_447_641 };
    expect(shouldOfferFullMatch(base)).toBe(true);
    expect(shouldOfferFullMatch({ ...base, currentTimeMs: 300_000 })).toBe(false);
    expect(shouldOfferFullMatch({ ...base, mode: "full" })).toBe(false);
    expect(shouldOfferFullMatch({ ...base, squadWipeMs: null })).toBe(false);
  });

  it("lite 끝까지의 일정 비율을 넘어야 full 생성을 미리 요청한다", () => {
    const base = { mode: "lite", squadWipeMs: 279_000, maxTimeMs: 1_447_641 };
    expect(shouldWarmFullMatch({ ...base, currentTimeMs: 309_000 * FULL_MATCH_WARMUP_PROGRESS })).toBe(true);
    expect(shouldWarmFullMatch({ ...base, currentTimeMs: 100_000 })).toBe(false);
    expect(shouldWarmFullMatch({ ...base, squadWipeMs: null, currentTimeMs: 999_000 })).toBe(false);
  });
});
