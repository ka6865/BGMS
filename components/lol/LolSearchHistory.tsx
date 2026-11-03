import type { LolSearchHistory as History } from "@/lib/lol/searchHistory";

export default function LolSearchHistory({ history, currentRiotId, onSearch, onRemove, onClear, onToggleFavorite }: {
  history: History;
  currentRiotId: string;
  onSearch: (riotId: string) => void;
  onRemove: (riotId: string) => void;
  onClear: () => void;
  onToggleFavorite: (riotId: string) => void;
}) {
  const isFavorite = !!currentRiotId && history.favorites.some(id => id.toLocaleLowerCase() === currentRiotId.toLocaleLowerCase());
  return (
    <section aria-label="검색 기록" className="mt-4 space-y-3 text-sm">
      <p className="text-xs text-zinc-500">검색 기록과 즐겨찾기는 이 브라우저에 저장됩니다.</p>
      {currentRiotId && <button type="button" onClick={() => onToggleFavorite(currentRiotId)} className="min-h-11 rounded-lg border border-zinc-700 px-3 font-semibold text-zinc-200 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400">
        {isFavorite ? "즐겨찾기 해제" : "현재 계정 즐겨찾기"}
      </button>}
      {history.favorites.length > 0 && <div>
        <h2 className="mb-1 text-xs font-semibold text-zinc-400">즐겨찾기</h2>
        <ul className="flex flex-wrap gap-2">{history.favorites.map(id => <li key={id} className="flex max-w-full items-center gap-1 rounded-lg border border-zinc-800 px-2">
          <button type="button" onClick={() => onSearch(id)} className="min-h-11 max-w-[16rem] truncate text-left text-amber-200 hover:underline">{id}</button>
          <button type="button" aria-label={`${id} 즐겨찾기 해제`} onClick={() => onToggleFavorite(id)} className="min-h-11 px-2 text-zinc-400 hover:text-white">삭제</button>
        </li>)}</ul>
      </div>}
      {history.recent.length > 0 && <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-xs font-semibold text-zinc-400">최근 검색</h2>
          <button type="button" onClick={onClear} className="min-h-11 px-2 text-xs text-zinc-400 underline underline-offset-4 hover:text-white">최근 기록 비우기</button>
        </div>
        <ul className="flex flex-wrap gap-2">{history.recent.map(id => <li key={id} className="flex max-w-full items-center gap-1 rounded-lg border border-zinc-800 px-2">
          <button type="button" onClick={() => onSearch(id)} className="min-h-11 max-w-[16rem] truncate text-left text-zinc-200 hover:underline">{id}</button>
          <button type="button" aria-label={`${id} 최근 검색에서 삭제`} onClick={() => onRemove(id)} className="min-h-11 px-2 text-zinc-400 hover:text-white">삭제</button>
        </li>)}</ul>
      </div>}
    </section>
  );
}
