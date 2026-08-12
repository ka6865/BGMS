import { describe, expect, it } from "vitest";
import { describeScraperRequestFailure } from "@/lib/pubg-analysis/scraperDiagnostics";

describe("scraper request diagnostics", () => {
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
