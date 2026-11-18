import { GTA6_GUIDE_CATEGORY, postBasePath } from "@/lib/gta6/guides";

describe("GTA6 공략 게시판 경로", () => {
  it("GTA6 공략 분류 글만 /gta6/guides 아래로 보낸다", () => {
    expect(postBasePath(GTA6_GUIDE_CATEGORY)).toBe("/gta6/guides");
    expect(postBasePath("자유")).toBe("/board");
    expect(postBasePath(null)).toBe("/board");
  });
});
