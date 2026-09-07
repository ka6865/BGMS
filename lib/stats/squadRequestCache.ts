// Owned by one stats page: never persisted or shared across server requests.
const TTL_MS = 60_000;
const MAX_ENTRIES = 16;
const REQUEST_TIMEOUT_MS = 20_000;

type Entry = { expiresAt: number; promise: Promise<any> };

export function createSquadRequestCache() {
  const entries = new Map<string, Entry>();
  return {
    get(scope: string, url: string): Promise<any> {
      const key = JSON.stringify([scope, url]);
      const existing = entries.get(key);
      if (existing && existing.expiresAt > Date.now()) return existing.promise;
      entries.delete(key);
      while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const entry: Entry = { expiresAt: Date.now() + REQUEST_TIMEOUT_MS, promise: Promise.resolve() };
      // A tab unmount does not cancel a shared GET; it can finish for the next
      // subscriber. A bounded timeout stops abandoned network work.
      entry.promise = fetch(url, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("스쿼드 데이터를 불러오지 못했습니다.");
          const data = await response.json();
          if (!data || data.error) throw new Error("스쿼드 분석 응답 오류");
          const groupKey = new URL(url, "https://bgms.kr").searchParams.get("groupKey");
          if (groupKey
            ? data.groupKey !== groupKey || !data.stats || !data.scores || !Array.isArray(data.matchesSummary) || !Array.isArray(data.roleProfiles)
            : !Array.isArray(data.groups)) throw new Error("스쿼드 분석 형식 오류");
          entry.expiresAt = Date.now() + TTL_MS;
          return data;
        })
        .catch((error) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        })
        .finally(() => clearTimeout(timer));
      entries.set(key, entry);
      return entry.promise;
    },
  };
}

export type SquadRequestCache = ReturnType<typeof createSquadRequestCache>;
