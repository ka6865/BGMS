import { describe, it, expect } from "vitest";
import { GET } from "../app/api/pubg/meta/route";

describe("GET /api/pubg/meta", () => {
  it("returns weapon meta statistics without emoji characters", async () => {
    const req = new Request("https://bgms.kr/api/pubg/meta");
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.weapons)).toBe(true);
  });
});
