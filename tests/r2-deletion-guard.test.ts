import { describe, it, expect } from "vitest";
import {
  inspectDeletionKey,
  isDeletableKey,
  partitionDeletionKeys,
  PROTECTED_KEY_PREFIXES,
  PROTECTED_EXTENSIONS,
} from "../lib/pubg-analysis/r2DeletionGuard";
import { deleteObjectsFromR2 } from "../lib/pubg-analysis/r2Service";

describe("R2 삭제 가드: 이미지 자산을 절대 삭제하지 않는다", () => {
  it("crates 경로 이미지를 차단한다", () => {
    const verdict = inspectDeletionKey("crates/11010112.webp");
    expect(verdict).toEqual({ allowed: false, reason: "protected-prefix" });
  });

  it("weapons 경로 이미지를 차단한다", () => {
    const verdict = inspectDeletionKey("weapons/ar_akm.webp");
    expect(verdict).toEqual({ allowed: false, reason: "protected-prefix" });
  });

  it("보호 경로의 모든 접두사를 차단한다", () => {
    for (const prefix of PROTECTED_KEY_PREFIXES) {
      expect(isDeletableKey(`${prefix}anything.json`)).toBe(false);
    }
  });

  it("경로가 달라도 이미지 확장자는 차단한다", () => {
    for (const extension of PROTECTED_EXTENSIONS) {
      expect(isDeletableKey(`some/other/path/file${extension}`)).toBe(false);
    }
  });

  it("대소문자가 섞여도 차단한다", () => {
    expect(isDeletableKey("Crates/Foo.WEBP")).toBe(false);
    expect(isDeletableKey("WEAPONS/BAR.PNG")).toBe(false);
    expect(isDeletableKey("root/IMAGE.PnG")).toBe(false);
  });

  it("삭제 목록 아카이브를 차단한다", () => {
    const verdict = inspectDeletionKey("telemetry-inventory/2026-07-31.json");
    expect(verdict).toEqual({ allowed: false, reason: "protected-pattern" });
  });
});

describe("R2 삭제 가드: 잘못된 입력을 거부한다", () => {
  it("빈 값과 비문자열을 거부한다", () => {
    for (const value of ["", "   ", null, undefined, 123, {}, []]) {
      expect(isDeletableKey(value)).toBe(false);
    }
  });

  it("상위 경로 탈출과 절대 경로를 거부한다", () => {
    expect(inspectDeletionKey("../secret.json")).toEqual({
      allowed: false,
      reason: "path-traversal",
    });
    expect(inspectDeletionKey("/etc/passwd")).toEqual({
      allowed: false,
      reason: "path-traversal",
    });
  });
});

describe("R2 삭제 가드: 정리 대상은 허용한다", () => {
  it("루트 분석 캐시를 허용한다", () => {
    const key = "001288d0-007c-4ca7-843b-7553c0fe4881_pk_ohu_v60_analyze.json";
    expect(inspectDeletionKey(key)).toEqual({ allowed: true });
  });

  it("telemetry-map 캐시를 허용한다", () => {
    expect(isDeletableKey("telemetry-map/abc-def_v60.json")).toBe(true);
  });
});

describe("R2 삭제 가드: 목록 분리", () => {
  it("삭제 대상과 차단 대상을 분리하고 이유를 보고한다", () => {
    const result = partitionDeletionKeys([
      "match-a_nick_v60_analyze.json",
      "crates/11010112.webp",
      "telemetry-map/match-b.json",
      "weapons/ar_akm.webp",
      "root/photo.png",
      "",
    ]);

    expect(result.deletable).toEqual([
      "match-a_nick_v60_analyze.json",
      "telemetry-map/match-b.json",
    ]);
    expect(result.blocked.map((entry) => entry.reason)).toEqual([
      "protected-prefix",
      "protected-prefix",
      "protected-extension",
      "empty-key",
    ]);
  });

  it("이미지가 섞인 목록에서 이미지가 하나도 통과하지 않는다", () => {
    const keys = [
      ...Array.from({ length: 50 }, (_, index) => `crates/asset-${index}.webp`),
      ...Array.from({ length: 50 }, (_, index) => `weapons/gun-${index}.webp`),
      ...Array.from({ length: 10 }, (_, index) => `match-${index}_nick_v60_analyze.json`),
    ];
    const result = partitionDeletionKeys(keys);

    expect(result.deletable).toHaveLength(10);
    expect(result.blocked).toHaveLength(100);
    expect(result.deletable.some((key) => /\.(webp|png|jpe?g)$/i.test(key))).toBe(false);
  });
});

describe("R2 삭제 함수: 기본 동작이 안전하다", () => {
  it("옵션을 주지 않으면 dry-run 으로 동작해 실제 삭제하지 않는다", async () => {
    const result = await deleteObjectsFromR2(["match-a_nick_v60_analyze.json"]);
    expect(result.dryRun).toBe(true);
    expect(result.deletedCount).toBe(0);
    expect(result.plannedCount).toBe(1);
  });

  it("dryRun 을 명시해도 삭제하지 않는다", async () => {
    const result = await deleteObjectsFromR2(["match-a_nick_v60_analyze.json"], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.deletedCount).toBe(0);
  });

  it("이미지 키는 계획 단계에서 제외되고 이유가 보고된다", async () => {
    const result = await deleteObjectsFromR2([
      "crates/11010112.webp",
      "weapons/ar_akm.webp",
      "match-a_nick_v60_analyze.json",
    ]);
    expect(result.plannedCount).toBe(1);
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.every((entry) => entry.reason === "protected-prefix")).toBe(true);
  });

  it("삭제 대상이 이미지뿐이면 계획이 비어 있다", async () => {
    const result = await deleteObjectsFromR2(["crates/a.webp", "weapons/b.webp"]);
    expect(result.plannedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
  });
});
