"use client";

import { useEffect, useState, Suspense } from "react";
import getApiUrl from "../../../lib/api-config";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "../../../lib/supabase";
import { PendingVehicle } from "../../../types/map";
import { toast } from "sonner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import {
  buildPendingMarkerReviewUrl,
  formatContributorNames,
} from "@/lib/admin/pendingMarkerReview";

// 쿼리스트링 파싱에 필요한 클라이언트 로직
function AdminReviewInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [marker, setMarker] = useState<PendingVehicle | null>(null);
  const [pendingMarkers, setPendingMarkers] = useState<PendingVehicle[]>([]);
  const [contributorNames, setContributorNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadContributorNames = async (markers: PendingVehicle[]) => {
      const ids = Array.from(
        new Set(markers.flatMap((pending) => pending.contributor_ids ?? [])),
      );

      if (ids.length === 0) {
        if (!cancelled) setContributorNames({});
        return;
      }

      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id, nickname")
        .in("id", ids);

      if (error) {
        console.error("[AdminReview] contributor profile lookup failed:", error);
        if (!cancelled) setContributorNames({});
        return;
      }

      if (!cancelled) {
        setContributorNames(
          Object.fromEntries(
            (profiles ?? [])
              .filter((profile) => profile.id)
              .map((profile) => [profile.id, profile.nickname ?? ""]),
          ),
        );
      }
    };

    async function checkAuthAndFetch() {
      setLoading(true);
      setLoadError(null);
      setMarker(null);

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

      // 3. ID가 있으면 단건 심사, 없으면 승인 대기 목록을 불러옵니다.
      if (id) {
        const { data: pending, error } = await supabase
          .from("pending_markers")
          .select("*")
          .eq("id", id)
          .single();

        if (error) {
          console.error("[AdminReview] marker lookup failed:", error);
          if (!cancelled) {
            setLoadError("제보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
            setLoading(false);
          }
          return;
        }

        if (!pending) {
          if (!cancelled) {
            setLoadError("존재하지 않거나 이미 승인/파기 처리된 제보입니다.");
            setLoading(false);
          }
          return;
        }

        if (!cancelled) setMarker(pending as PendingVehicle);
        await loadContributorNames([pending as PendingVehicle]);
      } else {
        const { data: pending, error } = await supabase
          .from("pending_markers")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) {
          console.error("[AdminReview] pending marker list failed:", error);
          if (!cancelled) {
            setLoadError("승인 대기 제보 목록을 불러오지 못했습니다.");
            setLoading(false);
          }
          return;
        }

        const rows = (pending ?? []) as PendingVehicle[];
        if (!cancelled) setPendingMarkers(rows);
        await loadContributorNames(rows);
      }

      if (!cancelled) setLoading(false);
    }
    
    checkAuthAndFetch();
    return () => {
      cancelled = true;
    };
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
        router.push("/admin/review");
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

  if (!isAdmin) return null;

  const contributorNameMap = new Map(Object.entries(contributorNames));

  if (!marker) {
    return (
      <div className="bg-[#222] border border-[#444] rounded-[12px] shadow-2xl w-full max-w-[760px] p-8 mx-4">
        <div className="flex items-center justify-between gap-4 border-b border-[#444] pb-4 mb-6">
          <h1 className="text-2xl font-black text-[#F2A900]">
            <InlineIconLabel icon="alert" iconSize={24}>승인 대기 제보 목록</InlineIconLabel>
          </h1>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="text-sm font-bold text-gray-400 hover:text-white"
          >
            홈으로
          </button>
        </div>

        {loadError ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            {loadError}
          </p>
        ) : pendingMarkers.length === 0 ? (
          <p className="rounded-md border border-[#333] bg-[#111] p-8 text-center text-sm text-gray-400">
            승인 대기 중인 제보가 없습니다.
          </p>
        ) : (
          <div className="space-y-3">
            {pendingMarkers.map((pending) => (
              <article
                key={String(pending.id)}
                className="rounded-lg border border-[#444] bg-[#151515] p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="font-bold text-white">
                      {pending.map_name} · {pending.marker_type}
                    </p>
                    <p className="text-xs text-gray-400">
                      제보자: {formatContributorNames(pending.contributor_ids, contributorNameMap)}
                    </p>
                    <p className="text-xs text-gray-500">
                      신뢰도 {pending.weight ?? 0}점 · 좌표 {pending.x.toFixed(2)}, {pending.y.toFixed(2)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => router.push(buildPendingMarkerReviewUrl(pending.id))}
                    className="shrink-0 rounded-md border border-[#F2A900]/40 bg-[#F2A900]/10 px-4 py-2 text-xs font-bold text-[#F2A900] hover:bg-[#F2A900]/20"
                  >
                    제보 보기
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

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
        <div className="flex justify-between items-center border-b border-[#333] pb-3">
          <span className="text-gray-400"><InlineIconLabel icon="team">제보자</InlineIconLabel></span>
          <span className="font-bold text-gray-200 text-right">
            {formatContributorNames(marker.contributor_ids, contributorNameMap)}
          </span>
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
        onClick={() => router.push("/admin/review")}
        className="w-full mt-6 bg-transparent border border-[#555] hover:bg-[#333] text-gray-400 hover:text-white font-bold py-3 rounded-[8px] transition-colors"
      >
        제보 목록으로 돌아가기
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
