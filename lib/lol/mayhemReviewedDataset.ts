import type { LolMayhemAugment } from "./augments/catalog";
import type { MayhemDataset } from "./mayhemDataset";
import { mappingSources, suggestedMapping, type MappingSource } from "./mayhemMappingReview";
import { MAYHEM_AVAILABILITY_LABELS, availabilityCounts, comboAvailability, parseMayhemArchive, type ArchiveAugment, type ArchiveSummary, type MayhemArchive, type MayhemAvailability } from "./mayhemArchive";
import reviewData from "./data/mayhem-augment-review-16.21.json";

export type MayhemOfficialAugment = LolMayhemAugment & { enabled: boolean; inPool: boolean; internal: boolean; state: string };
export type ReviewedMapping = { external_id: string; client_patch: string; platform_id: number; status: string };
export type MayhemNumericCombo = Omit<MayhemDataset["combos"][number], "championId"> & { championId: number };
const normalize = (name: string | null) => name?.normalize("NFKC").trim().toLocaleLowerCase("ko") ?? null;
const officialStatus = (a: MayhemOfficialAugment): MayhemAvailability => a.state === "official_removed" ? "removed" : !a.enabled || a.state === "official_disabled" ? "disabled" : a.inPool && ["official_active", "official_reenabled"].includes(a.state) ? "active" : "unverified";
const officialRow = (a: MayhemOfficialAugment): ArchiveAugment => ({ key: `official:${a.id}`, officialId: a.id, externalIds: [], name: a.name, nameEn: a.nameEn, sourceName: null,
  rarity: a.rarity, status: officialStatus(a), removedPatch: null, reason: `공식 카탈로그: ${MAYHEM_AVAILABILITY_LABELS[officialStatus(a)]}`, text: a.text, sourceUrl: null });

export function prepareReviewedMayhemDataset(input: { dataset: MayhemDataset; patch: string; sourcePatch: string; combos: MayhemNumericCombo[]; officials: Record<string, MayhemOfficialAugment[]>; mappings: ReviewedMapping[] }) {
  const { dataset, patch, sourcePatch, combos, officials, mappings } = input;
  for (const scope of [patch, sourcePatch]) if (!officials[scope]?.length || new Set(officials[scope].map(a => a.id)).size !== officials[scope].length) throw new Error("official_archive_catalog_missing");
  const ids = [...new Set([...dataset.rates.map(r => r.externalId), ...combos.flatMap(c => c.augmentIds)])];
  const sources = mappingSources(JSON.parse(dataset.raw.augments.body), JSON.parse(dataset.raw.combos.body), ids, dataset.releaseId);
  type Decision = { key: string; status: MayhemAvailability; official: MayhemOfficialAugment | null; source: MappingSource; reason: string; removedPatch: string | null; url: string | null };
  const decide = (s: MappingSource, scope: string): Decision => {
    const rule = !s.conflict && reviewData.clientPatch === scope ? reviewData.reviews.find(r => r.externalId === s.externalId && normalize(r.sourceName) === normalize(s.name) && normalize(r.sourceNameEn) === normalize(s.nameEn) && r.sourceRarity === s.rarity) : undefined;
    const mapping = mappings.find(m => m.external_id === s.externalId && m.client_patch === scope && m.status === "approved");
    let official = mapping ? officials[scope].find(a => a.id === mapping.platform_id && !a.internal) ?? null : null;
    if (rule?.status === "disabled" && rule.officialId) official = officials[scope].find(a => a.id === rule.officialId && !a.internal) ?? null;
    // 예전 명칭이 현행 한국어 이름과 같더라도 검토된 삭제 기록을 임의 연결하지 않는다.
    if (rule?.status === "removed") return { key: `external:${s.externalId}`, status: "removed", official: null, source: s, reason: `원본 ${rule.retiredPatch} 삭제 기록`, removedPatch: rule.retiredPatch, url: rule.sourceUrl };
    if (official && !s.conflict) {
      const status = officialStatus(official);
      const reviewed = rule && rule.officialId === official.id && rule.officialNameEn === official.nameEn && rule.officialRarity === official.rarity;
      const literal = suggestedMapping(s, officials[scope].filter(a => !a.internal && officialStatus(a) === "active"))?.id === official.id;
      if ((reviewed || literal) && !(status === "active" && !mapping)) return { key: `official:${official.id}`, status, official, source: s,
        reason: reviewed ? rule.evidence : "저장된 이름 연결과 공식 카탈로그 대조", removedPatch: null, url: rule?.sourceUrl ?? null };
    }
    return { key: `external:${s.externalId}`, status: "unverified", official: null, source: s, reason: "이름 연결 또는 현재 상태 확인 필요", removedPatch: null, url: null };
  };
  const current = new Map(sources.map(s => [s.externalId, decide(s, patch)]));
  const rated = sourcePatch === patch ? current : new Map(sources.map(s => [s.externalId, decide(s, sourcePatch)]));
  const augments = new Map(officials[patch].filter(a => !a.internal).map(a => [ `official:${a.id}`, officialRow(a) ]));
  for (const d of current.values()) {
    if (!augments.has(d.key)) augments.set(d.key, { key: d.key, officialId: null, externalIds: [], name: d.source.name ?? d.source.nameEn ?? d.source.externalId, nameEn: d.source.nameEn, sourceName: null,
      rarity: d.source.rarity, status: d.status, removedPatch: d.removedPatch, reason: d.reason, text: "", sourceUrl: d.url });
    const row = augments.get(d.key)!;
    row.externalIds.push(d.source.externalId); row.sourceName = d.source.name; row.sourceUrl ??= d.url; row.reason = d.reason;
    if (d.status !== row.status) throw new Error("reviewed_augment_state_conflict");
  }
  const archive: MayhemArchive = { schemaVersion: 1, patch, augments: [...augments.values()].sort((a, b) => a.name.localeCompare(b.name, "ko")), combos: combos.map(c => ({
    id: c.comboId, championId: c.championId, augments: c.augmentIds.map(id => current.get(id)!.key), status: comboAvailability(c.augmentIds.map(id => current.get(id)!.status)), types: c.types, sourceUrl: c.sourceUrl,
  })) };
  parseMayhemArchive(archive, patch);
  const rates = dataset.rates.filter(r => rated.get(r.externalId)?.status === "active");
  if (new Set(rates.map(r => rated.get(r.externalId)!.official!.id)).size !== rates.length) throw new Error("duplicate_reviewed_rate");
  const activeIds = new Set(archive.combos.filter(c => c.status === "active").map(c => c.id));
  const usableCombos = combos.filter(c => activeIds.has(c.comboId));
  const summary: ArchiveSummary = { augments: availabilityCounts(archive.augments), combos: availabilityCounts(archive.combos), sourceRates: dataset.rates.length, sourceCombos: combos.length };
  return { rates, combos: usableCombos, archive, summary };
}
