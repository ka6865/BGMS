"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MapContainer,
  TileLayer,
  Marker,
  CircleMarker,
  Tooltip,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L, { CRS } from "leaflet";
import "leaflet/dist/leaflet.css";
import { 
  Eye, 
  EyeOff, 
  Save, 
  Trash2, 
  LogOut, 
  Map as MapIcon, 
  CheckCircle2, 
  ChevronRight,
  PlusCircle,
  FileJson,
  Search,
  X
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { useMapSettings } from "@/hooks/useMapSettings";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import ConfirmModal from "@/components/common/ConfirmModal";

// SVG 경로와 색상을 조합해 커스텀 지도 마커 아이콘 객체 생성
const createPinIcon = (colorCode: string, pathData: string) => {
  return L.divIcon({
    className: "custom-pin-icon",
    html: `
      <div style="position: relative; width: 28px; height: 38px;">
        <svg viewBox="0 0 30 42" style="width: 100%; height: 100%; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));">
          <path d="M15 0C6.7 0 0 6.7 0 15c0 8.3 15 27 15 27s15-18.7 15-27C30 6.7 23.3 0 15 0z" fill="${colorCode}"/>
        </svg>
        <div style="position: absolute; top: 0; left: 0; width: 100%; height: 26px; display: flex; align-items: center; justify-content: center;">
          <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: white;">
            <path d="${pathData}"/>
          </svg>
        </div>
      </div>
    `,
    iconSize: [28, 38],
    iconAnchor: [14, 38],
  });
};

const MAP_LIST = [
  { id: "Erangel", label: "에란겔", imageUrl: "/Erangel.jpg" },
  { id: "Miramar", label: "미라마", imageUrl: "/Miramar.jpg" },
  { id: "Taego", label: "태이고", imageUrl: "/Taego.jpg" },
  { id: "Rondo", label: "론도", imageUrl: "/Rondo.jpg" },
  { id: "Vikendi", label: "비켄디", imageUrl: "/Vikendi.jpg" },
  { id: "Deston", label: "데스턴", imageUrl: "/Deston.jpg" },
];

const MAP_INDEX_MAP: Record<string, number> = {
  Erangel: 1,
  Miramar: 2,
  Taego: 3,
  Vikendi: 4,
  Deston: 5,
  Rondo: 6,
};

const CATEGORY_CODE_MAP: Record<string, number> = {
  Garage: 1,
  Esports: 2,
  Boat: 3,
  EsportsBoat: 4,
  Glider: 5,
  Key: 6,
  Porter: 7,
  SecretRoom: 8,
  GoldenMirado: 9,
  EsportsMirado: 10,
  EsportsPickup: 11,
  PoliceCar: 12,
  SecurityCard: 13,
  GasPump: 14,
  Snowmobile: 15,
};

const MapEvents = ({
  onClick,
}: {
  onClick: (e: L.LeafletMouseEvent) => void;
}) => {
  useMapEvents({ click: onClick });
  return null;
};

const MapController = ({
  center,
  zoom,
}: {
  center: [number, number];
  zoom: number;
}) => {
  const map = useMap();
  useEffect(() => {
    // Leaflet의 tap 핸들러가 모바일에서 click 이벤트를 삼키는 현상을 방지
    if ((map as any).tap) {
      (map as any).tap.disable();
    }
  }, [map]);

  useEffect(() => {
    map.setView(center, zoom, { animate: true });
  }, [center, zoom, map]);
  return null;
};

const MapEditorComponent = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [isAuthorized, setIsAuthorized] = useState(false);
  const [activeMapId, setActiveMapId] = useState("Erangel");
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // 모바일 화면 감지
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const currentMap = MAP_LIST.find((m) => m.id === activeMapId);

  const imageWidth = 8192;
  const imageHeight = 8192;
  const bounds: [[number, number], [number, number]] = [
    [0, 0],
    [imageHeight, imageWidth],
  ];

  const latParam = searchParams?.get("lat");
  const lngParam = searchParams?.get("lng");

  const initialCenter = useMemo<[number, number]>(() => {
    return latParam && lngParam
      ? [Number(latParam), Number(lngParam)]
      : [imageHeight / 2, imageWidth / 2];
  }, [latParam, lngParam, imageHeight, imageWidth]);

  const initialZoom = useMemo(() => {
    return latParam && lngParam ? 0 : -3;
  }, [latParam, lngParam]);

  const [isLoaded, setIsLoaded] = useState(false);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [pendingVehicles, setPendingVehicles] = useState<any[]>([]);

  // 3단계 알럿 모달화 상태
  const [isClearAllModalOpen, setIsClearAllModalOpen] = useState(false);
  const [isSaveConfirmModalOpen, setIsSaveConfirmModalOpen] = useState(false);

  const { activeCategories: allowedCategories, categoryInfoMap } = useMapSettings(activeMapId, true);

  const icons = useMemo(() => {
    const res: Record<string, L.DivIcon> = {};
    Object.keys(categoryInfoMap).forEach((key) => {
      res[key] = createPinIcon(
        categoryInfoMap[key].color,
        categoryInfoMap[key].path
      );
    });
    return res;
  }, [categoryInfoMap]);

  const [activeType, setActiveType] = useState<string>("Esports");
  const [filters, setFilters] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState("");

  // categoryInfoMap 로드 시 필터 초기화
  useEffect(() => {
    if (Object.keys(categoryInfoMap).length > 0) {
      setFilters(prev => {
        const next = { ...prev };
        Object.keys(categoryInfoMap).forEach(key => {
          if (next[key] === undefined) next[key] = true;
        });
        return next;
      });
    }
  }, [categoryInfoMap]);

  const effectiveActiveType = useMemo(() => {
    if (Object.keys(categoryInfoMap).includes(activeType)) return activeType;
    return Object.keys(categoryInfoMap)[0] || "Esports";
  }, [activeType, categoryInfoMap]);

  useEffect(() => {
    const checkAdmin = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        toast.error("관리자 로그인이 필요합니다.");
        router.push("/login");
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();

      if (profile?.role !== "admin") {
        toast.warning("관리자 권한이 없습니다.");
        router.push("/");
        return;
      }

      setIsAuthorized(true);

      const { data: dbMarkers, error: fetchError } = await supabase
        .from("map_markers")
        .select("*")
        .eq("map_id", activeMapId);

      if (fetchError) {
        console.error("Error fetching map markers:", fetchError);
        toast.error("마커 데이터를 불러오는 데 실패했습니다.");
        return;
      }

      const currentMapMarkers = dbMarkers
        ? dbMarkers.map((v) => ({ ...v, mapId: v.map_id }))
        : [];

      setVehicles(currentMapMarkers);

      const { data: pendingData } = await supabase
        .from("pending_markers")
        .select("*")
        .eq("map_name", activeMapId);
        
      setPendingVehicles(pendingData || []);

      setIsLoaded(true);
    };
    checkAdmin();
  }, [router, activeMapId]);

  useEffect(() => {
    if (isLoaded)
      localStorage.setItem("pubg-vehicles", JSON.stringify(vehicles));
  }, [vehicles, isLoaded]);

  const visibleVehicles = useMemo(() => {
    return vehicles.filter(
      (v) =>
        (v.mapId === activeMapId || (!v.mapId && activeMapId === "Erangel")) &&
        filters[v.type]
    );
  }, [vehicles, activeMapId, filters]);

  const removeVehicle = (id: number) =>
    setVehicles((prev) => prev.filter((v) => v.id !== id));

  const clearAllVehicles = () => {
    setIsClearAllModalOpen(true);
  };

  const executeClearAllVehicles = () => {
    setIsClearAllModalOpen(false);
    setVehicles((prev) =>
      prev.filter(
        (v) =>
          !(
            v.mapId === activeMapId ||
            (!v.mapId && activeMapId === "Erangel")
          )
      )
    );
    toast.success("현재 맵의 모든 마커가 삭제되었습니다.");
  };

  const updateVehiclePos = (id: number, newY: number, newX: number) => {
    setVehicles((prev) =>
      prev.map((v) => (v.id === id ? { ...v, y: newY, x: newX } : v))
    );
  };

  const toggleFilter = (type: string) =>
    setFilters((prev) => ({ ...prev, [type]: !prev[type] }));

  const getCount = (type: string) =>
    vehicles.filter(
      (v) =>
        (v.mapId === activeMapId || (!v.mapId && activeMapId === "Erangel")) &&
        v.type === type
    ).length;

  const totalCount = vehicles.filter(
    (v) => v.mapId === activeMapId || (!v.mapId && activeMapId === "Erangel")
  ).length;

  const handleSaveToDB = () => {
    setIsSaveConfirmModalOpen(true);
  };

  const executeSaveToDB = async () => {
    setIsSaveConfirmModalOpen(false);
    setIsSaving(true);

    try {
      const { data: dbMarkers } = await supabase
        .from("map_markers")
        .select("id")
        .eq("map_id", activeMapId);
      const dbIds = dbMarkers?.map((m) => m.id) || [];
      const currentMapVehicles = vehicles.filter(
        (v) =>
          v.mapId === activeMapId || (!v.mapId && activeMapId === "Erangel")
      );
      const currentIds = currentMapVehicles.map((v) => v.id);

      const idsToDelete = dbIds.filter((id) => !currentIds.includes(id));
      if (idsToDelete.length > 0) {
        const { error: deleteError } = await supabase
          .from("map_markers")
          .delete()
          .in("id", idsToDelete);
        if (deleteError) throw deleteError;
      }

      const insertData = currentMapVehicles.map((v) => ({
        id: Number(v.id),
        map_id: String(v.mapId || activeMapId),
        name: String(v.name || ""),
        type: String(v.type),
        x: Math.round(v.x),
        y: Math.round(v.y),
      }));

      if (insertData.length > 0) {
        const chunkSize = 500;
        for (let i = 0; i < insertData.length; i += chunkSize) {
          const chunk = insertData.slice(i, i + chunkSize);
          const { error: insertError } = await supabase
            .from("map_markers")
            .upsert(chunk);
          if (insertError) throw insertError;
        }
      }
      toast.success(
        `'${currentMap?.label}' 맵의 마커 ${insertData.length}개가 저장되었습니다!`
      );
    } catch (error: any) {
      console.error("서버 저장 에러:", error);
      toast.error("저장 실패: " + (error.message || "알 수 없는 오류 발생."));
    } finally {
      setIsSaving(false);
    }
  };

  const handleMapClick = (e: L.LeafletMouseEvent) => {
    const newVehicle = {
      id: Date.now(),
      name: categoryInfoMap[effectiveActiveType]?.label || "마커",
      x: e.latlng.lng,
      y: e.latlng.lat,
      mapId: activeMapId,
      type: effectiveActiveType,
    };
    setVehicles((prev) => [...prev, newVehicle]);
    
    // 마커 추가 시 가시성 필터가 꺼져있으면 켜줌
    if (!filters[effectiveActiveType]) {
      setFilters(prev => ({ ...prev, [effectiveActiveType]: true }));
    }
  };

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const importedData = JSON.parse(content);

        if (!Array.isArray(importedData)) {
          throw new Error("올바른 JSON 배열 형식이 아닙니다.");
        }

        const mapIdx = MAP_INDEX_MAP[activeMapId] || 9;
        const newMarkers = importedData.map((item: any, index: number) => {
          const catCode = CATEGORY_CODE_MAP[item.type] || 99;
          
          const prefix = mapIdx * 100000 + catCode * 1000;
          const sameTypeMarkers = vehicles.filter(v => 
            v.mapId === activeMapId && 
            Math.floor(Number(v.id) / 1000) === Math.floor(prefix / 1000)
          );
          
          const maxIdx = sameTypeMarkers.length > 0 
            ? Math.max(...sameTypeMarkers.map(v => Number(v.id) % 1000))
            : 0;

          return {
            id: prefix + maxIdx + index + 1,
            mapId: item.map_id || activeMapId,
            type: item.type,
            name: item.name || categoryInfoMap[item.type]?.label || "추출 마커",
            x: Number(item.x),
            y: Number(item.y),
          };
        });

        setVehicles((prev) => [...prev, ...newMarkers]);
        toast.success(`${newMarkers.length}개의 마커를 성공적으로 추가했습니다!`);
      } catch (err: any) {
        toast.error("파일 로드 실패: " + err.message);
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  if (!isAuthorized)
    return (
      <div className="w-full h-screen bg-[#0b0f19] flex items-center justify-center text-white font-bold">
        권한 확인 중...
      </div>
    );

  return (
    <div className="flex w-full h-screen bg-[#0b0f19] overflow-hidden relative">
      {/* 모바일 화면용 사이드바 배경 Overlay */}
      {isMobile && isSidebarOpen && (
        <div 
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 bg-black/60 z-[5500] backdrop-blur-sm transition-opacity duration-300"
        />
      )}

      {/* 🌟 사이드바 개편 */}
      <aside className={`
        ${isMobile 
          ? `fixed left-0 top-0 bottom-0 z-[6000] w-[300px] transition-transform duration-300 shadow-2xl ${isSidebarOpen ? 'translate-x-0' : 'translate-x-[-100%]'}` 
          : 'w-[340px]'
        } 
        flex flex-col bg-[#111827]/95 backdrop-blur-xl border-r border-white/5 shadow-2xl h-full
      `}>
        {/* 사이드바 헤더 */}
        <div className="p-6 border-b border-white/5">
          <div className="flex items-center justify-between mb-6">
            <div className="text-2xl font-black italic text-[#F2A900] tracking-tighter">
              PUBG<span className="text-white">EDITOR</span>
            </div>
            <div className="flex items-center gap-1">
              <button 
                onClick={() => router.push("/")}
                className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                title="나가기"
              >
                <LogOut size={20} />
              </button>
              {isMobile && (
                <button 
                  onClick={() => setIsSidebarOpen(false)}
                  className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                  title="닫기"
                >
                  <X size={20} />
                </button>
              )}
            </div>
          </div>
          
          {/* 검색창 추가 */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={14} />
            <input 
              type="text"
              placeholder="카테고리 검색..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white/5 border border-white/5 focus:border-[#F2A900]/50 focus:bg-white/10 rounded-xl py-2 pl-9 pr-4 text-xs text-white placeholder-gray-600 outline-none transition-all"
            />
            {searchTerm && (
              <button 
                onClick={() => setSearchTerm("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* 맵 선택 섹션 */}
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-gray-500 flex items-center gap-2 mb-3">
              <MapIcon size={12} /> Select Active Map
            </label>
            <div className="grid grid-cols-2 gap-2">
              {MAP_LIST.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setActiveMapId(m.id)}
                  className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-all border ${
                    activeMapId === m.id
                      ? "bg-[#F2A900] text-black border-[#F2A900] shadow-[0_0_15px_rgba(242,169,0,0.3)]"
                      : "bg-white/5 text-gray-400 border-white/5 hover:border-white/20 hover:bg-white/10"
                  }`}
                >
                  {m.label}
                  {activeMapId === m.id && <CheckCircle2 size={12} />}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 카테고리 리스트 섹션 */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-1">
          <div className="flex items-center justify-between px-2 mb-4">
            <label className="text-[10px] font-black uppercase tracking-widest text-gray-500 flex items-center gap-2">
              <PlusCircle size={12} /> Marker Categories
            </label>
            <div className="flex gap-1">
              <button 
                onClick={() => {
                  const newFilters: Record<string, boolean> = {};
                  Object.keys(categoryInfoMap).forEach(id => newFilters[id] = true);
                  setFilters(newFilters);
                }}
                className="text-[9px] font-bold text-gray-500 hover:text-[#F2A900] transition-colors"
              >
                전체 켜기
              </button>
              <span className="text-gray-700 text-[9px]">/</span>
              <button 
                onClick={() => setFilters({})}
                className="text-[9px] font-bold text-gray-500 hover:text-red-400 transition-colors"
              >
                끄기
              </button>
            </div>
          </div>
          
          {Object.keys(categoryInfoMap)
            .filter(id => {
              const info = categoryInfoMap[id];
              return info.label.toLowerCase().includes(searchTerm.toLowerCase()) || id.toLowerCase().includes(searchTerm.toLowerCase());
            })
            .sort((a, b) => {
              const aRec = allowedCategories.includes(a);
              const bRec = allowedCategories.includes(b);
              if (aRec && !bRec) return -1;
              if (!aRec && bRec) return 1;
              return categoryInfoMap[a].label.localeCompare(categoryInfoMap[b].label);
            })
            .map((id) => {
            const info = categoryInfoMap[id];
            const isActive = effectiveActiveType === id;
            const isFiltered = filters[id];
            const isMapRecommended = allowedCategories.includes(id);
            const count = getCount(id);

            return (
              <div
                key={id}
                className={`group flex items-center gap-2 p-1.5 rounded-xl transition-all border ${
                  isActive 
                    ? "bg-[#F2A900]/10 border-[#F2A900]/30 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]" 
                    : "bg-transparent border-transparent hover:bg-white/5"
                }`}
              >
                {/* 가시성 토글 */}
                <button
                  onClick={() => toggleFilter(id)}
                  className={`p-2 rounded-lg transition-all ${
                    isFiltered ? "text-[#F2A900] bg-[#F2A900]/10" : "text-gray-600 bg-white/5 hover:text-gray-400"
                  }`}
                  title={isFiltered ? "지도에서 숨기기" : "지도에 표시하기"}
                >
                  {isFiltered ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>

                {/* 카테고리 선택 영역 */}
                <div
                  onClick={() => {
                    setActiveType(id);
                    if (!isFiltered) toggleFilter(id); // 선택 시 자동으로 켬
                  }}
                  className="flex-1 flex items-center gap-3 cursor-pointer py-1"
                >
                  <div 
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shadow-lg relative"
                    style={{ 
                      backgroundColor: isFiltered ? `${info.color}20` : "#1f2937", 
                      color: isFiltered ? info.color : "#4b5563" 
                    }}
                  >
                    {info.iconType}
                    {isMapRecommended && (
                      <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-[#111827]" title="추천 카테고리" />
                    )}
                  </div>
                  <div className="flex flex-col">
                    <span className={`text-sm font-bold tracking-tight ${isActive ? "text-white" : "text-gray-400 group-hover:text-gray-300"}`}>
                      {info.label}
                    </span>
                    <span className="text-[9px] font-mono text-gray-500 uppercase tracking-tighter">
                      {id} • {count}
                    </span>
                  </div>
                </div>

                {/* 선택 표시 */}
                {isActive && (
                  <div className="pr-2 text-[#F2A900] animate-pulse">
                    <ChevronRight size={16} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 사이드바 하단 액션 */}
        <div className="p-6 bg-black/20 border-t border-white/5 space-y-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-white/5 hover:bg-white/10 text-gray-300 rounded-xl font-bold text-xs transition-all border border-white/5"
            >
              {isImporting ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <FileJson size={14} />}
              JSON 불러오기
            </button>
            <button
              onClick={clearAllVehicles}
              className="px-4 flex items-center justify-center text-gray-500 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all border border-transparent hover:border-red-500/20"
              title="현재 맵 마커 전체 삭제"
            >
              <Trash2 size={16} />
            </button>
          </div>

          <button
            onClick={handleSaveToDB}
            disabled={isSaving}
            className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-sm transition-all shadow-xl ${
              isSaving
                ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                : "bg-emerald-500 text-black hover:bg-emerald-400 active:scale-[0.98] shadow-emerald-500/20"
            }`}
          >
            {isSaving ? "처리 중..." : <><Save size={18} /> 서버에 최종 저장</>}
          </button>
          
          <div className="text-[10px] text-center text-gray-600 font-medium">
            현재 맵 마커 총 <span className="text-gray-400">{totalCount}</span>개
          </div>
        </div>
      </aside>

      {/* 메인 맵 영역 */}
      <main className="flex-1 relative w-full h-full">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImportJSON}
          accept=".json"
          className="hidden"
        />

        {/* 모바일 전용 에디터 메뉴 플로팅 버튼 */}
        {isMobile && (
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="absolute top-4 left-4 z-[4000] flex items-center gap-2 px-4 py-2.5 bg-[#F2A900] text-black font-black text-xs rounded-xl shadow-lg active:scale-[0.95] transition-all"
          >
            <span>🛠️</span> 에디터 메뉴
          </button>
        )}

        <MapContainer
          center={initialCenter}
          zoom={initialZoom}
          minZoom={-4}
          maxZoom={5}
          crs={CRS.Simple}
          maxBounds={bounds}
          maxBoundsViscosity={1.0}
          style={{ height: "100%", width: "100%", background: "#0b0f19" }}
        >
          <MapController center={initialCenter} zoom={initialZoom} />

          <TileLayer
             key={activeMapId}
             url={`/tiles/${activeMapId}/{z}/{x}/{y}.jpg`}
             minZoom={-4}
             maxZoom={5}
             maxNativeZoom={0}
             zoomOffset={5}
             bounds={bounds}
             noWrap={true}
          />
          <MapEvents onClick={handleMapClick} />
          {visibleVehicles.map((vehicle) => (
            <Marker
              key={vehicle.id}
              position={[vehicle.y, vehicle.x]}
              draggable={true}
              icon={icons[vehicle.type] || icons["Esports"]}
              eventHandlers={{
                dragend: (e) => {
                  const marker = e.target;
                  const pos = marker.getLatLng();
                  updateVehiclePos(vehicle.id, pos.lat, pos.lng);
                },
                contextmenu: (e) => {
                  e.originalEvent.preventDefault();
                  e.originalEvent.stopPropagation();
                  removeVehicle(vehicle.id);
                },
                click: (e) => {
                  e.originalEvent.stopPropagation();
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -30]} opacity={1}>
                <div className="bg-[#1a1a1a] text-white p-1 rounded font-bold text-[10px]">
                  {categoryInfoMap[vehicle.type]?.label || vehicle.type}
                </div>
              </Tooltip>
            </Marker>
          ))}

          {pendingVehicles.map((v) => {
            const weight = v.weight || 1;
            const radius = 15 + weight * 4;
            const color = weight >= 5 ? "#ef4444" : "#f59e0b";
            return (
              <CircleMarker
                key={`pending-${v.id}`}
                center={[v.y, v.x]}
                radius={radius}
                color={color}
                fillColor={color}
                fillOpacity={0.4}
                weight={2}
                interactive={false}
              >
                <Tooltip direction="top" opacity={0.9} permanent>
                  <InlineIconLabel icon="eye" iconSize={12}>제보: {v.marker_type}</InlineIconLabel>
                </Tooltip>
              </CircleMarker>
            );
          })}
        </MapContainer>

        {/* 맵 좌표 가이드 (우측 하단) */}
        <div className="absolute bottom-6 right-6 z-[1000] bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 text-[10px] font-mono text-gray-400 pointer-events-none">
          8192 x 8192 PX • CRS.Simple
        </div>
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        .leaflet-container {
          cursor: crosshair !important;
        }
        .leaflet-tooltip {
          background: #1a1a1a !important;
          border: 1px solid rgba(255,255,255,0.1) !important;
          color: white !important;
          padding: 2px 8px !important;
          border-radius: 4px !important;
          font-weight: bold !important;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
        }
        .leaflet-tooltip-top:before {
          border-top-color: #1a1a1a !important;
        }
      `}</style>
      {/* 맵 마커 전체 삭제 확인 모달 */}
      <ConfirmModal
        isOpen={isClearAllModalOpen}
        title="전체 마커 삭제"
        description={`현재 '${currentMap?.label}' 맵의 마커 ${vehicles.filter(v => v.mapId === activeMapId || (!v.mapId && activeMapId === "Erangel")).length}개를 모두 삭제하시겠습니까? (다른 맵의 마커는 유지됩니다)`}
        confirmText="전체 삭제"
        cancelText="취소"
        type="danger"
        onConfirm={executeClearAllVehicles}
        onCancel={() => setIsClearAllModalOpen(false)}
      />

      {/* 맵 변경사항 저장 확인 모달 */}
      <ConfirmModal
        isOpen={isSaveConfirmModalOpen}
        title="변경사항 저장"
        description={`'${currentMap?.label}' 맵의 변경사항을 서버에 저장하시겠습니까?`}
        confirmText="저장"
        cancelText="취소"
        type="warning"
        onConfirm={executeSaveToDB}
        onCancel={() => setIsSaveConfirmModalOpen(false)}
      />

    </div>
  );
};

export default MapEditorComponent;
