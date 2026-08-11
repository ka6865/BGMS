"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Clock, Star, User, X } from "lucide-react";
import type { StatsPlatform } from "@/types/stats-page";

export interface StatsSearchBarProps {
  platform: StatsPlatform;
  nickname: string;
  recentSearches: readonly string[];
  favorites: readonly string[];
  suggestions: readonly { nickname: string; platform: StatsPlatform }[];
  suggesting: boolean;
  empty: boolean;
  submitDisabled: boolean;
  submitLabel?: string;
  onPlatformChange(value: StatsPlatform): void;
  onNicknameChange(value: string): void;
  onSubmit(): void;
  onQuickSearch(name: string): void;
  onSuggestionSelect(value: { nickname: string; platform: StatsPlatform }): void;
  onFavoriteToggle(name: string): void;
  onRecentRemove(name: string): void;
}

export function StatsSearchBar({
  platform,
  nickname,
  recentSearches,
  favorites,
  suggestions,
  suggesting,
  empty,
  submitDisabled,
  submitLabel = "검색",
  onPlatformChange,
  onNicknameChange,
  onSubmit,
  onQuickSearch,
  onSuggestionSelect,
  onFavoriteToggle,
  onRecentRemove,
}: StatsSearchBarProps) {
  const platformId = useId();
  const nicknameId = useId();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => [
    ...favorites.map((name) => ({ name, type: "favorite" as const })),
    ...recentSearches
      .filter((name) => !favorites.includes(name))
      .map((name) => ({ name, type: "recent" as const })),
  ], [favorites, recentSearches]);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

  return (
    <div className={`flex flex-col md:flex-row gap-3 max-w-3xl mx-auto mb-8 relative ${showDropdown ? "z-[1000]" : "z-30"}`}>
      <label className="sr-only" htmlFor={platformId}>플랫폼</label>
      <select
        id={platformId}
        name="platform"
        autoComplete="off"
        value={platform}
        onChange={(event) => onPlatformChange(event.target.value === "kakao" ? "kakao" : "steam")}
        className="min-h-11 w-full md:w-48 p-3 bg-[#252525] color-white border border-[#444] rounded-md text-base focus:outline-none focus:border-[#F2A900] transition-colors"
      >
        <option value="steam">스팀 (Steam)</option>
        <option value="kakao">카카오 (Kakao)</option>
      </select>

      <div className="relative flex-1" ref={dropdownRef}>
        <input
          id={nicknameId}
          name="nickname"
          type="text"
          autoComplete="off"
          placeholder="정확한 대소문자 닉네임을 입력하세요"
          value={nickname}
          onChange={(event) => {
            onNicknameChange(event.target.value);
            setShowDropdown(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !submitDisabled) onSubmit();
          }}
          onFocus={() => setShowDropdown(true)}
          className="min-h-11 w-full p-3 bg-[#252525] text-white border border-[#444] rounded-md text-base focus:outline-none focus:border-[#F2A900] transition-colors"
        />

        {showDropdown && (nickname.trim().length >= 2 || items.length > 0) && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-[#0a0a1a]/95 border border-white/10 rounded-xl overflow-hidden shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl z-50">
            <div className="max-h-[350px] overflow-y-auto custom-scrollbar">
              {nickname.trim().length >= 2 && suggestions.length > 0 && (
                <div className="pb-2">
                  <div className="px-4 py-2 text-[10px] font-black text-amber-500/50 uppercase tracking-widest border-b border-white/5 bg-white/2">추천 플레이어</div>
                  {suggestions.map((suggestion) => {
                    const platformLabel = suggestion.platform === "kakao" ? "카카오" : "스팀";
                    return (
                      <button
                        type="button"
                        key={`${suggestion.platform}:${suggestion.nickname}`}
                        aria-label={`${suggestion.nickname} ${platformLabel}로 검색`}
                        onClick={() => {
                          onSuggestionSelect(suggestion);
                          setShowDropdown(false);
                        }}
                        className="flex min-h-11 w-full items-center gap-3 border-b border-white/5 px-4 py-3 text-left transition-colors last:border-0 hover:bg-amber-500/10 cursor-pointer"
                      >
                        <User size={14} className="text-amber-500 shrink-0" />
                        <span className="text-sm font-bold text-gray-200 truncate">{suggestion.nickname}</span>
                        <span className="ml-auto text-[10px] text-gray-500 uppercase">{suggestion.platform}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {nickname.trim().length >= 2 && suggestions.length === 0 && !suggesting && empty && (
                <div className="px-4 py-4 text-center text-xs text-gray-500 italic">검색 결과가 없습니다</div>
              )}

              {(nickname.trim().length < 2 || suggestions.length === 0) && items.map((item) => {
                const favorite = favorites.includes(item.name);
                return (
                  <div key={`${item.type}:${item.name}`} className="w-full px-4 py-3 flex items-center gap-3 border-b border-white/5 last:border-0">
                    <button
                      type="button"
                      onClick={() => {
                        onQuickSearch(item.name);
                        setShowDropdown(false);
                      }}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      {item.type === "favorite"
                        ? <Star size={14} className="text-yellow-400 fill-yellow-400 shrink-0" />
                        : <Clock size={14} className="text-gray-500 shrink-0" />}
                      <span className="truncate text-sm font-bold text-gray-300">{item.name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${item.name} 즐겨찾기 ${favorite ? "해제" : "추가"}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFavoriteToggle(item.name);
                      }}
                      className={favorite ? "flex min-h-11 min-w-11 items-center justify-center text-yellow-400" : "flex min-h-11 min-w-11 items-center justify-center text-gray-600"}
                    >
                      <Star size={14} fill={favorite ? "currentColor" : "none"} />
                    </button>
                    {item.type === "recent" && (
                      <button
                        type="button"
                        aria-label={`${item.name} 최근 검색 삭제`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRecentRemove(item.name);
                        }}
                        className="flex min-h-11 min-w-11 items-center justify-center text-gray-600 hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitDisabled}
        className={`min-h-11 min-w-11 flex-1 md:flex-none px-6 py-3 rounded-md font-bold text-base whitespace-nowrap transition-all active:scale-95 ${submitDisabled ? "bg-[#555] text-[#aaa] cursor-not-allowed" : "bg-[#F2A900] text-black cursor-pointer hover:bg-[#ffb700]"}`}
      >
        {submitLabel}
      </button>
    </div>
  );
}
