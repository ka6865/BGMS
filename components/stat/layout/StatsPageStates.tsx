"use client";

import type { StatsPageController } from "@/hooks/useStatsPageController";
import type { StatsPageStatus, StatsPlatform } from "@/types/stats-page";

export interface StatsPageStatesProps {
  status: StatsPageStatus;
  error: StatsPageController["error"];
  suggestedPlayers: StatsPageController["suggestedPlayers"];
  hasResult: boolean;
  routeBooting?: boolean;
  retryDisabled: boolean;
  onRetry(): void;
  onSuggestedPlayer(value: { nickname: string; platform: StatsPlatform }): void;
}

export function StatsPageStates({
  status,
  error,
  suggestedPlayers,
  hasResult,
  routeBooting = false,
  retryDisabled,
  onRetry,
  onSuggestedPlayer,
}: StatsPageStatesProps) {
  const loadingMessage = routeBooting
    ? "전적을 불러오는 중"
    : status === "loading"
      ? "플레이어 전적을 불러오는 중"
      : status === "refreshing"
        ? "전적을 새로고침하는 중"
        : null;

  // 비공개 프로필 상태
  if (error && error.type === "private") {
    return (
      <div
        role="alert"
        className="my-12 flex flex-col items-center justify-center rounded-3xl border border-white/10 bg-[#161616]/80 p-10 text-center shadow-2xl backdrop-blur-md"
      >
        {/* OP.GG 스타일 비공개 아이콘 플레이스홀더 */}
        <div className="mb-6 flex h-32 w-32 items-center justify-center rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02]">
          <div className="relative h-16 w-16 text-white/30">
            <svg
              className="h-full w-full"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
              />
            </svg>
          </div>
        </div>

        <h2 className="text-xl font-bold text-white/90 sm:text-2xl">
          {error.message}
        </h2>
        <p className="mt-2 text-xs text-white/40">
          플레이어의 설정 또는 요청에 따라 전적 데이터가 제공되지 않습니다.
        </p>
      </div>
    );
  }

  return (
    <>
      {loadingMessage && (
        <div
          role="status"
          className={`mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-center text-sm font-bold text-white/60 ${
            hasResult ? "stats-page-state--inline" : ""
          }`}
        >
          {loadingMessage}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className={`mb-4 rounded-xl border p-4 text-center ${
            error.type === "not_found"
              ? "border-amber-500/25 bg-amber-500/10"
              : "border-red-500/25 bg-red-500/10"
          } ${hasResult ? "stats-page-state--inline" : ""}`}
        >
          <div className={`text-sm font-black ${error.type === "not_found" ? "text-amber-300" : "text-red-300"}`}>
            {error.type === "not_found" ? "플레이어를 찾을 수 없습니다" : "전적을 불러오지 못했습니다"}
          </div>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-white/60">{error.message}</p>
          {error.type === "not_found" && (
            <p className="mx-auto mt-3 max-w-xl rounded-lg border border-amber-500/15 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-amber-100/70">
              PUBG 닉네임은 대소문자와 플랫폼이 다르면 검색되지 않을 수 있습니다. Steam/Kakao 선택과 닉네임 표기를 다시 확인해 주세요.
            </p>
          )}
          {suggestedPlayers.length > 0 && (
            <div className="mt-3 flex flex-wrap justify-center gap-2 border-t border-white/10 pt-3">
              {suggestedPlayers.map((player) => {
                const platformLabel = player.platform === "steam" ? "스팀" : "카카오";
                return (
                  <button
                    key={`${player.platform}:${player.nickname}`}
                    type="button"
                    aria-label={`${player.nickname} ${platformLabel}로 검색`}
                    onClick={() => onSuggestedPlayer(player)}
                    className="min-h-11 rounded-full border border-amber-500/20 bg-amber-500/10 px-4 text-xs font-black text-amber-400"
                  >
                    {player.nickname} ({platformLabel})
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={onRetry}
            disabled={retryDisabled}
            className="mt-3 min-h-11 min-w-11 rounded-xl bg-white/10 px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            다시 시도
          </button>
        </div>
      )}
    </>
  );
}
