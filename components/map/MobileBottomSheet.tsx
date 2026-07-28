'use client';

import React from 'react';
import AdfitBanner from "../ads/AdfitBanner";


import { X, ChevronUp, Map as MapIcon } from 'lucide-react';
import { Drawer } from 'vaul';
import { useMapSettings } from '@/hooks/useMapSettings';
import { BgmsIcon } from '@/components/common/BgmsIcon';


interface MobileBottomSheetProps {
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
  mapLabel: string;
  activeMapId: string;
  filters: { [key: string]: boolean };
  toggleFilter: (id: string) => void;
  getCount: (id: string) => number;
}

export default function MobileBottomSheet({
  isOpen,
  setIsOpen,
  mapLabel,
  activeMapId,
  filters,
  toggleFilter,
  getCount,
}: MobileBottomSheetProps) {
  // DB 기반 동적 취든 및 카테고리 정보 로드
  const { activeCategories: currentCategories, categoryInfoMap } = useMapSettings(activeMapId);


  return (
    <Drawer.Root open={isOpen} onOpenChange={setIsOpen}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/60 z-[5000] backdrop-blur-[2px]" />
        <Drawer.Content className="bg-[#121212] flex flex-col rounded-t-[32px] h-[85%] mt-24 fixed bottom-0 left-0 right-0 z-[5001] outline-none border-t border-[#333]">
          <div className="flex-1 overflow-y-auto p-4 rounded-t-[32px]">
            {/* 드래그 핸들 */}
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-[#333] mb-8" />
            
            <div className="max-w-md mx-auto">
              <div className="flex items-center justify-between mb-6">
                <Drawer.Title className="text-2xl font-black text-[#F2A900] tracking-tighter flex items-center gap-2">
                  <MapIcon size={24} />
                  <span>{mapLabel} 전술 정보</span>
                </Drawer.Title>
                <Drawer.Description className="sr-only">
                  {mapLabel}의 주요 차량 스폰 위치 및 전술 정보를 필터링하여 확인합니다.
                </Drawer.Description>
                <button 
                  onClick={() => setIsOpen(false)}
                  className="p-2 bg-[#222] rounded-full text-[#777] active:bg-[#333] transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {/* 필터 섹션 */}
              <div className="space-y-4">
                <section>
                  <h3 className="text-[#555] text-xs font-black uppercase tracking-widest mb-3 ml-1">상태 필터</h3>
                  <div
                    onClick={() => toggleFilter("pending")}
                    className={`flex items-center justify-between p-4 rounded-2xl transition-all border-l-4 cursor-pointer ${
                        filters["pending"] ? "bg-[#3b2f15] border-[#F2A900]" : "bg-[#1a1a1a] border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <BgmsIcon name="eye" size={24} className={filters["pending"] ? "text-[#F2A900]" : "text-[#777]"} />
                      <div className="flex flex-col">
                        <span className={`text-[13px] ${filters["pending"] ? "text-[#F2A900] font-black" : "text-[#777]"}`}>
                          실시간 제보 진행 중
                        </span>
                        <span className="text-[10px] text-[#555]">검증이 필요한 차량 스폰 지점</span>
                      </div>
                    </div>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${filters["pending"] ? "bg-[#F2A900] text-black" : "bg-black/40 text-[#444]"}`}>
                      <ChevronUp size={16} className={filters["pending"] ? "" : "rotate-180"} />
                    </div>
                  </div>
                </section>

                <div className="h-[1px] bg-[#222] my-2" />

                <section>
                  <h3 className="text-[#555] text-xs font-black uppercase tracking-widest mb-3 ml-1">스폰 카테고리</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {currentCategories.map((id) => {
                      const item = categoryInfoMap[id];
                      if (!item) return null;

                      return (
                        <div
                          key={id}
                          onClick={() => toggleFilter(id)}
                          className={`flex flex-col gap-3 p-4 rounded-2xl transition-all border-l-4 cursor-pointer relative overflow-hidden ${
                            filters[id] ? "bg-[#1a1a1a] border-l-4 shadow-[inset_0_0_20px_rgba(0,0,0,0.3)]" : "bg-[#1a1a1a] border-transparent"
                          }`}
                          style={{ borderLeftColor: filters[id] ? item.color : 'transparent' }}
                        >
                          <div className="flex items-center justify-between">
                            <svg
                              viewBox="0 0 24 24"
                              width="22"
                              height="22"
                              fill={filters[id] ? item.color : "#444"}
                            >
                              <path d={item.path} />
                            </svg>
                            <span className={`text-[11px] font-black ${filters[id] ? "text-white" : "text-[#444]"}`}>
                                {getCount(id)}
                            </span>
                          </div>
                          <span className={`text-[13px] font-bold tracking-tight ${filters[id] ? "text-white" : "text-[#777]"}`}>
                              {item.label}
                          </span>
                          
                          {/* 하단 활성화 데코레이션 */}
                          {filters[id] && (
                            <div 
                                className="absolute bottom-0 right-0 w-8 h-8 rounded-tl-full opacity-20"
                                style={{ backgroundColor: item.color }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
                
                {/* 모바일 화면 하단 광고 — 심사 통과 및 규격에 맞춰 320x100 탑재 */}
                <div className="my-4 flex justify-center">
                  <AdfitBanner
                    adUnit="DAN-tQGcqmddMC8tPpXA"
                    adWidth={320}
                    adHeight={100}
                  />
                </div>

                {/* 하단 미니 푸터 */}
                <div className="mt-8 pt-6 border-t border-[#222] pb-10">
                  <div className="flex items-center gap-4 mb-3 px-1">
                    <a 
                      href="https://discord.gg/T97MR78awb" 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="text-[11px] text-[#5865F2] font-black uppercase tracking-tight"
                    >
                      Discord
                    </a>
                  </div>
                  <p className="text-[10px] text-[#333] leading-relaxed px-1 font-medium">
                    © 2026 BGMS Team. All Rights Reserved.<br/>
                    BGMS는 배틀그라운드 팬을 위한 비공식 서비스입니다.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
