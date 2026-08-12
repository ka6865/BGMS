import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("WeaponMetaDashboard component code quality", () => {
  it("does not contain any text emoji characters and uses SVG icons", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu;
    expect(code.match(emojiRegex)).toBeNull();
    expect(code).toContain("lucide-react");
  });
});
