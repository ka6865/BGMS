"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Clock, Star, User, X } from "lucide-react";
import type { StatsPlatform } from "@/types/stats-page";
import { statsSearchKey, type StatsSearchEntry } from "@/hooks/useStatsSearchHistory";

export interface StatsSearchBarProps {
  platform: StatsPlatform;
  nickname: string;
  recentSearches: readonly StatsSearchEntry[];
  favorites: readonly StatsSearchEntry[];
  suggestions: readonly { nickname: string; platform: StatsPlatform }[];
  suggesting: boolean;
  empty: boolean;
  submitDisabled: boolean;
  submitLabel?: string;
  onPlatformChange(value: StatsPlatform): void;
  onNicknameChange(value: string): void;
  onSubmit(): void;
  onQuickSearch(name: string, platform: StatsPlatform): void;
  onSuggestionSelect(value: { nickname: string; platform: StatsPlatform }): void;
  onFavoriteToggle(name: string, platform: StatsPlatform): void;
  onRecentRemove(name: string, platform: StatsPlatform): void;
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
  const suggestionsId = useId();
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState<{
    item: StatsSearchBarProps["suggestions"][number];
    source: StatsSearchBarProps["suggestions"];
  } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => [
    ...favorites.map((entry) => ({ ...entry, type: "favorite" as const })),
    ...recentSearches
      .filter((entry) => !favorites.some(favorite => statsSearchKey(favorite) === statsSearchKey(entry)))
      .map((entry) => ({ ...entry, type: "recent" as const })),
  ], [favorites, recentSearches]);
  const suggestionIndex = activeSuggestion?.source === suggestions ? suggestions.indexOf(activeSuggestion.item) : -1;
  const suggestionsOpen = showDropdown && nickname.trim().length >= 2 && suggestions.length > 0;

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
    <div className={`flex flex-col gap-3 md:flex-row md:items-end max-w-3xl mx-auto mb-8 relative ${showDropdown ? "z-[1000]" : "z-30"}`}>
      <div className="w-full md:w-48">
        <label className="mb-1 block text-xs leading-4 text-gray-300" htmlFor={platformId}>플랫폼</label>
        <select
          id={platformId}
          name="platform"
          autoComplete="off"
          value={platform}
          onChange={(event) => {
            setActiveSuggestion(null);
            setShowDropdown(false);
            onPlatformChange(event.target.value === "kakao" ? "kakao" : "steam");
          }}
          className="min-h-11 w-full p-3 bg-[#252525] color-white border border-[#444] rounded-md text-base focus:outline-none focus:border-[#F2A900] transition-colors"
        >
          <option value="steam">스팀 (Steam)</option>
          <option value="kakao">카카오 (Kakao)</option>
        </select>
      </div>

      <div
        className="relative flex-1"
        ref={dropdownRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setActiveSuggestion(null);
            setShowDropdown(false);
          }
        }}
      >
        <label className="mb-1 block text-xs leading-4 text-gray-300" htmlFor={nicknameId}>닉네임</label>
        <input
          id={nicknameId}
          name="nickname"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestionsOpen}
          aria-controls={suggestionsOpen ? suggestionsId : undefined}
          aria-activedescendant={suggestionIndex >= 0 && suggestionsOpen ? `${suggestionsId}-option-${suggestionIndex}` : undefined}
          autoComplete="off"
          placeholder="정확한 대소문자 닉네임을 입력하세요"
          value={nickname}
          onChange={(event) => {
            setActiveSuggestion(null);
            onNicknameChange(event.target.value);
            setShowDropdown(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape") {
              setActiveSuggestion(null);
              setShowDropdown(false);
            } else if (nickname.trim().length >= 2 && suggestions.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setShowDropdown(true);
              const direction = event.key === "ArrowDown" ? 1 : -1;
              const nextIndex = suggestionIndex < 0
                ? (direction === 1 ? 0 : suggestions.length - 1)
                : (suggestionIndex + direction + suggestions.length) % suggestions.length;
              setActiveSuggestion({ item: suggestions[nextIndex], source: suggestions });
            } else if (event.key === "Enter" && suggestionIndex >= 0 && suggestionsOpen) {
              event.preventDefault();
              onSuggestionSelect(suggestions[suggestionIndex]);
              setActiveSuggestion(null);
              setShowDropdown(false);
            } else if (event.key === "Enter" && !submitDisabled) {
              onSubmit();
            }
          }}
          onFocus={() => setShowDropdown(true)}
          className="min-h-11 w-full p-3 bg-[#252525] text-white border border-[#444] rounded-md text-base focus:outline-none focus:border-[#F2A900] transition-colors"
        />

        {showDropdown && (nickname.trim().length >= 2 || items.length > 0) && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-[#0a0a1a]/95 border border-white/10 rounded-xl overflow-hidden shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl z-50">
            <div className="max-h-[350px] overflow-y-auto custom-scrollbar">
              {nickname.trim().length >= 2 && suggestions.length > 0 && (
                <div className="pb-2">
                  <div id={`${suggestionsId}-label`} className="px-4 py-2 text-xs font-semibold text-amber-300 border-b border-white/5 bg-white/2">추천 플레이어</div>
                  <div id={suggestionsId} role="listbox" aria-labelledby={`${suggestionsId}-label`}>
                    {suggestions.map((suggestion, index) => {
                    const platformLabel = suggestion.platform === "kakao" ? "카카오" : "스팀";
                    return (
                      <div
                        id={`${suggestionsId}-option-${index}`}
                        role="option"
                        aria-selected={index === suggestionIndex}
                        key={`${suggestion.platform}:${suggestion.nickname}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          onSuggestionSelect(suggestion);
                          setActiveSuggestion(null);
                          setShowDropdown(false);
                        }}
                        className={`flex min-h-11 w-full items-center gap-3 border-b border-white/5 px-4 py-3 text-left transition-colors last:border-0 hover:bg-amber-500/10 cursor-pointer ${index === suggestionIndex ? "bg-amber-500/10" : ""}`}
                      >
                        <User size={14} className="text-amber-500 shrink-0" />
                        <span className="min-w-0 truncate text-sm font-bold text-gray-200">{suggestion.nickname}</span>
                        <span className="ml-auto shrink-0 text-xs text-gray-300">{platformLabel}</span>
                      </div>
                    );
                    })}
                  </div>
                </div>
              )}

              {nickname.trim().length >= 2 && suggestions.length === 0 && !suggesting && empty && (
                <div className="px-4 py-4 text-center text-xs text-gray-400 italic">검색 결과가 없습니다</div>
              )}

              {(nickname.trim().length < 2 || suggestions.length === 0) && items.length > 0 && (
                <div role="region" aria-label="즐겨찾기 및 최근 검색">
                  {items.map((item) => {
                const favorite = favorites.some(entry => statsSearchKey(entry) === statsSearchKey(item));
                return (
                  <div key={statsSearchKey(item)} className="w-full px-4 py-3 flex items-center gap-3 border-b border-white/5 last:border-0">
                    <button
                      type="button"
                      aria-label={`${item.nickname} ${item.platform === "kakao" ? "카카오로" : "스팀으로"} 검색`}
                      onClick={() => {
                        onQuickSearch(item.nickname, item.platform);
                        setShowDropdown(false);
                      }}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      {item.type === "favorite"
                        ? <Star size={14} className="text-yellow-400 fill-yellow-400 shrink-0" />
                        : <Clock size={14} className="text-gray-500 shrink-0" />}
                      <span className="truncate text-sm font-bold text-gray-300">{item.nickname}</span>
                      <span aria-hidden="true" className="text-xs text-gray-300">{item.platform === "kakao" ? "카카오" : "스팀"}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${item.nickname} ${item.platform === "kakao" ? "카카오" : "스팀"} 즐겨찾기 ${favorite ? "해제" : "추가"}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFavoriteToggle(item.nickname, item.platform);
                      }}
                      className={favorite ? "flex min-h-11 min-w-11 items-center justify-center text-yellow-400" : "flex min-h-11 min-w-11 items-center justify-center text-gray-600"}
                    >
                      <Star size={14} fill={favorite ? "currentColor" : "none"} />
                    </button>
                    {item.type === "recent" && (
                      <button
                        type="button"
                        aria-label={`${item.nickname} ${item.platform === "kakao" ? "카카오" : "스팀"} 최근 검색 삭제`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRecentRemove(item.nickname, item.platform);
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
              )}
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
