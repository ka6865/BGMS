import { describe, expect, it } from "vitest";
import { lolCollectionStatus } from "../lib/lol/collectionStatus";

describe("LoL 집계 상태", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");

  it("유효한 시각을 KST로 표시하고 24시간 경과를 구분한다", () => {
    expect(lolCollectionStatus("2026-11-04T03:00:00.000Z", now)).toEqual({ time: "2026. 11. 4. 오후 12:00", stale: false });
    expect(lolCollectionStatus("2026-11-03T12:00:00.000Z", now).stale).toBe(true);
  });

  it.each([null, "", "not-a-date", "2026-11-04T12:01:00.000Z"])("잘못됐거나 미래인 시각 %s는 확인 불가로 처리한다", updatedAt => {
    expect(lolCollectionStatus(updatedAt, now)).toEqual({ time: null, stale: false });
  });
});
