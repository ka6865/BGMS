import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("WeaponMetaDashboard component code quality", () => {
  it("does not contain any text emoji characters and uses SVG icons", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu;
    expect(code.match(emojiRegex)).toBeNull();
    expect(code).toContain("lucide-react");
  });

  it("shows the collection notice only for sustained-burst data", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");
    const averageDamageCell = code.slice(
      code.indexOf('<th className="p-3">\n                <div>경기당 평균 딜량'),
      code.indexOf('<th className="p-3">\n                <div>지속 연사 명중'),
    );

    expect(averageDamageCell).not.toContain("수집 중");
  });

  it("shows pre and post sample counts beside every weapon comparison", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain("표본: {w.pre_patch.match_count}경기 → {w.post_patch.match_count}경기");
  });

  it("renders the reusable Recharts trend chart", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain('from "recharts"');
    expect(code).toContain("총기별 일별 채용률 추세");
  });

  it("lets the user select an individual weapon trend and shows burst collection progress", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain("총기별 일별 채용률 추세");
    expect(code).toContain("지속 연사 데이터 수집 현황");
    expect(code).toContain("selectedWeapon");
  });

  it("keeps the adoption chart on a readable zero-to-100 percent scale", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain('domain={[0, 100]}');
    expect(code).toContain('left: 8');
  });
});
