export type ScraperRequestStage = "season" | "leaderboard" | "player" | "match";

export type ScraperRequestFailure = {
  stage: ScraperRequestStage;
  status: number | null;
  code: string;
};

export function scraperRequestRequiresAttention(failure: ScraperRequestFailure): boolean {
  // 지원하지 않는 리더보드 모드와 조회되지 않는 계정 묶음은 장애가 아니다.
  if ((failure.stage === "leaderboard" || failure.stage === "player") && failure.status === 404) return false;
  if (failure.stage === "match" && [404, 409].includes(failure.status ?? 0)) return false;
  return true;
}

type AxiosLikeError = {
  code?: unknown;
  response?: {
    status?: unknown;
    data?: {
      errors?: Array<{ title?: unknown; code?: unknown }>;
    };
  };
};

export function describeScraperRequestFailure(
  stage: ScraperRequestStage,
  error: unknown,
): ScraperRequestFailure {
  const candidate = error as AxiosLikeError;
  const status = Number(candidate.response?.status);
  const apiError = candidate.response?.data?.errors?.[0];
  const apiCode = apiError?.title ?? apiError?.code;
  const networkCode = candidate.code;

  return {
    stage,
    status: Number.isInteger(status) ? status : null,
    code: typeof apiCode === "string" && apiCode.trim()
      ? apiCode.trim()
      : typeof networkCode === "string" && networkCode.trim()
        ? networkCode.trim()
        : "UNKNOWN",
  };
}
