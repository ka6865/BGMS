import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("BoardDetailClient migration to views API route", () => {
  it("should not call increment_views RPC directly", () => {
    const filePath = resolve(process.cwd(), "components/board/BoardDetailClient.tsx");
    const content = readFileSync(filePath, "utf-8");

    // increment_views RPC 호출이 제거되어야 함
    expect(content).not.toMatch(/\.rpc\s*\(\s*["']increment_views["']/);
    expect(content).not.toMatch(/rpc\("increment_views"/);
  });

  it("should call the views API route instead", () => {
    const filePath = resolve(process.cwd(), "components/board/BoardDetailClient.tsx");
    const content = readFileSync(filePath, "utf-8");

    // 새 views route 호출이 있어야 함
    expect(content).toMatch(/\/api\/board\/posts\/\$\{.*?\.id\}\/views/);
    expect(content).toMatch(/fetch\s*\(/);
  });

  it("should handle response errors gracefully without breaking UI", () => {
    const filePath = resolve(process.cwd(), "components/board/BoardDetailClient.tsx");
    const content = readFileSync(filePath, "utf-8");

    // 에러 처리가 있어야 함
    expect(content).toMatch(/\.catch\s*\(/);
  });
});
