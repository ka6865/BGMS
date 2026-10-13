import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertRoundtripPayload, localMigrationSql } from "../scripts/verify_backup_roundtrip_local";
import type { TableBackupResult } from "../scripts/backup_core_tables";

function readFixture(): Parameters<typeof assertRoundtripPayload>[0] {
  return JSON.parse(gunzipSync(readFileSync(resolve("tests/fixtures/backup/core-tables-roundtrip.json.gz"))).toString("utf8"));
}

describe("로컬 roundtrip 백업 계약", () => {
  it("실제 fixture는 허용하고 data/metadata의 누락·추가·중복 테이블은 거부한다", () => {
    expect(() => assertRoundtripPayload(readFixture())).not.toThrow();
    const missingData = readFixture();
    delete missingData.data.map_settings;
    const missingMetadata = readFixture();
    missingMetadata.tables = missingMetadata.tables.filter(row => row.table !== "map_settings");
    const extraData = readFixture();
    extraData.data.unexpected = [];
    const extraMetadata = readFixture();
    extraMetadata.tables.push({ table: "unexpected", rowCount: 0, skipped: false, error: null });
    const duplicateMetadata = readFixture();
    duplicateMetadata.tables[1] = duplicateMetadata.tables[0];

    for (const payload of [missingData, missingMetadata, extraData, extraMetadata, duplicateMetadata]) {
      expect(() => assertRoundtripPayload(payload)).toThrow("roundtrip fixture table list mismatch");
    }
  });

  it("metadata 행 수와 실제 본문 길이가 다르면 실패한다", () => {
    const payload = readFixture();
    const posts = payload.tables.find(row => row.table === "posts") as TableBackupResult;
    posts.rowCount += 1;

    expect(() => assertRoundtripPayload(payload)).toThrow("roundtrip fixture row count mismatch: posts");
  });

  it("7개 복원 대상 밖 테이블에 데이터가 있으면 성공으로 보고하지 않는다", () => {
    const payload = readFixture();
    payload.data.map_markers = [{ id: 1 }];
    const markers = payload.tables.find(row => row.table === "map_markers") as TableBackupResult;
    markers.rowCount = 1;

    expect(() => assertRoundtripPayload(payload)).toThrow("roundtrip fixture has unrestored rows: map_markers");
  });
});

describe("로컬 복원 migration 적용", () => {
  it("호스트 확장 설치 두 줄만 제외하고 실제 애플리케이션 SQL을 보존한다", () => {
    const sql = readFileSync(resolve("supabase/migrations/20261005081214_pubg_collection_database_clock.sql"), "utf8");
    const installs = "create extension if not exists pg_cron with schema pg_catalog;\n" +
      "create extension if not exists pg_net with schema extensions;\n";

    expect(sql).toContain(installs);
    expect(localMigrationSql(sql)).toBe(sql.replace(installs, ""));
  });

  it("다른 확장과 같은 줄의 애플리케이션 SQL은 생략하지 않는다", () => {
    const sql = "create extension if not exists pgcrypto;\n" +
      "create extension if not exists pg_net with schema extensions; select 1;\n" +
      "select net.http_post('fixture-only');\n";

    expect(localMigrationSql(sql)).toBe(sql);
  });
});
