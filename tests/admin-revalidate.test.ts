import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { revalidateTag } from "next/cache";
import { POST } from "../app/api/admin/revalidate/route";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

function request(authorization?: string, tag = "match-analysis") {
  const url = new URL("http://localhost/api/admin/revalidate");
  if (tag) url.searchParams.set("tag", tag);
  return new NextRequest(url, {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

describe("관리자 캐시 무효화 인증", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", "configured-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, ""])("비밀값이 %s이면 Bearer undefined를 거부한다", async (secret) => {
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", secret);
    const response = await POST(request("Bearer undefined"));
    expect(response.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong-secret", "Basic configured-secret", "Bearer "])(
    "인증 헤더 %s는 거부한다", async (header) => {
      const response = await POST(request(header));
      expect(response.status).toBe(401);
      expect(revalidateTag).not.toHaveBeenCalled();
    },
  );

  it("설정된 토큰은 기존 max 방식으로 태그를 무효화한다", async () => {
    const response = await POST(request("Bearer configured-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("match-analysis", "max");
  });

  it("인증 후 태그가 없으면 캐시를 건드리지 않는다", async () => {
    const response = await POST(request("Bearer configured-secret", ""));
    expect(response.status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
