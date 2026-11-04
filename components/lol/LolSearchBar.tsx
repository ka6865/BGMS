"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Clock, Star, User, X } from "lucide-react";
import type { LolSearchHistory } from "@/lib/lol/searchHistory";
import type { LolSuggestion } from "@/hooks/useLolAutocomplete";

export default function LolSearchBar({ value, history, suggestions, suggesting, empty, loading, onChange, onSearch, onToggleFavorite, onRemoveRecent, onClearRecent }: {
  value: string;
  history: LolSearchHistory;
  suggestions: LolSuggestion[];
  suggesting: boolean;
  empty: boolean;
  loading: boolean;
  onChange(value: string): void;
  onSearch(riotId: string): void;
  onToggleFavorite(riotId: string): void;
  onRemoveRecent(riotId: string): void;
  onClearRecent(): void;
}) {
  const listId = useId();
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{ index: number; source: LolSuggestion[] } | null>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const skipFocusOpen = useRef(false);
  const composing = useRef(false);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const query = value.trim();
  const activeIndex = selected?.source === suggestions ? selected.index : -1;
  const items = useMemo(() => [
    ...history.favorites.map((riotId) => ({ riotId, favorite: true })),
    ...history.recent
      .filter((id) => !history.favorites.some((favorite) => favorite.toLocaleLowerCase() === id.toLocaleLowerCase()))
      .map((riotId) => ({ riotId, favorite: false })),
  ], [history]);
  const suggestionsOpen = open && query.length >= 2 && suggestions.length > 0;

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const positionPopup = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 8));
      setPopupPosition({ top: rect.bottom + 4, left, width: Math.min(rect.width, window.innerWidth - left - 8) });
    };
    positionPopup();
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    return () => {
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
    };
  }, [open]);

  useEffect(() => {
    if (!suggestionsOpen || activeIndex < 0) return;
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId, suggestionsOpen]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composing.current) return;
    if (value.trim()) {
      setOpen(false);
      onSearch(value);
    }
  }

  function selectSuggestion(suggestion: LolSuggestion) {
    setOpen(false);
    setSelected(null);
    onSearch(`${suggestion.gameName}#${suggestion.tagLine}`);
  }

  return (
    <form ref={rootRef} onSubmit={submit} onBlur={(event) => {
      const next = event.relatedTarget as Node | null;
      if (!event.currentTarget.contains(next) && !popupRef.current?.contains(next)) {
        setOpen(false);
        setSelected(null);
      }
    }} onKeyDown={(event) => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      setOpen(false);
      setSelected(null);
      if (event.target !== event.currentTarget.querySelector("input")) {
        skipFocusOpen.current = true;
        inputRef.current?.focus();
      }
    }} className={`relative mb-0 flex gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-2 sm:p-3 ${open ? "z-40" : "z-0"}`}>
      <label className="sr-only" htmlFor="lol-riot-id">Riot ID</label>
      <input
        ref={inputRef}
        id="lol-riot-id"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && (items.length > 0 || value.trim().length >= 2)}
        aria-controls={open && (items.length > 0 || value.trim().length >= 2) ? popupId : undefined}
        aria-activedescendant={suggestionsOpen && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        value={value}
        onChange={(event) => { setSelected(null); onChange(event.target.value); setOpen(true); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onFocus={() => {
          if (skipFocusOpen.current) { skipFocusOpen.current = false; return; }
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if ((event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) && event.key === "Enter") {
            event.preventDefault();
            return;
          }
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setSelected(null);
          } else if (suggestions.length > 0 && query.length >= 2 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setSelected((current) => {
              const index = current?.source === suggestions ? current.index : -1;
              return { source: suggestions, index: index < 0 ? (step > 0 ? 0 : suggestions.length - 1) : (index + step + suggestions.length) % suggestions.length };
            });
          } else if (event.key === "Enter" && suggestionsOpen && activeIndex >= 0) {
            event.preventDefault();
            selectSuggestion(suggestions[activeIndex]);
          }
        }}
        placeholder="게임 이름#태그"
        autoComplete="off"
        maxLength={140}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-400"
      />
      <button type="submit" disabled={!value.trim()} className="min-h-11 shrink-0 rounded-lg bg-amber-400 px-4 text-sm font-bold text-zinc-950 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-400 sm:px-5">
        {loading ? "검색 중…" : "검색"}
      </button>
    {open && popupPosition && (items.length > 0 || query.length >= 2) && (
        <div ref={popupRef} id={popupId} data-testid="lol-search-dropdown" style={{ position: "fixed", top: popupPosition.top, left: popupPosition.left, width: popupPosition.width, zIndex: 1000 }}
          className="overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
          <div className="max-h-[min(22rem,60vh)] overflow-y-auto overscroll-contain">
            {query.length >= 2 && (
              <section aria-label="추천 플레이어">
                <h2 className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold text-amber-300">추천 플레이어</h2>
                {suggesting && <p role="status" className="px-3 py-3 text-sm text-zinc-400">검색 중…</p>}
                {!suggesting && empty && <p className="px-3 py-3 text-sm text-zinc-400">저장된 계정에서 찾지 못했습니다.</p>}
                {!suggesting && !empty && suggestions.length === 0 && <p className="px-3 py-3 text-sm text-zinc-500">추천 검색을 사용할 수 없습니다.</p>}
                {suggestions.length > 0 && <div id={listId} role="listbox" aria-label="추천 플레이어">
                  {suggestions.map((suggestion, index) => (
                    <button key={`${suggestion.gameName}#${suggestion.tagLine}`} id={`${listId}-option-${index}`} type="button" role="option" aria-selected={activeIndex === index}
                      onMouseDown={(event) => event.preventDefault()} onClick={() => selectSuggestion(suggestion)}
                      className={`flex min-h-11 w-full items-center gap-2 border-b border-zinc-800 px-3 py-2 text-left text-sm hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-amber-400 ${activeIndex === index ? "bg-zinc-800" : ""}`}>
                      <User size={15} aria-hidden="true" className="shrink-0 text-amber-300" />
                      <span className="min-w-0 truncate">{suggestion.gameName}</span><span className="shrink-0 text-zinc-400">#{suggestion.tagLine}</span>
                    </button>
                  ))}
                </div>}
              </section>
            )}
            {items.length > 0 && (query.length < 2 || suggestions.length === 0) && <div aria-label="즐겨찾기 및 최근 검색" onMouseDown={(event) => event.preventDefault()}>
              {history.favorites.length > 0 && <>
                <h2 className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-400">즐겨찾기</h2>
                {items.filter((item) => item.favorite).map((item) => <HistoryRow key={item.riotId} {...item} onSearch={(id) => { setOpen(false); onSearch(id); }} onToggleFavorite={onToggleFavorite} onRemoveRecent={onRemoveRecent} />)}
              </>}
              {items.some((item) => !item.favorite) && <>
                <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1">
                  <h2 className="text-xs font-semibold text-zinc-400">최근 검색</h2>
                  <button type="button" onClick={onClearRecent} className="min-h-11 px-2 text-xs text-zinc-400 underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-400">최근 기록 비우기</button>
                </div>
                {items.filter((item) => !item.favorite).map((item) => <HistoryRow key={item.riotId} {...item} onSearch={(id) => { setOpen(false); onSearch(id); }} onToggleFavorite={onToggleFavorite} onRemoveRecent={onRemoveRecent} />)}
              </>}
            </div>}
          </div>
        </div>
      )}
    </form>
  );
}

function HistoryRow({ riotId, favorite, onSearch, onToggleFavorite, onRemoveRecent }: {
  riotId: string;
  favorite: boolean;
  onSearch(riotId: string): void;
  onToggleFavorite(riotId: string): void;
  onRemoveRecent(riotId: string): void;
}) {
  return <div className="flex min-w-0 items-center gap-1 border-b border-zinc-800 px-2 last:border-0">
    <button type="button" onClick={() => onSearch(riotId)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-amber-400" aria-label={`${riotId} 검색`}>
      {favorite ? <Star size={15} aria-hidden="true" className="shrink-0 fill-amber-300 text-amber-300" /> : <Clock size={15} aria-hidden="true" className="shrink-0 text-zinc-500" />}
      <span className="truncate">{riotId}</span>
    </button>
    <button type="button" aria-label={`${riotId} 즐겨찾기 ${favorite ? "해제" : "추가"}`} aria-pressed={favorite} onClick={() => onToggleFavorite(riotId)} className="flex min-h-11 min-w-11 items-center justify-center text-amber-300 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-amber-400"><Star size={15} aria-hidden="true" fill={favorite ? "currentColor" : "none"} /></button>
    {!favorite && <button type="button" aria-label={`${riotId} 최근 검색에서 삭제`} onClick={() => onRemoveRecent(riotId)} className="flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-400"><X size={15} aria-hidden="true" /></button>}
  </div>;
}
