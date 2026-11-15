"use client";

import { useEffect, useRef, useState } from "react";
import OfficialCatalog from "@/components/game-data/OfficialCatalog";
import WeaponMetaDashboard from "@/components/meta/WeaponMetaDashboard";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import WeaponsClient from "./WeaponsClient";

export default function CatalogTabs() {
  const [tab, setTab] = useState<"weapons" | "meta" | "vehicles">("weapons");
  const [simulator, setSimulator] = useState(false);
  const [simulatorVisited, setSimulatorVisited] = useState(false);
  const [requestedItem, setRequestedItem] = useState<OfficialItem | null>(null);
  const [officialItems, setOfficialItems] = useState<OfficialItem[]>([]);
  const simulatorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!simulator) return;
    simulatorRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    simulatorRef.current?.focus({ preventScroll: true });
  }, [simulator, requestedItem]);

  return <main className="min-h-screen bg-[#0e0e0e] px-4 py-8 text-white sm:px-6 sm:py-12">
    <div className="mx-auto max-w-7xl">
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">도감</h1>
      <nav aria-label="도감 분류" className="mt-6 flex gap-6 border-b border-zinc-700">
        {([['weapons','무기'],['meta','메타'],['vehicles','탈것']] as const).map(([value,label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`min-h-12 border-b-2 px-1 text-sm font-bold transition-colors ${tab === value ? "border-amber-400 text-amber-400" : "border-transparent text-zinc-400 hover:text-white"}`}>{label}</button>)}
      </nav>
      <div className="mt-7">
        <div hidden={tab !== "weapons"}><OfficialCatalog category="weapons" onItemsLoaded={setOfficialItems} onConfigureWeapon={(item) => {
          setRequestedItem({ ...item });
          setSimulatorVisited(true);
          setSimulator(true);
        }} /></div>
        <div hidden={tab !== "vehicles"}><OfficialCatalog category="vehicles" /></div>
        {tab === "meta" && <WeaponMetaDashboard />}
      </div>
      <div hidden={tab !== "weapons"} className="mt-10 border-t border-zinc-700 pt-6">
        <button type="button" aria-expanded={simulator} aria-controls="weapon-simulator" onClick={() => { setSimulatorVisited(true); setSimulator(!simulator); }} className="min-h-11 border border-zinc-600 px-4 text-sm font-bold hover:border-amber-400">{simulator ? "파츠 시뮬레이터 닫기" : "파츠 시뮬레이터 열기"}</button>
        <div id="weapon-simulator" ref={simulatorRef} tabIndex={-1} aria-label="파츠 시뮬레이터" hidden={!simulator} className="mt-4 scroll-mt-20 focus-visible:outline-2 focus-visible:outline-amber-400">
          {simulatorVisited && <WeaponsClient requestedItem={requestedItem} officialItems={officialItems} />}
        </div>
      </div>
    </div>
  </main>;
}
