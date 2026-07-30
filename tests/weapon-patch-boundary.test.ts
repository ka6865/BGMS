import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PATCHABLE_COLUMNS, PATCHABLE_TABLES } from "@/lib/patch-notes/weaponSchema";
import {
  createWeaponPatchProposal,
  loadCatalogSnapshot,
} from "@/lib/patch-notes/weaponProposalService";
import { hashSourceText, type WeaponExtractDeps } from "@/lib/patch-notes/weaponExtract";
import { rowKey } from "@/lib/patch-notes/weaponValidate";

const sourceText = readFileSync(
  resolve("tests/fixtures/patch-notes/update-42-1.txt"),
  "utf8"
);

const WEAPON_ROWS = [
  { id: "ar_m416", name: "M416", damage: 41, bullet_speed: 880, ammo: "5.56mm", type: "AR", availability: "월드 스폰", weight: 3.9, patch_notes: null },
  { id: "ar_beryl", name: "Beryl M762", damage: 47, bullet_speed: 715, ammo: "7.62mm", type: "AR", availability: "월드 스폰", weight: 3.8, patch_notes: null },
];

interface MockState {
  existingProposal: { id: string } | null;
  insertedProposals: Record<string, unknown>[];
  insertedChanges: Record<string, unknown>[][];
  deletedProposalIds: string[];
  proposalInsertError: { code?: string; message: string } | null;
  changesInsertError: { code?: string; message: string } | null;
}

function createMockSupabase(state: MockState) {
  return {
    from(table: string) {
      if (table === "weapon_patch_proposals") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.existingProposal, error: null }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            state.insertedProposals.push(payload);
            return {
              select: () => ({
                single: async () =>
                  state.proposalInsertError
                    ? { data: null, error: state.proposalInsertError }
                    : { data: { id: "proposal-1" }, error: null },
              }),
            };
          },
          delete: () => ({
            eq: async (_column: string, value: string) => {
              state.deletedProposalIds.push(value);
              return { error: null };
            },
          }),
        };
      }

      if (table === "weapon_patch_proposal_changes") {
        return {
          insert: async (payload: Record<string, unknown>[]) => {
            state.insertedChanges.push(payload);
            return { error: state.changesInsertError };
          },
        };
      }

      // 게임 데이터 테이블: weapons 만 값을 반환하고 나머지는 빈 목록
      return {
        select: () => ({
          order: async () => ({
            data: table === "weapons" ? WEAPON_ROWS : [],
            error: null,
          }),
        }),
      };
    },
  };
}

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    existingProposal: null,
    insertedProposals: [],
    insertedChanges: [],
    deletedProposalIds: [],
    proposalInsertError: null,
    changesInsertError: null,
    ...overrides,
  };
}

function stubDeps(changes: unknown[]): WeaponExtractDeps & { calls: number } {
  const deps = {
    calls: 0,
    async generateJson() {
      deps.calls += 1;
      return {
        text: JSON.stringify({ changes }),
        modelName: "gemini-3.1-flash-lite",
        promptTokens: 1000,
        completionTokens: 50,
      };
    },
  };
  return deps;
}

const M416_DAMAGE_CHANGE = {
  target_table: "weapons",
  target_id: "ar_m416",
  column_name: "damage",
  new_value: "43",
  evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
  confidence: 0.93,
};

describe("loadCatalogSnapshot", () => {
  it("화이트리스트 컬럼만 조회하고 검증용 Map 을 함께 만든다", async () => {
    const selectSpy = vi.fn();
    const supabase = {
      from: () => ({
        select: (columns: string) => {
          selectSpy(columns);
          return { order: async () => ({ data: WEAPON_ROWS, error: null }) };
        },
      }),
    };


    const snapshot = await loadCatalogSnapshot(supabase as any, ["weapons"]);

    expect(selectSpy).toHaveBeenCalledWith(
      // 기대값을 화이트리스트에서 파생시켜 스키마 변경 시 함께 따라가게 한다.
      ["id", "name", ...Object.keys(PATCHABLE_COLUMNS.weapons)].join(",")
    );
    // 편집 대상이 아닌 컬럼은 조회하지 않는다.
    expect(selectSpy.mock.calls[0][0]).not.toContain("can_be_in_backpack");
    expect(selectSpy.mock.calls[0][0]).not.toContain("icon_url");
    expect(snapshot.catalog).toHaveLength(2);
    expect(snapshot.currentRows.get(rowKey("weapons", "ar_m416"))).toMatchObject({ damage: 41 });
  });
});

describe("createWeaponPatchProposal", () => {
  it("같은 본문의 제안이 이미 있으면 AI 를 호출하지 않는다", async () => {
    const state = baseState({ existingProposal: { id: "proposal-existing" } });
    const deps = stubDeps([M416_DAMAGE_CHANGE]);

    const result = await createWeaponPatchProposal({

      supabaseAdmin: createMockSupabase(state) as any,
      deps,
      sourceText,
      sourceUrl: "https://pubg.com/ko/news/1",
    });

    expect(result).toEqual({ status: "duplicate", proposalId: "proposal-existing" });
    expect(deps.calls).toBe(0);
    expect(state.insertedProposals).toHaveLength(0);
  });

  it("본문 해시를 저장해 제목 변경으로 중복이 우회되지 않게 한다", async () => {
    const state = baseState();
    const result = await createWeaponPatchProposal({

      supabaseAdmin: createMockSupabase(state) as any,
      deps: stubDeps([M416_DAMAGE_CHANGE]),
      sourceText,
      sourceUrl: "https://pubg.com/ko/news/1",
      patchLabel: "업데이트 42.1",
      sourcePostId: 42,
    });

    expect(result.status).toBe("created");
    expect(state.insertedProposals[0]).toMatchObject({
      source_text_hash: hashSourceText(sourceText),
      source_post_id: 42,
      patch_label: "업데이트 42.1",
      status: "pending",
      model_name: "gemini-3.1-flash-lite",
    });
  });

  it("검증 결과와 근거를 변경 항목에 함께 저장하고 승인은 pending 으로 둔다", async () => {
    const state = baseState();
    await createWeaponPatchProposal({

      supabaseAdmin: createMockSupabase(state) as any,
      deps: stubDeps([M416_DAMAGE_CHANGE]),
      sourceText,
      sourceUrl: "https://pubg.com/ko/news/1",
    });

    const [change] = state.insertedChanges[0];
    expect(change).toMatchObject({
      proposal_id: "proposal-1",
      target_table: "weapons",
      target_id: "ar_m416",
      operation: "update",
      column_name: "damage",
      old_value: 41,
      new_value: 43,
      evidence_found: true,
      validation_state: "ok",
      decision: "pending",
    });
    expect(change.evidence_quote).toBe(M416_DAMAGE_CHANGE.evidence_quote);
  });

  it("근거가 없는 항목은 invalid 로 저장해 승인 대상에서 제외한다", async () => {
    const state = baseState();
    await createWeaponPatchProposal({

      supabaseAdmin: createMockSupabase(state) as any,
      deps: stubDeps([
        {
          ...M416_DAMAGE_CHANGE,
          new_value: "70",
          evidence_quote: "M416이 대폭 상향되었습니다.",
        },
      ]),
      sourceText,
      sourceUrl: "https://pubg.com/ko/news/1",
    });

    const [change] = state.insertedChanges[0];
    expect(change).toMatchObject({
      validation_state: "invalid",
      evidence_found: false,
      decision: "pending",
    });
    expect(change.validation_reason).toContain("원문에서 찾을 수 없음");
  });

  it("저장할 항목이 없으면 빈 제안 행을 만들지 않는다", async () => {
    const state = baseState();
    const result = await createWeaponPatchProposal({

      supabaseAdmin: createMockSupabase(state) as any,
      deps: stubDeps([]),
      sourceText,
      sourceUrl: "https://pubg.com/ko/news/1",
    });

    expect(result.status).toBe("no_changes");
    expect(state.insertedProposals).toHaveLength(0);
    expect(state.insertedChanges).toHaveLength(0);
  });

  it("동시 실행으로 유니크 위반이 나면 기존 제안을 반환한다", async () => {
    const state = baseState({
      proposalInsertError: { code: "23505", message: "duplicate key" },
    });
    // 먼저 조회할 때는 없고, 위반 후 재조회에서는 존재하도록 전환
    let lookupCount = 0;
    const supabase = {
      ...createMockSupabase(state),
      from(table: string) {
        if (table === "weapon_patch_proposals") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  lookupCount += 1;
                  return {
                    data: lookupCount === 1 ? null : { id: "proposal-raced" },
                    error: null,
                  };
                },
              }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({ data: null, error: state.proposalInsertError }),
              }),
            }),
          };
        }
        return createMockSupabase(state).from(table);
      },
    };

    const result = await createWeaponPatchProposal({

      supabaseAdmin: supabase as any,
      deps: stubDeps([M416_DAMAGE_CHANGE]),
      sourceText,
      sourceUrl: "https://pubg.com/ko/news/1",
    });

    expect(result).toEqual({ status: "duplicate", proposalId: "proposal-raced" });
  });

  it("변경 항목 저장이 실패하면 제안 행을 되돌린다", async () => {
    const state = baseState({
      changesInsertError: { message: "insert failed" },
    });

    await expect(
      createWeaponPatchProposal({

        supabaseAdmin: createMockSupabase(state) as any,
        deps: stubDeps([M416_DAMAGE_CHANGE]),
        sourceText,
        sourceUrl: "https://pubg.com/ko/news/1",
      })
    ).rejects.toThrow("변경 항목 저장 실패");

    expect(state.deletedProposalIds).toEqual(["proposal-1"]);
  });
});

describe("관리자 게임 데이터 편집 경로", () => {
  const routeSource = readFileSync(resolve("app/api/admin/game-data/route.ts"), "utf8");

  it("service_role 쓰기 전에 테이블 화이트리스트를 검증한다", () => {
    expect(routeSource).toContain('from "@/lib/patch-notes/weaponSchema"');
    expect(routeSource).toContain("isPatchableTable");
    expect(routeSource.match(/assertPatchableTable\(/g)).toHaveLength(3);
  });

  it("화이트리스트가 관리자 UI 의 편집 카테고리와 일치한다", () => {
    const editorSource = readFileSync(resolve("components/admin/GameDataEditor.tsx"), "utf8");
    // 카테고리 내비게이션 배열만 잘라낸다. (은신처 상자 편집기 탭과 구분)
    const navStart = editorSource.indexOf('{ id: "weapons", label: "무기" }');
    const navEnd = editorSource.indexOf('{ id: "system", label: "시스템/캐시" }');
    expect(navStart).toBeGreaterThan(-1);
    expect(navEnd).toBeGreaterThan(navStart);

    const navBlock = editorSource.slice(navStart, navEnd);
    // crates / users 는 전용 라우트를 사용하므로 game-data 화이트리스트 대상이 아니다.
    const editorCategories = [...navBlock.matchAll(/\{ id: "([a-z]+)"/g)]
      .map((match) => match[1])
      .filter((id) => !["crates", "users"].includes(id));

    expect([...new Set(editorCategories)].sort()).toEqual([...PATCHABLE_TABLES].sort());
  });
});
