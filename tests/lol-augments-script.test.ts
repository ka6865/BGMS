import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sample from "./fixtures/lol-augments/sample-16.21";

const directory = mkdtempSync(join(tmpdir(), "lol-augments-check-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("증강 원본 확인 CLI", () => {
  const flags = [
    ["augment-lists", sample.augmentLists], ["cherry-augments", sample.cherryAugments], ["kiwi-bin", sample.kiwiBin],
    ["stringtable-ko", sample.stringTableKo], ["stringtable-en", sample.stringTableEn],
  ] as const;
  const args = flags.flatMap(([flag, value]) => {
    const path = join(directory, `${flag}.json`);
    writeFileSync(path, JSON.stringify(value));
    return [`--${flag}`, path];
  });
  it("파일 경로로 추출하고 표시 검증 요약·실패 목록을 출력한다", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/lol_augments_extract_check.ts", ...args], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.poolCount).toBe(sample.cherryAugments.length);
    expect(summary.internalCount).toBe(5);
    expect(summary.ko.ratio).toBeGreaterThan(0.05);
    expect(summary.ko.failures.length).toBeGreaterThan(0);
    expect(Object.values(summary.ko.unresolvedByCause).reduce((sum, count) => Number(sum) + Number(count), 0)).toBe(summary.ko.unresolvedTokenCount);
    expect(summary.unknownIcons).toEqual([]);
    expect(summary.ko.displays).toHaveLength(summary.poolCount);
    expect(summary.ko.displays.some((entry: { displaySource: string }) => entry.displaySource === "desc_partial")).toBe(true);
    expect(summary.ko.displays.every((entry: { text: string }) => !entry.text.includes("@"))).toBe(true);
    expect(summary.validation).toMatchObject({ ok: true, problems: [], warnings: [] });
  });
  it("필수 경로가 없으면 원본을 읽지 않고 실패를 알린다", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/lol_augments_extract_check.ts"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("원본 경로가 필요합니다");
    expect(result.stdout).toBe("");
  });
});
