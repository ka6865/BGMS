import type { LolAugmentRarity } from "./catalog";
import { diffAugments } from "./diff";
import type { Augment } from "./extract";
import { binHash, renderTooltip } from "./tooltip";

export type MayhemPatchNoteLine = { before: string | null; after: string };
export type MayhemPatchNoteValue = { name: string; label: string | null; percent: boolean; before: number | null; after: number | null };
export type MayhemPatchNoteEntry = { platformId: number | null; name: string; rarity: LolAugmentRarity | null; fields: string[]; lines: MayhemPatchNoteLine[]; values: MayhemPatchNoteValue[] };
export type MayhemPatchNote = { patch: string; displayPatch: string; notesUrl: string | null; publishedAt: string | null; added: MayhemPatchNoteEntry[]; changed: MayhemPatchNoteEntry[]; removed: MayhemPatchNoteEntry[] };
export type PatchChangeRow = { client_patch: string; platform_id: number | null; change_type: string; summary_ko: string };
export type PatchNoteSourceRow = { client_patch: string; url: string | null; published_at: string | null; removed_names: string[] | null };
export type PatchTextRow = { platform_id: number; client_patch: string; name: string; display_text: string | null };
export type PatchStateRow = { platform_id: number; client_patch: string; rarity: LolAugmentRarity };
export type PatchSnapshotAugment = Augment;

const FIELD_LABELS: Record<string, string> = { values: "수치", name: "이름", rarity: "등급", description: "설명", enabled: "사용 여부" };
const order = (a: string, b: string) => { const [x, y] = [a, b].map(p => p.split(".").map(Number)); return x[0] - y[0] || x[1] - y[1]; };
export const displayPatchOf = (patch: string) => `${Number(patch.split(".")[0]) + 10}.${patch.split(".")[1]}`;

// 툴팁의 계산식·수치를 채워 문장 단위로 나눈다. 경기 중 누적값 표시(@f1@ 등)처럼 채울 수 없는 줄은 뺀다.
function tooltipLines(augment: PatchSnapshotAugment | undefined): string[] | null {
  if (!augment?.ko.tooltip) return null;
  const result = renderTooltip(augment.ko.tooltip, { dataValues: augment.rootSpell.dataValues, calculations: augment.rootSpell.calculations, spellSlot: augment.rootSpell.spellSlot });
  if (result.status === "failed") return null;
  return result.tokens.map(token => token.text).join("").split(/\n+|(?<=다\.)\s+/).map(line => line.trim())
    .filter(line => line && !/^[^:]{1,20}:\s*@[^@\s]+@\S{0,3}$/.test(line)).map(line => line.replace(/@[^@\s]+@/g, "…"));
}

// 클라이언트 내부 값 이름을 단어 단위로 옮긴다. 모르는 단어가 있으면 추측하지 않고 원래 이름을 쓴다.
const VALUE_WORDS: Record<string, string> = {
  upgrade: "업그레이드당", armorpen: "물리 관통력", magicpen: "마법 관통력", critchance: "치명타 확률", critdamage: "치명타 피해", questrequirement: "퀘스트 목표",
  ad: "공격력", ap: "주문력", as: "공격 속도", ah: "스킬 가속", ar: "방어력", mr: "마법 저항력", armor: "방어력", health: "체력", hp: "체력", mana: "마나",
  lifesteal: "생명력 흡수", omnivamp: "모든 피해 흡혈", ms: "이동 속도", damage: "피해량", heal: "회복량", shield: "보호막", duration: "지속시간",
  cooldown: "재사용 대기시간", stacks: "중첩", max: "최대", min: "최소", base: "기본", bonus: "추가", range: "사거리", gold: "골드", hspower: "회복·보호막 효과",
  flat: "", percent: "", ratio: "계수",
};
export function valueLabel(name: string): { label: string | null; percent: boolean } {
  const words = (name.match(/ArmorPen|MagicPen|CritChance|CritDamage|QuestRequirement|HSPower|[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [name]).map(w => w.toLowerCase());
  const percent = words.includes("percent");
  const label = words.every(w => Object.hasOwn(VALUE_WORDS, w)) ? words.map(w => VALUE_WORDS[w]).filter(Boolean).join(" ") : null;
  return { label: label || null, percent };
}

function valueDiffs(before: PatchSnapshotAugment, after: PatchSnapshotAugment): MayhemPatchNoteValue[] {
  const first = (values: number[] | undefined) => values?.find(Number.isFinite) ?? null;
  const old = new Map(before.rootSpell.dataValues.map(v => [binHash(v.name), first(v.values)]));
  const now = new Map(after.rootSpell.dataValues.map(v => [binHash(v.name), first(v.values)]));
  const names = new Map([...before.rootSpell.dataValues, ...after.rootSpell.dataValues].filter(v => !/^\{[0-9a-f]{8}\}$/i.test(v.name)).map(v => [binHash(v.name), v.name]));
  return [...names].filter(([key]) => old.get(key) !== now.get(key)).map(([key, name]) => ({ name, ...valueLabel(name), before: old.get(key) ?? null, after: now.get(key) ?? null }));
}

// 검수 승인된 공식 변경 기록으로 패치별 노트를 만든다. 스냅샷이 있으면 숫자를 채운 툴팁으로 전후를 비교하고,
// 해시 이름이 풀리기만 한 것처럼 실제 값이 같은 변경은 뺀다.
export function buildMayhemPatchNotes({ changes, notes, texts, states, upTo, snapshots = {} }: { changes: PatchChangeRow[]; notes: PatchNoteSourceRow[]; texts: PatchTextRow[]; states: PatchStateRow[]; upTo: string; snapshots?: Record<string, PatchSnapshotAugment[]> }): MayhemPatchNote[] {
  const text = new Map(texts.map(t => [`${t.client_patch}:${t.platform_id}`, t]));
  const rarity = new Map(states.map(s => [`${s.client_patch}:${s.platform_id}`, s.rarity]));
  const patchesOf = (id: number) => texts.filter(t => t.platform_id === id).map(t => t.client_patch).sort(order);
  const snapshot = (patch: string | undefined, id: number) => patch ? snapshots[patch]?.find(a => a.platformId === id) : undefined;
  const label = (summary: string) => summary.slice(0, summary.lastIndexOf(":")).trim() || summary;
  const entry = (row: PatchChangeRow): MayhemPatchNoteEntry | null => {
    const id = row.platform_id!, prev = patchesOf(id).filter(p => order(p, row.client_patch) < 0).at(-1);
    const now = text.get(`${row.client_patch}:${id}`), old = prev ? text.get(`${prev}:${id}`) : undefined;
    const base = { platformId: id, name: now?.name ?? old?.name ?? label(row.summary_ko), rarity: rarity.get(`${row.client_patch}:${id}`) ?? (prev ? rarity.get(`${prev}:${id}`) ?? null : null), fields: [] as string[], lines: [] as MayhemPatchNoteLine[], values: [] as MayhemPatchNoteValue[] };
    const after = snapshot(row.client_patch, id), before = snapshot(prev, id);
    if (row.change_type === "added") {
      const lines = tooltipLines(after);
      return { ...base, lines: [{ before: null, after: lines?.join("\n") ?? now?.display_text ?? "" }].filter(line => line.after) };
    }
    if (row.change_type !== "changed") return base;
    if (before && after) {
      const fields = diffAugments([before], [after]).changed[0]?.fields;
      if (!fields) return null;
      const [oldLines, newLines] = [tooltipLines(before), tooltipLines(after)];
      const lines = oldLines && newLines && oldLines.length === newLines.length
        ? newLines.flatMap((line, i) => line === oldLines[i] ? [] : [{ before: oldLines[i], after: line }])
        : oldLines && newLines && oldLines.join("\n") !== newLines.join("\n") ? [{ before: oldLines.join("\n"), after: newLines.join("\n") }] : [];
      return { ...base, fields: fields.map(f => FIELD_LABELS[f] ?? f), lines, values: lines.length ? [] : valueDiffs(before, after) };
    }
    const fields = [...new Set(row.summary_ko.slice(row.summary_ko.lastIndexOf(":") + 1).split(",").map(f => FIELD_LABELS[f.trim()]).filter(Boolean))];
    const changedText = now?.display_text && old?.display_text && now.display_text !== old.display_text;
    return { ...base, fields, lines: changedText ? [{ before: old!.display_text, after: now!.display_text! }] : [] };
  };
  const byName = (a: MayhemPatchNoteEntry, b: MayhemPatchNoteEntry) => a.name.localeCompare(b.name, "ko");
  const entries = (rows: PatchChangeRow[]) => rows.map(entry).filter((e): e is MayhemPatchNoteEntry => e !== null).sort(byName);
  const patches = [...new Set(changes.map(c => c.client_patch))].filter(p => order(p, upTo) <= 0).sort((a, b) => order(b, a));
  return patches.map(patch => {
    const rows = changes.filter(c => c.client_patch === patch && c.platform_id !== null);
    const note = notes.find(n => n.client_patch === patch);
    const removed = entries(rows.filter(r => r.change_type === "removed" || r.change_type === "unannounced_absent"));
    // 공식 노트의 삭제 목록은 증강 ID 없이 이름만 기록된다.
    for (const name of changes.some(c => c.client_patch === patch && c.platform_id === null && c.change_type === "removed") ? note?.removed_names ?? [] : [])
      if (!removed.some(r => r.name === name)) removed.push({ platformId: null, name, rarity: null, fields: [], lines: [], values: [] });
    return { patch, displayPatch: displayPatchOf(patch), notesUrl: note?.url ?? null, publishedAt: note?.published_at ?? null,
      added: entries(rows.filter(r => r.change_type === "added")), changed: entries(rows.filter(r => r.change_type === "changed")), removed: removed.sort(byName) };
  }).filter(n => n.added.length || n.changed.length || n.removed.length);
}
