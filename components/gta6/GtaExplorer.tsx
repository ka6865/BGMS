"use client";

import dynamic from "next/dynamic";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronRight, MapPin, Search, Share2, Star, X } from "lucide-react";
import { CATEGORIES, filterLandmarks, parseLandmarks, parseProgress, STORAGE_KEY, type Category, type Landmark, type Progress } from "@/lib/gta6/map";
import manifest from "@/public/gta6/manifest.json";
import styles from "./gta6.module.css";

const GtaMap = dynamic(() => import("./GtaMap"), { ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-zinc-900 text-sm text-zinc-300" role="status">지도를 준비하고 있습니다…</div> });
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300";
type SavedFilter = "all" | "favorites" | "visited";

export default function GtaExplorer() {
  const [places, setPlaces] = useState<Landmark[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState<Category>("all");
  const [savedFilter, setSavedFilter] = useState<SavedFilter>("all");
  const [limit, setLimit] = useState(60);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<Progress>({ version: 1, favorites: [], visited: [] });
  const [progressReady, setProgressReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    fetch(`/gta6/landmarks.json?v=${manifest.commit}`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("장소 요청 실패"); return response.json(); })
      .then(value => { if (!controller.signal.aborted) setPlaces(parseLandmarks(value)); })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    try { setProgress(parseProgress(localStorage.getItem(STORAGE_KEY))); }
    catch { setStorageError(true); }
    setProgressReady(true);
    function readHash() {
      const id = window.location.hash.slice(1);
      setSelectedId(/^L[1-9]\d*$/.test(id) ? id : null);
      setNotice(id && !/^L[1-9]\d*$/.test(id) ? "공유한 장소 주소를 확인해 주세요." : "");
    }
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const favorites = useMemo(() => new Set(progress.favorites), [progress.favorites]);
  const visited = useMemo(() => new Set(progress.visited), [progress.visited]);
  const selected = places?.find(place => place.id === selectedId) ?? null;
  const filtered = useMemo(() => filterLandmarks(places ?? [], deferredQuery, category)
    .filter(place => savedFilter === "all" || (savedFilter === "favorites" ? favorites : visited).has(place.id))
    .sort((a, b) => Number(a.name.startsWith("이름 미확인")) - Number(b.name.startsWith("이름 미확인")) || a.name.localeCompare(b.name, "ko-KR")),
  [places, deferredQuery, category, savedFilter, favorites, visited]);
  const counts = useMemo(() => {
    const result = new Map<Category, number>();
    for (const place of places ?? []) result.set(place.category, (result.get(place.category) ?? 0) + 1);
    return result;
  }, [places]);
  const savedCount = (set: Set<string>) => (places ?? []).filter(place => set.has(place.id)).length;

  function select(id: string | null) {
    setSelectedId(id);
    setNotice("");
    window.location.hash = id ?? "";
  }
  function changeFilters(change: () => void) {
    change(); setLimit(60); if (selectedId) select(null);
  }
  function toggleSaved(key: "favorites" | "visited", id: string) {
    const ids = progress[key];
    const next = { ...progress, [key]: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id] };
    setProgress(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setStorageError(false); }
    catch { setStorageError(true); }
  }
  async function share() {
    if (!selected) return;
    const url = new URL(window.location.href);
    url.hash = selected.id;
    try { await navigator.clipboard.writeText(url.toString()); setNotice("장소 링크를 복사했습니다."); }
    catch { setNotice(`주소창의 링크를 복사해 공유해 주세요. 장소: ${selected.id}`); }
  }

  return <>
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section aria-label="레오니다 지도" className="relative min-h-[200px] flex-1 lg:order-2">
        <GtaMap places={filtered} selected={selected} visited={visited} onSelect={select} />
      </section>
      <aside aria-label="장소 탐색" className={`flex h-[46dvh] min-h-[260px] shrink-0 flex-col border-t border-white/10 bg-zinc-950 lg:order-1 lg:h-auto lg:min-h-0 lg:w-[360px] lg:border-r lg:border-t-0 ${styles.panel}`}>
        {!selected && <div className="shrink-0 px-4 pb-3 pt-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h1 className="text-lg font-bold tracking-tight">레오니다 탐색</h1>
            <span className="text-xs tabular-nums text-zinc-400">{places ? `${places.length.toLocaleString("ko-KR")}개 장소` : "장소 불러오는 중"}</span>
          </div>
          <form role="search" onSubmit={e => e.preventDefault()}>
            <label htmlFor="gta6-search" className="sr-only">장소 검색</label>
            <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 focus-within:border-amber-300">
              <Search size={17} aria-hidden className="shrink-0 text-zinc-400" />
              <input id="gta6-search" type="search" value={query} placeholder="장소·지역·ID 검색" autoComplete="off" maxLength={160}
                onChange={e => changeFilters(() => setQuery(e.target.value))}
                className="min-h-11 w-full min-w-0 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-400" />
              {query && <button type="button" aria-label="검색어 지우기" className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-amber-300" onClick={() => changeFilters(() => setQuery(""))}><X size={16} /></button>}
            </div>
          </form>
          <div className="mt-2 flex gap-2">
            <label className="sr-only" htmlFor="gta6-category">장소 분류</label>
            <select id="gta6-category" value={category} onChange={e => changeFilters(() => setCategory(e.target.value as Category))}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm focus-visible:outline-2 focus-visible:outline-amber-300">
              {Object.entries(CATEGORIES).filter(([key]) => key === "all" || counts.has(key as Category)).map(([key, value]) =>
                <option key={key} value={key}>{value.label}{key !== "all" ? ` (${counts.get(key as Category)})` : ""}</option>)}
            </select>
            <button type="button" aria-label="즐겨찾기만 보기" aria-pressed={savedFilter === "favorites"}
              className={`${button} ${savedFilter === "favorites" ? "bg-amber-300 text-zinc-950" : "bg-zinc-900 text-zinc-300"}`}
              onClick={() => changeFilters(() => setSavedFilter(savedFilter === "favorites" ? "all" : "favorites"))}>
              <Star size={16} aria-hidden /><span className="tabular-nums">{savedCount(favorites)}</span>
            </button>
            <button type="button" aria-label="방문한 장소만 보기" aria-pressed={savedFilter === "visited"}
              className={`${button} ${savedFilter === "visited" ? "bg-emerald-200 text-zinc-950" : "bg-zinc-900 text-zinc-300"}`}
              onClick={() => changeFilters(() => setSavedFilter(savedFilter === "visited" ? "all" : "visited"))}>
              <CheckCheck size={17} aria-hidden /><span className="tabular-nums">{savedCount(visited)}</span>
            </button>
          </div>
        </div>}

        <div ref={panel} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/10 ${styles.panel}`} aria-busy={!places && !loadError}>
          {storageError && <p role="status" className="px-4 pt-3 text-xs leading-relaxed text-amber-200">브라우저 저장소를 사용할 수 없습니다. 지금 체크한 내용은 이 화면을 닫으면 사라질 수 있습니다.</p>}
          {notice && <p role="status" className="break-words px-4 pt-3 text-xs leading-relaxed text-amber-200">{notice}</p>}
          {selectedId && places && !selected && <p role="status" className="px-4 pt-3 text-sm text-amber-200">공유한 장소가 없거나 지도 좌표가 아직 없습니다.</p>}
          {loadError ? <div role="alert" className="p-4 text-sm leading-relaxed text-zinc-300">
            <p>장소 정보를 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.</p>
            <button type="button" className={`${button} mt-3 bg-amber-300 text-zinc-950`} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>
          </div> : !places ? <p role="status" className="p-4 text-sm text-zinc-400">장소 정보를 불러오고 있습니다…</p> : selected ?
            <div className="p-4" data-testid="gta6-detail">
              <button type="button" className="-ml-2 mb-2 inline-flex min-h-11 items-center gap-1 rounded px-2 text-xs font-semibold text-zinc-300 focus-visible:outline-2 focus-visible:outline-amber-300" onClick={() => select(null)}><ArrowLeft size={15} aria-hidden />장소 목록</button>
              <div className="mb-2 flex items-center gap-2 text-xs text-zinc-300"><span className="h-2 w-2 rounded-full" style={{ background: CATEGORIES[selected.category].color }} />{CATEGORIES[selected.category].label}<span className="text-zinc-400">{selected.id}</span></div>
              <h2 className="break-words text-xl font-bold leading-snug">{selected.name}</h2>
              <p className="mt-2 break-words text-sm leading-relaxed text-zinc-300">{selected.address}</p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button type="button" disabled={!progressReady} aria-pressed={favorites.has(selected.id)} onClick={() => toggleSaved("favorites", selected.id)}
                  className={`${button} ${favorites.has(selected.id) ? "bg-amber-300 text-zinc-950" : "bg-zinc-800 text-zinc-100"} disabled:opacity-50`}>
                  <Star size={16} aria-hidden fill={favorites.has(selected.id) ? "currentColor" : "none"} />즐겨찾기
                </button>
                <button type="button" disabled={!progressReady} aria-pressed={visited.has(selected.id)} onClick={() => toggleSaved("visited", selected.id)}
                  className={`${button} ${visited.has(selected.id) ? "bg-emerald-200 text-zinc-950" : "bg-zinc-800 text-zinc-100"} disabled:opacity-50`}>
                  <Check size={17} aria-hidden />{visited.has(selected.id) ? "방문 완료" : "방문 체크"}
                </button>
              </div>
              <button type="button" className={`${button} mt-2 w-full bg-zinc-900 text-zinc-200`} onClick={share}><Share2 size={16} aria-hidden />장소 링크 복사</button>
              <dl className="mt-5 space-y-3 border-t border-white/10 pt-4 text-xs leading-relaxed">
                <div><dt className="text-zinc-400">게임 좌표 · 추정 위치</dt><dd className="mt-1 tabular-nums text-zinc-200">X {selected.coordinates[0].toFixed(1)} / Y {selected.coordinates[1].toFixed(1)}</dd></div>
                {selected.realAddress && selected.realAddress !== "?" && <div><dt className="text-zinc-400">현실의 대응 장소{selected.unconfirmed ? " · 미확인 매칭" : " · 커뮤니티 조사"}</dt><dd className="mt-1 break-words text-zinc-200">{selected.realAddress}</dd></div>}
              </dl>
              <a href={`https://map.gtadb.org/#VI,${selected.id}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-amber-300 underline underline-offset-4">원본 장소 확인<ArrowUpRight size={13} aria-hidden /></a>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">즐겨찾기와 방문 기록은 이 브라우저에만 저장됩니다. 게임 진행도와 자동으로 연결되지 않습니다.</p>
            </div> : <>
              <div className="flex min-h-11 items-center justify-between gap-2 px-4 text-xs text-zinc-400" role="status">
                <span>{savedFilter === "favorites" ? "즐겨찾기" : savedFilter === "visited" ? "방문한 장소" : "검색 결과"} <strong className="font-medium tabular-nums text-zinc-200">{filtered.length.toLocaleString("ko-KR")}개</strong></span>
                {(query || category !== "all" || savedFilter !== "all") && <button type="button" className="min-h-11 rounded px-2 font-semibold text-amber-300 focus-visible:outline-2 focus-visible:outline-amber-300" onClick={() => changeFilters(() => { setQuery(""); setCategory("all"); setSavedFilter("all"); })}>필터 초기화</button>}
              </div>
              {filtered.length === 0 ? <div className="px-4 pb-6 pt-3 text-sm leading-relaxed text-zinc-300">
                {savedFilter === "favorites" ? "즐겨찾기한 장소가 없습니다. 장소를 선택하고 별을 눌러 보세요." : savedFilter === "visited" ? "방문 체크한 장소가 없습니다." : "일치하는 장소가 없습니다. 다른 이름이나 지역으로 검색해 보세요."}
              </div> : <ul aria-label="검색된 장소">
                {filtered.slice(0, limit).map(place => <li key={place.id} className="border-t border-white/5">
                  <button type="button" onClick={() => select(place.id)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-300">
                    <MapPin size={17} aria-hidden className="shrink-0" style={{ color: CATEGORIES[place.category].color }} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{place.name}</span><span className="mt-1 block truncate text-xs text-zinc-400">{place.id} · {CATEGORIES[place.category].label} · {place.address.replace(/^[^,]*,?\s*/, "")}</span></span>
                    {favorites.has(place.id) && <Star size={13} className="shrink-0 text-amber-300" aria-label="즐겨찾기" fill="currentColor" />}
                    {visited.has(place.id) && <Check size={15} className="shrink-0 text-emerald-200" aria-label="방문 완료" />}
                    <ChevronRight size={15} aria-hidden className="shrink-0 text-zinc-500" />
                  </button>
                </li>)}
              </ul>}
              {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 60)} className={`${button} m-4 border border-zinc-700 text-zinc-200`}>장소 더 보기 ({Math.min(limit, filtered.length)}/{filtered.length})</button>}
            </>}
        </div>
      </aside>
    </div>
    <footer className="shrink-0 border-t border-white/10 bg-zinc-950 px-4 py-2 text-[10px] leading-relaxed text-zinc-400">
      <span className="text-zinc-300">커뮤니티 추정 지도 · 공식 지도 아님</span><span className="mx-2">·</span>
      <a href={manifest.source} target="_blank" rel="noreferrer" className="underline underline-offset-2">gtadb.org and all contributors</a>{" · "}
      <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className="underline underline-offset-2">CC BY 4.0</a>
      <span className="ml-2">자료 {manifest.importedAt} · 한국어 검색어 추가</span>
      <span className="hidden xl:inline"> · Rockstar Games 및 Take-Two Interactive와 관련 없는 팬 서비스입니다.</span>
    </footer>
  </>;
}
