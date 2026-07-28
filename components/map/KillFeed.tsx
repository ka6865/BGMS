"use client";

import React, { useMemo, useState } from "react";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import type { TelemetryEvent } from "../../hooks/useTelemetry";

interface KillFeedProps {
  events: TelemetryEvent[];
  currentTimeMs: number;
  teamNames: string[];
  playbackSpeed: number;
}

export const TEAM_COLORS = ["#F2A900", "#34A853", "#3b82f6", "#ef4444"];

// PUBG 내부 무기코드 → 한국어 이름 변환
const WEAPON_MAP: Record<string, string> = {
  // 돌격소총 (AR)
  WeapHK416_C: "M416",        WeapAKM_C: "AKM",          WeapSCAR_L_C: "SCAR-L",
  WeapBerylM762_C: "베릴 M762", WeapG36C_C: "G36C",       WeapQBZ95_C: "QBZ",
  WeapFamas_C: "FAMAS",       WeapMk47Mutant_C: "Mk47",   WeapACE32_C: "ACE32",
  WeapGroza_C: "그로자",        WeapM16A4_C: "M16A4",

  // 기관단총 (SMG)
  WeapUMP_C: "UMP45",         WeapUZI_C: "Micro UZI",    WeapVector_C: "벡터",
  WeapBizonPP19_C: "PP-19",   WeapThompson_C: "Tommy",    WeapMP5K_C: "MP5K",

  // 기관총 (LMG)
  WeapDP28_C: "DP-28",        WeapM249_C: "M249",         WeapMG3_C: "MG3",
  WeapMinigun_C: "미니건",

  // 지정사수소총 (DMR)
  WeapSKS_C: "SKS",           WeapSLR_C: "SLR",           WeapMini14_C: "Mini14",
  WeapVSS_C: "VSS",           WeapQBU88_C: "QBU",         WeapMk14_C: "Mk14",

  // 저격소총 (SR)
  WeapKar98k_C: "카98K",       WeapM24_C: "M24",           WeapAWM_C: "AWM",
  WeapWin94_C: "Win94",        WeapMosinNagant_C: "모신나강",

  // 샷건 (SG)
  WeapS12K_C: "S12K",          WeapS1897_C: "S1897",       WeapS686_C: "S686",
  WeapSawnoff_C: "소드오프",    WeapDBS_C: "DBS",

  // 권총 (Pistol)
  WeapR45_C: "R45",            WeapR1895_C: "R1895",       WeapP18C_C: "P18C",
  WeapP92_C: "P92",            WeapDesertEagle_C: "데저트이글",
  WeapRhino_C: "리노",         WeapNagantM1895_C: "나강",   WeapM1911_C: "M1911",

  // 특수/근접
  WeapPan_C: "프라이팬",        WeapCrowbar_C: "쇠지레",    WeapMachete_C: "마체테",
  WeapSickle_C: "낫",           WeapCrossbow_C: "석궁",      WeapFlareGun_C: "조명탄",

  // 투척물
  ProjFragGrenade_C: "수류탄",   ProjMolotov_C: "화염병",   ProjGrenade_C: "수류탄",
  ProjStickyGrenade_C: "점착 폭탄", ProjC4_C: "C4",        ProjFlashBang_C: "섬광탄",
  ProjSmokeBomb_C: "연막탄",

  // 중화기/특수
  PanzerFaust100M_C: "판저파우스트", PanzerFaust100M: "판저파우스트",
  PanzerFaust_C: "판저파우스트", WeapPanzerFaust_C: "판저파우스트",
  ProjSpinProjectile_C: "판저파우스트",
  Mortar_C: "박격포", Mortar_Projectile_C: "박격포",

  // 차량 충돌
  VehicleHit_C: "차량 충돌",
  Buggy_A_01_C: "버기 충돌", Buggy_A_02_C: "버기 충돌",
  Dacia_A_01_v2_C: "승용차 충돌", Dacia_A_01_v2_snow_C: "승용차 충돌",
  Uaz_A_01_C: "UAZ 충돌", Uaz_B_01_C: "UAZ 충돌", Uaz_C_01_C: "UAZ 충돌",
  Pickup_A_01_C: "픽업트럭 충돌", Pickup_A_02_C: "픽업트럭 충돌",
  MiniBus_A_01_C: "미니버스 충돌",
  Motorcycle_A_01_C: "모터사이클 충돌", Motorcycle_A_02_C: "모터사이클 충돌",
  MotorcyclesidecarDriver_C: "사이드카 충돌",
  PG117_A_01_C: "보트 충돌", Motorboat_A_01_C: "모터보트 충돌",
  AquaRail_A_01_C: "수상기 충돌", "AquaRail_C": "수상기 충돌",

  // 환경/기타
  InstantDamage: "자기장", BluezoneGrenade_A_C: "자기장 수류탄",
  RedZoneBomb_C: "레드존 폭격",
  Drown: "익사", BleedOut: "출혈사", Falling: "낙사",
  Explosion: "폭발사",
  "G-Liner_C": "포니쿠페 충돌", LootTruck_C: "보급트럭 충돌",
};

function getWeaponName(raw: string): string {
  if (!raw) return "";
  
  // 1. 대소문자 구분 없이 매핑 테이블 확인
  const lowerRaw = raw.toLowerCase();
  const entries = Object.entries(WEAPON_MAP);
  const found = entries.find(([key]) => key.toLowerCase() === lowerRaw);
  if (found) return found[1];
  
  // 2. 키워드 기반 정밀 매칭
  if (lowerRaw.includes("panzerfaust")) return "판저파우스트";
  if (lowerRaw.includes("mortar")) return "박격포";
  if (lowerRaw.includes("sticky")) return "점착폭탄";
  if (lowerRaw.includes("grenade") && !lowerRaw.includes("smoke") && !lowerRaw.includes("flash")) return "수류탄";
  if (lowerRaw.includes("motorcycle") || lowerRaw.includes("motorbike")) return "모터사이클 충돌";
  if (lowerRaw.includes("vehicle") || lowerRaw.includes("dacia") || lowerRaw.includes("uaz") || lowerRaw.includes("pickup") || lowerRaw.includes("buggy")) return "차량 충돌";
  if (lowerRaw.includes("boat") || lowerRaw.includes("aqua") || lowerRaw.includes("pg117")) return "보트 충돌";
  if (lowerRaw.includes("bluezone") || lowerRaw.includes("instantdamage") || lowerRaw.includes("poison")) return "자기장";
  if (lowerRaw.includes("redzone") || lowerRaw.includes("redbomb")) return "레드존";
  if (lowerRaw.includes("fall")) return "낙사";
  if (lowerRaw.includes("drown")) return "익사";
  if (lowerRaw.includes("bleed")) return "출혈사";
  
  // 3. Fallback: 불필요한 접두사/접미사 제거
  return raw
    .replace(/^Weap/, "")
    .replace(/^Proj/, "")
    .replace(/_C$/, "")
    .replace(/_/g, " ");
}


const DISPLAY_WINDOW_MS = (speed: number) => {
  if (speed >= 30) return 3000;
  if (speed >= 10) return 6000;
  if (speed >= 5) return 10000;
  return 5000;
};

export default function KillFeed({ events, currentTimeMs, teamNames, playbackSpeed }: KillFeedProps) {
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [showOnlyTeam, setShowOnlyTeam] = useState(true);
  const windowMs = DISPLAY_WINDOW_MS(playbackSpeed);

  const recentEvents = useMemo(() => {
    return events
      .filter((ev: any) => {
        if (ev.type !== "kill" && ev.type !== "groggy") return false;
        if (showOnlyTeam && !(ev.isTeamAttacker || ev.isTeamVictim)) return false;
        return true;
      })
      .filter((ev) => {
        const diff = currentTimeMs - ((ev as any).relativeTimeMs ?? 0);
        return diff >= 0 && diff <= windowMs;
      })
      .slice(-10) 
      .reverse();
  }, [events, currentTimeMs, windowMs, showOnlyTeam]);

  const allEvents = useMemo(() => {
    return events.filter((ev: any) => {
      if (ev.type !== "kill" && ev.type !== "groggy") return false;
      if (showOnlyTeam && !(ev.isTeamAttacker || ev.isTeamVictim)) return false;
      return true;
    });
  }, [events, showOnlyTeam]);

  const totalKills = allEvents.filter((e) => (e as any).isTeamAttacker && e.type === "kill").length;
  const totalGroggy = allEvents.filter((e) => (e as any).isTeamAttacker && e.type === "groggy").length;
  const teamDowned = allEvents.filter((e) => (e as any).isTeamVictim && e.type === "groggy").length;

  return (
    <div className="absolute top-[20px] md:top-[80px] right-3 md:right-4 z-[4500] flex flex-col gap-1.5 pointer-events-auto select-none" style={{ maxWidth: "280px" }}>
      
      {/* 보기 필터 토글 */}
      <div className="flex justify-end gap-1 mb-0.5">
        <button
          onClick={() => setShowOnlyTeam(false)}
          className={`px-2 py-0.5 text-[9px] font-bold rounded transition-colors ${!showOnlyTeam ? 'bg-[#F2A900] text-black' : 'bg-black/60 text-white/40 hover:text-white/60'}`}
        >
          ALL
        </button>
        <button
          onClick={() => setShowOnlyTeam(true)}
          className={`px-2 py-0.5 text-[9px] font-bold rounded transition-colors ${showOnlyTeam ? 'bg-blue-600 text-white' : 'bg-black/60 text-white/40 hover:text-white/60'}`}
        >
          TEAM ONLY
        </button>
      </div>

      {/* 실시간 킬로그 (최근 N초) */}
      <div className="flex flex-col gap-1 pointer-events-none">
        {recentEvents.map((ev: any, i) => {
          const { isTeamAttacker, isTeamVictim, attacker, victim } = ev;
          const isInvolved = isTeamAttacker || isTeamVictim;
          
          const attackerIdx = teamNames.indexOf(attacker);
          const victimIdx = teamNames.indexOf(victim);
          
          const attackerColor = isTeamAttacker && attackerIdx >= 0 
            ? TEAM_COLORS[attackerIdx % TEAM_COLORS.length] 
            : (isTeamVictim && attackerIdx === -1 ? "#ff4444" : "#aaaaaa");
            
          const victimColor = isTeamVictim && victimIdx >= 0 
            ? TEAM_COLORS[victimIdx % TEAM_COLORS.length] 
            : "#ffffffcc";
          
          const age = currentTimeMs - ((ev as any).relativeTimeMs ?? 0);
          const opacity = Math.max(0.3, 1 - age / windowMs);

          const isKill = ev.type === "kill";

          return (
            <div
              key={`live-${i}`}
              className={`flex flex-col rounded-lg backdrop-blur-sm shadow-lg border overflow-hidden transition-all ${isTeamVictim ? 'border-red-500/50 scale-105' : 'border-white/10'}`}
              style={{
                backgroundColor: isTeamVictim ? "rgba(45,0,0,0.85)" : (isTeamAttacker ? "rgba(10,10,10,0.92)" : "rgba(30,30,30,0.6)"),
                borderColor: isInvolved ? undefined : "rgba(255,255,255,0.1)",
                opacity,
                animation: i === 0 ? "slideInRight 0.25s ease-out" : undefined,
              }}
            >
              <div className="py-1 px-2.5 flex items-center gap-1.5 min-w-0">
                <span className={`font-black truncate max-w-[90px] ${isInvolved ? 'text-xs' : 'text-[11px]'}`} style={{ color: attackerColor }}>
                  {attacker}
                </span>
                <BgmsIcon name={isKill ? "skull" : "battle"} size={12} className="flex-shrink-0 text-white/70" />
                <span className={`font-black truncate max-w-[90px] ${isInvolved ? 'text-xs' : 'text-[11px]'}`} style={{ color: victimColor }}>
                  {victim}
                </span>
                <span
                  className="text-[8px] font-black px-1 rounded flex-shrink-0 ml-auto"
                  style={{
                    backgroundColor: isKill ? "#ef444433" : "#f9731633",
                    color: isKill ? "#ef4444" : "#f97316",
                  }}
                >
                  {isKill ? "KILL" : "DOWN"}
                </span>
              </div>
              
              <div className="px-2.5 pb-1 flex items-center justify-between gap-2 overflow-hidden bg-black/20">
                <span className={`text-[9px] truncate font-medium ${isInvolved ? 'text-white/50' : 'text-white/30'}`}>
                  {ev.weapon ? <InlineIconLabel icon="weapon" iconSize={9}>{getWeaponName(ev.weapon)}</InlineIconLabel> : ""}
                </span>
                {ev.distance != null && (
                  <span className="text-[9px] text-white/20 font-mono">
                    <InlineIconLabel icon="mapPin" iconSize={9}>{ev.distance}m</InlineIconLabel>
                  </span>
                )}
              </div>

              {isTeamVictim && (
                <div className="px-2.5 py-0.5 text-[9px] text-red-100 font-bold bg-red-600/40 border-t border-red-500/20">
                  <InlineIconLabel icon="alert" iconSize={10}>팀원 피해!</InlineIconLabel>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 팀 교전 기록 토글 버튼 */}
      {allEvents.length > 0 && (
        <button
          onClick={() => setIsLogOpen((p) => !p)}
          className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all"
          style={{
            backgroundColor: isLogOpen ? "rgba(242,169,0,0.15)" : "rgba(10,10,10,0.85)",
            borderColor: "#F2A90066",
            color: "#F2A900",
          }}
        >
          <InlineIconLabel icon="file" iconSize={13}>팀 교전 기록</InlineIconLabel>
          <span className="flex items-center gap-2">
            <InlineIconLabel icon="skull" iconSize={12} className="text-red-400">{totalKills}</InlineIconLabel>
            <InlineIconLabel icon="battle" iconSize={12} className="text-orange-400">{totalGroggy}</InlineIconLabel>
            {teamDowned > 0 && <InlineIconLabel icon="alert" iconSize={12} className="text-red-500">{teamDowned}</InlineIconLabel>}
            <span className="text-white/50">{isLogOpen ? "▲" : "▼"}</span>
          </span>
        </button>
      )}

      {/* 팀 킬로그 모음 패널 */}
      {isLogOpen && (
        <div
          className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-0.5 rounded-lg"
          style={{ scrollbarWidth: "thin" }}
        >
          {allEvents.map((ev: any, i: number) => {
            const { isTeamAttacker, isTeamVictim, attacker, victim } = ev;
            const victimIdx = teamNames.indexOf(victim);
            const victimColor = isTeamVictim && victimIdx >= 0 ? TEAM_COLORS[victimIdx % TEAM_COLORS.length] : "#ffffffcc";
            const attackerIdx = teamNames.indexOf(attacker);
            const attackerColor = isTeamAttacker && attackerIdx >= 0 ? TEAM_COLORS[attackerIdx % TEAM_COLORS.length] : "#aaaaaa";
            const isPast = ((ev as any).relativeTimeMs ?? 0) <= currentTimeMs;
            const isKill = ev.type === "kill";

            return (
              <div
                key={`log-${i}`}
                className={`flex flex-col py-1 px-2 rounded-lg backdrop-blur-sm border transition-opacity ${isTeamVictim ? 'bg-red-900/40 border-red-500/30' : (isTeamAttacker ? 'bg-black/60 border-white/10' : 'bg-white/5 border-white/5')}`}
                style={{ opacity: isPast ? 1 : 0.35 }}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-black truncate max-w-[80px] text-[10px]" style={{ color: attackerColor }}>
                    {attacker}
                  </span>
                  <BgmsIcon name={isKill ? "skull" : "battle"} size={10} className="flex-shrink-0 text-white/70" />
                  <span className="font-black truncate max-w-[80px] text-[10px]" style={{ color: victimColor }}>
                    {victim}
                  </span>
                  <span
                    className="text-[8px] font-black px-1 rounded flex-shrink-0 ml-auto"
                    style={{
                      backgroundColor: isKill ? "#ef444433" : "#f9731633",
                      color: isKill ? "#ef4444" : "#f97316",
                    }}
                  >
                    {isKill ? "K" : "D"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[8px] text-white/30 mt-0.5 px-0.5">
                   <span className="truncate max-w-[120px]">{ev.weapon ? getWeaponName(ev.weapon) : ""}</span>
                   {ev.distance != null && <span>{ev.distance}m</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style jsx global>{`
        @keyframes slideInRight {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0);   opacity: 1; }
        }
      `}</style>
    </div>
  );
}
