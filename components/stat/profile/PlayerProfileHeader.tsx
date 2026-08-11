"use client";

import { useState } from "react";
import { Crosshair, RefreshCw, Shield, Star, Swords } from "lucide-react";
import { selectCanonicalRankBucket } from "@/lib/stats/statsPageModel";
import type { PlayerStatsResponse } from "@/types/stats-page";

export interface PlayerProfileHeaderProps {
  player: PlayerStatsResponse;
  seasonId: string;
  refreshing: boolean;
  isRefreshCoolingDown: boolean;
  refreshAvailableAt?: number;
  favorite: boolean;
  onSeasonChange(value: string): void;
  onRefresh(): void;
  onFavoriteToggle(): void;
  onCompare(): void;
  onWeapons(): void;
}

function updatedLabel(value?: string): string {
  if (!value) return "정보 없음";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

type ProfilePopover = "clan" | "ban" | null;

function ClanTrigger({
  clan,
  open,
  onToggle,
}: {
  clan: NonNullable<PlayerStatsResponse["clan"]>;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`클랜 ${clan.tag} 정보`}
        aria-expanded={open}
        onClick={onToggle}
        className="min-h-11 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-black text-amber-300"
      >
        [{clan.tag}]
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 min-w-48 rounded-xl border border-white/10 bg-[#161616] p-3 text-xs shadow-2xl">
          <div className="font-black text-white">{clan.name}</div>
          <div className="mt-1 text-white/50">Lv. {clan.level} · {clan.memberCount}명</div>
        </div>
      )}
    </div>
  );
}

function localizedBanStatus(value?: string | null): string {
  const normalized = value?.trim() || "None";
  const labels: Record<string, string> = {
    innocent: "정상",
    none: "없음",
    banned: "제재됨",
  };
  return labels[normalized.toLowerCase()] ?? normalized;
}

function BanTrigger({
  banType,
  open,
  onToggle,
}: {
  banType?: string | null;
  open: boolean;
  onToggle(): void;
}) {
  const normalized = banType?.trim() || "None";
  const normal = normalized.toLowerCase() === "none" || normalized.toLowerCase() === "innocent";
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="제재 상태 확인"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-black ${
          normal
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            : "border-rose-500/30 bg-rose-500/10 text-rose-300"
        }`}
      >
        <Shield size={13} aria-hidden="true" />
        제재 상태
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 min-w-56 rounded-xl border border-white/10 bg-[#161616] p-3 text-xs shadow-2xl">
          <div className="font-black text-white">{normal ? "정상 활동 계정" : "제재 상태 확인 필요"}</div>
          <div className="mt-1 text-white/50">PUBG 상태: {localizedBanStatus(normalized)}</div>
        </div>
      )}
    </div>
  );
}

export function PlayerProfileHeader({
  player,
  seasonId,
  refreshing,
  isRefreshCoolingDown,
  refreshAvailableAt,
  favorite,
  onSeasonChange,
  onRefresh,
  onFavoriteToggle,
  onCompare,
  onWeapons,
}: PlayerProfileHeaderProps) {
  const [openPopover, setOpenPopover] = useState<ProfilePopover>(null);
  const rank = selectCanonicalRankBucket(player.stats);
  const tier = rank?.currentTier?.tier?.trim();
  const subTier = rank?.currentTier?.subTier;
  const rankLabel = tier ? `${tier}${subTier != null && String(subTier).trim() ? ` ${subTier}` : ""}` : "언랭크";

  return (
    <header className="rounded-2xl border border-white/10 bg-[#161616] p-4 md:p-5" aria-label="플레이어 프로필">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs font-black uppercase tracking-wider text-white/40">
            {player.platform === "steam" ? "Steam" : "Kakao"}
          </span>
          <h2 title={player.nickname} className="min-w-0 flex-1 truncate text-xl font-black text-white md:text-2xl">
            {player.nickname}
          </h2>
          {player.clan && (
            <ClanTrigger
              clan={player.clan}
              open={openPopover === "clan"}
              onToggle={() => setOpenPopover((current) => current === "clan" ? null : "clan")}
            />
          )}
          <BanTrigger
            banType={player.banType}
            open={openPopover === "ban"}
            onToggle={() => setOpenPopover((current) => current === "ban" ? null : "ban")}
          />
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4 border-y border-white/10 py-3">
          <div>
            <div className="text-[11px] font-black uppercase tracking-wider text-white/40">현재 랭크</div>
            <div className="mt-1 text-xl font-black text-amber-300">{rankLabel}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-black uppercase tracking-wider text-white/40">랭크 포인트</div>
            <div className="mt-1 text-lg font-black text-white">{rank ? `${rank.currentRankPoint ?? 0} RP` : "-"}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={isRefreshCoolingDown ? "최신 전적" : "전적 갱신"}
            onClick={onRefresh}
            disabled={refreshing || isRefreshCoolingDown}
            title={refreshAvailableAt ? `다음 갱신: ${new Date(refreshAvailableAt).toLocaleTimeString()}` : undefined}
            className="flex min-h-11 min-w-11 items-center gap-2 rounded-xl bg-teal-500/15 px-3 text-xs font-black text-teal-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
            {refreshing ? "갱신 중..." : isRefreshCoolingDown ? "최신 전적" : "전적 갱신"}
          </button>
          <button
            type="button"
            aria-label={favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
            aria-pressed={favorite}
            onClick={onFavoriteToggle}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-white/5 text-yellow-300"
          >
            <Star size={17} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
          </button>
          <span className="text-[11px] font-bold text-white/40">최근 업데이트: {updatedLabel(player.updatedAt)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="전적 비교"
            onClick={onCompare}
            className="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 text-xs font-black text-purple-300"
          >
            <Swords size={15} aria-hidden="true" />
            전적 비교
          </button>
          <button
            type="button"
            aria-label="무기 분석"
            onClick={onWeapons}
            className="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-black text-rose-300"
          >
            <Crosshair size={15} aria-hidden="true" />
            무기 분석
          </button>
          <label className="ml-auto flex min-h-11 items-center gap-2 text-xs font-black text-white/50">
            <span>시즌</span>
            <select
              aria-label="시즌 선택"
              value={seasonId}
              onChange={(event) => onSeasonChange(event.target.value)}
              className="min-h-11 rounded-lg border border-white/10 bg-[#252525] px-3 text-white"
            >
              {player.seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}
            </select>
          </label>
        </div>
      </div>
    </header>
  );
}
