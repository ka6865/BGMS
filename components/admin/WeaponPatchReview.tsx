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
  operation: string;
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

interface ApplyLog {
  id: string;
  proposal_id: string;
  target_table: string;
  target_id: string;
  column_name: string;
  patch_version: string | null;
  previous_patch_version: string | null;
  applied_at: string;
  reverted_at: string | null;
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

/** 백필 결과 항목 상태 표시명입니다. */
const BACKFILL_STATUS_LABELS: Record<string, string> = {
  created: "제안 생성",
  duplicate: "이미 존재",
  no_changes: "변경 없음",
  skipped: "건너뜀",
  source_gone: "원문 삭제",
  failed: "실패",
};

interface BackfillItem {
  postId: number;
  title: string;
  sourceUrl: string | null;
  status: string;
  reason?: string;
  changeCount?: number;
}

interface BackfillSummary {
  candidates: number;
  processed: number;
  created: number;
  duplicate: number;
  noChanges: number;
  skipped: number;
  sourceGone: number;
  failed: number;
  results: BackfillItem[];
}

/** jsonb 로 저장된 값을 사람이 읽을 수 있는 문자열로 만듭니다. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(없음)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export default function WeaponPatchReview() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [logs, setLogs] = useState<ApplyLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [backfill, setBackfill] = useState<BackfillSummary | null>(null);

  const loadLogs = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/weapon-patch/revert", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "적용 이력을 불러오지 못했습니다.");
      setLogs((data.logs ?? []) as ApplyLog[]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "적용 이력 조회 실패");
    }
  }, []);

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
    loadLogs();
  }, [loadProposals, loadLogs]);

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
      await loadLogs();
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

  /**
   * 과거 패치노트에 대한 제안을 소급 생성합니다.
   *
   * dryRun 이면 원문 수집만 확인하고 AI 를 호출하지 않으므로 비용이 들지 않습니다.
   * 실제 실행도 제안 테이블에만 기록하며 무기 데이터는 승인 후에만 바뀝니다.
   */
  const handleBackfill = async (dryRun: boolean) => {
    setBusy(true);
    const toastId = toast.loading(
      dryRun ? "과거 패치노트 원문을 점검 중..." : "과거 패치노트로 제안을 생성 중..."
    );
    try {
      const response = await fetch("/api/admin/weapon-patch/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, limit: 5 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "백필 실행에 실패했습니다.");

      const summary = data.summary as BackfillSummary;
      setBackfill(summary);
      toast.success(
        dryRun
          ? `패치노트 ${summary.candidates}건 점검 완료 (원문 삭제 ${summary.sourceGone}건)`
          : `제안 ${summary.created}건 생성 (변경없음 ${summary.noChanges}건, 실패 ${summary.failed}건)`,
        { id: toastId }
      );
      if (!dryRun) await loadProposals();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "백필 실패", { id: toastId });
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = async (log: ApplyLog) => {
    setBusy(true);
    const toastId = toast.loading("적용 내용을 되돌리는 중...");
    try {
      const response = await fetch("/api/admin/weapon-patch/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: log.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "되돌리기에 실패했습니다.");

      toast.success("적용 전 값으로 되돌렸습니다.", { id: toastId });
      await loadLogs();
      await loadProposals();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "되돌리기 실패", { id: toastId });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 과거 패치노트 백필 실행 패널입니다.
   *
   * 제안 파이프라인 도입 이전에 저장된 패치노트에는 제안이 없으므로
   * 관리자가 이 패널에서 소급 생성할 수 있게 합니다.
   */
  const renderBackfillPanel = () => (
    <section className="rounded-xl border border-[#333] bg-[#1a1a1a] p-5">
      <header className="flex flex-col gap-1 border-b border-[#2a2a2a] pb-3">
        <h4 className="text-lg font-black text-white">과거 패치노트 소급 수집</h4>
        <p className="text-xs text-gray-400">
          자동 수집이 도입되기 전에 등록된 패치노트에서도 변경안을 생성합니다. 원문 점검은 AI 를
          호출하지 않으므로 비용이 들지 않습니다. 한 번에 최대 5건까지 처리합니다.
        </p>
      </header>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => handleBackfill(true)}
          disabled={busy}
          className="rounded bg-[#252525] px-4 py-2 text-xs font-bold text-gray-300 transition-colors hover:bg-[#333] disabled:opacity-50"
        >
          원문 점검 (AI 미사용)
        </button>
        <button
          type="button"
          onClick={() => handleBackfill(false)}
          disabled={busy}
          className="rounded bg-[#F2A900] px-4 py-2 text-xs font-black text-black transition-colors hover:bg-[#cc8b00] disabled:opacity-50"
        >
          제안 생성 실행
        </button>
      </div>

      {backfill && (
        <div className="mt-4 rounded-lg border border-[#2a2a2a] bg-[#141414] p-3">
          <p className="text-xs font-bold text-gray-300">
            후보 {backfill.candidates}건 / 생성 {backfill.created} / 이미 존재 {backfill.duplicate} /
            변경없음 {backfill.noChanges} / 원문삭제 {backfill.sourceGone} / 실패 {backfill.failed}
          </p>
          <ul className="mt-2 space-y-1">
            {backfill.results.map((item) => (
              <li key={item.postId} className="text-[11px] text-gray-400">
                <span className="font-bold text-gray-200">
                  {BACKFILL_STATUS_LABELS[item.status] ?? item.status}
                </span>
                <span className="ml-2">{item.title}</span>
                {item.changeCount !== undefined && (
                  <span className="ml-2 text-[#F2A900]">변경 {item.changeCount}건</span>
                )}
                {item.reason && <span className="ml-2 text-gray-500">{item.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );

  /**
   * 최근 적용 이력과 되돌리기 버튼입니다.
   * 승인 후 잘못 반영한 값을 적용 전 상태로 복구할 수 있어야 하므로
   * 제안이 없는 상태에서도 항상 노출합니다.
   */
  const renderApplyHistory = () => {
    if (logs.length === 0) return null;

    return (
      <section className="rounded-xl border border-[#333] bg-[#1a1a1a] p-5">
        <header className="flex flex-col gap-1 border-b border-[#2a2a2a] pb-3">
          <h4 className="text-lg font-black text-white">최근 반영 이력</h4>
          <p className="text-xs text-gray-400">
            잘못 반영한 항목은 되돌리면 적용 전 값과 패치 버전으로 복구됩니다.
          </p>
        </header>

        <ul className="mt-3 space-y-2">
          {logs.map((log) => (
            <li
              key={log.id}
              className="flex flex-col gap-2 rounded-lg border border-[#2a2a2a] bg-[#141414] p-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0 text-xs text-gray-300">
                <span className="font-bold text-white">{log.target_id}</span>
                <span className="ml-2 text-gray-500">{log.target_table}</span>
                <span className="ml-2 text-[#F2A900]">{log.column_name}</span>
                {log.patch_version && (
                  <span className="ml-2 text-gray-400">({log.patch_version})</span>
                )}
                <span className="ml-2 text-[11px] text-gray-500">
                  {new Date(log.applied_at).toLocaleString("ko-KR")}
                </span>
              </div>

              {log.reverted_at ? (
                <span className="shrink-0 text-[11px] font-bold text-gray-500">되돌림 완료</span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleRevert(log)}
                  disabled={busy}
                  className="shrink-0 rounded bg-[#252525] px-3 py-1.5 text-[11px] font-black text-gray-300 transition-colors hover:bg-[#333] disabled:opacity-40"
                >
                  되돌리기
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
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
      <div className="space-y-6">
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
        {renderBackfillPanel()}
        {renderApplyHistory()}
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

      {renderBackfillPanel()}

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
                          {change.operation === "remove" ? (
                            <span className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-black text-red-300">
                              항목 제거
                            </span>
                          ) : (
                            <span className="text-[#F2A900]">{change.columnLabel}</span>
                          )}
                        </label>

                        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                          {change.operation === "remove" ? (
                            // 삭제는 새 값이 없다. 파괴적 변경이므로 붉은 배경으로 구분한다.
                            <span className="rounded bg-red-500/15 px-2 py-1 text-xs font-black text-red-300">
                              도감에서 제거 (되돌리기 가능)
                            </span>
                          ) : (
                            <>
                              <span className="rounded bg-[#252525] px-2 py-1 font-mono text-xs text-gray-400 line-through">
                                {formatValue(change.oldValue)}
                              </span>
                              <span aria-hidden="true" className="text-gray-500">
                                →
                              </span>
                              <span className="rounded bg-[#F2A900]/15 px-2 py-1 font-mono text-xs font-black text-[#F2A900]">
                                {formatValue(change.newValue)}
                              </span>
                            </>
                          )}
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

      {renderApplyHistory()}
    </div>
  );
}
