"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";
import {
  calcBackpackCapacity,
  calcTotalWeight,
} from "../../lib/backpackUtils";
import { trackEvent } from "../../lib/analytics";
import { toast } from "sonner";
import AdfitBanner from "../../components/ads/AdfitBanner";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

const BACKPACK_MOBILE_AD_UNIT = "DAN-tQGcqmddMC8tPpXA";
const BACKPACK_LEADERBOARD_AD_UNIT = "DAN-dPiCxgIGtXKjLPP3";
const BACKPACK_DESKTOP_AD_UNIT = "DAN-RjyosR2uf8eSsVIC";

interface InventoryItem {
  id: string;
  name: string;
  weight: number;
  quantity: number;
  category: string;
  can_be_in_backpack?: boolean;
}

// 1. 아이템 행을 전역 컴포넌트로 분리하여 리마운트 방지
const InventoryItemRow = ({ 
  item, 
  source, 
  editingKey, 
  setEditingKey, 
  handleDragStart, 
  updateQuantity, 
  removeFromInventory 
}: { 
  item: InventoryItem, 
  source: 'backpack' | 'trunk',
  editingKey: string | null,
  setEditingKey: (key: string | null) => void,
  handleDragStart: (e: React.DragEvent, item: InventoryItem, source: 'backpack' | 'trunk') => void,
  updateQuantity: (id: string, source: 'backpack' | 'trunk', newQty: number) => void,
  removeFromInventory: (id: string, source: 'backpack' | 'trunk') => void
}) => {
  const key = `${source}:${item.id}`;
  const isEditing = editingKey === key;

  return (
    <div 
      draggable={true}
      onDragStart={(e) => handleDragStart(e, item, source)}
      className="flex justify-between items-center p-3 bg-white/5 rounded-xl border border-white/5 group hover:bg-white/10 hover:border-white/20 transition-all duration-200 cursor-grab active:cursor-grabbing relative overflow-hidden select-none"
    >
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 pointer-events-none"></div>
      
      <div className="flex flex-col relative z-10">
        <span className="text-xs font-bold text-gray-200">{item.name}</span>
        <span className="text-[10px] text-gray-500 font-mono mt-0.5 tracking-tight">상세 무게: {(item.weight * item.quantity).toFixed(1)}</span>
      </div>

      <div className="flex items-center gap-2 relative z-10" onDragStart={(e) => e.stopPropagation()}>
        {isEditing ? (
          <input
            id={`qty-${source}-${item.id}`}
            name="quantity"
            type="number"
            autoComplete="off"
            defaultValue={item.quantity}
            autoFocus
            className="w-14 bg-[#1a1a1a] border border-[#F2A900] rounded text-center text-xs font-black text-[#F2A900] focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                updateQuantity(item.id, source, parseInt((e.target as HTMLInputElement).value) || 0);
                setEditingKey(null);
              }
              if (e.key === 'Escape') setEditingKey(null);
            }}
            onBlur={(e) => {
              updateQuantity(item.id, source, parseInt(e.target.value) || 0);
              setEditingKey(null);
            }}
          />
        ) : (
          <div 
            onClick={() => setEditingKey(key)}
            className={`text-sm font-black px-2.5 py-1 rounded-lg border cursor-text hover:scale-105 transition-transform min-w-[35px] text-center ${source === 'backpack' ? 'text-[#F2A900] bg-[#F2A900]/10 border-[#F2A900]/20' : 'text-blue-400 bg-blue-400/10 border-blue-400/20'}`}
          >
            {item.quantity}
          </div>
        )}
        <button 
          onClick={(e) => { e.stopPropagation(); removeFromInventory(item.id, source); }}
          className="w-7 h-7 flex items-center justify-center bg-black/20 hover:bg-red-500/20 text-gray-500 hover:text-red-500 rounded-lg transition-all active:scale-90"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* 모바일 전용 이동 버튼 (D&D 대체) */}
        <button 
          onClick={(e) => {
            e.stopPropagation();
            const target = source === 'backpack' ? 'trunk' : 'backpack';
            (window as any)._handleMobileMove?.(item, source, target);
          }}
          className="xl:hidden w-7 h-7 flex items-center justify-center bg-[#F2A900]/20 text-[#F2A900] rounded-lg border border-[#F2A900]/30 active:scale-95"
          title={source === 'backpack' ? '트렁크로 이동' : '배낭으로 이동'}
        >
          {source === 'backpack' ? '→' : '←'}
        </button>
      </div>
    </div>
  );
};

export default function BackpackSimulator() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  
  const [consumables, setConsumables] = useState<any[]>([]);
  const [throwables, setThrowables] = useState<any[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [ammo, setAmmo] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [weapons, setWeapons] = useState<any[]>([]);

  const [hasVest, setHasVest] = useState<boolean>(true);
  const [backpackLevel, setBackpackLevel] = useState<0 | 1 | 2 | 3>(2);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  
  const [backpack, setBackpack] = useState<InventoryItem[]>([]);
  const [trunk, setTrunk] = useState<InventoryItem[]>([]);
  
  const [activeTab, setActiveTab] = useState<"회복/부스트" | "투척 무기" | "파츠" | "탄약" | "특수/무기">("회복/부스트");

  const [dropTarget, setDropTarget] = useState<'backpack' | 'trunk' | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const hasTrackedBackpackSuccessRef = useRef(false);

  useEffect(() => {
    // GA4 가방 계산기 피처 소비 시작 트래킹
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "backpack-calculator",
        status: "start"
      }
    });

    async function fetchAllData() {
      // 10초 후 강제 로딩 해제 (무한 로딩 방지)
      const timeoutId = setTimeout(() => {
        setLoading(false);
      }, 10000);

      try {
        const [
          { data: cons }, { data: throwa }, { data: atts }, { data: amms }, { data: vehs }, { data: weaps }
        ] = await Promise.all([
          // 게임에서 제거된 항목은 인벤토리 계산 대상에서 제외한다.
          supabase.from("consumables").select("*").is("removed_at", null),
          supabase.from("throwables").select("*").is("removed_at", null),
          supabase.from("attachments").select("*").is("removed_at", null),
          supabase.from("ammo").select("*").is("removed_at", null),
          supabase.from("vehicles").select("*").is("removed_at", null),
          supabase.from("weapons").select("*").is("removed_at", null)
        ]);

        setConsumables(cons || []);
        setThrowables(throwa || []);
        setAttachments(atts || []);
        setAmmo(amms || []);
        setVehicles(vehs || []);
        setWeapons(weaps || []);
        
        if (vehs && vehs.length > 0) {
          const porter = vehs.find(v => v.id === 'porter');
          setSelectedVehicleId(porter ? porter.id : vehs[0].id);
        }
      } catch {
        toast.error("가방 시뮬레이터 데이터를 불러오지 못했습니다.");
      } finally {
        clearTimeout(timeoutId);
        setLoading(false);
      }
    }
    fetchAllData();
  }, []);

  const selectedVehicle = useMemo(() => vehicles.find(v => v.id === selectedVehicleId), [vehicles, selectedVehicleId]);
  const maxBackpackCapacity = calcBackpackCapacity(hasVest, backpackLevel);
  const maxTrunkCapacity = selectedVehicle?.trunk_capacity || 0;
  
  const backpackWeight = useMemo(
    () => calcTotalWeight(backpack),
    [backpack]
  );
  const trunkWeight = useMemo(
    () => calcTotalWeight(trunk),
    [trunk]
  );

  const backpackPercent = Math.min((backpackWeight / maxBackpackCapacity) * 100, 100);
  const trunkPercent = maxTrunkCapacity > 0 ? Math.min((trunkWeight / maxTrunkCapacity) * 100, 100) : 0;

  const removeFromInventory = useCallback((id: string, source: 'backpack' | 'trunk') => {
    if (source === 'backpack') setBackpack(prev => prev.filter(i => i.id !== id));
    else setTrunk(prev => prev.filter(i => i.id !== id));
  }, []);

  // 모바일 이동 핸들러 등록 (변수 선언 이후로 이동)
  useEffect(() => {
    (window as any)._handleMobileMove = (item: InventoryItem, source: 'backpack' | 'trunk', target: 'backpack' | 'trunk') => {
      if (source === target) return;
      
      if (target === 'backpack') {
        if (item.can_be_in_backpack === false) {
          toast.warning("이 아이템은 배낭에 넣을 수 없습니다.");
          return;
        }
        if (backpackWeight + (item.weight * item.quantity) > maxBackpackCapacity) {
          toast.error("배낭 용량이 부족합니다!");
          return;
        }
        removeFromInventory(item.id, source);
        setBackpack(prev => {
          const existing = prev.find(i => i.id === item.id);
          if (existing) return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + item.quantity } : i);
          return [...prev, item];
        });
      } else {
        if (trunkWeight + (item.weight * item.quantity) > maxTrunkCapacity) {
          toast.error("트렁크 용량이 부족합니다!");
          return;
        }
        removeFromInventory(item.id, source);
        setTrunk(prev => {
          const existing = prev.find(i => i.id === item.id);
          if (existing) return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + item.quantity } : i);
          return [...prev, item];
        });
      }
    };
    return () => { delete (window as any)._handleMobileMove; };
  }, [backpackWeight, trunkWeight, maxBackpackCapacity, maxTrunkCapacity, removeFromInventory]);

  const updateQuantity = useCallback((id: string, source: 'backpack' | 'trunk', newQty: number) => {
    if (newQty <= 0) {
      removeFromInventory(id, source);
      return;
    }

    if (source === 'backpack') {
      setBackpack(prev => {
        const item = prev.find(i => i.id === id);
        if (!item) return prev;
        const weightDiff = (newQty - item.quantity) * item.weight;
        if (backpackWeight + weightDiff > maxBackpackCapacity) {
          toast.error("배낭 용량이 부족합니다!");
          return prev;
        }
        return prev.map(i => i.id === id ? { ...i, quantity: newQty } : i);
      });
    } else {
      setTrunk(prev => {
        const item = prev.find(i => i.id === id);
        if (!item) return prev;
        const weightDiff = (newQty - item.quantity) * item.weight;
        if (trunkWeight + weightDiff > maxTrunkCapacity) {
          toast.error("트렁크 용량이 부족합니다!");
          return prev;
        }
        return prev.map(i => i.id === id ? { ...i, quantity: newQty } : i);
      });
    }
  }, [backpackWeight, trunkWeight, maxBackpackCapacity, maxTrunkCapacity, removeFromInventory]);

  const handleDragStart = useCallback((e: React.DragEvent, item: InventoryItem, source: 'backpack' | 'trunk') => {
    e.dataTransfer.setData("item-data", JSON.stringify({ item, source }));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const trackBackpackSuccessOnce = useCallback(() => {
    if (hasTrackedBackpackSuccessRef.current) return;
    hasTrackedBackpackSuccessRef.current = true;

    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "backpack-calculator",
        status: "success"
      }
    });
  }, []);

  const handleDrop = (e: React.DragEvent, target: 'backpack' | 'trunk') => {
    e.preventDefault();
    setDropTarget(null);
    const data = e.dataTransfer.getData("item-data");
    if (!data) return;
    const { item, source } = JSON.parse(data);
    
    if (source === target) return;

    if (target === 'backpack') {
      if (item.can_be_in_backpack === false) {
        toast.warning("이 아이템은 배낭에 넣을 수 없습니다.");
        return;
      }
      if (backpackWeight + (item.weight * item.quantity) > maxBackpackCapacity) {
        toast.error("배낭 용량이 부족합니다!");
        return;
      }
      removeFromInventory(item.id, source);
      setBackpack(prev => {
        const existing = prev.find(i => i.id === item.id);
        if (existing) return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + item.quantity } : i);
        return [...prev, item];
      });
    } else {
      if (trunkWeight + (item.weight * item.quantity) > maxTrunkCapacity) {
        toast.error("트렁크 용량이 부족합니다!");
        return;
      }
      removeFromInventory(item.id, source);
      setTrunk(prev => {
        const existing = prev.find(i => i.id === item.id);
        if (existing) return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + item.quantity } : i);
        return [...prev, item];
      });
    }
  };

  const addToInventory = (item: any, category: string, target: 'backpack' | 'trunk', qty: number = 1) => {
    if (target === 'backpack') {
      if (item.can_be_in_backpack === false) {
        toast.warning(`'${item.name}'은 배낭에 수납할 수 없습니다. 트렁크를 이용하세요!`);
        return;
      }
      if (backpackWeight + (item.weight * qty) > maxBackpackCapacity) {
        toast.error("배낭 용량이 부족합니다!");
        return;
      }
      setBackpack(prev => {
        const existing = prev.find(i => i.id === item.id);
        if (existing) return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + qty } : i);
        return [...prev, { id: item.id, name: item.name, weight: item.weight, quantity: qty, category, can_be_in_backpack: item.can_be_in_backpack }];
      });
    } else {
      if (trunkWeight + (item.weight * qty) > maxTrunkCapacity) {
        toast.error("트렁크 용량이 부족합니다!");
        return;
      }
      setTrunk(prev => {
        const existing = prev.find(i => i.id === item.id);
        if (existing) return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + qty } : i);
        return [...prev, { id: item.id, name: item.name, weight: item.weight, quantity: qty, category, can_be_in_backpack: item.can_be_in_backpack }];
      });
    }

    trackBackpackSuccessOnce();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#0b0f19] text-[#F2A900] gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#F2A900]"></div>
        <p className="font-bold">시스템 로드 중...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0f19] text-white p-6 pb-20 overflow-y-auto w-full font-sans safe-top safe-bottom">
      <div className="relative max-w-[1600px] mx-auto w-full">
        
        {/* 헤더 */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-white/10 pb-6 mb-8">
          <div className="flex items-center gap-4">
             <BgmsIcon name="backpack" size={40} className="text-[#F2A900] drop-shadow-[0_0_15px_rgba(242,169,0,0.5)]" />
             <div>
               <h1 className="text-3xl font-black text-[#F2A900] tracking-tighter">배그 인벤토리 시뮬레이터 v2</h1>
               <p className="text-xs text-gray-400 mt-1.5 flex items-center gap-2">
                 <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                 시스템 고도화 완료: 드래그 앤 드롭 이동 및 직접 수량 입력 지원
               </p>
             </div>
          </div>
          <button onClick={() => router.push("/")} className="px-6 py-2.5 border border-white/10 rounded-xl bg-white/5 hover:bg-white/10 transition-all font-black text-sm active:scale-95 shadow-xl">
            홈으로 돌아가기
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
          {/* 왼쪽: 설정 및 가방 상태 */}
          <div className="xl:col-span-3 flex flex-col gap-6">
            <div className="bg-[#1a1a1a]/60 backdrop-blur-xl p-6 rounded-3xl border border-white/5 shadow-2xl">
              <h2 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-5 flex items-center gap-2">장비 설정</h2>
              <div className="flex flex-col gap-5">
                <div className="flex justify-between items-center bg-white/5 p-4 rounded-2xl border border-white/5 shadow-inner">
                  <span className="text-sm font-bold text-gray-300">내구도 조끼</span>
                  <button onClick={() => setHasVest(!hasVest)} className={`px-4 py-1.5 rounded-xl text-[10px] font-black transition-all ${hasVest ? "bg-[#34A853] text-white shadow-lg" : "bg-white/10 text-gray-500"}`}>
                    {hasVest ? "착용 중" : "미착용"}
                  </button>
                </div>
                <div>
                  <div className="flex justify-between mb-3 px-1"><span className="text-xs font-bold text-gray-400">배낭 레벨</span></div>
                  <div className="flex gap-2">
                    {[0,1,2,3].map(lv => (
                      <button key={lv} onClick={() => setBackpackLevel(lv as any)} className={`flex-1 py-3 text-xs font-black rounded-xl transition-all ${backpackLevel === lv ? "bg-gradient-to-br from-[#F2A900] to-[#cc8b00] text-black shadow-lg" : "bg-white/5 text-gray-500 hover:bg-white/10"}`}>
                        LV.{lv}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#1a1a1a]/80 backdrop-blur-md p-6 rounded-3xl border border-white/5 shadow-2xl">
              <h2 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-5 flex items-center gap-2">배낭 상태</h2>
              <div className="flex justify-between items-end mb-3">
                <span className="text-sm font-bold text-gray-300">현재 무게</span>
                <span className={`text-3xl font-mono font-black tracking-tighter ${backpackWeight > maxBackpackCapacity ? "text-red-500" : "text-[#F2A900]"}`}>
                  {backpackWeight.toFixed(1)} <span className="text-xs font-normal text-gray-500">/ {maxBackpackCapacity}</span>
                </span>
              </div>
              <div className="w-full bg-black/40 rounded-full h-5 p-1 border border-white/5">
                <div className={`h-full rounded-full transition-all duration-700 ease-out ${backpackWeight > maxBackpackCapacity ? "bg-red-500" : "bg-gradient-to-r from-[#F2A900] to-[#ffd700]"}`} style={{ width: `${backpackPercent}%` }}></div>
              </div>
            </div>

            <div className="bg-[#1a1a1a]/80 backdrop-blur-md p-6 rounded-3xl border border-white/5 shadow-2xl">
              <h2 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-5 flex items-center gap-2">현재 차량</h2>
              <select 
                id="vehicle-select"
                name="vehicle_type"
                className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-4 text-sm font-black text-blue-400 appearance-none cursor-pointer"
                value={selectedVehicleId || ""}
                onChange={(e) => setSelectedVehicleId(e.target.value)}
              >
                {vehicles.map(v => <option key={v.id} value={v.id} className="bg-[#1a1a1a] text-white font-bold">{v.name} (용량: {v.trunk_capacity})</option>)}
              </select>
              <div className="mt-6">
                <div className="flex justify-between items-end mb-3">
                  <span className="text-sm font-bold text-gray-300">트렁크 잔여 용량</span>
                  <span className={`text-3xl font-mono font-black tracking-tighter ${trunkWeight > maxTrunkCapacity ? "text-red-500" : "text-blue-400"}`}>
                    {trunkWeight.toFixed(1)} <span className="text-xs font-normal text-gray-500">/ {maxTrunkCapacity}</span>
                  </span>
                </div>
                <div className="w-full bg-black/40 rounded-full h-5 p-1 border border-white/5">
                  <div className={`h-full rounded-full transition-all duration-700 ease-out ${trunkWeight > maxTrunkCapacity ? "bg-red-500" : "bg-gradient-to-r from-blue-600 to-blue-400"}`} style={{ width: `${trunkPercent}%` }}></div>
                </div>
              </div>
            </div>
          </div>

          {/* 중간: 인벤토리 목록 */}
          <div className="xl:col-span-5 flex flex-col gap-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 flex-1">
              <div 
                onDragOver={(e) => { e.preventDefault(); setDropTarget('backpack'); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleDrop(e, 'backpack')}
                className={`bg-[#1a1a1a]/80 backdrop-blur-md rounded-[2.5rem] border transition-all duration-300 flex flex-col overflow-hidden min-h-[600px] shadow-2xl ${dropTarget === 'backpack' ? 'border-[#F2A900] scale-[1.02] bg-[#F2A900]/10' : 'border-white/5'}`}
              >
                <div className="p-6 bg-white/5 border-b border-white/5 flex justify-between items-center">
                  <span className="font-black text-[14px] tracking-[0.05em] text-[#F2A900] uppercase">
                    <InlineIconLabel icon="backpack">배낭 인벤토리</InlineIconLabel>
                  </span>
                  <button onClick={() => setBackpack([])} className="text-[10px] text-red-500 font-black hover:bg-red-500/10 px-3 py-1 rounded-lg transition-all">전체 비우기</button>
                </div>
                <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-3">
                  {backpack.map(item => (
                    <InventoryItemRow 
                      key={item.id} 
                      item={item} 
                      source="backpack"
                      editingKey={editingKey}
                      setEditingKey={setEditingKey}
                      handleDragStart={handleDragStart}
                      updateQuantity={updateQuantity}
                      removeFromInventory={removeFromInventory}
                    />
                  ))}
                  {backpack.length === 0 && <div className="m-auto text-gray-700 font-black text-[11px] animate-pulse">여기로 드래그하세요</div>}
                </div>
              </div>

              <div 
                onDragOver={(e) => { e.preventDefault(); setDropTarget('trunk'); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleDrop(e, 'trunk')}
                className={`bg-[#1a1a1a]/80 backdrop-blur-md rounded-[2.5rem] border transition-all duration-300 flex flex-col overflow-hidden min-h-[600px] shadow-2xl ${dropTarget === 'trunk' ? 'border-blue-400 scale-[1.02] bg-blue-400/10' : 'border-white/5'}`}
              >
                <div className="p-6 bg-white/5 border-b border-white/5 flex justify-between items-center">
                  <span className="font-black text-[14px] tracking-[0.05em] text-blue-400 uppercase">
                    <InlineIconLabel icon="vehicle">트렁크 보관함</InlineIconLabel>
                  </span>
                  <button onClick={() => setTrunk([])} className="text-[10px] text-red-500 font-black hover:bg-red-500/10 px-3 py-1 rounded-lg transition-all">전체 비우기</button>
                </div>
                <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-3">
                  {trunk.map(item => (
                    <InventoryItemRow 
                      key={item.id} 
                      item={item} 
                      source="trunk"
                      editingKey={editingKey}
                      setEditingKey={setEditingKey}
                      handleDragStart={handleDragStart}
                      updateQuantity={updateQuantity}
                      removeFromInventory={removeFromInventory}
                    />
                  ))}
                  {trunk.length === 0 && <div className="m-auto text-gray-700 font-black text-[11px] animate-pulse">여기로 드래그하세요</div>}
                </div>
              </div>
            </div>
          </div>

          <div className="xl:col-span-4 bg-[#1a1a1a]/80 backdrop-blur-md rounded-[2.5rem] border border-white/5 flex flex-col overflow-hidden shadow-2xl">
            <div className="p-3 flex gap-2 bg-white/5 border-b border-white/5 overflow-x-auto scrollbar-hide">
              {["회복/부스트", "투척 무기", "파츠", "탄약", "특수/무기"].map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab as any)} className={`flex-1 min-w-[70px] px-4 py-3 rounded-2xl font-black text-[10px] transition-all duration-300 ${activeTab === tab ? "bg-[#34A853] text-white shadow-lg" : "text-gray-500 hover:bg-white/10"}`}>
                  {tab}
                </button>
              ))}
            </div>
            <div className="p-6 flex-1 overflow-y-auto max-h-[75vh]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(activeTab === "회복/부스트" ? consumables :
                  activeTab === "투척 무기" ? throwables :
                  activeTab === "파츠" ? attachments :
                  activeTab === "탄약" ? ammo :
                  weapons.filter(w => w.can_be_in_backpack === false || w.weight > 0)).map(item => (
                  <div key={item.id} className="bg-white/5 border border-white/5 p-4 rounded-[1.5rem] flex flex-col justify-between hover:border-[#F2A900]/30 transition-all duration-300 group shadow-lg">
                    <div>
                      <div className="flex justify-between items-start mb-3">
                        <div className="font-black text-gray-200 text-xs tracking-tight">{item.name}</div>
                        {item.can_be_in_backpack === false && <span className="bg-red-500/10 text-red-500 text-[8px] font-black px-2 py-0.5 rounded-full border border-red-500/20">ONLY TRUNK</span>}
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono tracking-tighter">단위 무게: <span className="text-[#F2A900] font-black">{item.weight}</span></div>
                    </div>
                    <div className="mt-6 flex flex-col gap-2.5">
                      <button 
                        onClick={() => addToInventory(item, activeTab, 'backpack', activeTab === "탄약" ? 30 : 1)}
                        className={`w-full text-[10px] font-black py-3 rounded-2xl transition-all active:scale-95 shadow-md ${item.can_be_in_backpack === false ? "bg-gray-800/40 text-gray-600 cursor-not-allowed" : "bg-gradient-to-br from-[#F2A900] to-[#cc8b00] text-black"}`}
                      >
                        배낭에 담기
                      </button>
                      <button 
                        onClick={() => addToInventory(item, activeTab, 'trunk', activeTab === "탄약" ? 30 : 1)}
                        className="w-full bg-gradient-to-br from-[#3b82f6] to-[#2563eb] text-white text-[10px] font-black py-3 rounded-2xl transition-all active:scale-95 shadow-md"
                      >
                        트렁크에 담기
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 flex justify-center md:hidden" aria-label="광고">
          <AdfitBanner
            adUnit={BACKPACK_MOBILE_AD_UNIT}
            adWidth={320}
            adHeight={100}
            className="max-w-full"
          />
        </div>

        <div className="mt-8 hidden justify-center md:flex min-[1880px]:hidden" aria-label="광고">
          <AdfitBanner
            adUnit={BACKPACK_LEADERBOARD_AD_UNIT}
            adWidth={728}
            adHeight={90}
            className="max-w-full"
          />
        </div>

        <aside className="hidden min-[1880px]:block absolute left-[calc(100%+24px)] top-0 w-[160px] h-full" aria-label="광고">
          <div className="sticky top-24">
            <AdfitBanner
              adUnit={BACKPACK_DESKTOP_AD_UNIT}
              adWidth={160}
              adHeight={600}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
