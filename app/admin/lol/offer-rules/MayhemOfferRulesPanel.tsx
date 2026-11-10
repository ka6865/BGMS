"use client";

import { useEffect, useState } from "react";
import type { LolAugmentRarity } from "@/lib/lol/augments/catalog";
import type { MayhemOfferRuleAdmin, MayhemOfferRuleInput } from "@/lib/lol/mayhemOfferRules";

type Augment = { id: number; name: string; rarity: LolAugmentRarity };
type Draft = MayhemOfferRuleInput & { id: number | null };
const STATUS_LABEL = { candidate: "후보", active: "게시", rejected: "거절" } as const;
const control = "min-h-11 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100";
const button = "inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 disabled:opacity-40";
const blank: Draft = { id: null, augmentId: null, kind: "condition", text: "", patch: null, verified: false, status: "active", sourceUrl: null };
const toDraft = (rule: MayhemOfferRuleAdmin): Draft => ({ id: rule.id, augmentId: rule.augmentId, kind: rule.kind, text: rule.text, patch: rule.patch, verified: rule.verified, status: rule.status, sourceUrl: rule.sourceUrl });

function RuleForm({ draft, augments, quote, onSaved, onDeleted }: { draft: Draft; augments: Augment[]; quote: string | null; onSaved: () => void; onDeleted: () => void }) {
  const [value, setValue] = useState(draft);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, next: Draft[K]) => setValue(current => ({ ...current, [key]: next }));
  async function send(method: "POST" | "DELETE") {
    setBusy(true); setMessage("");
    const response = await fetch(method === "POST" ? "/api/admin/lol/offer-rules" : `/api/admin/lol/offer-rules?id=${value.id}`, {
      method, headers: method === "POST" ? { "Content-Type": "application/json" } : undefined, body: method === "POST" ? JSON.stringify(value) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setMessage(typeof body.error === "string" ? body.error : "처리하지 못했습니다."); return; }
    if (method === "DELETE") onDeleted(); else onSaved();
  }
  return <form onSubmit={event => { event.preventDefault(); void send("POST"); }} className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm">
    {quote && <blockquote className="border-l-2 border-amber-400/60 pl-3 text-xs leading-5 text-zinc-300">패치노트 원문: {quote}</blockquote>}
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
      <label className="space-y-1"><span className="text-xs text-zinc-400">대상 증강</span>
        <select aria-label="대상 증강" value={value.augmentId ?? ""} onChange={event => set("augmentId", event.target.value ? Number(event.target.value) : null)} className={`${control} w-full`}>
          <option value="">선택 안 함 (후보만 가능)</option>
          {augments.map(augment => <option key={augment.id} value={augment.id}>{augment.name} · {augment.id}</option>)}
        </select>
      </label>
      <label className="space-y-1"><span className="text-xs text-zinc-400">종류</span>
        <select aria-label="종류" value={value.kind} onChange={event => set("kind", event.target.value as Draft["kind"])} className={control}>
          <option value="condition">제시 조건</option><option value="random_excluded">무작위 증강에서 제외</option>
        </select>
      </label>
      <label className="space-y-1"><span className="text-xs text-zinc-400">패치</span>
        <input aria-label="패치" value={value.patch ?? ""} onChange={event => set("patch", event.target.value || null)} placeholder="26.18" className={`${control} w-24`} />
      </label>
      <label className="space-y-1"><span className="text-xs text-zinc-400">상태</span>
        <select aria-label="상태" value={value.status} onChange={event => set("status", event.target.value as Draft["status"])} className={control}>
          {Object.entries(STATUS_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
    </div>
    {value.kind === "condition" && <label className="block space-y-1"><span className="text-xs text-zinc-400">화면 문장</span>
      <input aria-label="화면 문장" maxLength={300} value={value.text} onChange={event => set("text", event.target.value)} placeholder="예: 루난의 허리케인을 가지고 있으면 제시되지 않습니다." className={`${control} w-full`} />
    </label>}
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="space-y-1"><span className="text-xs text-zinc-400">근거 링크 (선택)</span>
        <input aria-label="근거 링크" value={value.sourceUrl ?? ""} onChange={event => set("sourceUrl", event.target.value || null)} placeholder="https://www.leagueoflegends.com/..." className={`${control} w-full`} />
      </label>
      <label className="flex min-h-11 items-center gap-2 self-end"><input type="checkbox" checked={value.verified} onChange={event => set("verified", event.target.checked)} className="size-4 accent-emerald-400" />Riot 원문으로 확인함 (공식 배지)</label>
    </div>
    {message && <p role="alert" className="text-xs text-red-300">{message}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={busy} className={`${button} border-amber-400/60 text-amber-200`}>{value.id === null ? "추가" : "저장"}</button>
      {value.id !== null && <button type="button" disabled={busy} onClick={() => void send("DELETE")} className={`${button} text-red-300`}>삭제</button>}
    </div>
  </form>;
}

export default function MayhemOfferRulesPanel({ augments }: { augments: Augment[] }) {
  const [rules, setRules] = useState<MayhemOfferRuleAdmin[] | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<keyof typeof STATUS_LABEL>("candidate");
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    fetch("/api/admin/lol/offer-rules", { cache: "no-store" }).then(async response => {
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.rules)) throw new Error();
      setRules(body.rules); setError(false);
    }).catch(() => setError(true));
  }, [reload]);
  const refresh = () => { setAdding(false); setReload(value => value + 1); };
  const names = new Map(augments.map(augment => [augment.id, augment.name]));
  const visible = (rules ?? []).filter(rule => rule.status === tab);
  return <main className="mx-auto max-w-4xl space-y-4 px-4 py-6 text-zinc-100">
    <header className="space-y-1">
      <h1 className="text-xl font-bold">증강 등장 조건</h1>
      <p className="text-sm text-zinc-400">증바람 도감의 &quot;등장 조건&quot;에 보이는 정보입니다. 게시하면 바로 반영됩니다. 증강 수집 작업이 새 패치노트에서 조건으로 보이는 문장을 찾으면 후보로 쌓입니다.</p>
    </header>
    <div className="flex flex-wrap items-center gap-2">
      {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map(key => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}
        className={`${button} ${tab === key ? "border-amber-400 bg-amber-400/10 text-amber-300" : ""}`}>{STATUS_LABEL[key]} {(rules ?? []).filter(rule => rule.status === key).length}</button>)}
      <button type="button" onClick={() => setAdding(value => !value)} className={`${button} ml-auto`}>{adding ? "추가 닫기" : "직접 추가"}</button>
    </div>
    {adding && <RuleForm draft={blank} augments={augments} quote={null} onSaved={refresh} onDeleted={refresh} />}
    {error && <p role="alert" className="text-sm text-red-300">등장 조건을 불러오지 못했습니다. <button type="button" onClick={() => setReload(value => value + 1)} className="underline">다시 시도</button></p>}
    {!rules && !error && <p role="status" className="text-sm text-zinc-400">불러오는 중입니다.</p>}
    {rules && !visible.length && <p className="rounded-xl border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-400">{STATUS_LABEL[tab]} 항목이 없습니다.</p>}
    <ul className="space-y-3">{visible.map(rule => <li key={`${rule.id}:${rule.updatedAt ?? rule.createdAt}`} className="space-y-1">
      <p className="text-xs text-zinc-400">#{rule.id} · {rule.augmentId ? names.get(rule.augmentId) ?? `증강 ${rule.augmentId}` : "대상 미지정"} · {new Date(rule.createdAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
      <RuleForm draft={toDraft(rule)} augments={augments} quote={rule.sourceQuote} onSaved={refresh} onDeleted={refresh} />
    </li>)}</ul>
  </main>;
}
