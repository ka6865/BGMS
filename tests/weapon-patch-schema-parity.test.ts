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

  it("v1 에서는 기존 항목 갱신만 허용한다", () => {
    expect(migration).toContain("check (operation = 'update')");
  });
});
