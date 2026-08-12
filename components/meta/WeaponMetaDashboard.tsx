"use client";

import React, { useEffect, useState, useMemo } from "react";
import { Layers, TrendingUp, Target, Zap, RefreshCw, ArrowRight } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface WeaponComparisonItem {
  id?: number;
  weapon_name: string;
  weapon_category: string;
  pre_patch: {
    match_count: number;
    pick_share: number;
    avg_damage: number;
    sustained_hits: number;
    burst_available: boolean;
    kill_efficiency: number;
  };
  post_patch: {
    match_count: number;
    pick_share: number;
    avg_damage: number;
    sustained_hits: number;
    burst_available: boolean;
    kill_efficiency: number;
  };
}

interface DailyWeaponTrendPoint {
  date: string;
  player_match_count: number;
  weapon_pick_count: number;
  weapon_name: string;
}

export default function WeaponMetaDashboard() {
  const [data, setData] = useState<{ patchVersion?: string; patchStartedAt?: string; weapons?: WeaponComparisonItem[]; dailyWeaponTrend?: DailyWeaponTrendPoint[]; burstCollection?: { pre: { total: number; completed: number }; post: { total: number; completed: number } } | null; status?: string; message?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string>("ALL");
  const [selectedWeapon, setSelectedWeapon] = useState<string>("");

  useEffect(() => {
    fetch("/api/pubg/meta")
      .then((res) => res.json())
      .then((resData) => {
        setData(resData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const weapons = data?.weapons || [];
  const activeWeapon = selectedWeapon || weapons[0]?.weapon_name || "";
  const dailyWeaponTrend = useMemo(() => (data?.dailyWeaponTrend || [])
    .filter((point) => point.weapon_name === activeWeapon)
    .map((point) => ({
    ...point,
    label: point.date.slice(5).replace("-", "/"),
    weapon_pick_share: point.player_match_count > 0 ? Number(((point.weapon_pick_count / point.player_match_count) * 100).toFixed(1)) : 0,
  })), [activeWeapon, data?.dailyWeaponTrend]);

  const metrics = useMemo(() => {
    const lmgWeapons = weapons.filter((w) => w.weapon_category === "LMG");
    const lmgPreShare = lmgWeapons.reduce((acc, w) => acc + w.pre_patch.pick_share, 0);
    const lmgPostShare = lmgWeapons.reduce((acc, w) => acc + w.post_patch.pick_share, 0);
    const shareDiffNum = lmgPostShare - lmgPreShare;
    const shareDiffStr = shareDiffNum >= 0 ? `+${shareDiffNum.toFixed(1)}%` : `${shareDiffNum.toFixed(1)}%`;

    const hasBurstComparison = lmgWeapons.some((w) => w.pre_patch.burst_available && w.post_patch.burst_available);
    const lmgPreHits = lmgWeapons.reduce((acc, w) => acc + w.pre_patch.sustained_hits, 0);
    const lmgPostHits = lmgWeapons.reduce((acc, w) => acc + w.post_patch.sustained_hits, 0);
    const hitsDiff = lmgPostHits - lmgPreHits;

    const preEffAvg = lmgWeapons.length > 0 ? (lmgWeapons.reduce((acc, w) => acc + w.pre_patch.kill_efficiency, 0) / lmgWeapons.length).toFixed(1) : "0";
    const postEffAvg = lmgWeapons.length > 0 ? (lmgWeapons.reduce((acc, w) => acc + w.post_patch.kill_efficiency, 0) / lmgWeapons.length).toFixed(1) : "0";

    return {
      lmgPreShare: `${lmgPreShare.toFixed(1)}%`,
      lmgPostShare: `${lmgPostShare.toFixed(1)}%`,
      lmgShareDiff: shareDiffStr,
      lmgPreHits,
      lmgPostHits,
      lmgHitsDiff: `${hitsDiff >= 0 ? "+" : ""}${hitsDiff.toLocaleString()}발`,
      efficiencyPre: preEffAvg,
      efficiencyPost: postEffAvg,
      hasBurstComparison,
    };
  }, [weapons]);

  if (loading) {
    return (
      <div className="flex h-48 w-full items-center justify-center rounded-2xl border border-white/10 bg-[#161616]">
        <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  const categories = ["ALL", "LMG", "AR", "DMR", "SR", "SG", "SMG"];
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
            <h2 className="text-lg font-black tracking-tight text-white">PUBG {data?.patchVersion || "-"} 패치 전후 총기 메타 검증 리포트</h2>
            <p className="text-xs text-zinc-400">패치 직전 14일과 적용 후 실제 분석 매치를 비교합니다.</p>
          </div>
        </div>
      </div>

      {dailyWeaponTrend.length > 0 && <section className="rounded-xl border border-white/10 bg-black/20 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-black text-white">총기별 일별 채용률 추세</h3>
          <p className="mt-1 text-[11px] text-zinc-500">선택한 총기로 유효 대인 딜을 낸 경기 비율입니다. 툴팁에서 일별 표본 수를 확인하세요.</p>
          <select value={activeWeapon} onChange={(event) => setSelectedWeapon(event.target.value)} className="mt-3 max-w-full rounded-md border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-white">
            {weapons.map((weapon) => <option key={weapon.weapon_name} value={weapon.weapon_name}>{weapon.weapon_name} · {weapon.weapon_category}</option>)}
          </select>
        </div>
        <div className="h-56 w-full" aria-label="총기별 일별 채용률 차트">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={dailyWeaponTrend} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
              <CartesianGrid stroke="#ffffff12" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#a1a1aa", fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis domain={[0, 100]} unit="%" tick={{ fill: "#a1a1aa", fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.date || ""}
                formatter={(value, _name, item) => [`${value ?? 0}% · 표본 ${item.payload.player_match_count}경기`, `${activeWeapon} 채용률`]}
              />
              {data?.patchStartedAt && <ReferenceLine x={new Date(data.patchStartedAt).toISOString().slice(5, 10).replace("-", "/")} stroke="#818cf8" strokeDasharray="4 4" />}
              <Line type="monotone" dataKey="weapon_pick_share" stroke="#34d399" strokeWidth={2} dot={{ r: 3, fill: "#34d399" }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>}

      {data?.burstCollection && <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <h3 className="text-sm font-black text-amber-100">지속 연사 데이터 수집 현황</h3>
        <p className="mt-1 text-[11px] text-zinc-400">전은 R2 백필 진행률, 후는 새 분석 매치의 실시간 측정 완료율입니다.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {[{ label: "패치 전", value: data.burstCollection.pre }, { label: "패치 후", value: data.burstCollection.post }].map(({ label, value }) => {
            const rate = value.total > 0 ? Math.round((value.completed / value.total) * 100) : 0;
            return <div key={label} className="rounded-lg bg-black/20 p-3">
              <div className="flex justify-between text-xs"><span className="text-zinc-300">{label}</span><span className="font-bold text-white">{value.completed} / {value.total}경기 ({rate}%)</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-amber-400" style={{ width: `${rate}%` }} /></div>
            </div>;
          })}
        </div>
      </section>}

      {weapons.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/20 p-6 text-sm text-zinc-400">
          {data?.message || "집계된 무기 데이터가 아직 없습니다."}
          <p className="mt-2 text-xs text-zinc-500">예시 수치나 추정치는 표시하지 않습니다.</p>
        </div>
      ) : <>
      {/* 요약 카드 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-emerald-300">유저 선호도 (얼마나 많이 쓰나?)</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-xs text-zinc-400 line-through">{metrics.lmgPreShare}</span>
            <ArrowRight className="h-3 w-3 text-zinc-500" />
            <span className="text-lg font-black text-emerald-400">{metrics.lmgPostShare}</span>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
              ({metrics.lmgShareDiff})
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-amber-300">지속 연사 명중 (꾹 누르고 쏜 탄수)</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
              <Zap className="h-4 w-4" />
            </div>
          </div>
          {metrics.hasBurstComparison ? <div className="mt-3 flex items-baseline gap-2">
            <span className="text-xs text-zinc-400">{metrics.lmgPreHits.toLocaleString()}발</span>
            <ArrowRight className="h-3 w-3 text-zinc-500" />
            <span className="text-lg font-black text-amber-300">{metrics.lmgPostHits.toLocaleString()}발</span>
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
              ({metrics.lmgHitsDiff})
            </span>
          </div> : <p className="mt-3 text-sm font-bold text-amber-200">수집 시작 후 비교 가능</p>}
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-indigo-300">적 눕히는 결정력 (1k딜당 킬/기절)</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
              <Target className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-xs text-zinc-400">{metrics.efficiencyPre}명</span>
            <ArrowRight className="h-3 w-3 text-zinc-500" />
            <span className="text-lg font-black text-indigo-300">{metrics.efficiencyPost}명</span>
            <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-bold text-indigo-300">
              ({Number(metrics.efficiencyPost) >= Number(metrics.efficiencyPre) ? "상승" : "하락"})
            </span>
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

      {/* 1:1 비교 표 */}
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/20">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-white/10 bg-white/5 font-black uppercase text-zinc-400">
            <tr>
              <th className="p-3">총기명</th>
              <th className="p-3">카테고리</th>
              <th className="p-3">
                <div>채용 지분율</div>
                <div className="text-[10px] font-normal text-zinc-500">유저 선호도 (전 → 후)</div>
              </th>
              <th className="p-3">
                <div>경기당 평균 딜량</div>
                <div className="text-[10px] font-normal text-zinc-500">판당 유효 딜 (전 → 후)</div>
              </th>
              <th className="p-3">
                <div>지속 연사 명중</div>
                <div className="text-[10px] font-normal text-zinc-500">꾹 쏘고 맞춘 총탄수</div>
              </th>
              <th className="p-3">
                <div>적 눕히는 결정력</div>
                <div className="text-[10px] font-normal text-zinc-500">1k딜당 킬/기절 전환</div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredWeapons.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-zinc-500">비교 데이터가 아직 없습니다.</td>
              </tr>
            ) : (
              filteredWeapons.map((w) => {
                const shareDiff = (w.post_patch.pick_share - w.pre_patch.pick_share).toFixed(1);
                const isShareUp = Number(shareDiff) >= 0;

                const damageDiff = w.post_patch.avg_damage - w.pre_patch.avg_damage;
                const isDmgUp = damageDiff >= 0;

                const hitsDiff = w.post_patch.sustained_hits - w.pre_patch.sustained_hits;
                const isHitsUp = hitsDiff >= 0;

                return (
                  <tr key={w.id || w.weapon_name} className="hover:bg-white/5">
                    <td className="p-3 font-bold text-white">{w.weapon_name}</td>
                    <td className="p-3">
                      <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-black text-indigo-300">
                        {w.weapon_category}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-zinc-400">{w.pre_patch.pick_share}%</span>
                        <ArrowRight className="h-3 w-3 text-zinc-600" />
                        <span className="font-bold text-white">{w.post_patch.pick_share}%</span>
                        <span className={`text-[10px] font-bold ${isShareUp ? "text-emerald-400" : "text-rose-400"}`}>
                          ({isShareUp ? "+" : ""}{shareDiff}%)
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-zinc-500">표본: {w.pre_patch.match_count}경기 → {w.post_patch.match_count}경기</div>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-zinc-400">{w.pre_patch.avg_damage}</span>
                        <ArrowRight className="h-3 w-3 text-zinc-600" />
                        <span className="font-bold text-white">{w.post_patch.avg_damage} HP</span>
                        <span className={`text-[10px] font-bold ${isDmgUp ? "text-emerald-400" : "text-rose-400"}`}>
                          ({isDmgUp ? "+" : ""}{damageDiff})
                        </span>
                      </div>
                    </td>
                    <td className="p-3">
                      {w.pre_patch.burst_available && w.post_patch.burst_available ? <div className="flex items-center gap-1.5">
                        <span className="text-zinc-400">{w.pre_patch.sustained_hits}</span>
                        <ArrowRight className="h-3 w-3 text-zinc-600" />
                        <span className="font-bold text-amber-300">{w.post_patch.sustained_hits}발</span>
                        <span className={`text-[10px] font-bold ${isHitsUp ? "text-emerald-400" : "text-rose-400"}`}>
                          ({isHitsUp ? "+" : ""}{hitsDiff})
                        </span>
                      </div> : <span className="text-zinc-500">수집 중</span>}
                    </td>
                    <td className="p-3 font-semibold text-indigo-300">
                      {w.pre_patch.kill_efficiency}명 → {w.post_patch.kill_efficiency}명
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </>}
    </div>
  );
}
