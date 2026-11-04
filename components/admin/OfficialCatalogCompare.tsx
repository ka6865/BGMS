"use client";

import { useState } from "react";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";

type Item = OfficialItem & { current: Record<string, unknown> | null };
type Category = { category: string; url: string; items: Item[] };

export default function OfficialCatalogCompare() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fingerprint, setFingerprint] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    setMessage("");
    setFingerprint("");
    try {
      const response = await fetch("/api/admin/weapon-patch/official-catalog", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setCategories(body.categories);
      setFingerprint(body.fingerprint);
    } catch (err) {
      setError(err instanceof Error ? err.message : "공식 도감을 읽지 못했습니다.");
    } finally { setLoading(false); }
  }

  async function publish() {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/weapon-patch/official-catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setMessage("확인한 공식 도감이 공개 도감에 저장되었습니다.");
    } catch (err) { setError(err instanceof Error ? err.message : "저장하지 못했습니다."); }
    finally { setLoading(false); }
  }

  return <section className="rounded-xl border border-[#333] bg-[#1a1a1a] p-5">
    <h4 className="text-lg font-black text-white">공식 도감 확인</h4>
    <p className="mt-1 text-xs text-gray-400">공식 원본과 BGMS 값을 확인합니다. 공식 수치의 단위와 갱신일을 확인한 후 판단하세요. 확인 후 공개할 수 있으며 기존 계산값은 바뀌지 않습니다.</p>
    <button type="button" onClick={load} disabled={loading} className="mt-3 rounded bg-[#252525] px-4 py-2 text-xs font-bold text-gray-200 disabled:opacity-50">{loading ? "불러오는 중…" : "공식 도감 불러오기"}</button>
    {fingerprint && <button type="button" onClick={publish} disabled={loading} className="ml-2 mt-3 rounded bg-[#F2A900] px-4 py-2 text-xs font-bold text-black disabled:opacity-50">확인한 공식 정보 공개</button>}
    {message && <p role="status" className="mt-2 text-sm text-green-300">{message}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    {categories && <div className="mt-3">
      <label className="text-sm text-gray-300">항목 검색 <input value={search} onChange={(event) => setSearch(event.target.value)} className="ml-2 rounded border border-gray-600 bg-[#141414] px-2 py-1 text-white" /></label>
      {categories.map((category) => <div key={category.category} className="mt-4">
        <h5 className="font-bold text-white"><a href={category.url} target="_blank" rel="noreferrer" className="underline">{category.category === "weapons" ? "공식 무기" : "공식 차량"}</a></h5>
        <ul className="mt-2 max-h-96 overflow-y-auto divide-y divide-[#333]">
          {category.items.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())).map((item) => <li key={item.key} className="py-3 text-xs leading-5 text-gray-300">
            <strong className="text-sm text-white">{item.name}</strong> <span>{item.updated}</span>
            <p>공식: {item.ammunition ? `탄약 ${item.ammunition} · ` : ""}{Object.entries(item.specs).map(([key, value]) => `${key} ${value}`).join(" · ") || "상세 정보 없음"}</p>
            <details className="mt-1"><summary className="cursor-pointer text-amber-300">공식 원본 전체 보기</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(item.official, null, 2)}</pre></details>
            <p>BGMS: {item.current ? Object.entries(item.current).filter(([key]) => !["id", "name"].includes(key)).map(([key, value]) => `${key}: ${value ?? "없음"}`).join(" · ") : "이름이 일치하는 항목 없음 또는 중복"}</p>
          </li>)}
        </ul>
      </div>)}
    </div>}
  </section>;
}
