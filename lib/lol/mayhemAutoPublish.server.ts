import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { autoPublishPlan, championUpdateGroup, comboUpdateGroup, referenceUpdateGroup, type UpdateGroup } from "./mayhemAdminUpdates";
import { getChampionDatasetAdmin, reviewChampionDataset } from "./mayhemChampionDatasetStore.server";
import { getMayhemDatasetAdmin } from "./mayhemDatasetStore.server";
import { getReferenceAdmin, reviewReference } from "./mayhemReferenceStore.server";

export type AutoPublishKind = "combos" | "champions" | "references";
type Review = (input: { id: number; action: "approve" | "publish"; expectedPublication: number | null; reviewedBy: string; reason: string }) => Promise<void>;
type Source = { groups: UpdateGroup[]; publishedAmount: (releaseId: number) => number | null | undefined; review: Review };

const REASON = "자동 공개: 수집 검증과 공개 기준 통과";
const errorCode = (error: unknown) => error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "auto_publish_failed";

async function load(kind: AutoPublishKind): Promise<Source> {
  if (kind === "combos") {
    const data = await getMayhemDatasetAdmin();
    return {
      groups: [comboUpdateGroup(data)],
      publishedAmount: id => data.releases.find(row => row.id === id)?.metadata.combos ?? null,
      review: async input => {
        const result = await createServiceRoleSupabase().rpc("review_lol_mayhem_dataset", { p_id: input.id, p_action: input.action,
          p_expected_publication: input.expectedPublication, p_reviewed_by: input.reviewedBy, p_reason: input.reason }).abortSignal(AbortSignal.timeout(10_000));
        if (result.error) throw new Error("dataset_review_failed");
      },
    };
  }
  if (kind === "champions") {
    const data = await getChampionDatasetAdmin();
    return { groups: [championUpdateGroup(data)], publishedAmount: id => data.releases.find(row => row.id === id)?.metadata.expectedChampionIds.length ?? null, review: reviewChampionDataset };
  }
  // 화면 노출은 앱 설정이 정하므로 여기서는 공개 기준만 판단한다.
  const data = { ...await getReferenceAdmin(), publicEnabled: true, itemsEnabled: true };
  return { groups: (["champion_tiers", "item_ratings", "augment_rankings"] as const).map(kind => referenceUpdateGroup(data, kind)), publishedAmount: () => undefined, review: reviewReference };
}

export async function autoPublishMayhem(kind: AutoPublishKind, options: { dryRun?: boolean } = {}) {
  const reviewedBy = process.env.LOL_MAYHEM_AUTO_REVIEWER_ID?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reviewedBy)) throw new Error("auto_publish_reviewer_missing");
  const source = await load(kind);
  const summary = { kind, dryRun: !!options.dryRun, published: 0, failures: 0, ready: [] as Array<{ group: string; patch: string; subject: string }>, held: [] as Array<{ group: string; patch: string; subject: string; reason: string }> };
  for (const group of source.groups) {
    const plan = autoPublishPlan(group, source.publishedAmount);
    summary.held.push(...plan.held.map(({ row, reason }) => ({ group: group.key, patch: row.patch, subject: row.subject, reason })));
    if (options.dryRun) { summary.ready.push(...plan.ready.map(row => ({ group: group.key, patch: row.patch, subject: row.subject }))); continue; }
    for (const row of plan.ready) {
      try {
        if (row.status !== "approved") await source.review({ id: row.id, action: "approve", expectedPublication: row.expectedPublication, reviewedBy, reason: REASON });
        await source.review({ id: row.id, action: "publish", expectedPublication: row.expectedPublication, reviewedBy, reason: REASON });
        summary.published++;
      } catch (error) {
        summary.failures++;
        console.warn("[lol-mayhem-auto-publish]", group.key, row.patch, row.subject, errorCode(error));
      }
    }
  }
  return summary;
}
