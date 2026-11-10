"use client";

import { useEffect, useState, type SyntheticEvent } from "react";
import { Pencil, Plus, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import type { LolChampion } from "@/lib/lol/champions";
import { LOL_AUGMENT_RARITIES, LOL_AUGMENT_RARITY_LABELS, filterLolMayhemAugments, type LolAugmentRarity, type LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import { MAYHEM_TIP_LIMITS, type MayhemTip, type MayhemTipItem, type MayhemTipSort } from "@/lib/lol/mayhemTips";
import { AugmentIcon, ChampionPicker } from "./LolMayhemArchive";
import { ChampionPortrait } from "./LolMayhemChampionStats";

const control = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const rarityTab: Record<LolAugmentRarity, string> = { silver: "data-[on=true]:border-zinc-300 data-[on=true]:text-zinc-100", gold: "data-[on=true]:border-amber-400 data-[on=true]:text-amber-300", prismatic: "data-[on=true]:border-fuchsia-400 data-[on=true]:text-fuchsia-300" };

function ItemIcon({ item, version, size }: { item: MayhemTipItem; version: string | null; size: number }) {
  return version ? <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${item.image}`} alt="" width={size} height={size} loading="lazy" decoding="async" className="shrink-0 rounded-md border border-zinc-700 bg-zinc-950" style={{ width: size, height: size }} />
    : <span aria-hidden="true" className="shrink-0 rounded-md bg-zinc-800" style={{ width: size, height: size }} />;
}

const toggle = (list: number[], id: number, max: number) => list.includes(id) ? list.filter(value => value !== id) : list.length < max ? [...list, id] : list;

function TipForm({ champions, version, catalog, items, initial = null, onSaved, onCancel }: {
  champions: LolChampion[]; version: string | null; catalog: LolMayhemCatalog; items: MayhemTipItem[]; initial?: MayhemTip | null; onSaved: (tip: MayhemTip) => void; onCancel: () => void;
}) {
  const [championId, setChampionId] = useState(initial?.championId ? String(initial.championId) : "");
  const [rarity, setRarity] = useState<LolAugmentRarity>("silver");
  const [augmentQuery, setAugmentQuery] = useState("");
  const [augmentIds, setAugmentIds] = useState<number[]>(initial?.augmentIds ?? []);
  const [itemQuery, setItemQuery] = useState("");
  const [itemIds, setItemIds] = useState<number[]>(initial?.itemIds ?? []);
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [usage, setUsage] = useState(initial?.usage ?? "");
  const [anonymous, setAnonymous] = useState(initial?.anonymous ?? false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const augmentMap = new Map(catalog.augments.map(a => [a.id, a]));
  const itemMap = new Map(items.map(i => [i.id, i]));
  const augmentChoices = filterLolMayhemAugments(catalog.augments, augmentQuery, augmentQuery.trim() ? null : rarity, false);
  const itemNeedle = itemQuery.replace(/\s+/g, "");
  const itemChoices = items.filter(item => !itemNeedle || item.name.replace(/\s+/g, "").includes(itemNeedle));

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!augmentIds.length || summary.trim().length < 2) { setError("증강을 1개 이상 고르고 한줄평을 2자 이상 적어 주세요."); return; }
    setSending(true); setError("");
    try {
      const response = await fetch("/api/lol/mayhem/tips", { method: initial ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(initial ? { id: initial.id } : {}), championId: championId ? Number(championId) : null, augmentIds, itemIds, summary, usage, anonymous }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.tip) throw new Error(typeof body.error === "string" ? body.error : "제보하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      onSaved(body.tip);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "제보하지 못했습니다."); }
    finally { setSending(false); }
  }

  return <form aria-label={initial ? "조합 제보 수정" : "조합 제보"} onSubmit={submit} className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 sm:p-5">
    <ChampionPicker id={initial ? `tip-champion-${initial.id}` : "tip-champion"} label="챔피언 (선택)" emptyLabel="공용 조합 (챔피언 무관)" champions={champions} version={version} value={championId} onChange={setChampionId} />

    <fieldset className="space-y-3">
      <legend className="text-sm">증강 <span className="text-zinc-400">{augmentIds.length}/{MAYHEM_TIP_LIMITS.augments}</span></legend>
      {augmentIds.length > 0 && <ol aria-label="고른 증강" className="flex flex-wrap gap-1.5">{augmentIds.map(id => { const a = augmentMap.get(id); return <li key={id}>
        <button type="button" aria-label={`${a?.name ?? id} 빼기`} onClick={() => setAugmentIds(list => list.filter(value => value !== id))} className="flex min-h-11 items-center gap-2 rounded-lg bg-zinc-950/60 py-1 pl-1 pr-2 text-[13px] hover:bg-zinc-800">
          <AugmentIcon icon={a?.icon} patch={catalog.clientPatch} rarity={a?.rarity} size={28} />{a?.name}<X aria-hidden="true" size={14} className="text-zinc-400" />
        </button></li>; })}</ol>}
      <div role="group" aria-label="증강 등급" className="grid grid-cols-3 gap-2">
        {[...LOL_AUGMENT_RARITIES].reverse().map(value => <button key={value} type="button" data-on={rarity === value && !augmentQuery.trim()} aria-pressed={rarity === value && !augmentQuery.trim()} onClick={() => { setRarity(value); setAugmentQuery(""); }} className={`${control} ${rarityTab[value]}`}>{LOL_AUGMENT_RARITY_LABELS[value]}</button>)}
      </div>
      <input type="search" aria-label="제보 증강 검색" placeholder="증강 이름이나 효과로 찾기 (전체 등급)" value={augmentQuery} onChange={event => setAugmentQuery(event.target.value)} className={input} />
      <div role="group" aria-label="증강 목록" className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1 overflow-y-auto overscroll-contain rounded-lg border border-zinc-800 p-1.5">
        {augmentChoices.map(a => <button key={a.id} type="button" aria-pressed={augmentIds.includes(a.id)} title={a.text} onClick={() => setAugmentIds(list => toggle(list, a.id, MAYHEM_TIP_LIMITS.augments))}
          className={`flex flex-col items-center gap-1 rounded-lg p-1.5 text-center text-[11px] leading-4 ${augmentIds.includes(a.id) ? "bg-amber-400/15 text-amber-200 ring-1 ring-amber-400" : "text-zinc-300 hover:bg-zinc-800"}`}>
          <AugmentIcon icon={a.icon} patch={catalog.clientPatch} rarity={a.rarity} size={40} /><span className="line-clamp-2">{a.name}</span>
        </button>)}
        {!augmentChoices.length && <p className="col-span-full py-6 text-center text-sm text-zinc-400">일치하는 증강이 없습니다.</p>}
      </div>
    </fieldset>

    <fieldset className="space-y-3">
      <legend className="text-sm">아이템 (선택) <span className="text-zinc-400">{itemIds.length}/{MAYHEM_TIP_LIMITS.items}</span></legend>
      {itemIds.length > 0 && <ol aria-label="고른 아이템" className="flex flex-wrap items-center gap-1.5">{itemIds.map((id, index) => { const item = itemMap.get(id); return <li key={id} className="flex items-center gap-1.5">
        {index > 0 && <span aria-hidden="true" className="text-zinc-500">→</span>}
        <button type="button" aria-label={`${item?.name ?? id} 빼기`} onClick={() => setItemIds(list => list.filter(value => value !== id))} className="flex min-h-11 items-center gap-2 rounded-lg bg-zinc-950/60 py-1 pl-1 pr-2 text-[13px] hover:bg-zinc-800">
          {item && <ItemIcon item={item} version={version} size={28} />}{item?.name}<X aria-hidden="true" size={14} className="text-zinc-400" />
        </button></li>; })}</ol>}
      <input type="search" aria-label="제보 아이템 검색" placeholder="아이템 이름으로 찾기 · 고른 순서가 구매 순서" value={itemQuery} onChange={event => setItemQuery(event.target.value)} className={input} />
      <div role="group" aria-label="아이템 목록" className="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1 overflow-y-auto overscroll-contain rounded-lg border border-zinc-800 p-1.5">
        {itemChoices.map(item => <button key={item.id} type="button" aria-pressed={itemIds.includes(item.id)} onClick={() => setItemIds(list => toggle(list, item.id, MAYHEM_TIP_LIMITS.items))}
          className={`flex flex-col items-center gap-1 rounded-lg p-1.5 text-center text-[11px] leading-4 ${itemIds.includes(item.id) ? "bg-amber-400/15 text-amber-200 ring-1 ring-amber-400" : "text-zinc-300 hover:bg-zinc-800"}`}>
          <ItemIcon item={item} version={version} size={36} /><span className="line-clamp-2">{item.name}</span>
        </button>)}
        {!itemChoices.length && <p className="col-span-full py-6 text-center text-sm text-zinc-400">{items.length ? "일치하는 아이템이 없습니다." : "아이템 목록을 불러오지 못했습니다."}</p>}
      </div>
    </fieldset>

    <label className="block space-y-2 text-sm"><span className="flex justify-between"><span>한줄평</span><span className="tabular-nums text-zinc-400">{summary.length}/{MAYHEM_TIP_LIMITS.summary}</span></span>
      <input required maxLength={MAYHEM_TIP_LIMITS.summary} value={summary} onChange={event => setSummary(event.target.value)} placeholder="예: 스킬 가속 몰빵하면 궁이 계속 돌아요" className={input} />
    </label>
    <label className="block space-y-2 text-sm"><span className="flex justify-between"><span>활용법 (선택)</span><span className="tabular-nums text-zinc-400">{usage.length}/{MAYHEM_TIP_LIMITS.usage}</span></span>
      <textarea maxLength={MAYHEM_TIP_LIMITS.usage} rows={4} value={usage} onChange={event => setUsage(event.target.value)} placeholder="어떤 순서로 고르고, 어떤 상황에서 강한지 적어 주세요." className={`${input} py-2.5 leading-6`} />
    </label>
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 text-sm">
      <span><span className="font-semibold">익명으로 제보</span><span className="ml-2 text-xs text-zinc-400">{anonymous ? "작성자가 \"익명\"으로 보입니다" : "닉네임이 함께 보입니다"}</span></span>
      <input type="checkbox" role="switch" aria-label="익명으로 제보" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} className="peer sr-only" />
      <span aria-hidden="true" className="relative h-6 w-11 shrink-0 rounded-full bg-zinc-700 transition peer-checked:bg-amber-400 peer-focus-visible:outline-2 peer-focus-visible:outline-amber-400 after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5" />
    </label>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={sending} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-amber-400 px-4 text-sm font-bold text-zinc-950 hover:bg-amber-300 disabled:opacity-50 sm:flex-none">{sending ? "저장하는 중" : initial ? "수정 저장" : "조합 제보하기"}</button>
      <button type="button" onClick={onCancel} className={control}>취소</button>
    </div>
  </form>;
}

function TipCard({ tip, champion, version, catalog, augmentMap, itemMap, signedIn, onVote, onEdit, onDelete }: {
  tip: MayhemTip; champion: LolChampion | undefined; version: string | null; catalog: LolMayhemCatalog; augmentMap: Map<number, LolMayhemCatalog["augments"][number]>; itemMap: Map<number, MayhemTipItem>;
  signedIn: boolean; onVote: (value: -1 | 0 | 1) => Promise<string | null>; onEdit: () => void; onDelete: () => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const run = async (action: () => Promise<string | null>) => { setBusy(true); setMessage((await action()) ?? ""); setBusy(false); };
  const vote = (value: 1 | -1) => run(() => onVote(tip.myVote === value ? 0 : value));
  const voteButton = (value: 1 | -1) => {
    const on = tip.myVote === value, Icon = value === 1 ? ThumbsUp : ThumbsDown, label = value === 1 ? "추천" : "비추천";
    return <button type="button" aria-pressed={on} aria-label={`${label} ${value === 1 ? tip.up : tip.down}`} disabled={busy || tip.mine || !signedIn} title={tip.mine ? "본인 제보에는 투표할 수 없습니다" : !signedIn ? "로그인 후 투표할 수 있습니다" : label}
      onClick={() => vote(value)} className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs tabular-nums disabled:cursor-not-allowed ${on ? value === 1 ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:hover:bg-transparent disabled:hover:text-zinc-400"}`}>
      <Icon aria-hidden="true" size={15} />{value === 1 ? tip.up : tip.down}
    </button>;
  };
  return <li className="flex min-w-0 flex-col gap-2.5 break-words rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
    <div className="flex items-center gap-2.5">
      {champion ? <ChampionPortrait champion={champion} version={version} size={36} /> : <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-[11px] font-bold text-zinc-300">공용</span>}
      <div className="min-w-0 flex-1"><strong className="block">{tip.summary}</strong>
        <span className="text-xs text-zinc-400">{champion?.name ?? "공용 조합"} · {tip.anonymous ? "익명" : tip.author ?? "BGMS 유저"}{tip.mine && <span className="ml-1 text-amber-300">(내 제보)</span>} · {new Date(tip.createdAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}{tip.updatedAt && " · 수정됨"}</span>
      </div>
    </div>
    <ol aria-label="제보 증강" className="flex flex-wrap items-center gap-1.5">{tip.augmentIds.map((id, index) => { const a = augmentMap.get(id); return <li key={id} className="flex items-center gap-1.5">
      {index > 0 && <Plus aria-hidden="true" size={12} className="text-zinc-500" />}
      <span className="flex items-center gap-2 rounded-lg bg-zinc-950/60 py-1 pl-1 pr-2.5 text-[13px]"><AugmentIcon icon={a?.icon} patch={catalog.clientPatch} rarity={a?.rarity} size={28} />{a?.name ?? `증강 ${id}`}</span>
    </li>; })}</ol>
    {tip.itemIds.length > 0 && <ol aria-label="제보 아이템" className="flex flex-wrap items-center gap-1">{tip.itemIds.map((id, index) => { const item = itemMap.get(id); return <li key={id} className="flex items-center gap-1">
      {index > 0 && <span aria-hidden="true" className="text-xs text-zinc-500">→</span>}
      {item ? <span className="flex items-center gap-1.5 rounded-lg bg-zinc-950/60 py-1 pl-1 pr-2 text-xs text-zinc-200"><ItemIcon item={item} version={version} size={24} />{item.name}</span> : <span className="text-xs text-zinc-400">아이템 {id}</span>}
    </li>; })}</ol>}
    {tip.usage && <p className="whitespace-pre-line text-[13px] leading-6 text-zinc-300">{tip.usage}</p>}
    <div className="-mb-1 flex flex-wrap items-center gap-1 border-t border-zinc-800 pt-1">
      {voteButton(1)}{voteButton(-1)}
      {tip.mine && <div className="ml-auto flex items-center gap-1">
        {confirming ? <>
          <span className="text-xs text-zinc-300">정말 지울까요?</span>
          <button type="button" disabled={busy} onClick={() => run(onDelete)} className="inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-semibold text-red-300 hover:bg-red-400/10">삭제</button>
          <button type="button" onClick={() => setConfirming(false)} className="inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs text-zinc-400 hover:bg-zinc-800">취소</button>
        </> : <>
          <button type="button" onClick={onEdit} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white"><Pencil aria-hidden="true" size={13} />수정</button>
          <button type="button" onClick={() => setConfirming(true)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-300"><Trash2 aria-hidden="true" size={13} />지우기</button>
        </>}
      </div>}
    </div>
    {message && <p role="alert" className="text-xs text-red-300">{message}</p>}
  </li>;
}

const send = async (url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> => {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: response.ok, body: await response.json().catch(() => ({})) };
};
const errorText = (body: Record<string, unknown>, fallback: string) => typeof body.error === "string" ? body.error : fallback;

export default function LolMayhemTips({ champions, championVersion = null, catalog, items }: { champions: LolChampion[]; championVersion?: string | null; catalog: LolMayhemCatalog; items: MayhemTipItem[] }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<MayhemTipSort>("recent");
  const [tips, setTips] = useState<MayhemTip[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const championMap = new Map(champions.map(c => [c.id, c]));
  const augmentMap = new Map(catalog.augments.map(a => [a.id, a]));
  const itemMap = new Map(items.map(i => [i.id, i]));
  const replace = (tip: MayhemTip) => setTips(list => list.map(row => row.id === tip.id ? tip : row));
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false);
    const params = new URLSearchParams({ sort, offset: String(offset) });
    if (filter) params.set("champion", filter);
    fetch(`/api/lol/mayhem/tips?${params}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.rows)) throw new Error();
      setTips(list => offset ? [...list, ...body.rows] : body.rows); setTotal(body.total); setSignedIn(body.signedIn === true);
    }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, sort, offset, retry]);

  const form = (initial: MayhemTip | null) => <TipForm champions={champions} version={championVersion} catalog={catalog} items={items} initial={initial}
    onCancel={() => initial ? setEditing(null) : setWriting(false)}
    onSaved={tip => { if (initial) { replace(tip); setEditing(null); } else { setWriting(false); setTips(list => [tip, ...list]); setTotal(value => value + 1); } }} />;

  return <section aria-label="유저 조합 제보" className="space-y-4 py-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-lg font-semibold">유저 조합 제보</h2><p className="mt-1 text-sm text-zinc-400">직접 써 본 증강 조합과 아이템, 활용법을 공유해 주세요. 패치 {catalog.displayPatch} 기준으로 모입니다.</p></div>
      {!writing && <button type="button" onClick={() => setWriting(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-amber-400 px-4 text-sm font-bold text-zinc-950 hover:bg-amber-300"><Plus aria-hidden="true" size={16} />조합 제보하기</button>}
    </header>
    {writing && (signedIn === null ? <p role="status" className="text-sm text-zinc-400">로그인 상태를 확인하는 중입니다.</p>
      : signedIn ? form(null)
      : <p className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm text-zinc-300">조합 제보는 로그인 후 할 수 있습니다. <a href="/login" className="ml-1 inline-flex min-h-11 items-center font-semibold text-amber-300 underline underline-offset-4">로그인하기</a></p>)}

    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1 sm:max-w-sm"><ChampionPicker id="tip-filter" label="보기" emptyLabel="모든 제보" extra={[{ value: "common", label: "공용 조합만" }]} champions={champions} version={championVersion} value={filter} onChange={value => { setFilter(value); setOffset(0); }} /></div>
      <div role="group" aria-label="정렬" className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1">
        {(["recent", "top"] as const).map(value => <button key={value} type="button" aria-pressed={sort === value} onClick={() => { setSort(value); setOffset(0); }} className={`min-h-11 rounded-lg px-3 text-sm font-semibold ${sort === value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}>{value === "recent" ? "최신순" : "추천순"}</button>)}
      </div>
    </div>
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-red-300">제보를 불러오지 못했습니다.</p><button type="button" className={control} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {!loading && !error && !tips.length && <p role="status" className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-400">아직 제보가 없습니다. 첫 조합을 제보해 주세요.</p>}
    <ul aria-label="유저 조합 목록" className="grid gap-2 md:grid-cols-2">{tips.map(tip => editing === tip.id ? <li key={tip.id} className="md:col-span-2">{form(tip)}</li>
      : <TipCard key={tip.id} tip={tip} champion={tip.championId ? championMap.get(tip.championId) : undefined} version={championVersion} catalog={catalog} augmentMap={augmentMap} itemMap={itemMap} signedIn={signedIn === true}
        onEdit={() => setEditing(tip.id)}
        onVote={async value => {
          const result = await send("/api/lol/mayhem/tips/vote", "POST", { id: tip.id, value });
          if (!result.ok) return errorText(result.body, "투표하지 못했습니다.");
          replace({ ...tip, up: Number(result.body.up), down: Number(result.body.down), myVote: value }); return null;
        }}
        onDelete={async () => {
          const result = await send(`/api/lol/mayhem/tips?id=${tip.id}`, "DELETE");
          if (!result.ok) return errorText(result.body, "지우지 못했습니다.");
          setTips(list => list.filter(row => row.id !== tip.id)); setTotal(value => value - 1); return null;
        }} />)}</ul>
    {loading && <p role="status" className="text-sm text-zinc-400">제보를 불러오는 중입니다.</p>}
    {!loading && tips.length < total && <button type="button" className={control} onClick={() => setOffset(tips.length)}>제보 더 보기</button>}
  </section>;
}
