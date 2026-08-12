"use client";

import React, { useEffect, useState, useMemo } from "react";
import { Layers, TrendingUp, Target, Zap, RefreshCw } from "lucide-react";

interface WeaponMetaItem {
  id?: number;
  weapon_name: string;
  weapon_category: string;
  match_count: number;
  active_pick_count: number;
  total_kills: number;
  total_dbnos: number;
  total_damage: number;
  first_sec_hits: number;
  sustained_hits: number;
  sustained_burst_count: number;
}

export default function WeaponMetaDashboard() {
  const [data, setData] = useState<{ patchVersion?: string; weapons?: WeaponMetaItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string>("ALL");

  useEffect(() => {
    fetch("/api/pubg/meta")
      .then((res) => res.json())
      .then((resData) => {
        if (resData.success) setData(resData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const weapons = data?.weapons || [];

  // 동적 요약 지표 산출
  const metrics = useMemo(() => {
    if (weapons.length === 0) {
      return {
        lmgShareStr: "0%",
        lmgSustainedHits: 0,
        totalDamageStr: "0",
        totalSustainedHitsStr: "0",
        weaponCount: 0,
      };
    }

    const totalActivePicks = weapons.reduce((acc, w) => acc + (w.active_pick_count || 0), 0);
    const lmgPicks = weapons.filter((w) => w.weapon_category === "LMG").reduce((acc, w) => acc + (w.active_pick_count || 0), 0);
    const lmgShare = totalActivePicks > 0 ? ((lmgPicks / totalActivePicks) * 100).toFixed(1) : "0";

    const lmgSustained = weapons.filter((w) => w.weapon_category === "LMG").reduce((acc, w) => acc + (w.sustained_hits || 0), 0);
    const totalDmg = weapons.reduce((acc, w) => acc + (w.total_damage || 0), 0);
    const totalSustained = weapons.reduce((acc, w) => acc + (w.sustained_hits || 0), 0);

    return {
      lmgShareStr: `${lmgShare}%`,
      lmgSustainedHits: lmgSustained,
      totalDamageStr: Math.round(totalDmg).toLocaleString(),
      totalSustainedHitsStr: totalSustained.toLocaleString(),
      weaponCount: weapons.length,
    };
  }, [weapons]);

  if (loading) {
    return (
      <div className="flex h-48 w-full items-center justify-center rounded-2xl border border-white/10 bg-[#161616]">
        <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  const categories = ["ALL", "AR", "LMG", "DMR", "SR", "SG", "SMG"];
  const filteredWeapons = filterCategory === "ALL"
    ? weapons
    : weapons.filter((w) => w.weapon_category === filterCategory);

  return (
    <div className="space-y-6 rounded-2xl border border-white/10 bg-[#161616] p-6 text-white shadow-xl">
      {/* 헤더 */}
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-400">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-black tracking-tight text-white">실시간 총기 메타 동향 리포트</h2>
            <p className="text-xs text-zinc-400">PUBG {data?.patchVersion || "34.1"} 패치 기준 · 실시간 텔레메트리 1.5초 피격버스트 파싱</p>
          </div>
        </div>
      </div>

      {/* 동적 요약 카드 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-emerald-300">LMG 활성 채용 지분: {metrics.lmgShareStr}</p>
            <p className="text-sm font-black text-white">LMG 지속 연사 타격 {metrics.lmgSustainedHits.toLocaleString()}발 집계</p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
            <Target className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-indigo-300">PvP 유효 딜량 정제 완료</p>
            <p className="text-sm font-black text-white">총 유효 딜량 {metrics.totalDamageStr} HP ({metrics.weaponCount}종)</p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-amber-300">피격 1.5초 버스트 윈도우</p>
            <p className="text-sm font-black text-white">전체 지속 연사 명중 {metrics.totalSustainedHitsStr}발</p>
          </div>
        </div>
      </div>

      {/* 필터 탭 */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setFilterCategory(cat)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterCategory === cat ? "bg-indigo-600 text-white" : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* 메타 테이블 */}
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/20">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-white/10 bg-white/5 font-black uppercase text-zinc-400">
            <tr>
              <th className="p-3">총기명</th>
              <th className="p-3">카테고리</th>
              <th className="p-3">매치 수</th>
              <th className="p-3">총 킬</th>
              <th className="p-3">총 데미지</th>
              <th className="p-3">지속 연사 명중 수</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredWeapons.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-zinc-500">집계된 무기 데이터가 아직 없습니다.</td>
              </tr>
            ) : (
              filteredWeapons.map((w) => (
                <tr key={w.id || w.weapon_name} className="hover:bg-white/5">
                  <td className="p-3 font-bold text-white">{w.weapon_name}</td>
                  <td className="p-3">
                    <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-black text-indigo-300">
                      {w.weapon_category}
                    </span>
                  </td>
                  <td className="p-3">{w.match_count}</td>
                  <td className="p-3 font-semibold text-emerald-400">{w.total_kills}</td>
                  <td className="p-3">{Math.round(w.total_damage).toLocaleString()}</td>
                  <td className="p-3 font-semibold text-amber-300">{w.sustained_hits.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
