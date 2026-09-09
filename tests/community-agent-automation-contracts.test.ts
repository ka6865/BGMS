import { describe, expect, it } from "vitest";
import { buildAgentAutomationContracts } from "../lib/admin-agent/automation-contracts";

describe("community agent automation contract", () => {
  it("does not present an unknown community policy as active", () => {
    const contract = buildAgentAutomationContracts().contracts.find((item) => item.id === "community-agent-publishing");
    expect(contract).toEqual(expect.objectContaining({ status: "manual" }));
  });

  it("is active only while collection and policy publishing are both enabled", () => {
    const active = buildAgentAutomationContracts({ communityAgent: { enabled: true, publishingEnabled: true } });
    const paused = buildAgentAutomationContracts({ communityAgent: { enabled: true, publishingEnabled: false } });
    expect(active.contracts.find((item) => item.id === "community-agent-publishing")?.status).toBe("active");
    expect(paused.contracts.find((item) => item.id === "community-agent-publishing")?.status).toBe("ready");
    expect(active.guardrails.join(" ")).toContain("일반 관리자 도구");
  });
});
