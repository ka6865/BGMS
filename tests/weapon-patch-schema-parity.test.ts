import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listPatchableColumns,
  PATCHABLE_COLUMNS,
  WEAPON_TYPES,
} from "@/lib/patch-notes/weaponSchema";

const MIGRATION_PATH = "supabase/migrations/20260730200100_weapon_patch_proposals.sql";
const migration = readFileSync(resolve(MIGRATION_PATH), "utf8");

/** weapon_patch_editable_columns() 본문의 VALUES 목록을 읽어옵니다. */
function readSqlWhitelist(): { table: string; column: string }[] {
  const body = migration.split("create or replace function public.weapon_patch_editable_columns()")[1];
  expect(body, "weapon_patch_editable_columns() 정의를 찾지 못했습니다").toBeTruthy();
  const values = body.split("as $$")[1].split("$$")[0];
  return [...values.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((match) => ({
    table: match[1],
    column: match[2],
  }));
}

describe("화이트리스트 이중 정의 일치", () => {
  it("TypeScript 와 SQL 의 편집 허용 컬럼 목록이 같다", () => {
    const fromTs = listPatchableColumns()
      .map(({ table, column }) => `${table}.${column}`)
      .sort();
    const fromSql = readSqlWhitelist()
      .map(({ table, column }) => `${table}.${column}`)
      .sort();

    expect(fromSql).toEqual(fromTs);
  });

  it("식별자와 표시명은 어느 쪽에서도 편집 대상이 아니다", () => {
    for (const columns of Object.values(PATCHABLE_COLUMNS)) {
      expect(Object.keys(columns)).not.toContain("id");
      expect(Object.keys(columns)).not.toContain("name");
    }
    const sqlColumns = readSqlWhitelist().map((entry) => entry.column);
    expect(sqlColumns).not.toContain("id");
    expect(sqlColumns).not.toContain("name");
  });

  it("무기 분류 enum 에 UI 전용 값 ALL 이 섞이지 않는다", () => {
    expect(WEAPON_TYPES).not.toContain("ALL");
  });
});

describe("마이그레이션 안전 장치", () => {
  it("제안 테이블 세 개 모두 RLS 를 활성화한다", () => {
    for (const table of [
      "weapon_patch_proposals",
      "weapon_patch_proposal_changes",
      "weapon_patch_apply_log",
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from anon, authenticated`);
    }
  });

  it("검증을 통과하지 않은 항목은 승인 상태가 될 수 없다", () => {
    expect(migration).toContain("weapon_patch_proposal_changes_accept_requires_ok");
    expect(migration).toContain("decision <> 'accepted' or validation_state = 'ok'");
  });

  it("동일 패치노트 본문에 대한 중복 제안을 해시로 차단한다", () => {
    expect(migration).toContain("weapon_patch_proposals_source_text_hash_key");
  });

  it("적용 RPC 가 화이트리스트를 재확인하고 old_value 를 대조한다", () => {
    const applyBody = migration.split("create or replace function public.apply_weapon_patch_proposal(")[1];
    expect(applyBody).toBeTruthy();
    expect(applyBody).toContain("weapon_patch_editable_columns()");
    expect(applyBody).toContain("raise exception 'column not editable");
    expect(applyBody).toContain("skipped_stale");
    expect(applyBody).toContain("for update");
  });

  it("적용 RPC 는 승인되고 검증을 통과한 항목만 대상으로 한다", () => {
    const applyBody = migration.split("create or replace function public.apply_weapon_patch_proposal(")[1];
    expect(applyBody).toContain("c.decision = 'accepted'");
    expect(applyBody).toContain("c.validation_state = 'ok'");
  });

  it("RPC 실행 권한을 service_role 로만 제한한다", () => {
    for (const fn of [
      "public.weapon_patch_editable_columns()",
      "public.apply_weapon_patch_proposal(uuid, uuid)",
      "public.revert_weapon_patch_apply(uuid, uuid)",
    ]) {
      expect(migration).toContain(`revoke all on function ${fn} from public, anon, authenticated`);
      expect(migration).toContain(`grant execute on function ${fn} to service_role`);
    }
  });

  it("SECURITY DEFINER 함수는 search_path 를 고정한다", () => {
    const definerCount = migration.match(/security definer/g)?.length ?? 0;
    const searchPathCount = migration.match(/set search_path = ''/g)?.length ?? 0;
    expect(definerCount).toBeGreaterThan(0);
    expect(searchPathCount).toBeGreaterThanOrEqual(definerCount);
  });

  it("v1 마이그레이션은 기존 항목 갱신만 허용했다", () => {
    // 삭제 지원은 20260731060000 에서 제약을 확장한다.
    // 이 테스트는 v1 파일 자체의 원래 정의가 보존되는지 확인한다.
    expect(migration).toContain("check (operation = 'update')");
  });
});

const REMOVAL_MIGRATION_PATH = "supabase/migrations/20260731060000_weapon_patch_removal.sql";
const removalMigration = readFileSync(resolve(REMOVAL_MIGRATION_PATH), "utf8");

describe("삭제 반영 마이그레이션 안전 장치", () => {
  it("행을 물리 삭제하지 않고 removed_at 소프트 삭제로 처리한다", () => {
    // delete from 이 서비스 테이블을 향하면 과거 전적 참조가 깨진다.
    expect(removalMigration).not.toMatch(/delete\s+from\s+public\.(weapons|attachments|ammo|consumables|throwables|vehicles)/i);
    // 동적 SQL 문자열 안이라 작은따옴표가 이스케이프되어 있다.
    expect(removalMigration).toContain("set removed_at = timezone(''utc'', now())");
  });

  it("편집 대상 6개 테이블 모두에 삭제 컬럼을 추가한다", () => {
    for (const table of [
      "weapons",
      "attachments",
      "ammo",
      "consumables",
      "throwables",
      "vehicles",
    ]) {
      expect(removalMigration).toContain(
        `alter table public.${table} add column if not exists removed_at timestamptz`
      );
    }
  });

  it("operation 제약을 update 와 remove 로만 확장한다", () => {
    expect(removalMigration).toContain("check (operation in ('update', 'remove'))");
  });

  it("삭제 제안은 column_name 을 removed_at 으로 고정한다", () => {
    expect(removalMigration).toContain("operation <> 'remove' or column_name = 'removed_at'");
  });

  it("수치 변경은 new_value 를 계속 요구한다", () => {
    expect(removalMigration).toContain("operation = 'update' and new_value is not null");
  });

  it("적용 RPC 는 삭제도 승인·검증 통과 항목만 대상으로 한다", () => {
    const applyBody = removalMigration.split(
      "create or replace function public.apply_weapon_patch_proposal("
    )[1];
    expect(applyBody).toBeTruthy();
    expect(applyBody).toContain("c.decision = 'accepted'");
    expect(applyBody).toContain("c.validation_state = 'ok'");
    expect(applyBody).toContain("for update");
  });

  it("되돌리기가 삭제 상태를 적용 전 값으로 복원한다", () => {
    const revertBody = removalMigration.split(
      "create or replace function public.revert_weapon_patch_apply("
    )[1];
    expect(revertBody).toBeTruthy();
    expect(revertBody).toContain("before_row ->> 'removed_at'");
  });

  it("SECURITY DEFINER 함수는 search_path 를 고정한다", () => {
    const definerCount = removalMigration.match(/security definer/g)?.length ?? 0;
    const searchPathCount = removalMigration.match(/set search_path = ''/g)?.length ?? 0;
    expect(definerCount).toBeGreaterThan(0);
    expect(searchPathCount).toBeGreaterThanOrEqual(definerCount);
  });

  it("RPC 실행 권한을 service_role 로만 제한한다", () => {
    for (const fn of [
      "public.apply_weapon_patch_proposal(uuid, uuid)",
      "public.revert_weapon_patch_apply(uuid, uuid)",
    ]) {
      expect(removalMigration).toContain(
        `revoke all on function ${fn} from public, anon, authenticated`
      );
      expect(removalMigration).toContain(`grant execute on function ${fn} to service_role`);
    }
  });
});
