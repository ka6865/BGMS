import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { recordLolOpsMetric } from "@/lib/lol/ops.server";
import type { AugmentAdminData } from "./admin";

const ICON_PATH = /^assets\/ux\/(kiwi|cherry)\/augments\/icons\/[a-z0-9_-]+\.png$/;
// 작은 아이콘은 회색 실루엣이라 색이 있는 큰 아이콘을 우선하고, 큰 아이콘 경로가 해시뿐인 증강만 작은 아이콘을 쓴다.
function preferredIcon(large: string | null, small: string | null): string | null {
  return large && ICON_PATH.test(large) ? large : small;
}

export async function getAugmentAdminData(patch?: string): Promise<AugmentAdminData> {
  const db = createServiceRoleSupabase();
  const signal = AbortSignal.timeout(10_000);
  try {
    const [runs, patches] = await Promise.all([
      db.from("lol_augment_ingestion_runs").select("id,client_patch,status,counts,error_code,started_at").order("started_at", { ascending: false }).limit(30).abortSignal(signal),
      db.from("lol_game_patches").select("client_patch,display_patch,published_at").order("released_at", { ascending: false, nullsFirst: false }).limit(100).abortSignal(signal),
    ]);
    if (runs.error || patches.error) throw new Error("database_error");
    const data: AugmentAdminData = { runs: runs.data, patches: patches.data, detail: null };
    const selected = patch ?? runs.data[0]?.client_patch;
    if (!selected) return data;
    const runResult = await db.from("lol_augment_ingestion_runs").select("id,client_patch,status,counts,error_code,started_at,snapshot_path")
      .eq("client_patch", selected).order("started_at", { ascending: false }).limit(1).abortSignal(signal);
    if (runResult.error) throw new Error("database_error");
    const selectedRun = runResult.data[0];
    if (selectedRun) {
      const { id, client_patch, status, counts, error_code, started_at } = selectedRun;
      data.runs = [{ id, client_patch, status, counts, error_code, started_at }, ...data.runs.filter(run => run.id !== id)];
    }
    const [states, texts, changes, notes] = await Promise.all([
      db.from("lol_augment_patch_states").select("platform_id,rarity,icon_small_path,icon_large_path").eq("client_patch", selected).order("platform_id").limit(1000).abortSignal(signal),
      db.from("lol_augment_localizations").select("platform_id,name,display_text,display_source,tooltip_rendered").eq("client_patch", selected).eq("locale", "ko_kr").limit(1000).abortSignal(signal),
      db.from("lol_augment_patch_changes").select("id,platform_id,change_type,official,summary_ko,review_status").eq("client_patch", selected).order("platform_id").limit(2000).abortSignal(signal),
      db.from("lol_augment_patch_notes").select("url,published_at,added_names,removed_names,parse_status").eq("client_patch", selected).abortSignal(signal),
    ]);
    if (states.error || texts.error || changes.error || notes.error) throw new Error("database_error");
    const names = new Map(texts.data.map(text => [text.platform_id, text]));
    const warnings: string[] = [];
    if (selectedRun?.error_code) warnings.push(selectedRun.error_code);
    if (selectedRun?.status === "review") warnings.push("검증 경고 또는 미해결 변경이 있어 검토가 필요합니다.");
    if (selectedRun?.snapshot_path) {
      const file = await db.storage.from("lol-augment-snapshots").download(selectedRun.snapshot_path);
      if (file.error || !file.data || file.data.size > 8 * 1024 * 1024) warnings.push("검증 상세를 불러오지 못했습니다.");
      else {
        const manifest = JSON.parse(await file.data.text());
        for (const problem of [...(manifest.validation?.problems ?? []), ...(manifest.validation?.warnings ?? [])]) {
          if (typeof problem.message === "string") warnings.push(problem.message);
        }
      }
    }
    data.detail = { patch: selected, published: !!patches.data.find(p => p.client_patch === selected)?.published_at,
      runId: selectedRun?.id ?? null, changes: changes.data, notes: notes.data, warnings,
      augments: states.data.map(state => ({ platformId: state.platform_id, name: names.get(state.platform_id)?.name ?? null,
        rarity: state.rarity, icon: preferredIcon(state.icon_large_path, state.icon_small_path), text: names.get(state.platform_id)?.display_text ?? "",
        tokens: names.get(state.platform_id)?.tooltip_rendered,
        displaySource: names.get(state.platform_id)?.display_source ?? "desc_partial" })) };
    return data;
  } catch {
    recordLolOpsMetric(signal.aborted ? "db_timeout" : "db_error");
    throw new Error("증강 검토 자료를 불러오지 못했습니다.");
  }
}
