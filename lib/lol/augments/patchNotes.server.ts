import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { LOL_AUGMENT_CATALOG_TAG } from "./catalog.server";
import { buildMayhemPatchNotes, type PatchSnapshotAugment, type PatchStateRow, type PatchTextRow } from "./patchNotes";

// 공식 증강 공개본 이하 패치의 승인된 변경 기록만 공개한다. 도감과 같은 태그로 공개 시 함께 갱신된다.
export const getMayhemPatchNotes = unstable_cache(async (upTo: string) => {
  const db = createServiceRoleSupabase(), signal = () => AbortSignal.timeout(10_000);
  const [changes, notes] = await Promise.all([
    db.from("lol_augment_patch_changes").select("client_patch,platform_id,change_type,summary_ko").eq("review_status", "approved").limit(2000).abortSignal(signal()),
    db.from("lol_augment_patch_notes").select("client_patch,url,published_at,removed_names").eq("locale", "ko_kr").limit(200).abortSignal(signal()),
  ]);
  if (changes.error || notes.error || changes.data.length >= 2000) throw new Error("patch_notes_unavailable");
  const ids = [...new Set(changes.data.map(c => c.platform_id).filter((id): id is number => id !== null))];
  const [texts, states] = ids.length ? await Promise.all([
    db.from("lol_augment_localizations").select("platform_id,client_patch,name,display_text").eq("locale", "ko_kr").in("platform_id", ids).limit(5000).abortSignal(signal()),
    db.from("lol_augment_patch_states").select("platform_id,client_patch,rarity").in("platform_id", ids).limit(5000).abortSignal(signal()),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (texts.error || states.error || texts.data.length >= 5000 || states.data.length >= 5000) throw new Error("patch_notes_unavailable");
  return buildMayhemPatchNotes({ changes: changes.data, notes: notes.data, texts: texts.data as PatchTextRow[], states: states.data as PatchStateRow[], upTo,
    snapshots: await loadSnapshots(db, [...new Set(changes.data.map(c => c.client_patch))]) });
}, ["lol-mayhem-patch-notes-v3"], { revalidate: 3600, tags: [LOL_AUGMENT_CATALOG_TAG] });

const patchOrder = (a: string, b: string) => { const [x, y] = [a, b].map(p => p.split(".").map(Number)); return x[0] - y[0] || x[1] - y[1]; };

// 패치마다 마지막 수집 스냅샷(계산식 포함)을 읽는다. 없거나 읽지 못한 패치는 저장된 설명 비교로 대신한다.
async function loadSnapshots(db: ReturnType<typeof createServiceRoleSupabase>, patches: string[]) {
  const runs = await db.from("lol_augment_ingestion_runs").select("client_patch,snapshot_path").in("status", ["succeeded", "review"]).not("snapshot_path", "is", null)
    .order("finished_at", { ascending: false }).limit(200).abortSignal(AbortSignal.timeout(10_000));
  if (runs.error) return {};
  const latest = new Map<string, string>();
  for (const run of runs.data) if (!latest.has(run.client_patch)) latest.set(run.client_patch, run.snapshot_path!);
  const known = [...latest.keys()].sort(patchOrder);
  const needed = new Set(patches.flatMap(p => [p, known.filter(k => patchOrder(k, p) < 0).at(-1)]).filter((p): p is string => !!p && latest.has(p)));
  const loaded = await Promise.all([...needed].map(async patch => {
    const file = await db.storage.from("lol-augment-snapshots").download(latest.get(patch)!);
    if (file.error) return null;
    try { return [patch, (JSON.parse(await file.data.text()) as { augments: PatchSnapshotAugment[] }).augments] as const; } catch { return null; }
  }));
  return Object.fromEntries(loaded.filter(entry => entry !== null && Array.isArray(entry[1])) as Array<readonly [string, PatchSnapshotAugment[]]>);
}
