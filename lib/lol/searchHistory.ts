import { lolRiotIdPath } from "./riotId";

const STORAGE_KEY = "bgms:lol-search-history:v1";
const RECENT_LIMIT = 10;
const FAVORITE_LIMIT = 20;

export type LolSearchHistory = { recent: string[]; favorites: string[] };

export const emptyLolSearchHistory = (): LolSearchHistory => ({ recent: [], favorites: [] });

export function normalizeLolRiotId(value: string): string | null {
  return lolRiotIdPath(value) ? value.split("#").map(part => part.trim()).join("#") : null;
}

function uniqueIds(values: unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = normalizeLolRiotId(value);
    const key = id?.toLocaleLowerCase();
    if (!id || !key || seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

export function loadLolSearchHistory(storage?: Storage): LolSearchHistory | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    if (raw === null) return emptyLolSearchHistory();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.recent) || !Array.isArray(parsed.favorites)) return null;
    return {
      recent: uniqueIds(parsed.recent).slice(0, RECENT_LIMIT),
      favorites: uniqueIds(parsed.favorites).slice(0, FAVORITE_LIMIT),
    };
  } catch {
    return null;
  }
}

export function saveLolSearchHistory(history: LolSearchHistory, storage?: Storage): boolean {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify({
      recent: uniqueIds(history.recent).slice(0, RECENT_LIMIT),
      favorites: uniqueIds(history.favorites).slice(0, FAVORITE_LIMIT),
    }));
    return true;
  } catch {
    return false;
  }
}

export function recordLolSearch(history: LolSearchHistory, value: string): LolSearchHistory {
  const id = normalizeLolRiotId(value);
  if (!id) return history;
  const key = id.toLocaleLowerCase();
  return { ...history, recent: [id, ...history.recent.filter(item => item.toLocaleLowerCase() !== key)].slice(0, RECENT_LIMIT) };
}

export function removeLolRecent(history: LolSearchHistory, value: string): LolSearchHistory {
  const key = value.toLocaleLowerCase();
  return { ...history, recent: history.recent.filter(item => item.toLocaleLowerCase() !== key) };
}

export function toggleLolFavorite(history: LolSearchHistory, value: string): LolSearchHistory | null {
  const id = normalizeLolRiotId(value);
  if (!id) return history;
  const key = id.toLocaleLowerCase();
  if (history.favorites.some(item => item.toLocaleLowerCase() === key)) {
    return { ...history, favorites: history.favorites.filter(item => item.toLocaleLowerCase() !== key) };
  }
  if (history.favorites.length >= FAVORITE_LIMIT) return null;
  return { ...history, favorites: [id, ...history.favorites] };
}
