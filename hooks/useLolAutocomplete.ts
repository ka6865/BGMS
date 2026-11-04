"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type LolSuggestion = { gameName: string; tagLine: string };

interface AutocompleteState {
  query: string;
  suggestions: LolSuggestion[];
  suggesting: boolean;
  empty: boolean;
}

function parseSuggestions(value: unknown): LolSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { gameName, tagLine } = item as Record<string, unknown>;
    return typeof gameName === "string" && gameName.trim() && typeof tagLine === "string" && tagLine.trim()
      ? [{ gameName: gameName.trim(), tagLine: tagLine.trim() }]
      : [];
  }).slice(0, 8);
}

export function useLolAutocomplete(query: string) {
  const normalizedQuery = query.trim();
  const requestId = useRef(0);
  const [result, setResult] = useState<AutocompleteState>({ query: "", suggestions: [], suggesting: false, empty: false });

  useEffect(() => {
    if (normalizedQuery.length < 2) return;
    const currentRequest = ++requestId.current;
    const controller = new AbortController();
    const isCurrent = () => requestId.current === currentRequest && !controller.signal.aborted;
    const timer = window.setTimeout(async () => {
      setResult({ query: normalizedQuery, suggestions: [], suggesting: true, empty: false });
      try {
        const response = await fetch(`/api/lol/suggest?q=${encodeURIComponent(normalizedQuery)}`, { signal: controller.signal });
        const data = await response.json() as { suggestions?: unknown };
        if (!isCurrent()) return;
        const suggestions = response.ok ? parseSuggestions(data.suggestions) : [];
        setResult({ query: normalizedQuery, suggestions, suggesting: false, empty: response.ok && suggestions.length === 0 });
      } catch {
        if (isCurrent()) setResult({ query: normalizedQuery, suggestions: [], suggesting: false, empty: false });
      }
    }, 300);

    return () => {
      requestId.current += 1;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedQuery]);

  return useMemo(() => {
    if (normalizedQuery.length < 2) return { suggestions: [], suggesting: false, empty: false };
    if (result.query !== normalizedQuery) return { suggestions: [], suggesting: true, empty: false };
    return { suggestions: result.suggestions, suggesting: result.suggesting, empty: result.empty };
  }, [normalizedQuery, result]);
}
