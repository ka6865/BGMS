"use client";

import { BgmsIcon } from "@/components/common/BgmsIcon";

interface MapStat {
  mapName: string;
  displayName: string;
  matchCount: number;
  avgDamage: number;
  avgKills: number;
  avgDeathPhase: number;
}

interface MapStatsData {
  list: MapStat[];
  bestMap: MapStat;
  worstMap: MapStat;
}

const MAP_ICON_TONES: Record<string, string> = {
  '에란겔': 'text-emerald-400',
  '미라마': 'text-amber-400',
  '사녹': 'text-green-400',
  '태이고': 'text-red-300',
  '론도': 'text-sky-300',
  '데스턴': 'text-yellow-300',
  '칼린도': 'text-cyan-300',
  '헤이븐': 'text-zinc-300',
};

export const MapKingCard = ({ mapStats }: { mapStats: MapStatsData }) => {
  if (!mapStats || mapStats.list.length < 2) return null;

  const { list, bestMap, worstMap } = mapStats;
  const baseDmg = list.reduce((s, m) => s + m.avgDamage, 0) / list.length;
  const maxDmg = list[0].avgDamage;
  const diffPct = Math.round(((bestMap.avgDamage - baseDmg) / Math.max(baseDmg, 1)) * 100);
  const isSameMap = worstMap.mapName === bestMap.mapName;

  return (
    <div className="p-8 bg-black/60 rounded-[32px] border border-white/10 backdrop-blur-xl shadow-2xl overflow-hidden relative">
      {/* 배경 장식 */}
      <div className="absolute -top-16 -right-16 w-48 h-48 bg-yellow-500/10 blur-[80px] rounded-full pointer-events-none" />

      {/* 헤더 */}
      <div className="relative z-10 mb-6">
        <div className="text-[12px] text-yellow-400 font-black uppercase tracking-[0.3em] mb-1">
          Map Identity
        </div>
        <div className="text-xl font-black text-white">나는 어느 맵의 왕인가</div>
      </div>

      {/* 최강 맵 하이라이트 */}
      <div className="relative z-10 p-5 bg-yellow-500/10 border border-yellow-500/20 rounded-2xl mb-5">
        <div className="flex items-center gap-4">
          <BgmsIcon name="map" size={38} className={MAP_ICON_TONES[bestMap.displayName] ?? 'text-[#F2A900]'} />
          <div className="flex-1">
            <div className="text-lg font-black text-yellow-400">
              {bestMap.displayName} 특화
            </div>
            <div className="text-sm text-gray-400 mt-0.5 flex flex-wrap gap-x-4 gap-y-1">
              <span>평균 <strong className="text-white">{bestMap.avgDamage}</strong>딜</span>
              <span>킬 <strong className="text-white">{bestMap.avgKills}</strong></span>
              <span>생존 <strong className="text-white">{bestMap.avgDeathPhase}</strong>ph</span>
              <span>({bestMap.matchCount}판 기준)</span>
            </div>
          </div>
          {diffPct > 0 && (
            <div className="shrink-0 text-right">
              <div className="text-2xl font-black text-yellow-400">+{diffPct}%</div>
              <div className="text-[10px] text-gray-500 font-bold uppercase">평균 대비</div>
            </div>
          )}
        </div>
      </div>

      {/* 맵별 딜량 바 차트 */}
      <div className="relative z-10 space-y-3">
        {list.map((m, idx) => {
          const pct = Math.max(5, Math.round((m.avgDamage / Math.max(maxDmg, 1)) * 100));
          const isBest  = idx === 0;
          const isWorst = !isSameMap && m.mapName === worstMap.mapName;
          return (
            <div key={m.mapName} className="flex items-center gap-3 group">
              <div className="w-6 text-lg shrink-0 text-center">
                <BgmsIcon name="map" size={18} className={`mx-auto ${MAP_ICON_TONES[m.displayName] ?? 'text-[#F2A900]'}`} />
              </div>
              <div className="w-14 text-xs font-black text-white/70 shrink-0 truncate">
                {m.displayName}
              </div>
              <div className="flex-1 h-3 bg-white/5 rounded-full overflow-hidden border border-white/5">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ${
                    isBest  ? 'bg-gradient-to-r from-yellow-500 to-yellow-300 shadow-[0_0_8px_rgba(234,179,8,0.5)]' :
                    isWorst ? 'bg-red-500/50' :
                              'bg-white/20'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className={`text-sm font-black w-14 text-right shrink-0 ${
                isBest ? 'text-yellow-400' : isWorst ? 'text-red-400/70' : 'text-white/60'
              }`}>
                {m.avgDamage}딜
              </div>
              <div className="text-[10px] text-gray-600 w-8 text-right shrink-0">
                {m.matchCount}판
              </div>
            </div>
          );
        })}
      </div>

      {/* 최약 맵 경고 */}
      {!isSameMap && (
        <div className="relative z-10 mt-5 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3">
          <BgmsIcon name="map" size={18} className={MAP_ICON_TONES[worstMap.displayName] ?? 'text-red-300'} />
          <div className="text-sm text-red-400 font-bold">
            <strong>{worstMap.displayName}</strong>에서 평균 {worstMap.avgDamage}딜 —{' '}
            가장 취약한 맵 (기피 권장)
          </div>
        </div>
      )}
    </div>
  );
};
