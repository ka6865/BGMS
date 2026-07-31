import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateSupabaseClient, mockSelect } = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mapSettingsTable = {
    select: mockSelect,
  };
  const mockCreateSupabaseClient = vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "map_settings") return mapSettingsTable;
      throw new Error(`예상하지 않은 테이블 요청: ${table}`);
    }),
  }));

  return { mockCreateSupabaseClient, mockSelect };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateSupabaseClient,
}));

const ROUTE_PATH = resolve("app/api/maps/settings/route.ts");

describe("공개 맵 카테고리 설정 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    mockSelect.mockResolvedValue({ data: [], error: null });
  });

  it("모바일 클라이언트용 공개 설정 경로를 제공한다", () => {
    expect(existsSync(ROUTE_PATH)).toBe(true);
  });

  it("DB 설정을 우선하고 상수 폴백을 포함한 맵별 활성 카테고리를 캐시하여 반환한다", async () => {
    expect(existsSync(ROUTE_PATH)).toBe(true);
    if (!existsSync(ROUTE_PATH)) return;

    mockSelect.mockResolvedValueOnce({
      data: [
        { map_id: "Erangel", categories: ["Garage", "Esports", "EsportsBoat", "Glider", "SecretRoom"] },
        { map_id: "Custom", categories: ["Boat"] },
      ],
      error: null,
    });

    const { GET } = await import("../app/api/maps/settings/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      mapCategories: expect.objectContaining({
        Erangel: ["Garage", "Esports", "EsportsBoat", "Glider", "SecretRoom"],
        Miramar: ["GoldenMirado", "EsportsMirado", "EsportsPickup", "EsportsBoat", "Glider", "SecretRoom"],
        Custom: ["Boat"],
      }),
    }));
    expect(body.mapCategories.Erangel).not.toContain("Boat");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    expect(mockCreateSupabaseClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
    );
  });
});
