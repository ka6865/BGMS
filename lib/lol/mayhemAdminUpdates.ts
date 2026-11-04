import type { ChampionDatasetAdminData } from "./mayhemChampionDataset";
import type { MayhemDatasetAdminData } from "./mayhemDatasetView";
import { compareReferencePatches, type ReferenceKind, type ReferencePublication, type ReferenceRelease } from "./mayhemReference";

export type ReferenceAdminData = {
  enabled: boolean; publicEnabled: boolean; itemsEnabled: boolean;
  champions?: { id: number; name: string }[]; truncatedKinds?: ReferenceKind[];
  releases: ReferenceRelease[]; publications: ReferencePublication[]; sync: ChampionDatasetAdminData["sync"];
};
export type UpdateRow = {
  id: number; patch: string; subject: string; status: string; fetchedAt: string; sourceDate: string;
  amount: number; blocked: string; expectedPublication: number | null; previousPatch: string | null;
};
export type UpdateGroup = {
  key: string; title: string; effect: string; endpoint: string; unit: string;
  rows: UpdateRow[]; targets: UpdateRow[]; publications: { release_id: number; published_at: string }[];
  blocked: string; syncError: boolean;
};

function group(input: Omit<UpdateGroup, "targets">): UpdateGroup {
  return { ...input, targets: input.rows.filter(row => row.status !== "rejected" && row.id !== row.expectedPublication) };
}

// 새 자료가 제외된 경우 같은 대상의 옛 수집본을 대신 적용하지 않는다.
function newest<T extends { id: number; fetchedAt: string }>(rows: T[], scope: (row: T) => string): T[] {
  const seen = new Set<string>();
  return [...rows].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id).filter(row => {
    const key = scope(row);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function championUpdateGroup(data: ChampionDatasetAdminData & { databaseAvailable?: boolean }): UpdateGroup {
  const rows = newest(data.releases.map(row => ({
    id: row.id, patch: row.client_patch, subject: "챔피언 전체", status: row.status, fetchedAt: row.fetched_at,
    sourceDate: row.source_data_date, amount: row.metadata.expectedChampionIds.length,
    blocked: !row.metadata.expectedChampionIds.length || row.metadata.files.length !== row.metadata.expectedChampionIds.length ? "챔피언 자료가 모두 모이지 않았습니다." : "",
    expectedPublication: data.publications.find(pub => pub.client_patch === row.client_patch)?.release_id ?? null,
    previousPatch: data.publications.some(pub => pub.client_patch === row.client_patch) ? row.client_patch : null,
  })), row => row.patch);
  return group({ key: "champions", title: "챔피언별 증강", effect: "챔피언을 눌렀을 때 보이는 증강 선택 통계와 미관측 기록이 바뀝니다.",
    endpoint: "/api/admin/lol/mayhem-champion-datasets", unit: "명", rows, publications: data.publications,
    blocked: data.databaseAvailable === false ? "저장된 자료를 확인할 수 없습니다. 새로고침해 주세요." : !Object.values(data.readiness).every(Boolean) ? "수집·적용 설정을 확인해야 합니다." : "",
    syncError: data.sync.some(row => !!row.last_error_code),
  });
}

export function referenceUpdateGroup(data: ReferenceAdminData, kind: ReferenceKind): UpdateGroup {
  const definitions = {
    champion_tiers: { title: "챔피언 티어", effect: "챔피언 선택 목록의 티어 표시와 정렬 순서가 바뀝니다.", unit: "명" },
    item_ratings: { title: "아이템·신발", effect: "챔피언별 아이템·신발 탭의 평가 순위가 바뀝니다.", unit: "명" },
    augment_rankings: { title: "패치별 증강 순위", effect: "전체 증강 순위의 패치 선택 목록과 해당 패치 순위가 바뀝니다.", unit: "개 패치" },
  };
  let rows = newest(data.releases.filter(row => row.kind === kind).map(row => ({
    id: row.id, patch: row.client_patch, subject: row.champion_id ? data.champions?.find(champion => champion.id === row.champion_id)?.name ?? `챔피언 ${row.champion_id}` : "전체",
    championId: row.champion_id, status: row.status, fetchedAt: row.fetched_at, sourceDate: row.source_data_date,
    amount: kind === "champion_tiers" ? data.champions?.length ?? 0 : 1, blocked: "",
    expectedPublication: data.publications.find(pub => pub.kind === kind && pub.client_patch === row.client_patch && pub.champion_id === row.champion_id)?.release_id ?? null,
    previousPatch: data.publications.filter(pub => pub.kind === kind && pub.champion_id === row.champion_id && (kind === "item_ratings" || pub.client_patch === row.client_patch)).sort((a, b) => compareReferencePatches(a.client_patch, b.client_patch))[0]?.client_patch ?? null,
  })), row => `${row.patch}:${row.championId}`);
  if (kind === "item_ratings") {
    const latest = new Map<number, string>();
    for (const row of [...rows, ...data.publications.filter(pub => pub.kind === kind).map(pub => ({ patch: pub.client_patch, championId: pub.champion_id }))]) {
      if (!latest.has(row.championId) || compareReferencePatches(row.patch, latest.get(row.championId)!) < 0) latest.set(row.championId, row.patch);
    }
    rows = rows.filter(row => row.patch === latest.get(row.championId));
  }
  return group({ key: kind, ...definitions[kind], rows, publications: data.publications.filter(pub => pub.kind === kind),
    endpoint: "/api/admin/lol/mayhem-references",
    blocked: !data.enabled || !data.publicEnabled || (kind === "item_ratings" && !data.itemsEnabled) ? "화면 적용 설정이 꺼져 있습니다. 운영 설정을 확인해 주세요." : "",
    syncError: data.sync.some(row => !!row.last_error_code),
  });
}

export function comboUpdateGroup(data: MayhemDatasetAdminData): UpdateGroup {
  const rows = newest(data.releases.map(row => ({
    id: row.id, patch: row.verified_client_patch, subject: "증강 조합 전체", status: row.status, fetchedAt: row.fetched_at,
    sourceDate: row.metadata.sourceStatsDate ?? "미제공", amount: row.metadata.combos ?? 0,
    blocked: row.metadata.unknown_count ? `증강 ${row.metadata.unknown_count}개의 이름을 먼저 연결해야 합니다.` : "",
    expectedPublication: data.publications.find(pub => pub.client_patch === row.verified_client_patch)?.release_id ?? null,
    previousPatch: data.publications.some(pub => pub.client_patch === row.verified_client_patch) ? row.verified_client_patch : null,
  })), row => row.patch);
  return group({ key: "combos", title: "증강 추천 조합", effect: "챔피언별 외부 추천 조합이 바뀝니다.",
    endpoint: "/api/admin/lol/mayhem-datasets", unit: "개 조합", rows, publications: data.publications, blocked: "",
    syncError: data.sync.some(row => row.job_key === "mayhem-external:arammayhem" && !!row.last_error_code),
  });
}
