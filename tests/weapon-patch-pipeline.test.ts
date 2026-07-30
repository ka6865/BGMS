import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractPatchLabel,
  triggerWeaponPatchProposal,
  MIN_SOURCE_TEXT_LENGTH,
} from "@/lib/patch-notes/weaponProposalTrigger";
import {
  decideProposalChanges,
  describeColumn,
  isChangeDecision,
  isProposalStatus,
  listWeaponPatchProposals,
} from "@/lib/patch-notes/weaponProposalQuery";

describe("패치 버전 라벨 추출", () => {
  it("한국어 업데이트 표기에서 버전을 뽑는다", () => {
    expect(extractPatchLabel("업데이트 42.1 패치노트")).toBe("업데이트 42.1");
    expect(extractPatchLabel("PUBG 업데이트 43 안내")).toBe("업데이트 43");
  });

  it("영문 Update 표기와 숫자+패치 표기도 지원한다", () => {
    expect(extractPatchLabel("Update 42.2 Patch Notes")).toBe("업데이트 42.2");
    expect(extractPatchLabel("41.2 패치 상세")).toBe("업데이트 41.2");
  });

  it("버전을 찾을 수 없으면 null 을 반환해 도감 배지를 만들지 않는다", () => {
    expect(extractPatchLabel("상점 신규 스킨 출시")).toBeNull();
  });
});

describe("제안 생성 트리거", () => {
  const longText = "가".repeat(MIN_SOURCE_TEXT_LENGTH + 10);

  it("원문이 너무 짧으면 AI 를 호출하지 않고 건너뛴다", async () => {
    const createDeps = vi.fn();

    const outcome = await triggerWeaponPatchProposal({
      supabaseAdmin: {} as never,
      sourceText: "짧은 본문",
      sourceUrl: "https://pubg.com/ko/news/1",
      title: "업데이트 42.1",
      createDeps: createDeps as never,
    });

    expect(outcome.status).toBe("skipped");
    expect(createDeps).not.toHaveBeenCalled();
  });

  it("Gemini 키가 없으면 건너뛴다", async () => {
    const previous = process.env.GOOGLE_GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;

    try {
      const outcome = await triggerWeaponPatchProposal({
        supabaseAdmin: {} as never,
        sourceText: longText,
        sourceUrl: "https://pubg.com/ko/news/1",
        title: "업데이트 42.1",
      });
      expect(outcome.status).toBe("skipped");
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = previous;
    }
  });

  it("추출 실패는 예외를 던지지 않고 failed 로 보고한다", async () => {
    process.env.GOOGLE_GEMINI_API_KEY = "test-key";

    const supabaseAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: "조회 불가" } }),
          }),
        }),
      }),
    };

    const outcome = await triggerWeaponPatchProposal({
      supabaseAdmin: supabaseAdmin as never,
      sourceText: longText,
      sourceUrl: "https://pubg.com/ko/news/1",
      title: "업데이트 42.1",
      createDeps: (() => ({ generateJson: async () => ({ text: "{}", modelName: "m", promptTokens: 0, completionTokens: 0 }) })) as never,
    });

    expect(outcome.status).toBe("failed");
  });
});

describe("제안 조회·결정 계층", () => {
  it("status 와 decision 값을 화이트리스트로 검증한다", () => {
    expect(isProposalStatus("pending")).toBe(true);
    expect(isProposalStatus("deleted")).toBe(false);
    expect(isChangeDecision("accepted")).toBe(true);
    expect(isChangeDecision("maybe")).toBe(false);
  });

  it("컬럼명을 관리자가 읽을 수 있는 표시명으로 바꾼다", () => {
    expect(describeColumn("weapons", "damage")).toBe("데미지");
    expect(describeColumn("weapons", "bullet_speed")).toBe("탄속");
  });

  it("검증을 통과하지 않은 항목은 승인할 수 없다", async () => {
    const supabaseAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: async () => ({
              data: [
                { id: "change-1", validation_state: "ok" },
                { id: "change-2", validation_state: "stale" },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };

    const result = await decideProposalChanges(
      supabaseAdmin as never,
      "proposal-1",
      ["change-1", "change-2"],
      "accepted",
      "admin-1"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("검증을 통과하지 않은");
  });

  it("다른 제안에 속한 항목이 섞이면 거부한다", async () => {
    const supabaseAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: async () => ({ data: [{ id: "change-1", validation_state: "ok" }], error: null }),
          }),
        }),
      }),
    };

    const result = await decideProposalChanges(
      supabaseAdmin as never,
      "proposal-1",
      ["change-1", "change-foreign"],
      "accepted",
      "admin-1"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("속하지 않은");
  });

  it("제안 목록에 대상 표시명과 컬럼 표시명을 채워 반환한다", async () => {
    const supabaseAdmin = {
      from(table: string) {
        if (table === "weapon_patch_proposals") {
          return {
            select: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    {
                      id: "proposal-1",
                      source_url: "https://pubg.com/ko/news/1",
                      source_post_id: 10,
                      patch_label: "업데이트 42.1",
                      status: "pending",
                      model_name: "gemini",
                      validation_summary: { total: 1, ok: 1 },
                      created_at: "2026-07-30T00:00:00Z",
                      reviewed_at: null,
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }

        if (table === "weapon_patch_proposal_changes") {
          return {
            select: () => ({
              in: async () => ({
                data: [
                  {
                    id: "change-1",
                    proposal_id: "proposal-1",
                    target_table: "weapons",
                    target_id: "ar_m416",
                    column_name: "damage",
                    old_value: 41,
                    new_value: 43,
                    evidence_quote: "M416의 기본 데미지가 41에서 43으로 증가합니다.",
                    evidence_found: true,
                    confidence: "0.90",
                    validation_state: "ok",
                    validation_reason: null,
                    decision: "pending",
                  },
                ],
                error: null,
              }),
            }),
          };
        }

        return {
          select: () => ({
            in: async () => ({ data: [{ id: "ar_m416", name: "M416" }], error: null }),
          }),
        };
      },
    };

    const proposals = await listWeaponPatchProposals(supabaseAdmin as never);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].patchLabel).toBe("업데이트 42.1");
    expect(proposals[0].changes[0].targetName).toBe("M416");
    expect(proposals[0].changes[0].columnLabel).toBe("데미지");
    expect(proposals[0].changes[0].oldValue).toBe(41);
    expect(proposals[0].changes[0].newValue).toBe(43);
    expect(proposals[0].changes[0].confidence).toBeCloseTo(0.9);
  });
});

describe("동기화 경로와 UI 배선", () => {
  const readSource = (path: string) => readFileSync(resolve(path), "utf8");

  it("동기화 3경로가 모두 제안 생성 트리거를 호출한다", () => {
    for (const path of [
      "app/api/cron/patch-notes/route.ts",
      "app/api/admin/patch-notes/sync/route.ts",
      "scripts/sync_patch_notes.ts",
    ]) {
      const source = readSource(path);
      expect(source).toContain("triggerWeaponPatchProposal");
    }
  });

  it("승인 API 4개가 관리자 가드를 통과해야만 동작한다", () => {
    for (const path of [
      "app/api/admin/weapon-patch/route.ts",
      "app/api/admin/weapon-patch/decide/route.ts",
      "app/api/admin/weapon-patch/apply/route.ts",
      "app/api/admin/weapon-patch/revert/route.ts",
    ]) {
      const source = readSource(path);
      expect(source).toContain("requireAdmin");
      expect(source).toContain("if (!admin.ok) return admin.error;");
    }
  });

  it("적용·되돌리기는 RPC 로만 서비스 테이블을 변경한다", () => {
    const applySource = readSource("app/api/admin/weapon-patch/apply/route.ts");
    expect(applySource).toContain('rpc("apply_weapon_patch_proposal"');
    expect(applySource).not.toMatch(/\.from\("weapons"\)/);

    const revertSource = readSource("app/api/admin/weapon-patch/revert/route.ts");
    expect(revertSource).toContain('rpc("revert_weapon_patch_apply"');
  });

  it("관리자 화면에 제안 검토 탭과 컴포넌트가 연결되어 있다", () => {
    const editor = readSource("components/admin/GameDataEditor.tsx");
    expect(editor).toContain("WeaponPatchReview");
    expect(editor).toContain('id: "weapon-patch"');

    const review = readSource("components/admin/WeaponPatchReview.tsx");
    expect(review).toContain("/api/admin/weapon-patch/decide");
    expect(review).toContain("/api/admin/weapon-patch/apply");
    expect(review).toContain("패치노트 원문 근거");
  });

  it("버전 추적 마이그레이션이 patch_version 기록과 복원을 정의한다", () => {
    const migration = readSource(
      "supabase/migrations/20260730220000_weapon_patch_version_tracking.sql"
    );

    expect(migration).toContain("add column if not exists patch_version text");
    expect(migration).toContain("set patch_version = $1, patch_applied_at");
    expect(migration).toContain("previous_patch_version");
    expect(migration).toContain("create or replace function public.apply_weapon_patch_proposal");
    expect(migration).toContain("create or replace function public.revert_weapon_patch_apply");
  });

  it("되돌리기가 patch_version 과 patch_applied_at 을 함께 복원한다", () => {
    // 운영 E2E 검증에서 되돌린 뒤에도 patch_applied_at 이 남는 문제를 확인해 고쳤다.
    // 시각이 남으면 도감 정렬과 변경 이력이 실제 상태와 어긋난다.
    const migration = readSource(
      "supabase/migrations/20260730230000_fix_weapon_patch_revert_applied_at.sql"
    );

    expect(migration).toContain("add column if not exists previous_patch_applied_at timestamptz");
    expect(migration).toContain("v_previous_patch_applied_at := (v_before ->> 'patch_applied_at')");
    expect(migration).toContain("set patch_version = $1, patch_applied_at = $2 where id = $3");
    expect(migration).toContain("using v_log.previous_patch_version, v_log.previous_patch_applied_at");
  });
});
