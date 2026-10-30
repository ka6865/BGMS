"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import getApiUrl from "../../../lib/api-config";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "../../../lib/supabase";
import { PendingVehicle } from "../../../types/map";
import { toast } from "sonner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import ConfirmModal from "@/components/common/ConfirmModal";
import {
  buildPendingMarkerReviewUrl,
  formatContributorNames,
} from "@/lib/admin/pendingMarkerReview";

type ReviewAction = "approve" | "reject";

// 승인·거절 확인 모달 문구. 실제 동작은 /api/admin/approve, /api/admin/reject 기준이다.
const REVIEW_ACTION_COPY: Record<ReviewAction, { title: string; description: string; confirmText: string; success: string }> = {
  approve: {
    title: "제보 승인",
    description: "이 제보를 지도 마커로 등록해 모든 사용자 지도에 반영합니다. 승인 후 대기 목록에서 사라집니다.",
    confirmText: "지도에 반영",
    success: "제보를 승인해 지도에 반영했습니다."
  },
  reject: {
    title: "제보 거절(삭제)",
    description: "이 제보를 승인 대기 목록에서 삭제합니다. 지도에는 반영되지 않으며 삭제한 제보는 되돌릴 수 없습니다.",
    confirmText: "거절하고 삭제",
    success: "제보를 거절하고 삭제했습니다."
  }
};

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
  const [confirmAction, setConfirmAction] = useState<ReviewAction | null>(null);
  const [actionPending, setActionPending] = useState(false);

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

  // 관리자 액션 (Approve / Reject POST 요청). 확인 모달을 거친 뒤에만 호출한다.
  const handleAction = async (action: ReviewAction) => {
    if (!marker || actionPending) return;
    setActionPending(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("로그인이 만료되었습니다. 다시 로그인해 주세요.");
        return;
      }

      const apiUrl = getApiUrl(`/api/admin/${action}`);
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ id: marker.id })
      });

      const result = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(REVIEW_ACTION_COPY[action].success);
        setConfirmAction(null);
        router.push("/admin/review");
      } else {
        toast.error(result.error || "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
    } catch {
      toast.error("서버 통신에 실패했습니다.");
    } finally {
      setActionPending(false);
    }
  };

  if (loading) {
    return (
      <div role="status" className="flex flex-col items-center justify-center py-16 text-[#F2A900] gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F2A900]"></div>
        <p className="font-bold text-sm">권한과 제보 데이터를 불러오는 중입니다...</p>
      </div>
    );
  }

  if (!isAdmin) return null;

  const contributorNameMap = new Map(Object.entries(contributorNames));

  if (!marker) {
    return (
      <div className="w-full max-w-[760px] rounded-xl border border-[#333] bg-[#1a1a1a] p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#333] pb-4">
          <div className="min-w-0">
            <h1 className="text-xl font-black text-[#F2A900] sm:text-2xl">
              <InlineIconLabel icon="alert" iconSize={22}>지도 제보 심사</InlineIconLabel>
            </h1>
            <p className="mt-1 text-xs text-gray-400">승인 대기 중인 제보를 확인하고 지도 반영 여부를 결정합니다.</p>
          </div>
          <Link
            href="/admin/dashboard"
            className="flex min-h-11 items-center text-sm font-bold text-gray-400 hover:text-white"
          >
            운영 대시보드로
          </Link>
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
                className="rounded-lg border border-[#333] bg-[#141414] p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="break-words font-bold text-white">
                      {pending.map_name} · {pending.marker_type}
                    </p>
                    <p className="break-words text-xs text-gray-400">
                      제보자: {formatContributorNames(pending.contributor_ids, contributorNameMap)}
                    </p>
                    <p className="text-xs text-gray-500">
                      신뢰도 {pending.weight ?? 0}점 · 좌표 {pending.x.toFixed(2)}, {pending.y.toFixed(2)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => router.push(buildPendingMarkerReviewUrl(pending.id))}
                    className="min-h-11 shrink-0 rounded-md border border-[#F2A900]/40 bg-[#F2A900]/10 px-4 py-2 text-xs font-bold text-[#F2A900] hover:bg-[#F2A900]/20"
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
    <div className="w-full max-w-[520px] rounded-xl border border-[#333] bg-[#1a1a1a] p-4 sm:p-6">
      <h1 className="mb-4 border-b border-[#333] pb-4 text-xl font-black text-[#F2A900] sm:text-2xl">
        <InlineIconLabel icon="alert" iconSize={22}>지도 제보 심사</InlineIconLabel>
      </h1>

      <dl className="mb-6 flex flex-col gap-3 text-sm">
        <div className="flex items-center justify-between gap-3 border-b border-[#2a2a2a] pb-3">
          <dt className="shrink-0 text-gray-400"><InlineIconLabel icon="map">맵 위치</InlineIconLabel></dt>
          <dd className="break-words rounded-md bg-[#111] px-3 py-1 text-right font-bold">{marker.map_name}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-[#2a2a2a] pb-3">
          <dt className="shrink-0 text-gray-400"><InlineIconLabel icon="vehicle">발견 물자</InlineIconLabel></dt>
          <dd className="break-words rounded-md bg-[#34A853]/10 px-3 py-1 text-right font-bold text-[#34A853]">
            {marker.marker_type}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-[#2a2a2a] pb-3">
          <dt className="shrink-0 text-gray-400"><InlineIconLabel icon="mapPin">좌표 (X, Y)</InlineIconLabel></dt>
          <dd className="font-mono text-gray-300">
            {marker.x.toFixed(2)}, {marker.y.toFixed(2)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-[#2a2a2a] pb-3">
          <dt className="shrink-0 text-gray-400"><InlineIconLabel icon="flame">유저 신뢰도(교차검증)</InlineIconLabel></dt>
          <dd className="font-bold text-red-400">{marker.weight}점 합산</dd>
        </div>
        <div className="flex items-start justify-between gap-3 border-b border-[#2a2a2a] pb-3">
          <dt className="shrink-0 text-gray-400"><InlineIconLabel icon="team">제보자</InlineIconLabel></dt>
          <dd className="min-w-0 break-words text-right font-bold text-gray-200">
            {formatContributorNames(marker.contributor_ids, contributorNameMap)}
          </dd>
        </div>
      </dl>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setConfirmAction("approve")}
          disabled={actionPending}
          className="min-h-12 rounded-lg bg-[#10b981] px-3 py-3 text-sm font-bold text-white transition-colors hover:bg-[#059669] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <InlineIconLabel icon="check" className="justify-center">승인(지도 반영)</InlineIconLabel>
        </button>
        <button
          type="button"
          onClick={() => setConfirmAction("reject")}
          disabled={actionPending}
          className="min-h-12 rounded-lg bg-[#ef4444] px-3 py-3 text-sm font-bold text-white transition-colors hover:bg-[#dc2626] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <InlineIconLabel icon="error" className="justify-center">제보 거절(삭제)</InlineIconLabel>
        </button>
      </div>

      <Link
        href="/admin/review"
        className="mt-4 flex min-h-11 w-full items-center justify-center rounded-lg border border-[#444] text-sm font-bold text-gray-400 transition-colors hover:bg-[#2a2a2a] hover:text-white"
      >
        제보 목록으로 돌아가기
      </Link>

      <ConfirmModal
        isOpen={confirmAction !== null}
        title={confirmAction ? REVIEW_ACTION_COPY[confirmAction].title : ""}
        description={confirmAction ? REVIEW_ACTION_COPY[confirmAction].description : ""}
        confirmText={confirmAction ? REVIEW_ACTION_COPY[confirmAction].confirmText : "확인"}
        cancelText="취소"
        type={confirmAction === "reject" ? "danger" : "info"}
        isPending={actionPending}
        onConfirm={() => {
          if (confirmAction) handleAction(confirmAction);
        }}
        onCancel={() => {
          if (!actionPending) setConfirmAction(null);
        }}
      />
    </div>
  );
}

// 빌드 에러 방지를 위한 래핑
export default function AdminReviewPage() {
  return (
    <div className="flex min-h-full justify-center bg-[#111] px-3 py-4 text-white sm:items-center sm:px-6 sm:py-8">
      <Suspense fallback={<div role="status" className="py-16 text-sm text-gray-300">불러오는 중...</div>}>
        <AdminReviewInner />
      </Suspense>
    </div>
  );
}
