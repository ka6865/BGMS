import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { MapMarker, UserProfile, AuthUser, PendingVehicle } from "../types/map";

/**
 * 활성화된 맵 데이터와 주입된 사용자 정보를 동의화하는 커스텀 훅입니다.
 * 인증 상태 원천이 AuthProvider로 단일화됨에 따라 내부의 Auth 구독 로직이 제거되었습니다.
 *
 * @param activeMapId - 현재 지도 ID
 * @param injectedUser - AuthProvider로부터 제공받은 현재 사용자 정보
 */
export function useMapData(activeMapId: string, injectedUser: AuthUser | null) {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [optimisticNickname, setOptimisticNickname] = useState<string | null>(null);
  const [dbVehicles, setDbVehicles] = useState<MapMarker[]>([]);
  const [pendingVehicles, setPendingVehicles] = useState<PendingVehicle[]>([]);
  const [isDataLoading, setIsDataLoading] = useState(false);

  // 사용자 프로필 조회
  const fetchUserProfile = async (user: AuthUser) => {
    const { data, error } = await supabase
      .rpc("get_my_profile")
      .single<UserProfile>();

    if (!error && data) {
      setUserProfile(data as UserProfile);
      setOptimisticNickname(data.nickname);
    }
  };



  // 주입된 사용자 정보가 바뀔 때마다 프로필/알림 동기화
  useEffect(() => {
    if (!injectedUser) {
      setUserProfile(null);
      setOptimisticNickname(null);
      return;
    }

    const syncUserData = async () => {
      await fetchUserProfile(injectedUser);
    };

    syncUserData();
  }, [injectedUser]);

  // 맵 마커 동기화
  useEffect(() => {
    const fetchMarkers = async () => {
      if (activeMapId === "Board" || activeMapId === "Stats") return;

      setIsDataLoading(true);
      try {
        // 1. 공인된 마커 데이터 (map_markers)
        const { data: approved, error: approvedError } = await supabase
          .from("map_markers")
          .select("*")
          .eq("map_id", activeMapId);

        if (!approvedError && approved) {
          const mapMarkers = approved.map((v: any) => ({
            ...v,
            mapId: v.map_id // 내부에서는 camelCase 사용을 위해 매핑
          }));
          setDbVehicles(mapMarkers as MapMarker[]);
        }

        // 2. 대기 중인 사용자 제보 (pending_markers)
        // 📍 404가 발생하는 테이블이므로 안전하게 try-catch로 별도 처리
        try {
          const { data: pending, error: pendingError } = await supabase
            .from("pending_markers")
            .select("*")
            .eq("map_name", activeMapId);

          if (!pendingError && pending) {
            const mappedPending = pending.map((v: any) => ({
              ...v,
              mapId: v.map_name // 내부 통일성을 위해 매핑
            }));
            setPendingVehicles(mappedPending as PendingVehicle[]);
          }
        } catch {
          // 테이블 부재 시 조용히 넘어감
          console.log("[useMapData] pending_markers 테이블을 찾을 수 없어 건너뜁니다.");
        }
      } catch (err) {
        console.error("[useMapData] 데이터 로드 중 치명적 에러:", err);
      } finally {
        setIsDataLoading(false);
      }
    };

    fetchMarkers();
  }, [activeMapId]);

  return {
    currentUser: injectedUser, // 주입받은 사용자를 다시 내보내어 하위 호환성 유지
    userProfile,
    optimisticNickname,
    dbVehicles,
    pendingVehicles,
    isDataLoading,
    setOptimisticNickname,
    fetchUserProfile,
    setDbVehicles,
    setPendingVehicles
  };
}
