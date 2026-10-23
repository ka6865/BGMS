import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createServiceRoleSupabase } from "../lib/server/serviceRoleSupabase.server";
import { buildIngestion, createSourceDownloader, MAX_SOURCE_BYTES, notesUrl, parsePatchNotes,
  sha256, SOURCE_FILES, validClientPatch, type PatchNotes, type SourceKind } from "../lib/lol/augments/ingest";
import { toDisplayPatch } from "../lib/lol/augments/patchMap";
import { extractAugmentPool, type Augment } from "../lib/lol/augments/extract";
import { diffAugments } from "../lib/lol/augments/diff";
import type { AugmentSnapshot } from "../lib/lol/augments/persistence.server";

type Options = { patch?: string; dryRun: boolean; sourceDir?: string; force?: boolean };
type Manifest = { augments: Augment[]; validation: ReturnType<typeof buildIngestion>["validation"]; descriptions?: ReturnType<typeof buildIngestion>["descriptions"] };

function isDuplicateObject(error: { message?: string; statusCode?: string | number; status?: number }): boolean {
  return String(error.statusCode ?? error.status ?? "") === "409" || /already exists|duplicate/i.test(error.message ?? "");
}

export async function runIngestion(options: Options) {
  if (!options.dryRun && process.env.LOL_AUGMENT_INGEST_ENABLED !== "true") throw new Error("ingest_disabled");
  if (options.patch && !validClientPatch(options.patch)) throw new Error("invalid_patch");
  if (options.sourceDir && !options.patch) throw new Error("source_dir_requires_patch");
  const download = createSourceDownloader();
  const db = options.dryRun ? null : createServiceRoleSupabase();
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!db) throw new Error("write_unavailable");
    const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new Error("database_error");
    return data as T;
  }
  let patch = options.patch ?? "";
  let version: string | null = null;
  if (!options.sourceDir) {
    const versions: unknown = JSON.parse(await download("https://ddragon.leagueoflegends.com/api/versions.json", true, 1024 * 1024));
    if (!Array.isArray(versions) || versions.some(item => typeof item !== "string")) throw new Error("invalid_versions");
    // 최신 버전은 목록 첫 항목이다. 대응 규칙이 없는 연도로 넘어가면 이전 패치에 머무르지 않고 중단한다.
    version = (patch ? versions.find((v: string) => v.startsWith(`${patch}.`)) : versions[0]) ?? null;
    if (!version) throw new Error("patch_not_available");
    patch ||= version.split(".").slice(0, 2).join(".");
    if (!validClientPatch(patch)) throw new Error("unsupported_patch_year");

  }
  let runId: string | null = null;
  try {
    if (db) {
      const existing = await db.from("lol_game_patches").select("published_at").eq("client_patch", patch).maybeSingle();
      if (existing.error) throw new Error("database_error");
      if (existing.data?.published_at) return { patch, skipped: "already_published" };
      // 수집은 끝났고 관리자 게시를 기다리는 패치는 원본을 매일 다시 받지 않는다. 다시 수집하려면 --force를 쓴다.
      if (!options.force) {
        const collected = await db.from("lol_augment_ingestion_runs").select("id").eq("client_patch", patch)
          .in("status", ["succeeded", "review"]).limit(1).maybeSingle();
        if (collected.error) throw new Error("database_error");
        if (collected.data) return { patch, skipped: "awaiting_review" };
      }
      runId = await rpc<string | null>("acquire_lol_augment_ingestion_lease", { p_client_patch: patch, p_ttl_seconds: 1800 });
      if (!runId) throw new Error("lease_busy");
    }
    if (!options.sourceDir) await download(`https://raw.communitydragon.org/${patch}/`, false, 1024 * 1024);
    const sources = {} as Record<SourceKind, unknown>;
    const raw = {} as Record<SourceKind, string>;
    const paths = {} as Record<SourceKind, string>;
    const files = options.sourceDir ? await readdir(options.sourceDir) : [];
    for (const [kind, path] of Object.entries(SOURCE_FILES) as Array<[SourceKind, string]>) {
      if (options.sourceDir) {
        const suffix = kind === "augment-lists" || kind === "cherry-augments" ? `default_${kind}.json`
          : kind === "kiwi-bin" ? "kiwi.bin.json" : `${kind === "stringtable-ko" ? "ko_kr" : "en_us"}_lol.stringtable.json`;
        const name = files.includes(`${patch}_${suffix}`) ? `${patch}_${suffix}` : `${kind}.json`;
        const file = resolve(options.sourceDir, name);
        if ((await stat(file)).size > MAX_SOURCE_BYTES) throw new Error("source_too_large");
        raw[kind] = await readFile(file, "utf8");
      } else raw[kind] = await download(`https://raw.communitydragon.org/${patch}/${path}`);
      sources[kind] = JSON.parse(raw[kind]);
      paths[kind] = `${patch}/${kind}-${sha256(raw[kind])}.json`;
    }
    let notes: PatchNotes = { url: notesUrl(patch), published_at: null, added_names: [], removed_names: [], parse_status: "failed" };
    try {
      const html = options.sourceDir ? await readFile(resolve(options.sourceDir, "patch-notes.html"), "utf8")
        : await download(notes.url, false, 4 * 1024 * 1024);
      notes = parsePatchNotes(html, notes.url);
    } catch { /* 공식 노트 장애는 관리자 검토로 넘긴다. */ }
    let previous: Augment[] | undefined;
    let previousDescriptions: Manifest["descriptions"];
    let previousPatch: string | null = null;
    if (db) {
      const publication = await db.from("lol_augment_publication").select("client_patch,run_id").eq("singleton", true).maybeSingle();
      if (publication.error) throw new Error("database_error");
      if (publication.data) {
        previousPatch = publication.data.client_patch;
        const run = await db.from("lol_augment_ingestion_runs").select("snapshot_path").eq("id", publication.data.run_id).single();
        if (run.error || !run.data.snapshot_path) throw new Error("baseline_missing");
        const file = await db.storage.from("lol-augment-snapshots").download(run.data.snapshot_path);
        if (file.error || !file.data || file.data.size > MAX_SOURCE_BYTES) throw new Error("baseline_unavailable");
        const manifest: Manifest = JSON.parse(await file.data.text());
        if (!Array.isArray(manifest.augments) || !manifest.augments.length) throw new Error("baseline_invalid");
        previous = manifest.augments;
        previousDescriptions = manifest.descriptions;
      }
    }
    const result = buildIngestion(patch, sources, notes, previous, previousDescriptions);
    let offlinePoolDiff = null;
    if (options.sourceDir) {
      const older = files.filter(name => /^(15|16)\.[1-9][0-9]?_default_augment-lists\.json$/.test(name))
        .map(name => name.split("_")[0]).filter(value => value.localeCompare(patch, undefined, { numeric: true }) < 0)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      if (older) {
        const load = async (name: string) => JSON.parse(await readFile(resolve(options.sourceDir!, name), "utf8"));
        const diff = diffAugments(extractAugmentPool(await load(`${older}_default_augment-lists.json`), await load(`${older}_default_cherry-augments.json`)),
          extractAugmentPool(sources["augment-lists"], sources["cherry-augments"]));
        offlinePoolDiff = { patch: older, scope: "구성·등급만 비교", added: diff.added.map(a => a.platformId),
          removed: diff.removed.map(a => a.platformId), changed: diff.changed.map(c => c.after.platformId), internalAdded: diff.internal.added.length };
      }
    }
    const manifest = JSON.stringify({ patch, sources: paths, augments: result.augments, validation: result.validation,
      distribution: result.distribution, descriptions: result.descriptions, notes, previousPatch });
    const snapshotPath = `${patch}/${sha256(manifest)}.json`;
    const summary = { patch, dryRun: options.dryRun, count: result.augments.length, distribution: result.distribution,
      validation: result.validation, notes, baseline: result.baseline, changes: result.changes, offlinePoolDiff };
    if (db && runId) {
      if (!result.validation.ok) {
        await rpc("finish_lol_augment_ingestion_run", { p_run_id: runId, p_status: "blocked", p_error_code: "validation_blocked" });
        return summary;
      }
      const storage = db.storage.from("lol-augment-snapshots");
      for (const [path, body] of [...Object.keys(SOURCE_FILES).map(kind => [paths[kind as SourceKind], raw[kind as SourceKind]]), [snapshotPath, manifest]]) {
        // 경로에 내용 해시가 들어가므로 이미 있는 객체는 같은 내용이다. exists()는 없는 객체에 400을 돌려 오류와 구분되지 않아 쓰지 않는다.
        const upload = await storage.upload(path, body, { contentType: "application/json", upsert: false });
        if (upload.error && !isDuplicateObject(upload.error)) throw new Error("storage_error");
      }
      const payload: AugmentSnapshot = { patch: { display_patch: toDisplayPatch(patch)!, released_at: notes.published_at,
        ddragon_version: version, cdragon_version: version ? patch : null, notes_url_ko: notes.url, notes_url_en: null,
        verified_at: version && notes.published_at ? new Date().toISOString() : null }, snapshot_path: snapshotPath, augments: result.rows };
      await rpc("upsert_lol_augment_snapshot", { p_run_id: runId, p_client_patch: patch, p_payload: payload });
      await rpc("record_lol_augment_patch_notes", { p_run_id: runId, p_client_patch: patch, p_locale: "ko_kr", p_notes: notes });
      await rpc("record_lol_augment_patch_changes", { p_run_id: runId, p_client_patch: patch, p_changes: result.changes });
      await rpc("finish_lol_augment_ingestion_run", { p_run_id: runId,
        p_status: !result.validation.ok ? "blocked" : result.changes.some(c => c.review_status === "pending") || result.validation.warnings.length ? "review" : "succeeded",
        p_error_code: result.validation.ok ? null : "validation_blocked" });
    }
    return summary;
  } catch (error) {
    if (runId) await rpc("finish_lol_augment_ingestion_run", { p_run_id: runId, p_status: "failed",
      p_error_code: error instanceof Error && /^[a-z_]{1,128}$/.test(error.message) ? error.message : "ingest_failed" });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { patch: { type: "string" }, "dry-run": { type: "boolean", default: false }, "source-dir": { type: "string" }, force: { type: "boolean", default: false } } });
    const summary = await runIngestion({ patch: values.patch, dryRun: values["dry-run"], sourceDir: values["source-dir"], force: values.force });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if ("validation" in summary && !summary.validation.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error && /^[a-z_]{1,128}$/.test(error.message) ? error.message : "ingest_failed"}\n`);
    process.exitCode = 1;
  }
}
