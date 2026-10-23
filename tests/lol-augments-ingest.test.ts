import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/lol-augments/sample-16.21";
import { buildIngestion, createSourceDownloader, notesUrl, parsePatchNotes, type SourceKind } from "../lib/lol/augments/ingest";
import { runIngestion } from "../scripts/lol_augments_ingest";

const sources: Record<SourceKind, unknown> = { "augment-lists": sample.augmentLists, "cherry-augments": sample.cherryAugments,
  "kiwi-bin": sample.kiwiBin, "stringtable-ko": sample.stringTableKo, "stringtable-en": sample.stringTableEn };
const notes = { url: notesUrl("16.21"), published_at: null, added_names: ["푸른 방어막"], removed_names: [], parse_status: "partial" as const };

describe("증강 수집·공식 대조", () => {
  it("표시 규칙을 저장 계약으로 변환하고 공식 이름 일치만 승인한다", () => {
    const result = buildIngestion("16.21", sources, notes);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every(row => row.localizations.length === 2 && /^[0-9a-f]{64}$/.test(row.source_hash))).toBe(true);
    expect(Object.values(result.distribution.ko_kr).reduce((a, b) => a + b, 0)).toBe(result.rows.length);
    expect(result.changes.find(c => c.platform_id === 3051)).toMatchObject({ official: true, review_status: "approved" });
    expect(result.changes.some(c => c.review_status === "pending")).toBe(true);
    expect(result.rows.flatMap(a => a.localizations).every(l => !/<script/i.test(l.display_text))).toBe(true);
  });
  it("기준 게시본이 없는 첫 수집은 공식 신규만 변경으로 남기고 나머지 풀은 초기 도감으로 둔다", () => {
    const result = buildIngestion("16.21", sources, { ...notes, removed_names: ["도박꾼"], parse_status: "ok" });
    expect(result.baseline).toBe("none");
    expect(result.changes.filter(c => c.platform_id !== null)).toEqual([
      expect.objectContaining({ platform_id: 3051, change_type: "added", official: true, review_status: "approved" }),
    ]);
    expect(result.changes.find(c => c.platform_id === null)).toMatchObject({ change_type: "removed", official: true });
    expect(result.changes.some(c => c.review_status === "pending")).toBe(false);
  });
  it("파싱 실패는 모든 변경을 검토 대기로 남긴다", () => {
    const result = buildIngestion("16.21", sources, { ...notes, parse_status: "failed" });
    expect(result.changes.every(c => !c.official && c.review_status === "pending")).toBe(true);
  });
  it("직전 게시본과 비교해 변경 없는 재수집을 신규로 분류하지 않는다", () => {
    const previous = buildIngestion("16.21", sources, notes).augments;
    const result = buildIngestion("16.21", sources, { ...notes, added_names: [], parse_status: "ok" }, previous);
    expect(result.changes).toEqual([]);
    expect(result.baseline).toBe("published");
  });
  it("아수라장 절만 읽고 HTML 원문을 결과에 넣지 않는다", () => {
    const result = parsePatchNotes(`<time datetime="2026-10-20"></time><h2>일반 모드</h2><h3>신규 증강</h3><ul><li>무관</li></ul>
      <h2>아수라장</h2><h3>신규 실버 증강</h3><ul><li><strong>푸른 방어막</strong>: 설명</li></ul>
      <h3>삭제된 증강</h3><ul><li>없어진 증강</li></ul><h2>버그 수정</h2><li>무관</li>`, notes.url);
    expect(result).toMatchObject({ published_at: "2026-10-20T00:00:00.000Z", added_names: ["푸른 방어막"], removed_names: ["없어진 증강"], parse_status: "ok" });
    expect(Object.keys(result)).not.toContain("html");
    expect(parsePatchNotes("<html>변경된 형식</html>", notes.url).parse_status).toBe("failed");
  });
  it("JSON 데이터만 파싱하고 3회 재시도·요청 간격·지수 백오프를 지킨다", async () => {
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network")).mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(new Response('{"ok":true}'));
    expect(await createSourceDownloader(fetcher, wait)("https://source.invalid/file")).toBe('{"ok":true}');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toHaveLength(5);
    expect(wait).toHaveBeenCalledWith(1000);
    expect(wait).toHaveBeenCalledWith(2000);
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("content-length가 없어도 스트림 크기를 제한하고 실행형 입력을 거부한다", async () => {
    await expect(createSourceDownloader(vi.fn(async () => new Response("12345")), async () => undefined)("https://source.invalid/file", true, 4))
      .rejects.toThrow("source_too_large");
    const fetcher = vi.fn(async () => new Response("globalThis.secret=1"));
    await expect(createSourceDownloader(fetcher, async () => undefined)("https://source.invalid/file")).rejects.toThrow("source_download_failed");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("403은 재시도하지 않고 고정 User-Agent와 사유 코드를 사용한다", async () => {
    const fetcher = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(createSourceDownloader(fetcher, async () => undefined)("https://source.invalid/file")).rejects.toThrow("source_forbidden");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toBeDefined();
  });
  it("실제 신규 목록 형태의 p/strong과 dateTime 속성을 읽는다", () => {
    const result = parsePatchNotes(`<time dateTime="2026-10-20T18:00:00Z"></time><h2>무작위 총력전: 아수라장</h2>
      <h4>신규 증강</h4><p><strong>실버</strong> <strong>푸른 방어막</strong></p><ul><li>설명은 이름이 아닙니다.</li></ul>
      <h4>삭제된 증강</h4><ul><li>타오르는 이자</li></ul>`, notes.url);
    expect(result).toMatchObject({ published_at: "2026-10-20T18:00:00.000Z", added_names: ["푸른 방어막"], removed_names: ["타오르는 이자"], parse_status: "ok" });
  });
  it("쓰기 플래그가 없으면 네트워크·DB 진입 전에 거부한다", async () => {
    const original = process.env.LOL_AUGMENT_INGEST_ENABLED;
    delete process.env.LOL_AUGMENT_INGEST_ENABLED;
    try { await expect(runIngestion({ patch: "16.21", dryRun: false })).rejects.toThrow("ingest_disabled"); }
    finally { if (original !== undefined) process.env.LOL_AUGMENT_INGEST_ENABLED = original; }
  });
  it("source-dir dry-run은 자격 증명·네트워크 없이 실행한다", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lol-ingest-test-"));
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      for (const [kind, value] of Object.entries(sources)) await writeFile(join(folder, `${kind}.json`), JSON.stringify(value));
      const result = await runIngestion({ patch: "16.21", dryRun: true, sourceDir: folder });
      expect(result).toMatchObject({ dryRun: true, count: 46 });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); await rm(folder, { recursive: true, force: true }); }
  });
});
