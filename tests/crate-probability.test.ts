import { afterEach, describe, it, expect, vi } from "vitest";
import { drawSingleItem, drawSinglePrimeItem, tryDrawBonusItem } from "../lib/crateUtils";
import type { BonusItem, CrateItem, PrimeParcelItem } from "../types/crates";

// 추첨 함수는 name/probability만 사용하므로 나머지 필드는 테스트에서 채우지 않는다
const asItems = <T>(items: { name: string; probability: number }[]) => items as unknown as T[];

// Math.random을 [0, 1) 구간의 균등 격자로 대체해 실제 추첨 함수의 구간 배분을 결정적으로 측정한다
function measureGridShares<T extends { name: string }>(draw: () => T, steps: number): Record<string, number> {
  const counts: Record<string, number> = {};
  const random = vi.spyOn(Math, "random");
  for (let index = 0; index < steps; index += 1) {
    random.mockReturnValueOnce((index + 0.5) / steps);
    const selected = draw();
    counts[selected.name] = (counts[selected.name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, count / steps]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUBG 상자깡 시뮬레이터 실제 추첨 함수", () => {
  // 할리데이비슨 전리품 상자 기본 구성품
  const harleyBaseItems = asItems<CrateItem>([
    { name: "의상 및 장비 도안", probability: 0.3 },
    { name: "세트 도안", probability: 0.7 },
  ]);

  // 할리데이비슨 보너스 구성품: 가중치 합이 독립 당첨 확률 27%와 같다
  const harleyBonusItems = asItems<BonusItem>([
    { name: "할리데이비슨™ 최고급 꾸러미", probability: 0.065 },
    { name: "할리데이비슨™ 토큰 x10", probability: 0.1 },
    { name: "[에픽 이상] 의상 및 장비 획득권", probability: 0.005 },
    { name: "할리데이비슨™ 전리품 상자", probability: 0.1 },
  ]);

  // 할리데이비슨 최고급 꾸러미 구성품 일부(가중치 합이 1이 아닌 경우의 정규화 확인용)
  const harleyPrimeItems = asItems<PrimeParcelItem>([
    { name: "할리데이비슨™ 토큰 x50", probability: 0.1 },
    { name: '"CVO™ Road Glide® ST (리미티드)" 모터사이클 도안', probability: 0.012 },
    { name: '"CVO™ Road Glide® ST" 모터사이클 도안', probability: 0.04 },
    { name: "할리데이비슨® 엔진 배지 도안", probability: 0.05 },
  ]);

  it("기본 구성품은 가중치 경계에서 정확히 다음 품목으로 넘어간다", () => {
    const random = vi.spyOn(Math, "random");

    random.mockReturnValueOnce(0);
    expect(drawSingleItem(harleyBaseItems).name).toBe("의상 및 장비 도안");
    random.mockReturnValueOnce(0.299999);
    expect(drawSingleItem(harleyBaseItems).name).toBe("의상 및 장비 도안");
    random.mockReturnValueOnce(0.3);
    expect(drawSingleItem(harleyBaseItems).name).toBe("세트 도안");
    random.mockReturnValueOnce(0.999999);
    expect(drawSingleItem(harleyBaseItems).name).toBe("세트 도안");
  });

  it("기본 구성품은 난수 구간을 가중치 비율대로 배분한다", () => {
    const shares = measureGridShares(() => drawSingleItem(harleyBaseItems), 10_000);

    expect(shares["의상 및 장비 도안"]).toBeCloseTo(0.3, 3);
    expect(shares["세트 도안"]).toBeCloseTo(0.7, 3);
  });

  it("최고급 꾸러미는 가중치 합으로 정규화해 구간을 배분한다", () => {
    const total = harleyPrimeItems.reduce((sum, item) => sum + item.probability, 0);
    const shares = measureGridShares(() => drawSinglePrimeItem(harleyPrimeItems), 20_000);

    for (const item of harleyPrimeItems) {
      expect(shares[item.name]).toBeCloseTo(item.probability / total, 3);
    }
  });

  it("부동소수 오차로 누적 구간을 벗어나면 마지막 품목을 반환한다", () => {
    const items = asItems<CrateItem>([
      { name: "first", probability: 0.1 },
      { name: "last", probability: 0.2 },
    ]);
    vi.spyOn(Math, "random").mockReturnValueOnce(1);

    expect(drawSingleItem(items).name).toBe("last");
  });

  it("보너스는 27% 경계에서 당첨 여부가 갈리고 미당첨이면 품목 추첨을 하지 않는다", () => {
    const random = vi.spyOn(Math, "random");

    random.mockReturnValueOnce(0.27);
    expect(tryDrawBonusItem(harleyBonusItems)).toBeNull();
    expect(random).toHaveBeenCalledTimes(1);

    random.mockReturnValueOnce(0.269999).mockReturnValueOnce(0);
    expect(tryDrawBonusItem(harleyBonusItems)?.name).toBe("할리데이비슨™ 최고급 꾸러미");
    expect(random).toHaveBeenCalledTimes(3);
  });

  it("보너스 당첨 후 품목은 보너스 가중치 구간에 따라 결정된다", () => {
    const total = harleyBonusItems.reduce((sum, item) => sum + item.probability, 0);
    const random = vi.spyOn(Math, "random");
    const drawAt = (weight: number) => {
      random.mockReturnValueOnce(0).mockReturnValueOnce(weight / total);
      return tryDrawBonusItem(harleyBonusItems)?.name;
    };

    expect(drawAt(0.06)).toBe("할리데이비슨™ 최고급 꾸러미");
    expect(drawAt(0.07)).toBe("할리데이비슨™ 토큰 x10");
    expect(drawAt(0.167)).toBe("[에픽 이상] 의상 및 장비 획득권");
    expect(drawAt(0.2)).toBe("할리데이비슨™ 전리품 상자");
  });
});
