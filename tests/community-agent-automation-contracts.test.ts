import { describe, expect, it } from "vitest";
import { buildAgentAutomationContracts } from "../lib/admin-agent/automation-contracts";

describe("community agent automation contract", () => {
  it("does not present an unknown community policy as active", () => {
    const contract = buildAgentAutomationContracts().contracts.find((item) => item.id === "community-agent-publishing");
    expect(contract).toEqual(expect.objectContaining({ status: "manual" }));
  });

  it("describes the required human review for both posts and replies", () => {
    const result = buildAgentAutomationContracts();
    const contract = result.contracts.find((item) => item.id === "community-agent-publishing");
    expect(contract?.status).toBe("manual");
    expect(contract?.whatRuns).toContain("글·답글");
    expect(contract?.whatRuns).toContain("운영자 승인");
    expect(result.guardrails.join(" ")).not.toContain("별도 계약");
  });
});
