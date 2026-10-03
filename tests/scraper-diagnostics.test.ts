import { describe, expect, it } from "vitest";
import { describeScraperRequestFailure, scraperRequestRequiresAttention } from "@/lib/pubg-analysis/scraperDiagnostics";

describe("scraper request diagnostics", () => {
  it("keeps unsupported boards and unavailable/in-progress matches separate from outages", () => {
    expect(scraperRequestRequiresAttention({ stage: "leaderboard", status: 404, code: "Not Found" })).toBe(false);
    expect(scraperRequestRequiresAttention({ stage: "match", status: 409, code: "in progress" })).toBe(false);
    expect(scraperRequestRequiresAttention({ stage: "player", status: 404, code: "Not Found" })).toBe(true);
    for (const status of [401, 403, 429, 500, 503, null]) {
      expect(scraperRequestRequiresAttention({ stage: "match", status, code: "failure" })).toBe(true);
    }
  });
  it("keeps the request stage and HTTP status without exposing request secrets", () => {
    const detail = describeScraperRequestFailure("season", {
      response: {
        status: 401,
        data: {
          errors: [{ title: "Unauthorized", detail: "Bearer secret-api-key" }],
        },
      },
      message: "Request failed with status code 401 for Bearer secret-api-key",
    });

    expect(detail).toEqual({
      stage: "season",
      status: 401,
      code: "Unauthorized",
    });
    expect(JSON.stringify(detail)).not.toContain("secret-api-key");
  });

  it("uses a safe network code when PUBG did not return an HTTP response", () => {
    expect(describeScraperRequestFailure("player", { code: "ECONNABORTED" })).toEqual({
      stage: "player",
      status: null,
      code: "ECONNABORTED",
    });
  });
});
