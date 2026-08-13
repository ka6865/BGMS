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
    expect(code).toContain("selectedTrendWeapon");
  });

  it("uses category then weapon filters for the daily adoption trend", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain("selectedTrendCategory");
    expect(code).toContain("selectedTrendWeapon");
    expect(code).toContain("카테고리 전체");
    expect(code).toContain("총기 전체");
    expect(code).toContain("metaMatchType");
    expect(code).toContain("경쟁전");
  });

  it("changes the preference card with the selected category or weapon", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain("selectedScopeWeapons");
    expect(code).not.toContain("const lmgWeapons");
  });

  it("labels sustained hits as a comparable average and suppresses sparse samples", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain("지속 교전 명중");
    expect(code).toContain("같은 적과 1~3초 이어진 교전에서 맞힌 탄 수");
    expect(code).toContain("연사 표본");
    expect(code).toContain("연사 표본 20경기부터 비교 가능");
  });

  it("keeps the adoption chart on a readable zero-to-100 percent scale", () => {
    const code = readFileSync("components/meta/WeaponMetaDashboard.tsx", "utf8");

    expect(code).toContain('domain={[0, 100]}');
    expect(code).toContain('left: 8');
  });
});
