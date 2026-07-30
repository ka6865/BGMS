"use client";

/**
 * @fileoverview 패치노트 기반 무기도감 갱신 제안을 검토·승인하는 관리자 화면입니다.
 *
 * 이 화면은 제안 테이블만 다룹니다. 실제 게임 데이터 변경은 관리자가
 * [승인 항목 DB 반영] 을 눌렀을 때 서버의 apply_weapon_patch_proposal RPC 가 수행합니다.
 * 각 항목은 패치노트 원문 인용을 함께 보여주므로 근거 없이 승인할 수 없습니다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface ProposalChange {
  id: string;
  targetTable: string;
  targetId: string;
  targetName: string;
  columnName: string;
  columnLabel: string;
  oldValue: unknown;
  newValue: unknown;
  evidenceQuote: string;
  evidenceFound: boolean;
  confidence: number | null;
  validationState: string;
  validationReason: string | null;
  decision: "pending" | "accepted" | "rejected";
}

interface Proposal {
  id: string;
  sourceUrl: string;
  sourcePostId: number | null;
  patchLabel: string | null;
  status: string;
  modelName: string | null;
  validationSummary: Record<string, unknown>;
  createdAt: string;
  reviewedAt: string | null;
  changes: ProposalChange[];
}

const STATUS_LABELS: Record<string, string> = {
  pending: "검토 대기",
  partially_applied: "일부 반영",
  applied: "반영 완료",
  rejected: "거부",
  superseded: "대체됨",
};

const VALIDATION_LABELS: Record<string, string> = {
  ok: "검증 통과",
  stale: "현재값 불일치",
  invalid: "검증 실패",
};

/** jsonb 로 저장된 값을 사람이 읽을 수 있는 문자열로 만듭니다. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(없음)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export default function WeaponPatchReview() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const loadProposals = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/weapon-patch?status=pending", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "제안 목록을 불러오지 못했습니다.");

      const loaded = (data.proposals ?? []) as Proposal[];
      setProposals(loaded);

      // 검증을 통과한 항목은 기본 선택 상태로 둔다. 관리자가 해제할 수 있다.
      const preselected = new Set<string>();
      for (const proposal of loaded) {
        for (const change of proposal.changes) {
          if (change.validationState === "ok") preselected.add(change.id);
        }
      }
      setSelected(preselected);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "제안 목록 조회 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProposals();
  }, [loadProposals]);

  const toggleChange = (changeId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(changeId)) next.delete(changeId);
      else next.add(changeId);
      return next;
    });
  };

  const selectedByProposal = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const proposal of proposals) {
      const ids = proposal.changes.filter((c) => selected.has(c.id)).map((c) => c.id);
      map.set(proposal.id, ids);
    }
    return map;
  }, [proposals, selected]);

  const decide = async (
    proposalId: string,
    changeIds: string[],
    decision: "accepted" | "rejected"
  ) => {
    if (changeIds.length === 0) {
      toast.warning("선택된 항목이 없습니다.");
      return false;
    }

    const response = await fetch("/api/admin/weapon-patch/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId, changeIds, decision }),
    });
    const data = await response.json();
    if (!response.ok) {
      toast.error(data.error || "결정 저장에 실패했습니다.");
      return false;
    }
    return true;
  };

  const handleApply = async (proposal: Proposal) => {
    const changeIds = selectedByProposal.get(proposal.id) ?? [];
    if (changeIds.length === 0) {
      toast.warning("반영할 항목을 먼저 선택해 주세요.");
      return;
    }

    setBusy(true);
    const toastId = toast.loading(`${changeIds.length}건을 승인하고 DB에 반영 중...`);
    try {
      const accepted = await decide(proposal.id, changeIds, "accepted");
      if (!accepted) {
        toast.dismiss(toastId);
        return;
      }

      const response = await fetch("/api/admin/weapon-patch/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: proposal.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "DB 반영에 실패했습니다.");

      const skippedNote = data.skippedCount > 0 ? ` (건너뜀 ${data.skippedCount}건)` : "";
      toast.success(`${data.appliedCount}건을 무기도감에 반영했습니다.${skippedNote}`, { id: toastId });
      await loadProposals();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "DB 반영 실패", { id: toastId });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async (proposal: Proposal) => {
    const changeIds = selectedByProposal.get(proposal.id) ?? [];
    if (changeIds.length === 0) {
      toast.warning("거부할 항목을 먼저 선택해 주세요.");
      return;
    }

    setBusy(true);
    const toastId = toast.loading(`${changeIds.length}건을 거부 처리 중...`);
    try {
      const rejected = await decide(proposal.id, changeIds, "rejected");
      if (!rejected) {
        toast.dismiss(toastId);
        return;
      }
      toast.success(`${changeIds.length}건을 거부했습니다.`, { id: toastId });
      await loadProposals();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "거부 처리 실패", { id: toastId });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-center text-sm text-gray-400">
        무기도감 갱신 제안을 불러오는 중입니다...
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <div className="rounded-xl border border-[#333] bg-[#1a1a1a] p-6">
        <h3 className="text-lg font-black text-white">무기도감 갱신 제안</h3>
        <p className="mt-2 text-sm text-gray-400">
          검토 대기 중인 제안이 없습니다. 패치노트를 동기화하면 게임 데이터 변경안이 자동으로 수집됩니다.
        </p>
        <button
          type="button"
          onClick={loadProposals}
          className="mt-4 rounded bg-[#252525] px-4 py-2 text-xs font-bold text-gray-300 transition-colors hover:bg-[#333]"
        >
          새로 고침
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 border-b border-[#333] pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-xl font-black text-white">무기도감 갱신 제안 검토</h3>
          <p className="mt-1 text-xs text-gray-400">
            패치노트 원문 근거를 확인하고 승인한 항목만 무기도감에 반영됩니다.
          </p>
        </div>
        <button
          type="button"
          onClick={loadProposals}
          disabled={busy}
          className="rounded bg-[#252525] px-4 py-2 text-xs font-bold text-gray-300 transition-colors hover:bg-[#333] disabled:opacity-50"
        >
          새로 고침
        </button>
      </div>

      {proposals.map((proposal) => {
        const selectedCount = (selectedByProposal.get(proposal.id) ?? []).length;

        return (
          <section key={proposal.id} className="rounded-xl border border-[#333] bg-[#1a1a1a] p-5">
            <header className="flex flex-col gap-3 border-b border-[#2a2a2a] pb-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {proposal.patchLabel && (
                    <span className="rounded-full border border-[#F2A900]/30 bg-[#F2A900]/10 px-2.5 py-0.5 text-[11px] font-black text-[#F2A900]">
                      {proposal.patchLabel}
                    </span>
                  )}
                  <span className="text-xs font-bold text-gray-300">
                    {STATUS_LABELS[proposal.status] ?? proposal.status}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    변경안 {proposal.changes.length}건
                  </span>
                </div>
                <a
                  href={proposal.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 block truncate text-xs text-sky-400 underline hover:text-sky-300"
                >
                  패치노트 원문 열기
                </a>
                {proposal.modelName && (
                  <p className="mt-1 text-[11px] text-gray-500">추출 모델: {proposal.modelName}</p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleReject(proposal)}
                  disabled={busy || selectedCount === 0}
                  className="rounded bg-[#3a2222] px-4 py-2 text-xs font-black text-red-300 transition-colors hover:bg-[#4a2a2a] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  선택 {selectedCount}건 거부
                </button>
                <button
                  type="button"
                  onClick={() => handleApply(proposal)}
                  disabled={busy || selectedCount === 0}
                  className="rounded bg-[#F2A900] px-4 py-2 text-xs font-black text-black transition-colors hover:bg-[#cc8b00] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  선택 {selectedCount}건 승인 후 DB 반영
                </button>
              </div>
            </header>

            <ul className="mt-4 space-y-3">
              {proposal.changes.map((change) => {
                const isSelectable = change.validationState === "ok";
                const isChecked = selected.has(change.id);

                return (
                  <li
                    key={change.id}
                    className={`rounded-lg border p-4 ${
                      isSelectable ? "border-[#333] bg-[#141414]" : "border-red-900/40 bg-[#1c1414]"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        id={`change-${change.id}`}
                        checked={isChecked}
                        disabled={!isSelectable || busy}
                        onChange={() => toggleChange(change.id)}
                        className="mt-1 h-4 w-4 shrink-0 accent-[#F2A900] disabled:opacity-40"
                      />
                      <div className="min-w-0 flex-1">
                        <label
                          htmlFor={`change-${change.id}`}
                          className="flex flex-wrap items-center gap-2 text-sm font-bold text-white"
                        >
                          <span>{change.targetName}</span>
                          <span className="text-[11px] font-medium text-gray-500">
                            {change.targetTable}
                          </span>
                          <span className="text-[#F2A900]">{change.columnLabel}</span>
                        </label>

                        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                          <span className="rounded bg-[#252525] px-2 py-1 font-mono text-xs text-gray-400 line-through">
                            {formatValue(change.oldValue)}
                          </span>
                          <span aria-hidden="true" className="text-gray-500">
                            →
                          </span>
                          <span className="rounded bg-[#F2A900]/15 px-2 py-1 font-mono text-xs font-black text-[#F2A900]">
                            {formatValue(change.newValue)}
                          </span>
                        </div>

                        <blockquote className="mt-3 border-l-2 border-[#F2A900]/40 bg-[#0f0f0f] py-2 pl-3 pr-2 text-xs italic leading-relaxed text-gray-300">
                          <span className="mb-1 block text-[10px] font-bold not-italic text-gray-500">
                            패치노트 원문 근거
                          </span>
                          {change.evidenceQuote}
                        </blockquote>

                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                          <span
                            className={
                              isSelectable ? "font-bold text-emerald-400" : "font-bold text-red-400"
                            }
                          >
                            {VALIDATION_LABELS[change.validationState] ?? change.validationState}
                          </span>
                          <span className={change.evidenceFound ? "text-gray-400" : "text-red-400"}>
                            {change.evidenceFound ? "원문 인용 확인됨" : "원문에서 인용문을 찾지 못함"}
                          </span>
                          {change.confidence !== null && (
                            <span className="text-gray-500">
                              모델 신뢰도 {Math.round(change.confidence * 100)}%
                            </span>
                          )}
                        </div>

                        {change.validationReason && (
                          <p className="mt-1 text-[11px] text-red-300">{change.validationReason}</p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
