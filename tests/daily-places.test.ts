import { dailyNearbyPlace, dailyPlaceLabel } from "@/lib/learn/dailyPlaces";

describe("dailyPlaceLabel", () => {
  it("translates telemetry zone ids and keeps the first of overlapping zones", () => {
    expect(dailyPlaceLabel("sosnovkamilitarybase")).toBe("소스노브카 군사기지");
    expect(dailyPlaceLabel("truckstop, GDTruckStop")).toBe("트럭 휴게소");
    expect(dailyPlaceLabel("게오르고폴")).toBe("게오르고폴");
    expect(dailyPlaceLabel("unknownzone")).toBe("unknownzone");
    expect(dailyPlaceLabel(" ")).toBeNull();
    expect(dailyPlaceLabel(null)).toBeNull();
  });
});

describe("dailyNearbyPlace", () => {
  it("names a point inside, near, or away from a recorded area", () => {
    expect(dailyNearbyPlace("에란겔", { x: 3636, y: 4069 })).toBe("포친키");
    expect(dailyNearbyPlace("에란겔", { x: 3636 + 172 + 300, y: 4069 })).toBe("포친키 인근");
    expect(dailyNearbyPlace("에란겔", { x: 100, y: 7900 })).toBeNull();
    expect(dailyNearbyPlace("비켄디", { x: 3636, y: 4069 })).toBeNull();
    expect(dailyNearbyPlace("에란겔", null)).toBeNull();
  });
});
