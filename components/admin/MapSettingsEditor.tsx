"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";
import { toast } from "sonner";
import { MAP_CATEGORIES } from "../../lib/map_config";
import { updateMapSettings, getMapSettings } from "../../app/actions/map-settings";
import { useMapSettings } from "@/hooks/useMapSettings";

const MAP_LIST = [
  { id: "Erangel", label: "에란겔" },
  { id: "Miramar", label: "미라마" },
  { id: "Taego", label: "태이고" },
  { id: "Rondo", label: "론도" },
  { id: "Vikendi", label: "비켄디" },
  { id: "Deston", label: "데스턴" },
];

export default function MapSettingsEditor() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [selectedMap, setSelectedMap] = useState(MAP_LIST[0].id);
  const [dbSettings, setDbSettings] = useState<Record<string, string[]>>({});
  const [currentCategories, setCurrentCategories] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // 모바일 화면 크기 감지
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 관리자 권한 확인
  useEffect(() => {
    const checkAdmin = async () => {
      const { data: { session } } = await supabase.auth.getSession();
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
    };
    checkAdmin();
  }, [router]);

  // DB에서 데이터 로드
  useEffect(() => {
    if (!isAuthorized) return;

    const loadSettings = async () => {
      const data = await getMapSettings();
      const settingsMap: Record<string, string[]> = {};
      data.forEach((item: any) => {
        settingsMap[item.map_id] = item.categories;
      });
      setDbSettings(settingsMap);
    };
    loadSettings();
  }, [isAuthorized]);

  // 맵 변경 시 현재 카테고리 업데이트
  useEffect(() => {
    const categories = dbSettings[selectedMap] || MAP_CATEGORIES[selectedMap] || [];
    setCurrentCategories(categories);
  }, [selectedMap, dbSettings]);

  const handleCategoryToggle = (categoryKey: string) => {
    setCurrentCategories(prev => 
      prev.includes(categoryKey)
        ? prev.filter(k => k !== categoryKey)
        : [...prev, categoryKey]
    );
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateMapSettings(selectedMap, currentCategories);
      
      // 로컬 상태 업데이트
      setDbSettings(prev => ({
        ...prev,
        [selectedMap]: currentCategories
      }));
      
      toast.success(`${selectedMap} 맵 설정이 저장되었습니다.`);
    } catch (err: any) {
      toast.error("저장 중 오류 발생: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  // DB 기반 카테고리 마스터 정보 로드 (선택된 맵 없이 전역으로 사용)
  const { categoryInfoMap } = useMapSettings(selectedMap);

  if (!isAuthorized) {
    return (
      <div role="status" className="flex min-h-[40vh] items-center justify-center text-sm font-bold text-[#F2A900]">
        관리자 권한을 확인하는 중입니다...
      </div>
    );
  }

  const allCategoryKeys = Object.keys(categoryInfoMap);
  const selectedMapLabel = MAP_LIST.find(m => m.id === selectedMap)?.label;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[#333] text-gray-200 md:flex-row">
      {/* 사이드바: 맵 리스트 */}
      <aside className="hidden w-[240px] shrink-0 flex-col border-r border-[#333] bg-[#141414] md:flex">
        <div className="border-b border-[#222] bg-[#1a1a1a] p-4">
          <h2 className="text-sm font-bold text-gray-400">대상 맵 선택</h2>
        </div>
        <div className="flex flex-col">
          {MAP_LIST.map(map => (
            <button
              key={map.id}
              type="button"
              onClick={() => setSelectedMap(map.id)}
              aria-pressed={selectedMap === map.id}
              className={`border-b border-[#222] p-4 text-left transition-colors hover:bg-[#1a1a1a] ${
                selectedMap === map.id ? "border-l-4 border-l-[#F2A900] bg-[#1a1a1a]" : ""
              }`}
            >
              <div className="text-base font-bold">{map.label}</div>
              <div className="mt-1 font-mono text-xs text-gray-500">{map.id}</div>
            </button>
          ))}
        </div>
      </aside>

      {/* 메인: 카테고리 체크박스 목록 */}
      <section className="min-w-0 flex-1 bg-[#0d0d0d] p-3 sm:p-6">
        <div className="mx-auto max-w-[800px]">
          {/* 모바일 맵 선택 드롭다운 */}
          {isMobile && (
            <div className="mb-4">
              <label htmlFor="map-settings-target-map" className="mb-2 block text-xs font-bold text-gray-400">대상 맵 선택</label>
              <select
                id="map-settings-target-map"
                value={selectedMap}
                onChange={(e) => setSelectedMap(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-[#333] bg-[#1a1a1a] px-3 font-bold text-white outline-none focus:border-[#F2A900]"
              >
                {MAP_LIST.map((map) => (
                  <option key={map.id} value={map.id}>
                    {map.label} ({map.id})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-black text-white sm:text-2xl">{selectedMapLabel} 맵 노출 설정</h2>
              <p className="mt-1 text-xs text-gray-500 sm:text-sm">해당 맵의 사이드바 필터와 제보 폼에 표시할 카테고리를 선택하세요.</p>
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className={`min-h-11 w-full rounded-lg px-6 text-sm font-black transition-colors sm:w-auto ${
                isSaving ? "cursor-not-allowed bg-gray-700 text-gray-500" : "bg-[#F2A900] text-black hover:bg-[#cc8b00]"
              }`}
            >
              {isSaving ? "저장 중..." : "설정 저장하기"}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {allCategoryKeys.map(key => {
              const info = categoryInfoMap[key];
              if (!info) return null;
              const isActive = currentCategories.includes(key);

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleCategoryToggle(key)}
                  aria-pressed={isActive}
                  className={`relative flex min-w-0 items-center gap-3 rounded-lg border-2 p-3 text-left transition-colors ${
                    isActive
                      ? "border-[#F2A900] bg-[#F2A900]/10"
                      : "border-[#333] bg-[#1a1a1a] hover:border-gray-500"
                  }`}
                >
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl"
                    style={{ backgroundColor: info.color + '22', color: info.color }}
                  >
                    {info.iconType}
                  </div>
                  <div className="min-w-0 pr-6">
                    <div className={`break-words font-bold ${isActive ? "text-white" : "text-gray-400"}`}>{info.label}</div>
                    <div className="break-all font-mono text-xs text-gray-500">{key}</div>
                  </div>

                  {/* 체크 표시 */}
                  {isActive && (
                    <div className="absolute right-2 top-2 text-[#F2A900]" aria-hidden="true">
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-8 border-t border-[#222] pt-4 text-sm text-blue-300/80">
            <h3 className="mb-2 font-bold">안내 사항</h3>
            <ul className="list-inside list-disc space-y-1 text-xs sm:text-sm">
              <li>설정 저장하기를 누르면 해당 맵의 사용자 화면에 반영됩니다.</li>
              <li>카테고리 이름·색상·아이콘은 카테고리 마스터 관리 탭에서 수정합니다.</li>
              <li>새 아이콘 종류가 필요하면 <code className="rounded bg-blue-500/10 px-1 text-blue-300">lib/map_config.ts</code>에 추가한 뒤 여기서 활성화하세요.</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
