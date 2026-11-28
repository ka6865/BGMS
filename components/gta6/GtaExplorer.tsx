"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, EyeOff, MapPin, Search, Share2, Star, X } from "lucide-react";
import { CATEGORIES, MAP_REGIONS, filterLandmarks, parseLandmarks, parseProgress, STORAGE_KEY, type Category, type Landmark, type Progress } from "@/lib/gta6/map";
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
  const [hidden, setHidden] = useState<ReadonlySet<Category>>(() => new Set());
  const [hideVisited, setHideVisited] = useState(false);
  const [savedFilter, setSavedFilter] = useState<SavedFilter>("all");
  const [limit, setLimit] = useState(60);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<Progress>({ version: 1, favorites: [], visited: [] });
  const progressRef = useRef(progress);
  const storageFailed = useRef(false);
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
    try {
      const current = parseProgress(localStorage.getItem(STORAGE_KEY));
      progressRef.current = current;
      setProgress(current);
    } catch { storageFailed.current = true; setStorageError(true); }
    setProgressReady(true);
    function syncProgress(event: StorageEvent) {
      if (storageFailed.current || (event.key !== STORAGE_KEY && event.key !== null)) return;
      try {
        if (event.storageArea !== localStorage) return;
        const current = parseProgress(localStorage.getItem(STORAGE_KEY));
        progressRef.current = current;
        setProgress(current);
        setStorageError(false);
      } catch { storageFailed.current = true; setStorageError(true); }
    }
    window.addEventListener("storage", syncProgress);
    function readHash() {
      const id = window.location.hash.slice(1);
      setSelectedId(/^L[1-9]\d*$/.test(id) ? id : null);
      setNotice(id && !/^L[1-9]\d*$/.test(id) ? "공유한 장소 주소를 확인해 주세요." : "");
    }
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => {
      window.removeEventListener("storage", syncProgress);
      window.removeEventListener("hashchange", readHash);
    };
  }, []);

  const favorites = useMemo(() => new Set(progress.favorites), [progress.favorites]);
  const visited = useMemo(() => new Set(progress.visited), [progress.visited]);
  const selected = places?.find(place => place.id === selectedId) ?? null;
  const filtered = useMemo(() => filterLandmarks(places ?? [], deferredQuery, "all")
    .filter(place => !hidden.has(place.category) && !(hideVisited && visited.has(place.id)))
    .filter(place => savedFilter === "all" || (savedFilter === "favorites" ? favorites : visited).has(place.id))
    .sort((a, b) => Number(a.name.startsWith("이름 미확인")) - Number(b.name.startsWith("이름 미확인")) || a.name.localeCompare(b.name, "ko-KR")),
  [places, deferredQuery, hidden, hideVisited, savedFilter, favorites, visited]);
  const counts = useMemo(() => {
    const result = new Map<Category, { total: number; visited: number }>();
    for (const place of places ?? []) {
      const count = result.get(place.category) ?? { total: 0, visited: 0 };
      count.total++;
      if (visited.has(place.id)) count.visited++;
      result.set(place.category, count);
    }
    return result;
  }, [places, visited]);
  const categories = (Object.keys(CATEGORIES) as Category[]).filter(key => counts.has(key));
  const toggleCategory = (key: Category) => changeFilters(() => setHidden(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }));
  const savedCount = (set: Set<string>) => (places ?? []).filter(place => set.has(place.id)).length;

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setNotice("");
    window.location.hash = id ?? "";
  }, []);
  function changeFilters(change: () => void) {
    change(); setLimit(60); if (selectedId) select(null);
  }
  function toggleSaved(key: "favorites" | "visited", id: string) {
    const applyToggle = () => {
      let current = progressRef.current;
      if (!storageFailed.current) {
        try { current = parseProgress(localStorage.getItem(STORAGE_KEY)); }
        catch { storageFailed.current = true; setStorageError(true); }
      }
      const ids = current[key];
      const next = { ...current, [key]: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id] };
      progressRef.current = next;
      setProgress(next);
      if (!storageFailed.current) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
        catch { storageFailed.current = true; setStorageError(true); }
      }
    }
    if (navigator.locks) {
      let applied = false;
      void navigator.locks.request(STORAGE_KEY, () => { applied = true; applyToggle(); }).catch(() => {
        if (!applied) applyToggle();
      });
    } else applyToggle();
  }
  async function share() {
    if (!selected) return;
    const url = new URL(window.location.href);
    url.hash = selected.id;
    try { await navigator.clipboard.writeText(url.toString()); setNotice("장소 링크를 복사했습니다."); }
    catch { setNotice(`주소창의 링크를 복사해 공유해 주세요. 장소: ${selected.id}`); }
  }

  return <>
    <div className={`flex min-h-0 flex-1 flex-col bg-zinc-900 lg:flex-row ${styles.explorer}`}>
      <section aria-label="레오니다 지도" className={`relative min-h-[200px] flex-1 overflow-hidden lg:order-2 lg:m-3 lg:min-w-0 lg:rounded-xl lg:border lg:border-white/10 ${styles.mapPanel}`}>
        <GtaMap places={filtered} selected={selected} visited={visited} onSelect={select} />
      </section>
      <aside aria-label="장소 탐색" data-expanded={panelOpen} className={`flex min-h-0 shrink-0 flex-col border-t border-white/10 bg-zinc-950 lg:order-1 lg:w-[340px] lg:border-r lg:border-t-0 xl:w-[360px] ${styles.panel} ${styles.listPanel}`}>
        <button type="button" aria-expanded={panelOpen} aria-controls={selected ? "gta6-results" : "gta6-filters gta6-results"}
          aria-label={selected ? `${selected.name} 상세 정보` : undefined}
          onClick={() => setPanelOpen(open => !open)}
          className="flex min-h-11 w-full shrink-0 items-center gap-2 px-4 text-left text-sm font-semibold text-zinc-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-300 lg:hidden">
          {selected ? <MapPin size={17} aria-hidden className="shrink-0 text-amber-300" /> : <Search size={17} aria-hidden className="shrink-0 text-amber-300" />}
          <span className="min-w-0 flex-1 truncate">{selected?.name ?? "장소 검색·필터"}</span>
          {!selected && places && <span className="shrink-0 text-xs font-medium tabular-nums text-zinc-400">{filtered.length.toLocaleString("ko-KR")}곳</span>}
          <ChevronDown size={17} aria-hidden className={`shrink-0 text-zinc-400 ${panelOpen ? "" : "rotate-180"}`} />
        </button>
        {!selected && <div id="gta6-filters" className={`shrink-0 px-4 pb-3 pt-4 ${styles.panelContent}`}>
          <div className="sr-only lg:not-sr-only lg:mb-4 lg:flex lg:items-center lg:justify-between lg:gap-3">
            <h1 className="text-xl font-bold tracking-tight text-white">GTA6 지도</h1>
            {places && <span className="text-xs tabular-nums text-zinc-400">{places.length.toLocaleString("ko-KR")}개 장소</span>}
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
          <div className="mt-2 flex gap-2 whitespace-nowrap">
            <button type="button" aria-label="즐겨찾기만 보기" aria-pressed={savedFilter === "favorites"}
              className={`${button} flex-1 ${savedFilter === "favorites" ? "bg-amber-300 text-zinc-950" : "bg-zinc-900 text-zinc-300"}`}
              onClick={() => changeFilters(() => setSavedFilter(savedFilter === "favorites" ? "all" : "favorites"))}>
              <Star size={16} aria-hidden /><span className="hidden lg:inline">즐겨찾기</span><span className="tabular-nums">{savedCount(favorites)}</span>
            </button>
            <button type="button" aria-label="방문한 장소만 보기" aria-pressed={savedFilter === "visited"}
              className={`${button} flex-1 ${savedFilter === "visited" ? "bg-emerald-200 text-zinc-950" : "bg-zinc-900 text-zinc-300"}`}
              onClick={() => changeFilters(() => setSavedFilter(savedFilter === "visited" ? "all" : "visited"))}>
              <CheckCheck size={17} aria-hidden /><span className="hidden lg:inline">방문</span><span className="tabular-nums">{savedCount(visited)}</span>
            </button>
            <button type="button" aria-pressed={hideVisited}
              className={`${button} flex-1 ${hideVisited ? "bg-zinc-200 text-zinc-950" : "bg-zinc-900 text-zinc-300"}`}
              onClick={() => changeFilters(() => setHideVisited(value => !value))}>
              <EyeOff size={16} aria-hidden />방문 숨김
            </button>
          </div>
          {places && <div className="mt-2 lg:mt-3">
            <div className="sr-only lg:not-sr-only lg:flex lg:items-center lg:justify-between lg:gap-2">
              <h2 id="gta6-category-title" className="text-xs font-semibold text-zinc-300">장소 분류</h2>
              <div className="hidden text-xs font-semibold text-amber-300 lg:flex">
                <button type="button" disabled={hidden.size === 0} className="min-h-11 rounded px-2 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:text-zinc-500 lg:min-h-8"
                  onClick={() => changeFilters(() => setHidden(new Set()))}>모두 켜기</button>
                <button type="button" disabled={hidden.size === categories.length} className="-mr-2 min-h-11 rounded px-2 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:text-zinc-500 lg:min-h-8"
                  onClick={() => changeFilters(() => setHidden(new Set(categories)))}>모두 끄기</button>
              </div>
            </div>
            <div role="group" aria-labelledby="gta6-category-title" className={`-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-2 lg:overflow-visible lg:px-0 ${styles.panel}`}>
              <button type="button" aria-pressed={hidden.size === 0} className={`${styles.categoryButton} lg:hidden`}
                onClick={() => changeFilters(() => setHidden(hidden.size === 0 ? new Set(categories) : new Set()))}>전체</button>
              {categories.map(key => {
                const { total, visited: done } = counts.get(key)!;
                return <button key={key} type="button" aria-pressed={!hidden.has(key)} onClick={() => toggleCategory(key)}
                  aria-label={`${CATEGORIES[key].label} ${total}곳 중 ${done}곳 방문`} className={styles.categoryButton}>
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORIES[key].color }} />
                  <span className="whitespace-nowrap">{CATEGORIES[key].label}</span>
                  <span aria-hidden className="ml-auto whitespace-nowrap tabular-nums text-zinc-400">{done > 0 && <span className="text-emerald-200">{done}/</span>}{total.toLocaleString("ko-KR")}</span>
                  {done > 0 && <span aria-hidden className={styles.categoryProgress} style={{ width: `${(done / total) * 100}%` }} />}
                </button>;
              })}
            </div>
          </div>}
        </div>}

        <div id="gta6-results" ref={panel} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/10 ${styles.panel} ${styles.panelContent}`} aria-busy={!places && !loadError}>
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
              {selected.originalName && selected.originalName !== selected.name && <p lang="en" className="mt-1 break-words text-xs leading-relaxed text-zinc-400">{selected.originalName}</p>}
              <p className="mt-2 break-words text-sm leading-relaxed text-zinc-300">{selected.displayAddress}</p>
              {selected.displayAddress !== selected.address && <details className="mt-2 text-xs leading-relaxed text-zinc-400">
                <summary className="min-h-11 w-fit cursor-pointer rounded py-3 focus-visible:outline-2 focus-visible:outline-amber-300">원문 주소</summary>
                <p lang="en" className="break-words">{selected.address}</p>
              </details>}
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
                {(query || hidden.size > 0 || hideVisited || savedFilter !== "all") && <button type="button" className="min-h-11 rounded px-2 font-semibold text-amber-300 focus-visible:outline-2 focus-visible:outline-amber-300" onClick={() => changeFilters(() => { setQuery(""); setHidden(new Set()); setHideVisited(false); setSavedFilter("all"); })}>필터 초기화</button>}
              </div>
              {filtered.length === 0 ? <div className="px-4 pb-6 pt-3 text-sm leading-relaxed text-zinc-300">
                {hidden.size === categories.length ? "켜진 분류가 없습니다. 위에서 보고 싶은 분류를 켜 주세요." : savedFilter === "favorites" ? "즐겨찾기한 장소가 없습니다. 장소를 선택하고 별을 눌러 보세요." : savedFilter === "visited" ? "방문 체크한 장소가 없습니다." : "일치하는 장소가 없습니다. 다른 이름이나 지역으로 검색해 보세요."}
              </div> : <ul aria-label="검색된 장소">
                {filtered.slice(0, limit).map(place => <li key={place.id} className="border-t border-white/5">
                  <button type="button" onClick={() => select(place.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-300">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-900" style={{ color: CATEGORIES[place.category].color }}><MapPin size={16} aria-hidden /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{place.name}</span><span className="mt-1 block truncate text-xs text-zinc-400">{place.id} · {CATEGORIES[place.category].label} · {place.displayAddress.replace(/^[^,]*,?\s*/, "")}</span></span>
                    {favorites.has(place.id) && <Star size={13} className="shrink-0 text-amber-300" aria-label="즐겨찾기" fill="currentColor" />}
                    {visited.has(place.id) && <Check size={15} className="shrink-0 text-emerald-200" aria-label="방문 완료" />}
                    <ChevronRight size={15} aria-hidden className="shrink-0 text-zinc-500" />
                  </button>
                </li>)}
              </ul>}
              {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 60)} className={`${button} m-4 border border-zinc-700 text-zinc-200`}>장소 더 보기 ({Math.min(limit, filtered.length)}/{filtered.length})</button>}
            </>}
          {!selected && <section aria-labelledby="gta6-about" className="border-t border-white/10 px-4 py-5 text-xs leading-relaxed text-zinc-400">
            <h2 id="gta6-about" className="text-sm font-semibold text-zinc-200">GTA6 지도 소개</h2>
            <p className="mt-2">GTA VI의 무대인 레오니다 주를 한국어로 검색하는 커뮤니티 지도입니다. {MAP_REGIONS.map(region => region.name).join(", ")} 등 주요 지역과 장소 {manifest.locatedCount.toLocaleString("ko-KR")}곳의 추정 위치를 지도에서 찾고, 즐겨찾기와 방문 체크로 기록할 수 있습니다.</p>
            <p className="mt-2">위치는 GTADB 커뮤니티 자료를 바탕으로 한 추정이며, 데이터가 갱신되면 반영합니다. 미션 공략과 팁은 <Link href="/gta6/guides" className="font-semibold text-amber-300 underline underline-offset-2">GTA6 공략 게시판</Link>에서 나눌 수 있습니다.</p>
          </section>}
        </div>
      </aside>
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-zinc-950 px-4 text-[10px] leading-relaxed text-zinc-400">
      <p className="min-w-0 py-2">
        <span className="text-zinc-300">비공식 팬 지도 · 장소는 커뮤니티 추정</span>{" · "}
        <a href={manifest.source} target="_blank" rel="noreferrer" className="underline underline-offset-2">장소 데이터 GTADB 및 기여자</a>{" · "}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className="underline underline-offset-2">{manifest.license}</a>
        {" · "}자료 {manifest.importedAt}
      </p>
      <Link href="/gta6/sources" className="inline-flex min-h-11 shrink-0 items-center rounded px-1 text-xs font-semibold text-amber-300 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-300">
        출처 및 권리 문의
      </Link>
    </footer>
  </>;
}
