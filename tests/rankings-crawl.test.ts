import { describe, expect, it } from "vitest";

describe("랭킹 검색 수집 계약", () => {
  it("생성된 robots.txt는 랭킹 본문 API만 예외로 허용하고 경로 경계를 지킨다", async () => {
    const { default: robots } = await import("@/app/robots");
    const { resolveRobots } = await import("next/dist/build/webpack/loaders/metadata/resolve-route-data");
    const text = resolveRobots(robots());
    expect([...text.matchAll(/^User-Agent: (.+)$/gm)].map(match => match[1])).toEqual(["*"]);
    const rules = [...text.matchAll(/^(Allow|Disallow): (.+)$/gm)];
    // 현행 단일 * 그룹의 리터럴 접두사와 끝 앵커만 평가한다.
    for (const rule of rules) expect(rule[2]).not.toContain("*");
    const canCrawl = (path: string) => {
      const matching = rules.filter(([, , pattern]) => pattern.endsWith("$")
        ? path === pattern.slice(0, -1)
        : path.startsWith(pattern));
      matching.sort((a, b) => b[2].length - a[2].length || a[1].localeCompare(b[1]));
      return !matching.length || matching[0][1] === "Allow";
    };
    for (const path of [
      "/rankings", "/api/rankings",
      "/api/rankings?tab=damage&mode=all&perspective=all&matchType=all",
      "/api/rankings?matchType=official&perspective=fpp&mode=solo&tab=kills",
      "/api/rankings?tab=tier", "/api/rankings?", "/api/rankings?tab=tier&next=/admin",
    ]) expect(canCrawl(path), path).toBe(true);
    for (const path of [
      "/api", "/api?tab=damage", "/api/admin", "/api/pubg/player", "/api/admin/agent/tools",
      "/api/rankings/", "/api/rankings/private?tab=damage", "/api/rankings-admin",
      "/api/rankings.json", "/api/rankingsExtra?tab=damage", "/api/Rankings?tab=damage",
      "/admin", "/admin/agent", "/login?next=/rankings", "/map-editor",
    ]) expect(canCrawl(path), path).toBe(false);
  });

  it("랭킹 JSON의 색인 제외 헤더는 쿼리와 무관하게 적용하고 페이지로 번지지 않는다", async () => {
    const { default: nextConfig } = await import("@/next.config");
    const { unstable_getResponseFromNextConfig } = await import("next/experimental/testing/server");
    for (const path of ["/api/rankings", "/api/rankings?tab=damage&mode=all&perspective=all&matchType=all", "/api/rankings?tab=tier"]) {
      const response = await unstable_getResponseFromNextConfig({ url: `https://bgms.kr${path}`, nextConfig });
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
    }
    for (const path of ["/rankings", "/rankings?tab=tier", "/stats/steam/Player", "/api/rankings/private", "/api/rankingsExtra"]) {
      const response = await unstable_getResponseFromNextConfig({ url: `https://bgms.kr${path}`, nextConfig });
      expect(response.headers.has("x-robots-tag"), path).toBe(false);
    }
  });
});
