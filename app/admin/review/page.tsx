"use client";

import { useEffect, useState, Suspense } from "react";
import getApiUrl from "../../../lib/api-config";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "../../../lib/supabase";
import { PendingVehicle } from "../../../types/map";
import { toast } from "sonner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

// 쿼리스트링 파싱에 필요한 클라이언트 로직
function AdminReviewInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [marker, setMarker] = useState<PendingVehicle | null>(null);

  useEffect(() => {
    async function checkAuthAndFetch() {
      if (!id) {
        toast.error("잘못된 접근입니다. (ID 누락)");
        router.push("/");
        return;
      }

      // 1. 유저 세션 확인
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("관리자 로그인이 필요합니다.");
        router.push("/");
        return;
      }

      // 2. 관리자 권한(Role) 확인
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();

      if (profile?.role !== "admin") {
        toast.error("관리자 권한이 없습니다.");
        router.push("/");
        return;
      }

      setIsAdmin(true);

      // 3. 마커(제보) 데이터 불러오기
      const { data: pending } = await supabase
        .from("pending_markers")
        .select("*")
        .eq("id", id)
        .single();
        
      if (!pending) {
        toast.error("존재하지 않거나 이미 승인/파기 처리된 제보입니다.");
        router.push("/");
        return;
      }

      setMarker(pending as PendingVehicle);
      setLoading(false);
    }
    
    checkAuthAndFetch();
  }, [id, router]);

  // 관리자 액션 (Approve / Reject POST 요청)
  const handleAction = async (action: "approve" | "reject") => {
    if (!marker) return;
    
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    try {
      const apiUrl = getApiUrl(`/api/admin/${action}`);
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ id: marker.id })
      });

      const result = await res.json();
      if (res.ok) {
        toast.success(`성공적으로 ${action === "approve" ? "승인(지도 반영)" : "파기(삭제)"} 되었습니다!`);
        router.push("/");
      } else {
        toast.error(`오류 발생: ${result.error}`);
      }
    } catch {
      toast.error("서버 통신에 실패했습니다.");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[#F2A900] gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#F2A900]"></div>
        <p className="font-bold text-lg">권한 및 제보 데이터를 스캔 중입니다...</p>
      </div>
    );
  }

  if (!isAdmin || !marker) return null;

  return (
    <div className="bg-[#222] border border-[#444] rounded-[12px] shadow-2xl w-full max-w-[500px] p-8 mx-4">
      <h1 className="text-2xl font-black mb-6 border-b border-[#444] pb-4 text-[#F2A900] text-center">
        <InlineIconLabel icon="alert" iconSize={24} className="justify-center">관제탑 제보 심사 조종석</InlineIconLabel>
      </h1>
      
      <div className="flex flex-col gap-4 mb-8 text-[15px]">
        <div className="flex justify-between items-center border-b border-[#333] pb-3">
          <span className="text-gray-400"><InlineIconLabel icon="map">맵 위치</InlineIconLabel></span>
          <span className="font-bold bg-[#111] px-3 py-1 rounded-md">{marker.map_name}</span>
        </div>
        <div className="flex justify-between items-center border-b border-[#333] pb-3">
          <span className="text-gray-400"><InlineIconLabel icon="vehicle">발견 물자</InlineIconLabel></span>
          <span className="font-bold text-[#34A853] bg-[#34A853]/10 px-3 py-1 rounded-md">
            {marker.marker_type}
          </span>
        </div>
        <div className="flex justify-between items-center border-b border-[#333] pb-3">
          <span className="text-gray-400"><InlineIconLabel icon="mapPin">좌표 (X, Y)</InlineIconLabel></span>
          <span className="font-mono text-gray-300">
            {marker.x.toFixed(2)}, {marker.y.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between items-center border-b border-[#333] pb-3">
          <span className="text-gray-400"><InlineIconLabel icon="flame">유저 신뢰도(교차검증)</InlineIconLabel></span>
          <span className="font-bold text-red-400">{marker.weight} 점 합산됨</span>
        </div>
      </div>

      <div className="flex gap-4">
        <button 
          onClick={() => handleAction("approve")}
          className="flex-1 bg-[#10b981] hover:bg-[#059669] text-white font-bold py-4 px-4 rounded-[8px] transition-all transform hover:scale-105 shadow-lg"
        >
          <InlineIconLabel icon="check" className="justify-center">즉시 승인</InlineIconLabel>
        </button>
        <button 
          onClick={() => handleAction("reject")}
          className="flex-1 bg-[#ef4444] hover:bg-[#dc2626] text-white font-bold py-4 px-4 rounded-[8px] transition-all transform hover:scale-105 shadow-lg"
        >
          <InlineIconLabel icon="error" className="justify-center">거짓말 (파기)</InlineIconLabel>
        </button>
      </div>
      
      <button 
        onClick={() => router.push("/")}
        className="w-full mt-6 bg-transparent border border-[#555] hover:bg-[#333] text-gray-400 hover:text-white font-bold py-3 rounded-[8px] transition-colors"
      >
        홈으로 돌아가기
      </button>
    </div>
  );
}

// 빌드 에러 방지를 위한 래핑
export default function AdminReviewPage() {
  return (
    <div className="min-h-screen bg-[#111] flex items-center justify-center">
      <Suspense fallback={<div className="text-white">Loading...</div>}>
        <AdminReviewInner />
      </Suspense>
    </div>
  );
}
