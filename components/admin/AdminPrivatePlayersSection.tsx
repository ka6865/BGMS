"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Lock, Plus, Trash2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import ConfirmModal from "@/components/common/ConfirmModal";

export interface PrivatePlayerItem {
  platform: string;
  nickname: string;
  lower_nickname: string;
  created_at: string;
}

export function AdminPrivatePlayersSection() {
  const [players, setPlayers] = useState<PrivatePlayerItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 새 비공개 유저 입력 상태
  const [newPlatform, setNewPlatform] = useState("steam");
  const [newNickname, setNewNickname] = useState("");

  // 삭제(공개 전환) 확인 모달 상태
  const [deleteTarget, setDeleteTarget] = useState<PrivatePlayerItem | null>(null);

  const fetchPrivatePlayers = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/admin/private-players");
      if (!res.ok) throw new Error("비공개 플레이어 목록 로드 실패");
      const data = await res.json();
      if (data.success && Array.isArray(data.players)) {
        setPlayers(data.players);
      }
    } catch (err: any) {
      toast.error(err.message || "비공개 목록 로드 중 오류 발생");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrivatePlayers();
  }, [fetchPrivatePlayers]);

  const handleAddPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNickname.trim()) {
      toast.error("닉네임을 입력해 주세요.");
      return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading("비공개 유저 등록 중...");
    try {
      const res = await fetch("/api/admin/private-players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: newPlatform,
          nickname: newNickname.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "비공개 등록 실패");

      toast.success(newNickname.trim() + " 전적이 비공개 등록되었습니다.", { id: toastId });
      setNewNickname("");
      if (Array.isArray(data.players)) {
        setPlayers(data.players);
      } else {
        fetchPrivatePlayers();
      }
    } catch (err: any) {
      toast.error(err.message || "등록 실패", { id: toastId });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemovePlayer = async () => {
    if (!deleteTarget) return;
    const { platform, nickname } = deleteTarget;
    setDeleteTarget(null);

    const toastId = toast.loading("공개 전환 처리 중...");
    try {
      const res = await fetch(
        "/api/admin/private-players?platform=" + encodeURIComponent(platform) + "&nickname=" + encodeURIComponent(nickname),
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "공개 전환 실패");

      toast.success(nickname + " 전적이 정상적으로 공개 전환되었습니다.", { id: toastId });
      if (Array.isArray(data.players)) {
        setPlayers(data.players);
      } else {
        fetchPrivatePlayers();
      }
    } catch (err: any) {
      toast.error(err.message || "공개 전환 오류", { id: toastId });
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-[#161616] p-6 shadow-xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Lock size={18} className="text-amber-400" />
            <h3 className="text-base font-black text-white">전적 비공개 플레이어 관리</h3>
          </div>
          <p className="text-xs text-white/50 mt-1">
            본인 요청이나 비공개 처리된 유저를 등록하면 전적 검색 시 PUBG 조회를 차단하고 OP.GG 스타일 비공개 안내 화면을 표시합니다.
          </p>
        </div>
        <span className="text-xs font-bold text-amber-400/90 bg-amber-500/10 border border-amber-500/20 px-3 py-1 rounded-full self-start sm:self-auto">
          현재 비공개 {players.length}명
        </span>
      </div>

      {/* 1. 비공개 유저 추가 폼 */}
      <form onSubmit={handleAddPlayer} className="flex flex-col sm:flex-row gap-3 items-end sm:items-center">
        <div className="w-full sm:w-36">
          <label className="block text-[11px] font-bold text-white/40 mb-1">플랫폼</label>
          <select
            value={newPlatform}
            onChange={(e) => setNewPlatform(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white focus:border-amber-500 focus:outline-none"
          >
            <option value="steam">Steam (PC)</option>
            <option value="kakao">Kakao (PC)</option>
            <option value="all">모든 플랫폼</option>
          </select>
        </div>

        <div className="flex-1 w-full">
          <label className="block text-[11px] font-bold text-white/40 mb-1">PUBG 닉네임</label>
          <input
            type="text"
            placeholder="비공개 처리할 닉네임 입력 (예: eunbbuing)"
            value={newNickname}
            onChange={(e) => setNewNickname(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white placeholder-white/30 focus:border-amber-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !newNickname.trim()}
          className="w-full sm:w-auto px-5 py-2.5 rounded-xl text-xs font-black bg-[#F2A900] text-black hover:bg-[#d89700] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-1.5 shrink-0 shadow-lg shadow-amber-950/20"
        >
          <Plus size={14} />
          비공개 등록
        </button>
      </form>

      {/* 2. 등록된 비공개 목록 */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-white/60">등록된 비공개 플레이어 목록</div>
        {isLoading ? (
          <div className="p-8 text-center text-xs text-white/40 font-bold border border-white/5 rounded-xl bg-black/20">
            목록 불러오는 중...
          </div>
        ) : players.length === 0 ? (
          <div className="p-8 text-center text-xs text-white/30 font-bold border border-white/5 rounded-xl bg-black/20">
            현재 비공개로 등록된 플레이어가 없습니다.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {players.map((p) => (
              <div
                key={p.platform + ":" + p.lower_nickname}
                className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-black/30 hover:border-amber-500/30 transition-all"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0 text-amber-400">
                    <ShieldAlert size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-black text-white truncate">{p.nickname}</span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-white/70 uppercase">
                        {p.platform}
                      </span>
                    </div>
                    <div className="text-[10px] text-white/40 font-mono mt-0.5">
                      {p.created_at ? new Date(p.created_at).toLocaleDateString() : ""}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setDeleteTarget(p)}
                  className="p-2 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="공개 전환(삭제)"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 공개 전환 확인 모달 */}
      {deleteTarget && (
        <ConfirmModal
          isOpen={Boolean(deleteTarget)}
          title="전적 공개 전환 확인"
          description={"'" + deleteTarget.nickname + "' (" + deleteTarget.platform + ") 플레이어를 비공개 목록에서 삭제하시겠습니까? 삭제 후에는 모든 유저가 다시 전적을 조회할 수 있게 됩니다."}
          confirmText="공개 전환 실행"
          cancelText="취소"
          onConfirm={handleRemovePlayer}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}