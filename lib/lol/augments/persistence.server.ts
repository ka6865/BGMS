import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { LolPersistenceError } from "@/lib/lol/persistence.server";
import { recordLolOpsMetric } from "@/lib/lol/ops.server";
import type { Rarity, DataValue } from "./extract";
import type { AugmentDisplay } from "./validate";
import type { TooltipResult } from "./tooltip";

export type AugmentChange = {
  platform_id: number | null;
  change_type: "added" | "removed" | "reenabled" | "changed" | "unannounced_absent";
  official: boolean;
  summary_ko: string;
  source_id?: string | null;
  review_status: "pending" | "approved" | "rejected";
};
export type AugmentLocalization = {
  locale: "ko_kr" | "en_us";
  name: string | null;
  description: string;
  tooltip_raw: string | null;
  tooltip_rendered: TooltipResult["tokens"];
  render_status: TooltipResult["status"];
  display_source: AugmentDisplay["displaySource"];
  display_text: string;
};
export type AugmentSnapshot = {
  patch: {
    display_patch: string;
    released_at: string | null;
    ddragon_version: string | null;
    cdragon_version: string | null;
    notes_url_ko: string | null;
    notes_url_en: string | null;
    verified_at: string | null;
  };
  snapshot_path: string;
  augments: Array<{
    platform_id: number;
    name_id: string;
    rarity: Rarity;
    icon_small_path: string | null;
    icon_large_path: string | null;
    is_internal: boolean;
    mode_name: "KIWI";
    in_pool: boolean;
    enabled: boolean;
    quest: boolean;
    ability: boolean;
    build_tags: number;
    augment_tags: number;
    data_values: DataValue[];
    source_hash: string;
    state?: "official_active" | "official_disabled" | "official_removed" | "official_reenabled" | "unlock_required"
      | "client_absent_unannounced" | "insufficient_data";
    localizations: AugmentLocalization[];
    aliases?: Array<{ alias: string; kind: "patch_note" | "search" | "en_upper"; source_id?: string | null }>;
  }>;
};
export type AugmentCatalog = {
  clientPatch: string;
  displayPatch: string;
  releasedAt: string;
  notesUrlKo: string | null;
  notesUrlEn: string | null;
  augments: Array<{
    platformId: number;
    rarity: Rarity;
    isInternal: boolean;
    enabled: boolean;
    inPool: boolean;
    quest: boolean;
    ability: boolean;
    state: NonNullable<AugmentSnapshot["augments"][number]["state"]>;
    iconSmallPath: string | null;
    iconLargePath: string | null;
    localizations: Record<AugmentLocalization["locale"], {
      name: string | null; text: string; tokens: TooltipResult["tokens"];
      displaySource: AugmentDisplay["displaySource"]; notice: string | null;
    }>;
  }>;
  changes: Array<{ platformId: number | null; changeType: AugmentChange["change_type"]; official: boolean; summaryKo: string }>;
};

async function rpc<T>(operation: string, args: Record<string, unknown>): Promise<T> {
  const signal = AbortSignal.timeout(10_000);
  try {
    const { data, error } = await createServiceRoleSupabase().rpc(operation, args).abortSignal(signal);
    if (error) throw error;
    return data as T;
  } catch (error) {
    const cause = error && typeof error === "object" ? error as { name?: string; code?: string; message?: string } : undefined;
    const timeout = signal.aborted || cause?.name === "TimeoutError" || cause?.name === "AbortError"
      || (typeof cause?.message === "string" && /AbortError|TimeoutError|timed?\s*out/i.test(cause.message));
    const reasonCode = timeout ? "timeout" : cause?.code === "22023" ? "invalid_payload" : cause?.code === "55000" ? "invalid_state" : "db_error";
    recordLolOpsMetric(timeout ? "db_timeout" : "db_error");
    console.error("[lol-augment-persistence] request_failed", JSON.stringify({ operation, stage: "database", reasonCode }));
    throw new LolPersistenceError();
  }
}

export function acquireLolAugmentIngestionLease(clientPatch: string, sourceId: string | null = null, ttlSeconds = 600): Promise<string | null> {
  return rpc("acquire_lol_augment_ingestion_lease", { p_client_patch: clientPatch, p_source_id: sourceId, p_ttl_seconds: ttlSeconds });
}
export function upsertLolAugmentSnapshot(runId: string, clientPatch: string, payload: AugmentSnapshot): Promise<number> {
  return rpc("upsert_lol_augment_snapshot", { p_run_id: runId, p_client_patch: clientPatch, p_payload: payload });
}
export function recordLolAugmentPatchChanges(runId: string, clientPatch: string, changes: AugmentChange[]): Promise<number> {
  return rpc("record_lol_augment_patch_changes", { p_run_id: runId, p_client_patch: clientPatch, p_changes: changes });
}
export type LolAugmentPatchNotesInput = {
  url: string; published_at: string | null; added_names: string[]; removed_names: string[]; parse_status: "ok" | "partial" | "failed";
};
export function recordLolAugmentPatchNotes(runId: string, clientPatch: string, notes: LolAugmentPatchNotesInput, locale = "ko_kr"): Promise<void> {
  return rpc("record_lol_augment_patch_notes", { p_run_id: runId, p_client_patch: clientPatch, p_locale: locale, p_notes: notes });
}
export function finishLolAugmentIngestionRun(runId: string, status: "succeeded" | "review" | "blocked" | "failed", errorCode: string | null = null): Promise<void> {
  return rpc("finish_lol_augment_ingestion_run", { p_run_id: runId, p_status: status, p_error_code: errorCode });
}
export function publishLolAugmentPatch(clientPatch: string, runId?: string): Promise<void> {
  return rpc("publish_lol_augment_patch", { p_client_patch: clientPatch, ...(runId === undefined ? {} : { p_run_id: runId }) });
}
export function getLolAugmentCatalog(clientPatch: string | null = null): Promise<AugmentCatalog | null> {
  return rpc("get_lol_augment_catalog", { p_client_patch: clientPatch });
}
