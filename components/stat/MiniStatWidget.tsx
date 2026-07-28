import React, { useState, useEffect } from "react";
import getApiUrl from "../../lib/api-config";
import { getTierIconPath } from "@/utils/tier";
import { BgmsIcon } from "@/components/common/BgmsIcon";

interface MiniStatWidgetProps {
  pubgNickname: string;
  platform?: string;
}

export default function MiniStatWidget({ pubgNickname, platform = "steam" }: MiniStatWidgetProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    tier: string;
    subTier: string;
    kd: number;
    winRate: number;
    damage: number;
    wins: number;
    dbnos: number;
  } | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      if (!pubgNickname) return;
      try {
        setLoading(true);
        // 클라이언트에서 pubg API 라우트를 호출하여 전적 요약(솔로/스쿼드 선택적)
        const apiUrl = getApiUrl(`/api/pubg/player?nickname=${pubgNickname}&platform=${platform}`);
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error("전적 조회 실패");
        const json = await res.json();
        
        const rankedSquad = json.stats?.ranked?.squad;
        const normalSquad = json.stats?.normal?.squad;

        // 1. 게임 판수(roundsPlayed)가 있는 쪽을 우선적으로 선택합니다.
        // 경쟁전 기록이 있으면 경쟁전을, 없으면 일반전 기록을 가져옵니다.
        const stats = (rankedSquad && rankedSquad.roundsPlayed > 0) ? rankedSquad : 
                      (normalSquad && normalSquad.roundsPlayed > 0) ? normalSquad : null;

        if (stats) {
          const isRanked = stats === rankedSquad;
          setData({
            tier: stats.currentTier?.tier || (isRanked ? "Unranked" : "일반전"),
            subTier: stats.currentTier?.subTier || "",
            kd: (stats.kills || 0) / Math.max(1, (stats.deaths || stats.losses || 1)),
            winRate: ((stats.wins || 0) / Math.max(1, stats.roundsPlayed || 1)) * 100,
            damage: (stats.damageDealt || 0) / Math.max(1, stats.roundsPlayed || 1),
            wins: stats.wins || 0,
            dbnos: (stats.dBNOs || 0) / Math.max(1, stats.roundsPlayed || 1)
          });
        } else {
          setData(null);
        }
      } catch (e) {
        console.error("Mini stat error", e);
      } finally {
        setLoading(false);
      }
    };
    
    fetchStats();
  }, [pubgNickname, platform]);

  if (!pubgNickname) return null;

  return (
    <div className="w-full bg-[#111] p-4 rounded-xl border border-[#333] shadow-md flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-[#333] pb-2">
        <h3 className="font-bold text-[#F2A900] flex items-center gap-2">
          <BgmsIcon name="battle" size={16} /> 배틀그라운드 연동 전적
        </h3>
        <span className="text-xs px-2 py-1 bg-[#222] rounded-md text-gray-300">
          {pubgNickname}
        </span>
      </div>
      
      {loading ? (
        <div className="text-center text-sm text-gray-500 py-4 animate-pulse">전적 요약 불러오는 중...</div>
      ) : data ? (
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col">
            <span className="text-xs text-gray-500">K/D</span>
            <span className="font-bold text-lg">{data.kd.toFixed(2)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500">승률</span>
            <span className="font-bold text-lg">{data.winRate.toFixed(1)}%</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500">평균 딜량</span>
            <span className="font-bold text-lg">{Math.round(data.damage)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500">평균 기절</span>
            <span className="font-bold text-lg text-[#34A853]">{data.dbnos.toFixed(1)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500">우승 횟수</span>
            <span className="font-bold text-lg text-[#F2A900]">{data.wins}회</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500">티어(스쿼드)</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <img
                src={getTierIconPath(data.tier, data.subTier)}
                alt={`${data.tier} ${data.subTier}`}
                className="w-5 h-5 object-contain"
              />
              <span className="font-bold text-sm text-[#F2A900]">{data.tier} {data.subTier}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center text-sm text-gray-500 py-4">이번 시즌 스쿼드 전적 기록이 없습니다.</div>
      )}
    </div>
  );
}
