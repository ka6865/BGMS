import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";

const root = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("애드센스 광고 단위", () => {
  it("광고 위치마다 서로 다른 단위 ID를 쓴다", () => {
    const slots = Object.values(ADSENSE_SLOTS);
    expect(new Set(slots).size).toBe(slots.length);
    for (const slot of slots) expect(slot).toMatch(/^\d{10}$/);
  });

  it("화면 코드에 애드핏 배너나 하드코딩한 애드센스 단위 ID가 남지 않는다", () => {
    const files = ["app", "components", "lib"].flatMap(sourceFiles)
      .filter((file) => !file.endsWith("lib/ads/adsenseUnits.ts"));
    const slotIds = Object.values(ADSENSE_SLOTS);
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, file).not.toMatch(/AdfitBanner|kakao_ad_area|DAN-[A-Za-z0-9]+/);
      for (const slot of slotIds) expect(source, file).not.toContain(`"${slot}"`);
    }
  });
});
