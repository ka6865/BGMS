import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import {
  BACKUP_TABLES,
  MAX_ROWS_PER_TABLE,
  PAGE_SIZE,
  TABLE_KEYS,
  assertBackupComplete,
  backupCoreTables,
  buildBackupKey,
  buildPartKey,
  planReadRanges,
  readRetry,
  readTableRows,
  streamTableRows,
  restoreBackupRows,
} from "../scripts/backup_core_tables";
import { verifyCoreBackup } from "../scripts/verify_core_backup";
import { isDeletableKey } from "../lib/pubg-analysis/r2DeletionGuard";

type Row = Record<string, unknown>;
type TableData = Record<string, Row[]>;

function compare(a: unknown, b: unknown): number {
  return (a as number | string) < (b as number | string) ? -1 : (a as number | string) > (b as number | string) ? 1 : 0;
}

/** PostgREST 의 select/eq/gt/order/limit 동작을 흉내 낸다. */
function createSupabase(tables: TableData, errors: Record<string, string> = {}) {
  return {
    from: vi.fn((table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const orders: string[] = [];
      let limit = Number.POSITIVE_INFINITY;
      let offset = 0;
      let head = false;
      const chain = {
        select: vi.fn((_columns?: string, options?: { head?: boolean }) => { head = options?.head === true; return chain; }),
        lte: vi.fn((column: string, value: unknown) => { filters.push(row => compare(row[column], value) <= 0); return chain; }),
        lt: vi.fn((column: string, value: unknown) => { filters.push(row => compare(row[column], value) < 0); return chain; }),
        range: vi.fn((from: number, to: number) => { offset = from; limit = to - from + 1; return chain; }),
        eq: vi.fn((column: string, value: unknown) => { filters.push(row => row[column] === value); return chain; }),
        gt: vi.fn((column: string, value: unknown) => { filters.push(row => compare(row[column], value) > 0); return chain; }),
        gte: vi.fn((column: string, value: unknown) => { filters.push(row => compare(row[column], value) >= 0); return chain; }),
        order: vi.fn((column: string) => { orders.push(column); return chain; }),
        limit: vi.fn((count: number) => { limit = count; return chain; }),
        abortSignal: vi.fn(() => chain),
        then: (resolve: (result: unknown) => unknown) => {
          if (errors[table]) return Promise.resolve({ data: null, error: { message: errors[table] } }).then(resolve);
          const matched = (tables[table] ?? [])
            .filter(row => filters.every(filter => filter(row)))
            .sort((a, b) => orders.reduce((result, column) => result || compare(a[column], b[column]), 0));
          if (head) return Promise.resolve({ data: null, count: matched.length, error: null }).then(resolve);
          return Promise.resolve({ data: matched.slice(offset, offset + limit), error: null }).then(resolve);
        },
      };
      return chain;
    }),
  } as never;
}

describe("핵심 테이블 백업", () => {
  const originalDelays = readRetry.delaysMs;
  // 재시도 대기를 없애 실패 경로 테스트가 느려지지 않게 한다.
  beforeEach(() => { readRetry.delaysMs = [0, 0, 0]; });
  afterEach(() => { readRetry.delaysMs = originalDelays; });

  it("복구 불가능한 사용자 데이터를 대상으로 삼는다", () => {
    // 분석 캐시는 PUBG API 로 재생성할 수 있어 백업 대상이 아니다.
    // 여기에 추가되면 백업 용량이 수백 MB 로 늘어난다.
    expect(BACKUP_TABLES).toContain("map_markers");
    expect(BACKUP_TABLES).toContain("profiles");
    expect(BACKUP_TABLES).toContain("global_benchmarks");
    // 150만 행 읽기가 timeout 으로 백업 전체를 막아 Supabase 일일 백업에 맡긴다.
    expect(BACKUP_TABLES).not.toContain("pubg_player_matches");
    expect(BACKUP_TABLES).toContain("pubg_match_performance");
    expect(BACKUP_TABLES).toContain("weapon_meta_match_samples");
    expect(BACKUP_TABLES).toContain("weapon_meta_patches");
    expect(BACKUP_TABLES).toContain("board_post_delete_credentials");
    expect(BACKUP_TABLES).toContain("board_comment_delete_credentials");
    expect(BACKUP_TABLES).not.toContain("match_stats_raw");
    expect(BACKUP_TABLES).not.toContain("processed_match_telemetry");
    expect(BACKUP_TABLES).not.toContain("pubg_player_cache");
  });

  it("모든 백업 대상에 기본키 순서를 정의한다", () => {
    for (const table of BACKUP_TABLES) expect(TABLE_KEYS[table].length).toBeGreaterThan(0);
    // 운영 기본키와 같은 순서여야 인덱스를 따라 읽는다.
    expect(TABLE_KEYS.pubg_player_matches).toEqual(["player_id", "platform", "match_id"]);
    expect(TABLE_KEYS.pubg_match_performance)
      .toEqual(["platform", "account_id", "match_id", "calculation_version", "result_version"]);
  });

  it("1000행 제한을 넘는 테이블을 끝까지 읽는다", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ id: index + 1 }));
    const supabase = createSupabase({ map_markers: rows });

    const result = await readTableRows(supabase, "map_markers");

    expect(result.rows).toHaveLength(2_500);
    expect(result.skipped).toBe(false);
  });

  it("복합 기본키 테이블을 OFFSET 없이 기본키 순서로 빠짐없이 한 번씩 읽는다", async () => {
    // 한 선수의 경기가 페이지 경계에 걸치도록 묶음 크기를 PAGE_SIZE 와 어긋나게 만든다.
    const rows: Row[] = [];
    for (let player = 0; player < 7; player++) {
      for (const platform of ["kakao", "steam"]) {
        for (let match = 0; match < 333; match++) {
          rows.push({ player_id: `p${player}`, platform, match_id: `m${String(match).padStart(4, "0")}` });
        }
      }
    }
    const shuffled = [...rows].reverse();
    const supabase = createSupabase({ pubg_player_matches: shuffled }) as unknown as { from: ReturnType<typeof vi.fn> };

    const result = await readTableRows(supabase as never, "pubg_player_matches");

    expect(result.error).toBeNull();
    expect(result.rows).toEqual(rows);
    const chains = supabase.from.mock.results.map(entry => entry.value);
    expect(chains.every(chain => chain.limit.mock.calls.every(([count]: [number]) => count <= PAGE_SIZE))).toBe(true);
    expect(chains.every(chain => chain.range.mock.calls.length === 0)).toBe(true);
    expect(chains[0].order.mock.calls.map(([column]: [string]) => column)).toEqual(["player_id", "platform", "match_id"]);
  });

  it("복합 기본키 테이블은 대부분의 페이지를 요청 1번으로 읽는다", async () => {
    const rows: Row[] = [];
    for (let player = 0; player < 50; player++) {
      for (let match = 0; match < 97; match++) rows.push({ player_id: `p${String(player).padStart(3, "0")}`, platform: "steam", match_id: `m${String(match).padStart(3, "0")}` });
    }
    const supabase = createSupabase({ pubg_player_matches: rows }) as unknown as { from: ReturnType<typeof vi.fn> };

    const result = await readTableRows(supabase as never, "pubg_player_matches");

    expect(result.rows).toEqual(rows);
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    // 페이지마다 이미 읽은 묶음 일부를 다시 받으므로 페이지 수가 조금 늘 수 있지만, 단계 조회(페이지당 3번)보다 훨씬 적다.
    expect(supabase.from.mock.calls.length).toBeLessThanOrEqual(pages * 2);
  });

  it("한 묶음이 PAGE_SIZE 보다 커도 정확한 단계 조회로 빠짐없이 한 번씩 읽는다", async () => {
    const big = Array.from({ length: 2_345 }, (_, match) => ({ player_id: "p0", platform: "steam", match_id: `m${String(match).padStart(5, "0")}` }));
    const rest = Array.from({ length: 10 }, (_, match) => ({ player_id: "p1", platform: "kakao", match_id: `m${match}` }));
    const result = await readTableRows(createSupabase({ pubg_player_matches: [...rest, ...big] }), "pubg_player_matches");
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([...big, ...rest]);
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
    expect(result.complete).toBe(false);
    expect(JSON.parse(uploaded[0].body)).toMatchObject({
      complete: false,
      tables: expect.arrayContaining([expect.objectContaining({ table: "reports", error: "relation does not exist" })]),
    });
    expect(() => assertBackupComplete(result)).toThrow("backup-core-tables-incomplete: reports");
  });

  it("detects rows beyond the safety limit rather than claiming a full backup", async () => {
    expect(MAX_ROWS_PER_TABLE).toBeGreaterThan(1_100_000);
    const rows = Array.from({ length: 2_501 }, (_, id) => ({ id }));
    const result = await readTableRows(createSupabase({ map_markers: rows }), "map_markers", { maxRows: 2_500 });
    expect(result.rows).toHaveLength(2_500);
    expect(result.error).toBe("backup-row-limit-exceeded");
    const exact = await readTableRows(createSupabase({ map_markers: rows.slice(0, 2_500) }), "map_markers", { maxRows: 2_500 });
    expect(exact.error).toBeNull();
    expect(exact.rows).toHaveLength(2_500);
  });

  it.each([
    ["map_markers", "id"],
    ["map_settings", "map_id"],
    ["weapon_meta_patches", "version"],
    ["board_post_delete_credentials", "post_id"],
    ["board_comment_delete_credentials", "comment_id"],
  ])(
    "paginates %s by its unique key and bounds each request", async (table, key) => {
      const supabase = createSupabase({}) as unknown as { from: ReturnType<typeof vi.fn> };
      await readTableRows(supabase as never, table);
      const chain = supabase.from.mock.results[0].value;
      expect(chain.order).toHaveBeenCalledWith(key);
      expect(chain.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    },
  );

  it("marks failures after the first page as partial without losing already read rows", async () => {
    const chain = {
      select: () => chain, order: () => chain, eq: () => chain, gt: () => chain,
      limit: () => chain, abortSignal: () => chain,
      then: vi.fn().mockImplementationOnce(resolve => resolve({ data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }))
        .mockImplementationOnce(resolve => resolve({ data: null, error: { message: "read interrupted" } })),
    };
    const result = await readTableRows({ from: () => chain } as never, "profiles");
    expect(result).toMatchObject({ skipped: false, error: "read interrupted" });
    expect(result.rows).toHaveLength(1000);
  });

  /** 호출 순서대로 결과를 돌려주는 단일 체인. 마지막 결과는 이후 호출에도 반복한다. */
  function sequencedChain(results: Array<{ data: Row[] | null; error: { message: string } | null }>) {
    let calls = 0;
    const chain = {
      select: () => chain, order: () => chain, eq: () => chain, gt: () => chain,
      limit: () => chain, abortSignal: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(results[Math.min(calls++, results.length - 1)]).then(resolve),
    };
    return { chain, calls: () => calls };
  }

  it("페이지 하나가 statement timeout 에 걸려도 다시 읽어 완전하게 백업한다", async () => {
    const { chain, calls } = sequencedChain([
      { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
      { data: [{ id: 1000 }], error: null },
    ]);
    const result = await readTableRows({ from: () => chain } as never, "profiles");
    expect(result).toMatchObject({ skipped: false, error: null });
    expect(result.rows).toHaveLength(1001);
    expect(calls()).toBe(4);
  });

  it("일시적 오류가 계속되면 정해진 횟수만 다시 시도하고 부분 백업으로 보고한다", async () => {
    const { chain, calls } = sequencedChain([
      { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
    ]);
    const result = await readTableRows({ from: () => chain } as never, "profiles");
    expect(result).toMatchObject({ skipped: false, error: "canceling statement due to statement timeout" });
    expect(result.rows).toHaveLength(1000);
    // 첫 페이지 1번 + 실패한 페이지 처음 시도 1번 + 재시도 3번
    expect(calls()).toBe(5);
  });

  it("권한이나 스키마 오류 같은 영구 오류는 다시 시도하지 않는다", async () => {
    const { chain, calls } = sequencedChain([{ data: null, error: { message: "permission denied for table profiles" } }]);
    const result = await readTableRows({ from: () => chain } as never, "profiles");
    expect(result).toMatchObject({ skipped: true, error: "permission denied for table profiles" });
    expect(calls()).toBe(1);
  });

  it("큰 테이블은 part 로 나눠 올리고 manifest 를 마지막에 올린다", async () => {
    const matches = Array.from({ length: 2_500 }, (_, index) => ({ id: index + 1 }));
    const supabase = createSupabase({ weapon_meta_match_samples: matches, profiles: [{ id: "a" }] });
    const uploaded: Array<{ key: string; body: string }> = [];
    const now = new Date("2026-10-13T00:00:00.000Z");

    const result = await backupCoreTables(supabase, async (key, body) => { uploaded.push({ key, body }); },
      { write: () => undefined, partRows: 1_000, now });

    const manifestKey = buildBackupKey(now);
    expect(uploaded.map(entry => entry.key)).toEqual([
      buildPartKey(manifestKey, "weapon_meta_match_samples", 1),
      buildPartKey(manifestKey, "weapon_meta_match_samples", 2),
      buildPartKey(manifestKey, "weapon_meta_match_samples", 3),
      manifestKey,
    ]);
    const manifest = JSON.parse(uploaded[3].body);
    expect(manifest).toMatchObject({ formatVersion: 2, complete: true });
    expect(manifest.data.weapon_meta_match_samples).toBeUndefined();
    expect(manifest.data.profiles).toEqual([{ id: "a" }]);
    expect(manifest.parts.weapon_meta_match_samples.map((part: { rows: number }) => part.rows)).toEqual([1_000, 1_000, 500]);
    const restored = uploaded.slice(0, 3).flatMap(entry => JSON.parse(entry.body));
    expect(restored).toEqual(matches);
    expect(result.tables.find(table => table.table === "weapon_meta_match_samples")).toMatchObject({ rowCount: 2_500, parts: 3 });
    expect(() => assertBackupComplete(result)).not.toThrow();
    for (const entry of uploaded) expect(isDeletableKey(entry.key)).toBe(false);
  });

  it("part 업로드가 실패하면 완전 백업으로 보고하지 않는다", async () => {
    const matches = Array.from({ length: 2_500 }, (_, index) => ({ id: index + 1 }));
    const supabase = createSupabase({ weapon_meta_match_samples: matches, profiles: [{ id: "a" }] });
    const uploaded: string[] = [];
    let calls = 0;

    const result = await backupCoreTables(supabase, async (key) => {
      calls += 1;
      if (calls === 2) throw new Error("r2 unavailable");
      uploaded.push(key);
    }, { write: () => undefined, partRows: 1_000 });

    expect(result.complete).toBe(false);
    expect(result.tables.find(table => table.table === "weapon_meta_match_samples")?.error).toBe("backup-part-upload-failed");
    const manifest = uploaded[uploaded.length - 1];
    expect(manifest.endsWith(".json") && !manifest.includes("/part-")).toBe(true);
    expect(() => assertBackupComplete(result)).toThrow("backup-core-tables-incomplete: weapon_meta_match_samples");
  });

  describe("구간 동시 읽기", () => {
    // 첫 글자가 0~z 에 고르게 퍼진 닉네임을 만든다.
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    const players = (count: number, perPlayer: number) => {
      const rows: Row[] = [];
      for (let player = 0; player < count; player++) {
        const id = `${alphabet[player % alphabet.length]}${String(player).padStart(4, "0")}`;
        for (let match = 0; match < perPlayer; match++) {
          rows.push({ player_id: id, platform: "steam", match_id: `m${String(match).padStart(3, "0")}` });
        }
      }
      return rows.sort((a, b) => compare(a.player_id, b.player_id) || compare(a.match_id, b.match_id));
    };
    const keyOf = (row: Row) => `${row.player_id}|${row.platform}|${row.match_id}`;

    it("첫 키 값으로 겹치지 않는 오름차순 구간을 만든다", async () => {
      const ranges = await planReadRanges(createSupabase({ pubg_player_matches: players(200, 50) }), "pubg_player_matches", 4);
      expect(ranges).toHaveLength(4);
      expect(ranges[0]).toEqual({ through: ranges[1].after });
      expect(ranges[3]).toEqual({ after: ranges[2].through });
      const bounds = ranges.slice(0, 3).map(range => range.through as string);
      expect([...bounds].sort()).toEqual(bounds);
      expect(new Set(bounds).size).toBe(3);
    });

    it("큰 묶음 때문에 경계가 같으면 하나로 줄이고, 작은 테이블은 구간 하나로 읽는다", async () => {
      const skewed = [...players(1, 9_000), ...players(3, 10).map(row => ({ ...row, player_id: `z${row.player_id}` }))];
      const ranges = await planReadRanges(createSupabase({ pubg_player_matches: skewed }), "pubg_player_matches", 4);
      expect(ranges.length).toBeLessThan(4);
      expect(await planReadRanges(createSupabase({ pubg_player_matches: players(2, 10) }), "pubg_player_matches", 4)).toEqual([{}]);
    });

    it("경계 계산에 큰 OFFSET 조회를 쓰지 않는다", async () => {
      const supabase = createSupabase({ pubg_player_matches: players(200, 50) }) as unknown as { from: ReturnType<typeof vi.fn> };
      await planReadRanges(supabase as never, "pubg_player_matches", 4);
      const chains = supabase.from.mock.results.map(entry => entry.value);
      expect(chains.every(chain => chain.range.mock.calls.length === 0)).toBe(true);
    });

    it("후보 밖의 첫 글자(대문자·한글·기호)가 섞여도 모든 행이 정확히 한 구간에 들어간다", async () => {
      const odd = ["Zed", "가나다", "_under", "~tilde", "Ärger"].flatMap(id =>
        Array.from({ length: 30 }, (_, match) => ({ player_id: id, platform: "kakao", match_id: `m${match}` })));
      const source = [...players(200, 50), ...odd];
      const supabase = createSupabase({ pubg_player_matches: source });
      const ranges = await planReadRanges(supabase, "pubg_player_matches", 4);
      expect(ranges.length).toBeGreaterThan(1);
      const seen: string[] = [];
      for (const range of ranges) {
        await streamTableRows(supabase, "pubg_player_matches", rows => { seen.push(...rows.map(row => keyOf(row))); }, { range });
      }
      expect(seen).toHaveLength(source.length);
      expect(new Set(seen).size).toBe(source.length);
    });

    it("여러 구간을 동시에 읽어 올린 백업을 목록대로 복원하면 모든 행이 정확히 한 번씩 있다", async () => {
      const source = players(240, 45);
      const now = new Date("2026-10-14T00:00:00.000Z");
      const store = new Map<string, string>();
      const result = await backupCoreTables(createSupabase({ pubg_player_matches: source }),
        async (key, body) => { store.set(key, body); },
        { write: () => undefined, partRows: 1_000, now, tables: ["pubg_player_matches"] });

      expect(result.complete).toBe(true);
      const manifestKey = buildBackupKey(now);
      const manifest = JSON.parse(store.get(manifestKey)!);
      const restored = await restoreBackupRows(manifestKey, manifest, async key => store.get(key) ?? null, ["pubg_player_matches"]);
      const keys = restored.pubg_player_matches.map(row => keyOf(row as Row));
      expect(keys).toHaveLength(source.length);
      expect(new Set(keys).size).toBe(source.length);
      expect([...keys].sort()).toEqual(source.map(keyOf).sort());
      expect(manifest.parts.pubg_player_matches.map((part: { key: string }) => part.key))
        .toEqual(manifest.parts.pubg_player_matches.map((_: unknown, index: number) => buildPartKey(manifestKey, "pubg_player_matches", index + 1)));
    });

    it("한 구간이라도 읽기에 실패하면 완전 백업으로 보고하지 않는다", async () => {
      const source = players(240, 45);
      const ranges = await planReadRanges(createSupabase({ pubg_player_matches: source }), "pubg_player_matches", 4);
      const failingAfter = ranges[2].after;
      const supabase = createSupabase({ pubg_player_matches: source }) as unknown as { from: ReturnType<typeof vi.fn> };
      type FakeChain = { gt: (column: string, value: unknown) => unknown; then: unknown };
      const original = supabase.from.getMockImplementation() as unknown as (table: string) => FakeChain;
      supabase.from.mockImplementation((table: string) => {
        const chain = original(table);
        const gt = chain.gt;
        chain.gt = vi.fn((column: string, value: unknown) => {
          // 세 번째 구간(첫 키 > failingAfter)의 조회만 실패시킨다.
          if (column === "player_id" && value === failingAfter) {
            chain.then = (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { message: "range read failed" } }).then(resolve);
          }
          return gt(column, value);
        });
        return chain;
      });

      const result = await backupCoreTables(supabase as never, async () => undefined,
        { write: () => undefined, partRows: 1_000, tables: ["pubg_player_matches"] });
      const matches = result.tables.find(table => table.table === "pubg_player_matches")!;
      expect(result.complete).toBe(false);
      expect(matches.error).toBe("range read failed");
      expect(matches.rowCount).toBeLessThan(source.length);
      expect(() => assertBackupComplete(result)).toThrow("pubg_player_matches");
    });

    it("첫 키 종류가 적은 성과 테이블은 빠른 경로를 건너뛴다", async () => {
      const rows = Array.from({ length: 2_500 }, (_, index) => ({ platform: "steam", account_id: `a${String(index).padStart(5, "0")}`, match_id: "m", calculation_version: 3, result_version: 73 }));
      const supabase = createSupabase({ pubg_match_performance: rows }) as unknown as { from: ReturnType<typeof vi.fn> };
      const result = await readTableRows(supabase as never, "pubg_match_performance");
      expect(result.rows).toEqual(rows);
      const chains = supabase.from.mock.results.map(entry => entry.value);
      expect(chains.some(chain => chain.gte.mock.calls.length > 0)).toBe(false);
    });
  });

  describe("분할 백업 복원", () => {
    const now = new Date("2026-10-13T00:00:00.000Z");
    const manifestKey = buildBackupKey(now);
    const matches = Array.from({ length: 2_500 }, (_, index) => ({ id: index + 1 }));
    const source = { weapon_meta_match_samples: matches, profiles: [{ id: "a" }], posts: [{ id: 1, title: "t" }] };

    async function storeBackup() {
      const store = new Map<string, string>();
      await backupCoreTables(createSupabase(source), async (key, body) => { store.set(key, body); },
        { write: () => undefined, partRows: 1_000, now });
      return store;
    }

    it("manifest 의 part 목록을 따라 원래 행을 그대로 다시 조립한다", async () => {
      const store = await storeBackup();
      const manifest = JSON.parse(store.get(manifestKey)!);
      const restored = await restoreBackupRows(manifestKey, manifest, async key => store.get(key) ?? null);

      expect(Object.keys(restored).sort()).toEqual([...BACKUP_TABLES].sort());
      expect(restored.weapon_meta_match_samples).toEqual(matches);
      expect(restored.profiles).toEqual(source.profiles);
      expect(restored.posts).toEqual(source.posts);
      expect(restored.map_markers).toEqual([]);

      const lines: string[] = [];
      const counts = await verifyCoreBackup(manifestKey, async key => store.get(key) ?? null, line => lines.push(line));
      expect(counts.weapon_meta_match_samples).toBe(2_500);
      expect(lines.at(-1)).toContain("복원 검증 통과");
    });

    it("part 파일이 없으면 실패한다", async () => {
      const store = await storeBackup();
      const missing = buildPartKey(manifestKey, "weapon_meta_match_samples", 2);
      store.delete(missing);
      await expect(restoreBackupRows(manifestKey, JSON.parse(store.get(manifestKey)!), async key => store.get(key) ?? null))
        .rejects.toThrow(`backup-restore-part-missing: ${missing}`);
    });

    it("part 행 수가 manifest 와 다르면 실패한다", async () => {
      const store = await storeBackup();
      const key = buildPartKey(manifestKey, "weapon_meta_match_samples", 3);
      store.set(key, JSON.stringify(JSON.parse(store.get(key)!).slice(1)));
      await expect(restoreBackupRows(manifestKey, JSON.parse(store.get(manifestKey)!), async k => store.get(k) ?? null))
        .rejects.toThrow(`backup-restore-part-row-mismatch: ${key}`);
    });

    it("테이블 총 행 수가 manifest 기록과 다르면 실패한다", async () => {
      const store = await storeBackup();
      const manifest = JSON.parse(store.get(manifestKey)!);
      manifest.tables.find((table: { table: string }) => table.table === "profiles").rowCount = 2;
      await expect(restoreBackupRows(manifestKey, manifest, async key => store.get(key) ?? null))
        .rejects.toThrow("backup-restore-row-count-mismatch: profiles");
    });

    it("part 목록이 줄었거나 순서가 바뀌면 실패한다", async () => {
      const store = await storeBackup();
      const dropped = JSON.parse(store.get(manifestKey)!);
      dropped.parts.weapon_meta_match_samples.pop();
      await expect(restoreBackupRows(manifestKey, dropped, async key => store.get(key) ?? null))
        .rejects.toThrow("backup-restore-part-count-mismatch: weapon_meta_match_samples");
      const swapped = JSON.parse(store.get(manifestKey)!);
      swapped.parts.weapon_meta_match_samples.reverse();
      await expect(restoreBackupRows(manifestKey, swapped, async key => store.get(key) ?? null))
        .rejects.toThrow("backup-restore-part-key-mismatch");
    });

    it("미완료 manifest 나 테이블 목록이 다른 manifest 로는 복원하지 않는다", async () => {
      const store = await storeBackup();
      const incomplete = { ...JSON.parse(store.get(manifestKey)!), complete: false };
      await expect(restoreBackupRows(manifestKey, incomplete, async key => store.get(key) ?? null))
        .rejects.toThrow("backup-restore-incomplete-manifest");
      const shortList = JSON.parse(store.get(manifestKey)!);
      shortList.tables = shortList.tables.filter((table: { table: string }) => table.table !== "posts");
      await expect(restoreBackupRows(manifestKey, shortList, async key => store.get(key) ?? null))
        .rejects.toThrow("backup-restore-table-list-mismatch");
      await expect(verifyCoreBackup(manifestKey, async () => null, () => undefined))
        .rejects.toThrow(`backup-restore-manifest-missing: ${manifestKey}`);
    });
  });

  it("dry-run 은 업로드하지 않는다", async () => {
    const supabase = createSupabase({ profiles: [{ id: "a" }] });
    const upload = vi.fn();

    const result = await backupCoreTables(supabase, upload, { dryRun: true, write: () => undefined });

    expect(upload).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.key).toBeNull();
    expect(result.tables.find(table => table.table === "profiles")?.rowCount).toBe(1);
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
    expect(parsed.complete).toBe(true);
  });

  it("gzip 백업 fixture에 최종 삭제 비밀과 분석 버전을 보존한다", () => {
    const compressed = readFileSync(resolve("tests/fixtures/backup/core-tables-roundtrip.json.gz"));
    expect(compressed.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const fixture = JSON.parse(gunzipSync(compressed).toString("utf8"));

    expect(fixture.complete).toBe(true);
    expect(fixture.data.posts[0].password_hash).toBeNull();
    expect(fixture.data.comments[0].password_hash).toBeNull();
    expect(fixture.data.board_post_delete_credentials[0]).toMatchObject({ post_id: 918001, password_hash: expect.any(String) });
    expect(fixture.data.board_comment_delete_credentials[0]).toMatchObject({ comment_id: 918002, password_hash: fixture.data.board_post_delete_credentials[0].password_hash });
    expect(fixture.data.pubg_match_performance[0]).toMatchObject({ calculation_version: 73, result_version: 2 });
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
    expect(isDeletableKey(buildPartKey(key, "pubg_player_matches", 1))).toBe(false);
  });
});
