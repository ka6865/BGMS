"use client";

import { useState } from "react";
import OfficialCatalog from "@/components/game-data/OfficialCatalog";
import WeaponMetaDashboard from "@/components/meta/WeaponMetaDashboard";
import WeaponsClient from "./WeaponsClient";

export default function CatalogTabs() {
  const [tab, setTab] = useState<"weapons" | "meta" | "vehicles">("weapons");
  const [simulator, setSimulator] = useState(false);
  return <main className="min-h-screen bg-[#0e0e0e] px-4 py-8 text-white sm:px-6 sm:py-12">
    <div className="mx-auto max-w-7xl">
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">도감</h1>
      <nav aria-label="도감 분류" className="mt-6 flex gap-6 border-b border-zinc-700">
        {([['weapons','무기'],['meta','메타'],['vehicles','탈것']] as const).map(([value,label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`min-h-12 border-b-2 px-1 text-sm font-bold transition-colors ${tab === value ? "border-amber-400 text-amber-400" : "border-transparent text-zinc-400 hover:text-white"}`}>{label}</button>)}
      </nav>
      <div className="mt-7">{tab === "meta" ? <WeaponMetaDashboard /> : <OfficialCatalog key={tab} category={tab} />}</div>
      {tab === "weapons" && <div className="mt-10 border-t border-zinc-700 pt-6"><button type="button" aria-expanded={simulator} onClick={() => setSimulator(!simulator)} className="min-h-11 border border-zinc-600 px-4 text-sm font-bold hover:border-amber-400">{simulator ? "무기 시뮬레이터 닫기" : "무기 스탯 비교·파츠 시뮬레이터 열기"}</button>{simulator && <WeaponsClient />}</div>}
    </div>
  </main>;
}
