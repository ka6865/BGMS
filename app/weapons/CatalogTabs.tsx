"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import OfficialCatalog, { compareKey } from "@/components/game-data/OfficialCatalog";
import WeaponCompare, { COMPARE_LIMIT, type CompareEntry } from "@/components/game-data/WeaponCompare";
import WeaponMetaDashboard from "@/components/meta/WeaponMetaDashboard";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import WeaponsClient, { type OfficialStatus } from "./WeaponsClient";

export default function CatalogTabs() {
  const [tab, setTab] = useState<"weapons" | "meta" | "vehicles">("weapons");
  const [vehiclesVisited, setVehiclesVisited] = useState(false);
  const [simulator, setSimulator] = useState(false);
  const [simulatorVisited, setSimulatorVisited] = useState(false);
  const [requestedItem, setRequestedItem] = useState<OfficialItem | null>(null);
  const [officialItems, setOfficialItems] = useState<OfficialItem[]>([]);
  const [officialStatus, setOfficialStatus] = useState<OfficialStatus>("loading");
  const [compare, setCompare] = useState<CompareEntry[]>([]);
  const simulatorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!simulator) return;
    simulatorRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    simulatorRef.current?.focus({ preventScroll: true });
  }, [simulator, requestedItem]);
  const handleItemsLoaded = useCallback((items: OfficialItem[]) => { setOfficialItems(items); setOfficialStatus("ready"); }, []);
  const handleLoadError = useCallback(() => setOfficialStatus("error"), []);
  // 같은 key는 빼고, 새 항목은 한도 안에서만 추가한다.
  const toggleCompare = useCallback((entry: CompareEntry) => setCompare((current) => current.some((item) => item.key === entry.key)
    ? current.filter((item) => item.key !== entry.key)
    : current.length < COMPARE_LIMIT ? [...current, entry] : current), []);
  const compareKeys = compare.map((entry) => entry.key);

  return <main className="min-h-screen bg-[#0e0e0e] px-4 py-8 text-white sm:px-6 sm:py-12">
    <div className="mx-auto max-w-7xl">
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">도감</h1>
      <nav aria-label="도감 분류" className="mt-6 flex gap-6 border-b border-zinc-700">
        {([['weapons','무기'],['meta','메타'],['vehicles','탈것']] as const).map(([value,label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => { setTab(value); if (value === "vehicles") setVehiclesVisited(true); }} className={`min-h-12 border-b-2 px-1 text-sm font-bold transition-colors ${tab === value ? "border-amber-400 text-amber-400" : "border-transparent text-zinc-400 hover:text-white"}`}>{label}</button>)}
      </nav>
      <div className="mt-7">
        <div hidden={tab !== "weapons"}><OfficialCatalog category="weapons" onItemsLoaded={handleItemsLoaded} onLoadError={handleLoadError}
          comparedKeys={compareKeys} compareFull={compare.length >= COMPARE_LIMIT}
          onToggleCompare={(item) => toggleCompare({ key: compareKey(item), name: item.name, item })}
          onConfigureWeapon={(item) => {
            setRequestedItem({ ...item });
            setSimulatorVisited(true);
            setSimulator(true);
          }} /></div>
        {/* 탈것은 처음 열 때 조회하고, 이후에는 탭 상태 보존을 위해 마운트를 유지한다. */}
        {vehiclesVisited && <div hidden={tab !== "vehicles"}><OfficialCatalog category="vehicles" /></div>}
        {tab === "meta" && <WeaponMetaDashboard />}
      </div>
      <div hidden={tab !== "weapons"}>
        <WeaponCompare entries={compare} onRemove={(key) => setCompare((current) => current.filter((entry) => entry.key !== key))} onClear={() => setCompare([])} />
      </div>
      <div hidden={tab !== "weapons"} className="mt-10 border-t border-zinc-700 pt-6">
        <button type="button" aria-expanded={simulator} aria-controls="weapon-simulator" onClick={() => { setSimulatorVisited(true); setSimulator(!simulator); }} className="min-h-11 border border-zinc-600 px-4 text-sm font-bold hover:border-amber-400">{simulator ? "파츠 시뮬레이터 닫기" : "파츠 시뮬레이터 열기"}</button>
        <div id="weapon-simulator" ref={simulatorRef} tabIndex={-1} aria-label="파츠 시뮬레이터" hidden={!simulator} className="mt-4 scroll-mt-20 focus-visible:outline-2 focus-visible:outline-amber-400">
          {simulatorVisited && <WeaponsClient requestedItem={requestedItem} officialItems={officialItems} officialStatus={officialStatus}
            comparedKeys={compareKeys} compareFull={compare.length >= COMPARE_LIMIT} onToggleCompare={toggleCompare} />}
        </div>
      </div>
    </div>
  </main>;
}
