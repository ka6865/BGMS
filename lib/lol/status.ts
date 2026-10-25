export type LolStatusItem = { id: number; kind: "maintenance" | "incident"; title: string; message: string; createdAt: string | null };
export type LolPlatformStatus = { items: LolStatusItem[]; fetchedAt: string | null; stale: boolean; available: boolean };

type Translation = { locale?: unknown; content?: unknown };
function translated(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const locale of ["ko_KR", "en_US"]) {
    const item = value.find((row: Translation) => row?.locale === locale && typeof row.content === "string" && row.content.trim());
    if (item) return item.content.slice(0, 10_000);
  }
  return "";
}

export function parseLolPlatformStatus(raw: unknown): LolStatusItem[] {
  const data = raw as { maintenances?: unknown; incidents?: unknown } | null;
  if (!data || !Array.isArray(data.maintenances) || !Array.isArray(data.incidents)) throw new Error("서버 상태 응답이 올바르지 않습니다.");
  const items: LolStatusItem[] = [];
  for (const [kind, notices] of [["maintenance", data.maintenances], ["incident", data.incidents]] as const) {
    for (const notice of notices) {
      if (!notice || !Number.isSafeInteger(notice.id)) throw new Error("서버 공지 응답이 올바르지 않습니다.");
      if (notice.archive_at || notice.maintenance_status === "complete") continue;
      const updates = Array.isArray(notice.updates) ? notice.updates.filter((update: { publish?: unknown }) => update?.publish === true) : [];
      updates.sort((a: { created_at?: string }, b: { created_at?: string }) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
      const messages = updates.map((update: { translations?: unknown }) => translated(update.translations));
      items.push({ id: notice.id, kind, title: translated(notice.titles) || (kind === "maintenance" ? "서버 점검 안내" : "서버 장애 안내"),
        message: messages.find((message: string) => message) ?? "", createdAt: typeof notice.created_at === "string" ? notice.created_at : null });
    }
  }
  return items;
}
