"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseStatsPlatform } from "@/lib/stats/statsPageModel";
import type { StatsPlatform } from "@/types/stats-page";

export interface StatsAutocompleteState {
  suggestions: readonly { nickname: string; platform: StatsPlatform }[];
  suggesting: boolean;
  empty: boolean;
}

interface AutocompleteResult extends StatsAutocompleteState {
  query: string;
}

function parseSuggestions(value: unknown): { nickname: string; platform: StatsPlatform }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const nickname = "nickname" in item && typeof item.nickname === "string"
      ? item.nickname.trim()
      : "";
    const platform = "platform" in item ? parseStatsPlatform(String(item.platform)) : null;
    return nickname && platform ? [{ nickname, platform }] : [];
  });
}

export function useStatsAutocomplete(query: string): StatsAutocompleteState {
  const normalizedQuery = query.trim();
  const requestIdRef = useRef(0);
  const [result, setResult] = useState<AutocompleteResult>({
    query: "",
    suggestions: [],
    suggesting: false,
    empty: false,
  });

  useEffect(() => {
    if (normalizedQuery.length < 2) return;
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    const isCurrent = () => requestId === requestIdRef.current && !controller.signal.aborted;
    const timer = window.setTimeout(async () => {
      setResult({ query: normalizedQuery, suggestions: [], suggesting: true, empty: false });
      try {
        const response = await fetch(`/api/pubg/suggest?q=${encodeURIComponent(normalizedQuery)}`, {
          signal: controller.signal,
        });
        const data = await response.json() as { suggestions?: unknown };
        if (!isCurrent()) return;
        const suggestions = response.ok ? parseSuggestions(data.suggestions) : [];
        setResult({
          query: normalizedQuery,
          suggestions,
          suggesting: false,
          empty: response.ok && suggestions.length === 0,
        });
      } catch {
        if (!isCurrent()) return;
        setResult({ query: normalizedQuery, suggestions: [], suggesting: false, empty: false });
      }
    }, 300);

    return () => {
      requestIdRef.current += 1;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedQuery]);

  return useMemo(() => {
    if (normalizedQuery.length < 2) {
      return { suggestions: [], suggesting: false, empty: false };
    }
    if (result.query !== normalizedQuery) {
      return { suggestions: [], suggesting: true, empty: false };
    }
    return {
      suggestions: result.suggestions,
      suggesting: result.suggesting,
      empty: result.empty,
    };
  }, [normalizedQuery, result]);
}
