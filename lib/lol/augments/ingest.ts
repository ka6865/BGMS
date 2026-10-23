import { createHash } from "node:crypto";
import { parse } from "node-html-parser";
import { extractAugments, type Augment } from "./extract";
import { diffAugments } from "./diff";
import { toDisplayPatch } from "./patchMap";
import { parseStringTable } from "./stringTable";
import { renderTooltip, type TooltipResult } from "./tooltip";
import { chooseAugmentDisplay, validateAugments } from "./validate";
import type { AugmentSnapshot, AugmentChange } from "./persistence.server";

export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const validClientPatch = (patch: string) => /^(15|16)\.[1-9][0-9]?$/.test(patch);
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const SOURCE_FILES = {
  "augment-lists": "plugins/rcp-be-lol-game-data/global/default/v1/augment-lists.json",
  "cherry-augments": "plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json",
  "kiwi-bin": "game/maps/modespecificdata/kiwi.bin.json",
  // CommunityDragon은 한국어 문자열도 menu/en_us 하위 폴더에 둔다(16.21 확인).
  "stringtable-ko": "game/ko_kr/data/menu/en_us/lol.stringtable.json",
  "stringtable-en": "game/en_us/data/menu/en_us/lol.stringtable.json",
} as const;
export type SourceKind = keyof typeof SOURCE_FILES;
export type PatchNotes = {
  url: string; published_at: string | null; added_names: string[]; removed_names: string[];
  parse_status: "ok" | "partial" | "failed";
};
export function notesUrl(patch: string) {
  return `https://www.leagueoflegends.com/ko-kr/news/game-updates/league-of-legends-patch-${toDisplayPatch(patch)?.replace(".", "-")}-notes/`;
}

// shortcut: 공식 노트의 제목·p/strong·li 구조만 처리하며 구조가 바뀌면 파서를 갱신한다.
export function parsePatchNotes(html: string, url: string): PatchNotes {
  const root = parse(html);
  const date = root.querySelector('meta[property="article:published_time"]')?.getAttribute("content")
    ?? root.querySelector("time")?.getAttribute("datetime") ?? root.querySelector("time")?.getAttribute("dateTime");
  let published_at = date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
  if (!published_at) {
    for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(script.textContent);
        const articles = Array.isArray(value) ? value : [value, ...(value["@graph"] ?? [])];
        const date = articles.find(item => item?.datePublished)?.datePublished;
        if (typeof date === "string" && Number.isFinite(Date.parse(date))) published_at = new Date(date).toISOString();
      } catch { /* 잘못된 메타데이터는 대조를 차단하지 않는다. */ }
    }
  }
  const result: PatchNotes = { url, published_at, added_names: [], removed_names: [], parse_status: "failed" };
  let mayhem = false;
  let mode: "added_names" | "removed_names" | null = null;
  for (const node of root.querySelectorAll("h2,h3,h4,p,li")) {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (node.tagName === "H2") {
      mayhem = /아수라장/.test(text); mode = null; continue;
    }
    if (!mayhem) continue;
    if (/^H[34]$/.test(node.tagName)) {
      mode = /신규.*증강|새로운 증강/.test(text) ? "added_names" : /삭제.*증강|제거.*증강/.test(text) ? "removed_names" : null;
      continue;
    }
    if (!mode) continue;
    if (node.tagName === "P") {
      if (mode !== "added_names") continue;
      for (const strong of node.querySelectorAll("strong,b")) {
        const name = strong.textContent.trim();
        if (name && name.length <= 256 && !/^(실버|골드|프리즘)$/.test(name)) result.added_names.push(name);
      }
    } else if (mode === "removed_names" || node.querySelector("strong,b")) {
      const name = (node.querySelector("strong,b")?.textContent ?? text.split(/[:：]/)[0]).replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (name && name.length <= 256 && !node.querySelector("li")) result[mode].push(name);
    }
  }
  result.added_names = [...new Set(result.added_names)].slice(0, 1000);
  result.removed_names = [...new Set(result.removed_names)].slice(0, 1000);
  result.parse_status = result.added_names.length && result.removed_names.length ? "ok"
    : result.added_names.length || result.removed_names.length ? "partial" : "failed";
  return result;
}

export function buildIngestion(patch: string, sources: Record<SourceKind, unknown>, notes: PatchNotes, previous?: Augment[], previousDescriptions?: TooltipResult[]) {
  if (!validClientPatch(patch)) throw new Error("invalid_patch");
  const augments = extractAugments({ augmentLists: sources["augment-lists"], cherryAugments: sources["cherry-augments"],
    kiwiBin: sources["kiwi-bin"], stringTableKo: sources["stringtable-ko"], stringTableEn: sources["stringtable-en"] });
  const ko = parseStringTable(sources["stringtable-ko"]);
  const en = parseStringTable(sources["stringtable-en"]);
  const descriptions = augments.filter(a => !a.isInternal).flatMap(a => [
    renderTooltip(a.ko.description, { ...a.rootSpell, stringTable: ko }),
    renderTooltip(a.en.description, { ...a.rootSpell, stringTable: en }),
  ]);
  const validation = validateAugments({ current: augments, previous, descriptions, previousDescriptions });
  const distribution = { ko_kr: { tooltip: 0, desc: 0, desc_partial: 0 }, en_us: { tooltip: 0, desc: 0, desc_partial: 0 } };
  const rows: AugmentSnapshot["augments"] = augments.map(a => ({
    platform_id: a.platformId, name_id: a.nameId, rarity: a.rarity, icon_small_path: a.icons.small, icon_large_path: a.icons.large,
    is_internal: a.isInternal, mode_name: "KIWI", in_pool: true, enabled: a.enabled, quest: a.quest, ability: a.ability,
    build_tags: a.buildTags, augment_tags: a.augmentTags, data_values: a.rootSpell.dataValues, source_hash: sha256(JSON.stringify(a)),
    state: a.enabled ? "official_active" : "official_disabled",
    localizations: (["ko_kr", "en_us"] as const).map(locale => {
      const text = a[locale === "ko_kr" ? "ko" : "en"];
      const context = { ...a.rootSpell, stringTable: locale === "ko_kr" ? ko : en };
      const tooltip = renderTooltip(text.tooltip, context);
      const display = chooseAugmentDisplay(tooltip, renderTooltip(text.description, context));
      distribution[locale][display.displaySource]++;
      return { locale, name: text.name, description: text.description ?? "", tooltip_raw: text.tooltip,
        tooltip_rendered: display.tokens, render_status: tooltip.status, display_source: display.displaySource, display_text: display.text };
    }),
  }));
  const diff = diffAugments(previous ?? [], augments);
  const normalize = (name: string) => name.replace(/\s+/g, "").normalize("NFKC");
  const changes: AugmentChange[] = [];
  // 기준 게시본이 없는 첫 수집은 현재 풀 전체가 초기 도감이므로, 공식 노트가 신규로 밝힌 증강만 변경으로 남긴다.
  const initial = !previous;
  for (const bucket of [diff, diff.internal]) {
    for (const [type, entries] of [["added", bucket.added], ["removed", bucket.removed]] as const) {
      for (const a of entries) {
        const names = type === "added" ? notes.added_names : notes.removed_names;
        const official = notes.parse_status !== "failed" && !a.isInternal && !!a.ko.name
          && names.some(name => normalize(name) === normalize(a.ko.name!));
        if (initial && !official) continue;
        changes.push({ platform_id: a.platformId, change_type: type === "removed" && !official ? "unannounced_absent" : type,
          official, summary_ko: `${a.ko.name ?? a.nameId}: ${type === "added" ? "신규" : "목록에서 제외"}`,
          review_status: official ? "approved" : "pending" });
      }
    }
    for (const { before, after, fields } of bucket.changed) {
      changes.push({ platform_id: after.platformId, change_type: !before.enabled && after.enabled ? "reenabled" : "changed",
        official: false, summary_ko: `${after.ko.name ?? after.nameId}: ${fields.join(", ")}`, review_status: "pending" });
    }
  }
  const unmatchedNames: string[] = [];
  for (const [names, entries] of (initial ? [[notes.added_names, diff.added]] : [[notes.added_names, diff.added], [notes.removed_names, diff.removed]]) as [string[], typeof diff.added][]) {
    unmatchedNames.push(...names.filter(name => !entries.some(a => a.ko.name && normalize(a.ko.name) === normalize(name))));
  }
  if (initial && notes.removed_names.length) changes.push({ platform_id: null, change_type: "removed", official: true,
    summary_ko: `공식 노트 삭제 목록(기준 게시본 없음): ${notes.removed_names.join(", ")}`.slice(0, 4096), review_status: "approved" });
  if (unmatchedNames.length) changes.push({ platform_id: null, change_type: "changed", official: false,
    summary_ko: `공식 노트 대조 불일치: ${unmatchedNames.join(", ")}`.slice(0, 4096), review_status: "pending" });
  if (notes.parse_status !== "ok") {
    const mismatch = changes.find(change => change.platform_id === null);
    if (mismatch) mismatch.summary_ko = `공식 패치 노트 파싱이 불완전합니다. ${mismatch.summary_ko}`.slice(0, 4096);
    else changes.push({ platform_id: null, change_type: "changed", official: false,
      summary_ko: "공식 패치 노트 파싱이 불완전합니다. 신규·삭제 목록을 직접 확인하세요.", review_status: "pending" });
  }
  return { augments, rows, changes, validation, distribution, descriptions, baseline: previous ? "published" : "none" };
}

export function createSourceDownloader(fetcher: typeof fetch = fetch, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  let lastRequest = 0;
  return async (url: string, json = true, maxBytes = MAX_SOURCE_BYTES): Promise<string> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await wait(Math.max(0, 1000 - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(60_000), redirect: "error",
          headers: { "User-Agent": "BGMS-augment-sync/1.0 (+https://bgms.kr)" } });
        if (response.status === 403) throw new Error("source_forbidden");
        if (!response.ok) throw new Error("source_http_error");
        if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("source_too_large");
        if (!response.body) throw new Error("source_empty");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) throw new Error("source_too_large");
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const text = Buffer.concat(chunks).toString("utf8");
        if (json) JSON.parse(text);
        return text;
      } catch (error) {
        if (error instanceof Error && ["source_too_large", "source_forbidden"].includes(error.message)) throw error;
        if (attempt === 2) throw new Error("source_download_failed");
        await wait(1000 * 2 ** attempt);
      }
    }
    throw new Error("source_download_failed");
  };
}
