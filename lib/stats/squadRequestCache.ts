// Owned by one stats page: never persisted or shared across server requests.
const TTL_MS = 60_000;
const MAX_ENTRIES = 16;
const REQUEST_TIMEOUT_MS = 20_000;

type Entry = { expiresAt: number; promise: Promise<any> };

export class SquadRequestCacheError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { status?: number; errorCode?: string | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "SquadRequestCacheError";
    this.status = details.status ?? 0;
    this.errorCode = details.errorCode ?? null;
    this.retryable = details.retryable === true;
  }
}

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
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new SquadRequestCacheError(
              typeof data?.error === "string" ? data.error : "스쿼드 데이터를 불러오지 못했습니다.",
              {
                status: response.status,
                errorCode: typeof data?.errorCode === "string" ? data.errorCode : null,
                retryable: data?.retryable === true,
              },
            );
          }
          if (!data || data.error) {
            throw new SquadRequestCacheError(
              typeof data?.error === "string" ? data.error : "스쿼드 분석 응답 오류",
              {
                status: response.status,
                errorCode: typeof data?.errorCode === "string" ? data.errorCode : null,
                retryable: data?.retryable === true,
              },
            );
          }
          const groupKey = new URL(url, "https://bgms.kr").searchParams.get("groupKey");
          const basicOnly = data.analysisAvailability === "basic_only"
            && data.analysisUnavailableReason === "calculation_upgrade_required"
            && Array.isArray(data.basicMatches) && data.basicMatches.length > 0
            && data.basicMatches.every((match: any) => typeof match?.matchId === "string" && match.matchId && match.stats);
          const fullAnalysis = data.analysisAvailability !== "basic_only" && data.stats && data.scores
            && Array.isArray(data.matchesSummary) && Array.isArray(data.roleProfiles);
          if (groupKey
            ? data.groupKey !== groupKey || (!basicOnly && !fullAnalysis)
            : !Array.isArray(data.groups)) throw new Error("스쿼드 분석 형식 오류");
          entry.expiresAt = Date.now() + TTL_MS;
          return data;
        })
        .catch((error) => {
          // A known calculation rollout wait cannot recover from rapid tab revisits.
          if (error instanceof SquadRequestCacheError
              && error.status === 409 && error.errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED") {
            entry.expiresAt = Date.now() + TTL_MS;
          } else if (entries.get(key) === entry) entries.delete(key);
          throw error;
        })
        .finally(() => clearTimeout(timer));
      entries.set(key, entry);
      return entry.promise;
    },
  };
}

export type SquadRequestCache = ReturnType<typeof createSquadRequestCache>;
