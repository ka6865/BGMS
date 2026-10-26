import { describe, expect, it } from "vitest";
import { attributeLolLpChanges, type LolLpGame, type LolRankedObservation } from "@/lib/lol/lpChange";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 0, minute)).toISOString();
const ms = (minute: number) => Date.UTC(2026, 9, 27, 0, minute);
const solo = (minute: number, tier: string, rank: string, lp: number, wins: number, losses: number): LolRankedObservation =>
  ({ queueType: "RANKED_SOLO_5x5", tier, rank, lp, wins, losses, recordedAt: at(minute) });
const game = (matchId: string, minute: number, win: boolean | null, extra: Partial<LolLpGame> = {}): LolLpGame =>
  ({ matchId, queueId: 420, gameEndTimestamp: ms(minute), win, remake: false, ...extra });

describe("경기별 LP 증감 귀속", () => {
  it("두 관측 사이 같은 큐 한 판이고 승패가 맞으면 LP 차이를 붙인다", () => {
    const changes = attributeLolLpChanges(
      [solo(0, "PLATINUM", "II", 40, 10, 10), solo(40, "PLATINUM", "II", 60, 11, 10), solo(80, "PLATINUM", "II", 39, 11, 11)],
      [game("KR_1", 30, true), game("KR_2", 70, false)],
    );
    expect(changes.get("KR_1")).toEqual({ kind: "lp", value: 20 });
    expect(changes.get("KR_2")).toEqual({ kind: "lp", value: -21 });
  });

  it("디비전·티어가 바뀌면 숫자 대신 승급·강등으로 표시한다", () => {
    const changes = attributeLolLpChanges(
      [solo(0, "GOLD", "I", 90, 5, 5), solo(40, "PLATINUM", "IV", 10, 6, 5), solo(80, "GOLD", "I", 75, 6, 6)],
      [game("KR_UP", 30, true), game("KR_DOWN", 70, false)],
    );
    expect(changes.get("KR_UP")).toEqual({ kind: "promotion" });
    expect(changes.get("KR_DOWN")).toEqual({ kind: "demotion" });
  });

  it("마스터 이상은 같은 티어면 LP 차이, 티어가 오르면 승급이다", () => {
    const changes = attributeLolLpChanges(
      [solo(0, "MASTER", "I", 180, 50, 40), solo(40, "MASTER", "I", 198, 51, 40), solo(80, "GRANDMASTER", "I", 210, 52, 40)],
      [game("KR_M", 30, true), game("KR_GM", 70, true)],
    );
    expect(changes.get("KR_M")).toEqual({ kind: "lp", value: 18 });
    expect(changes.get("KR_GM")).toEqual({ kind: "promotion" });
  });

  it("두 관측 사이에 여러 판이 있으면 판별 값을 붙이지 않는다", () => {
    // 1승 1패 합계 +19는 +20/-1인지 +30/-11인지 알 수 없다.
    const changes = attributeLolLpChanges(
      [solo(0, "PLATINUM", "II", 40, 10, 10), solo(90, "PLATINUM", "II", 59, 11, 11)],
      [game("KR_A", 30, true), game("KR_B", 70, false)],
    );
    expect(changes.size).toBe(0);
  });

  it("판 수는 1 늘었지만 저장된 경기가 0판·2판이거나 승패가 어긋나면 붙이지 않는다", () => {
    const observations = [solo(0, "PLATINUM", "II", 40, 10, 10), solo(40, "PLATINUM", "II", 60, 11, 10)];
    expect(attributeLolLpChanges(observations, []).size).toBe(0);
    expect(attributeLolLpChanges(observations, [game("KR_A", 10, true), game("KR_B", 30, true)]).size).toBe(0);
    expect(attributeLolLpChanges(observations, [game("KR_L", 30, false)]).size).toBe(0);
  });

  it("다시하기·다른 큐·관측 밖 경기·시즌 초기화는 대상이 아니다", () => {
    const observations = [solo(0, "PLATINUM", "II", 40, 10, 10), solo(40, "PLATINUM", "II", 60, 11, 10)];
    expect(attributeLolLpChanges(observations, [game("KR_R", 30, true, { remake: true })]).size).toBe(0);
    expect(attributeLolLpChanges(observations, [game("KR_F", 30, true, { queueId: 440 })]).size).toBe(0);
    expect(attributeLolLpChanges(observations, [game("KR_OLD", -5, true)]).size).toBe(0);
    const reset = [solo(0, "PLATINUM", "II", 40, 100, 90), solo(40, "GOLD", "IV", 0, 1, 0)];
    expect(attributeLolLpChanges(reset, [game("KR_S", 30, true)]).size).toBe(0);
  });

  it("승리인데 LP가 줄거나 한 판 변화로 보기 어려운 차이는 붙이지 않는다", () => {
    const loss = [solo(0, "PLATINUM", "II", 40, 10, 10), solo(40, "PLATINUM", "II", 35, 11, 10)];
    expect(attributeLolLpChanges(loss, [game("KR_W", 30, true)]).size).toBe(0);
    const huge = [solo(0, "MASTER", "I", 100, 10, 10), solo(40, "MASTER", "I", 260, 11, 10)];
    expect(attributeLolLpChanges(huge, [game("KR_H", 30, true)]).size).toBe(0);
  });

  it("자유랭크는 자유랭크 관측끼리만 비교한다", () => {
    const flex = (minute: number, lp: number, wins: number, losses: number): LolRankedObservation =>
      ({ queueType: "RANKED_FLEX_SR", tier: "GOLD", rank: "II", lp, wins, losses, recordedAt: at(minute) });
    const changes = attributeLolLpChanges(
      [solo(0, "PLATINUM", "II", 40, 10, 10), flex(0, 50, 3, 3), flex(40, 71, 4, 3), solo(40, "PLATINUM", "II", 40, 10, 10)],
      [game("KR_FLEX", 30, true, { queueId: 440 })],
    );
    expect(changes.get("KR_FLEX")).toEqual({ kind: "lp", value: 21 });
  });
});
