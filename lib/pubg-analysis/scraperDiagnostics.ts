export type ScraperRequestStage = "season" | "leaderboard" | "player" | "match" | "sample";

export type ScraperRequestFailure = {
  stage: ScraperRequestStage;
  status: number | null;
  code: string;
};

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
