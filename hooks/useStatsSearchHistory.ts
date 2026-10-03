"use client";

import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEY_FAVORITES, STORAGE_KEY_RECENT } from "@/lib/pubg-analysis/constants";
import { parseStatsPlatform } from "@/lib/stats/statsPageModel";
import type { StatsPlatform } from "@/types/stats-page";

export interface StatsSearchEntry { nickname: string; platform: StatsPlatform }
export const statsSearchKey = (entry: StatsSearchEntry) => `${entry.platform}:${entry.nickname.trim().toLowerCase()}`;

export interface StatsSearchHistory {
  recentSearches: readonly StatsSearchEntry[];
  favorites: readonly StatsSearchEntry[];
  addRecent(name: string, platform?: StatsPlatform): void;
  toggleFavorite(name: string, platform?: StatsPlatform): void;
  removeRecent(name: string, platform?: StatsPlatform): void;
}

function readStoredNames(key: string): StatsSearchEntry[] {
  let sourceKey = key;
  try {
    let raw = localStorage.getItem(key);
    if (raw === null) {
      sourceKey = key === STORAGE_KEY_RECENT ? "pubg_recent_searches_v2" : "pubg_favorites_v2";
      raw = localStorage.getItem(sourceKey);
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("stored value is not an array");
    const seen = new Set<string>();
    return parsed.flatMap(value => {
      // Legacy names have no platform information; retain the previous Steam default.
      const nickname = typeof value === "string" ? value.trim() : typeof value?.nickname === "string" ? value.nickname.trim() : "";
      const platform = typeof value === "string" ? "steam" : parseStatsPlatform(value?.platform);
      if (!nickname || !platform) return [];
      const entry = { nickname, platform };
      const identity = statsSearchKey(entry);
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [entry];
    });
  } catch {
    try { localStorage.removeItem(sourceKey); } catch { /* Storage can be disabled. */ }
    return [];
  }
}

function writeStoredNames(key: string, names: readonly StatsSearchEntry[]): void {
  try { localStorage.setItem(key, JSON.stringify(names)); } catch { /* Keep the in-memory history usable. */ }
}

export function useStatsSearchHistory(): StatsSearchHistory {
  const [recentSearches, setRecentSearches] = useState<StatsSearchEntry[]>([]);
  const [favorites, setFavorites] = useState<StatsSearchEntry[]>([]);

  useEffect(() => {
    setRecentSearches(readStoredNames(STORAGE_KEY_RECENT).slice(0, 10));
    setFavorites(readStoredNames(STORAGE_KEY_FAVORITES));
  }, []);

  const addRecent = useCallback((name: string, platform: StatsPlatform = "steam") => {
    const normalized = name.trim();
    if (!normalized) return;
    setRecentSearches((previous) => {
      const entry = { nickname: normalized, platform };
      const next = [entry, ...previous.filter(value => statsSearchKey(value) !== statsSearchKey(entry))].slice(0, 10);
      writeStoredNames(STORAGE_KEY_RECENT, next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((name: string, platform: StatsPlatform = "steam") => {
    const normalized = name.trim();
    if (!normalized) return;
    setFavorites((previous) => {
      const entry = { nickname: normalized, platform };
      const remaining = previous.filter(value => statsSearchKey(value) !== statsSearchKey(entry));
      const next = remaining.length === previous.length ? [entry, ...previous] : remaining;
      writeStoredNames(STORAGE_KEY_FAVORITES, next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((name: string, platform: StatsPlatform = "steam") => {
    setRecentSearches((previous) => {
      const next = previous.filter(value => statsSearchKey(value) !== statsSearchKey({ nickname: name, platform }));
      writeStoredNames(STORAGE_KEY_RECENT, next);
      return next;
    });
  }, []);

  return { recentSearches, favorites, addRecent, toggleFavorite, removeRecent };
}
