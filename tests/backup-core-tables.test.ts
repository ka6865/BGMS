import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_TABLES,
  backupCoreTables,
  buildBackupKey,
  readTableRows,
} from "../scripts/backup_core_tables";
import { isDeletableKey } from "../lib/pubg-analysis/r2DeletionGuard";

type TableData = Record<string, unknown[]>;

function createSupabase(tables: TableData, errors: Record<string, string> = {}) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        range: vi.fn(async (from: number, to: number) => {
          if (errors[table]) return { data: null, error: { message: errors[table] } };
          const rows = tables[table] ?? [];
          return { data: rows.slice(from, to + 1), error: null };
        }),
      })),
    })),
  } as never;
}

describe("핵심 테이블 백업", () => {
  it("복구 불가능한 사용자 데이터를 대상으로 삼는다", () => {
    // 분석 캐시는 PUBG API 로 재생성할 수 있어 백업 대상이 아니다.
    // 여기에 추가되면 백업 용량이 수백 MB 로 늘어난다.
    expect(BACKUP_TABLES).toContain("map_markers");
    expect(BACKUP_TABLES).toContain("profiles");
    expect(BACKUP_TABLES).toContain("global_benchmarks");
    expect(BACKUP_TABLES).not.toContain("match_stats_raw");
    expect(BACKUP_TABLES).not.toContain("processed_match_telemetry");
    expect(BACKUP_TABLES).not.toContain("pubg_player_cache");
  });

  it("1000행 제한을 넘는 테이블을 끝까지 읽는다", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ id: index + 1 }));
    const supabase = createSupabase({ map_markers: rows });

    const result = await readTableRows(supabase, "map_markers");

    expect(result.rows).toHaveLength(2_500);
    expect(result.skipped).toBe(false);
  });

  it("한 테이블을 읽지 못해도 나머지를 백업한다", async () => {
    const supabase = createSupabase(
      { profiles: [{ id: "a" }], map_markers: [{ id: 1 }] },
      { reports: "relation does not exist" },
    );
    const uploaded: Array<{ key: string; body: string }> = [];

    const result = await backupCoreTables(
      supabase,
      async (key, body) => { uploaded.push({ key, body }); },
      { write: () => undefined },
    );

    expect(uploaded).toHaveLength(1);
    expect(result.tables.find((table) => table.table === "reports")?.skipped).toBe(true);
    expect(result.totalRows).toBe(2);
  });

  it("dry-run 은 업로드하지 않는다", async () => {
    const supabase = createSupabase({ profiles: [{ id: "a" }] });
    const upload = vi.fn();

    const result = await backupCoreTables(supabase, upload, { dryRun: true, write: () => undefined });

    expect(upload).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.key).toBeNull();
  });

  it("조회가 전부 실패하면 빈 백업을 만들지 않는다", async () => {
    // 빈 파일을 올리면 이전 백업이 있는데도 복구 가능하다고 오인할 수 있다.
    const supabase = createSupabase({}, Object.fromEntries(
      BACKUP_TABLES.map((table) => [table, "permission denied"]),
    ));

    await expect(
      backupCoreTables(supabase, async () => undefined, { write: () => undefined }),
    ).rejects.toThrow("backup-core-tables-no-rows");
  });

  it("백업 본문에 실제 행 데이터를 담는다", async () => {
    const supabase = createSupabase({
      map_markers: [{ id: 1, map_id: "Erangel", x: 100, y: 200 }],
    });
    let body = "";

    await backupCoreTables(supabase, async (_key, value) => { body = value; }, { write: () => undefined });
    const parsed = JSON.parse(body);

    expect(parsed.data.map_markers).toEqual([{ id: 1, map_id: "Erangel", x: 100, y: 200 }]);
    expect(parsed.createdAt).toBeTypeOf("string");
  });

  it("백업 키는 날짜순으로 정렬된다", () => {
    const older = buildBackupKey(new Date("2026-08-01T00:00:00.000Z"));
    const newer = buildBackupKey(new Date("2026-08-02T00:00:00.000Z"));

    expect(older < newer).toBe(true);
    expect(older.startsWith("backups/")).toBe(true);
  });

  it("백업 파일은 R2 정리 작업이 지울 수 없다", () => {
    // Supabase 무료 플랜에 자동 백업이 없어 이 파일이 유일한 복구 수단이다.
    const key = buildBackupKey(new Date("2026-08-01T00:00:00.000Z"));

    expect(isDeletableKey(key)).toBe(false);
    expect(isDeletableKey("backups/anything.json")).toBe(false);
  });
});
