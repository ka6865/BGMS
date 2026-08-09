"use client";

import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEY_FAVORITES, STORAGE_KEY_RECENT } from "@/lib/pubg-analysis/constants";
import { normalizeStoredNames } from "@/lib/stats/statsPageModel";

export interface StatsSearchHistory {
  recentSearches: readonly string[];
  favorites: readonly string[];
  addRecent(name: string): void;
  toggleFavorite(name: string): void;
  removeRecent(name: string): void;
}

function readStoredNames(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("stored value is not an array");
    return normalizeStoredNames(parsed);
  } catch {
    localStorage.removeItem(key);
    return [];
  }
}

function writeStoredNames(key: string, names: readonly string[]): void {
  localStorage.setItem(key, JSON.stringify([...names]));
}

export function useStatsSearchHistory(): StatsSearchHistory {
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    setRecentSearches(readStoredNames(STORAGE_KEY_RECENT));
    setFavorites(readStoredNames(STORAGE_KEY_FAVORITES));
  }, []);

  const addRecent = useCallback((name: string) => {
    const normalized = name.trim();
    if (!normalized) return;
    setRecentSearches((previous) => {
      const next = [normalized, ...previous.filter((value) => value !== normalized)].slice(0, 10);
      writeStoredNames(STORAGE_KEY_RECENT, next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((name: string) => {
    const normalized = name.trim();
    if (!normalized) return;
    setFavorites((previous) => {
      const next = previous.includes(normalized)
        ? previous.filter((value) => value !== normalized)
        : [normalized, ...previous];
      writeStoredNames(STORAGE_KEY_FAVORITES, next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((name: string) => {
    setRecentSearches((previous) => {
      const next = previous.filter((value) => value !== name);
      writeStoredNames(STORAGE_KEY_RECENT, next);
      return next;
    });
  }, []);

  return { recentSearches, favorites, addRecent, toggleFavorite, removeRecent };
}
