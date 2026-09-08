"use client";

import { useEffect, useMemo, useState } from "react";
import type { CollectSource, CommunityAgentStatus, Policy, RunSnapshot, Stage } from "@/lib/community-agent/types";

const SOURCE_META: Record<CollectSource, { label: string; href: string }> = {
  dc: { label: "디시인사이드 배틀그라운드", href: "https://gall.dcinside.com/board/lists/?id=battlegrounds" },
  naver: { label: "네이버 배틀그라운드 공식 카페", href: "https://cafe.naver.com/playbattlegrounds" },
  youtube: { label: "PUBG: BATTLEGROUNDS Korea", href: "https://www.youtube.com/@PUBG_KR" },
};
const SOURCE_ORDER: CollectSource[] = ["dc", "naver", "youtube"];
const TRIAL_STAGES: Stage[] = ["dc", "naver", "youtube", "select", "draft", "verify"];

function isStatus(value: unknown): value is CommunityAgentStatus {
  return Boolean(value && typeof value === "object" && "policy" in value && "runs" in value && "sources" in value && "usage" in value);
}

function dateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function sourceName(source: CollectSource): string {
  return SOURCE_META[source].label;
}

function runUsage(run: RunSnapshot): number {
  return Object.values(run.stages).reduce((total, stage) => {
    const usage = stage?.result?.usage;
    if (!usage || typeof usage !== "object") return total;
    const value = (usage as Record<string, unknown>).totalTokens;
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function reasonText(reason: string | null): string {
  if (!reason) return "정상";
  const values: Record<string, string> = {
    missing_credentials: "연결 정보가 필요합니다",
    naver_search_credentials_missing: "네이버 검색 연결 정보가 필요합니다",
    youtube_data_api_key_missing: "YouTube 연결 정보가 필요합니다",
    no_usable_evidence: "본문으로 확인한 자료가 부족해 보류했습니다",
  };
  return values[reason] ?? reason.replaceAll("_", " ");
}

function sourceStateText(state: CommunityAgentStatus["sources"][number]["state"] | undefined): string {
  const values = {
    ok: "정상",
    partial: "일부 수집",
    empty: "자료 없음",
    needs_setup: "설정 필요",
    blocked: "접근 보류",
    failed: "수집 실패",
    disabled: "중지됨",
  } as const;
  return state ? values[state] : "상태 정보 없음";
}

function runStatusText(status: RunSnapshot["status"]): string {
  const values = {
    collecting: "수집 중",
    selected: "주제 선정됨",
    drafted: "초안 작성됨",
    ready: "발행 준비됨",
    deferred: "보류",
    failed: "실패",
    published: "발행됨",
  } as const;
  return values[status];
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error("request_failed");
  return response.json();
}

export default function CommunityAgentPanel() {
  const [status, setStatus] = useState<CommunityAgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (clearError = true) => {
    if (clearError) setError(null);
    try {
      const data = await requestJson("/api/admin/agent/community");
      const candidate = (data as { status?: unknown }).status;
      if (!isStatus(candidate)) throw new Error("invalid_status");
      setStatus(candidate);
    } catch {
      setStatus(null);
      setError("운영 상태를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
    }
  };

  useEffect(() => { void load(); }, []);

  const updatePolicy = async (patch: Partial<Policy>, operation: string) => {
    if (!status) return;
    const previous = status.policy;
    const optimistic = { ...previous, ...patch };
    setBusy(operation);
    setError(null);
    setStatus((current) => current ? { ...current, policy: optimistic } : current);
    try {
      const data = await requestJson("/api/admin/agent/community", {
        method: "POST",
        body: JSON.stringify({ action: "configure", patch }),
      });
      const policy = (data as { policy?: unknown }).policy;
      if (!policy || typeof policy !== "object") throw new Error("invalid_policy");
      setStatus((current) => current ? { ...current, policy: policy as Policy } : current);
    } catch {
      setStatus((current) => current ? { ...current, policy: previous } : current);
      setError("설정을 저장하지 못했습니다. 기존 운영 상태로 되돌렸습니다.");
    } finally {
      setBusy(null);
    }
  };

  const prepare = async () => {
    setBusy("prepare");
    setError(null);
    try {
      await requestJson("/api/admin/agent/community", { method: "POST", body: JSON.stringify({ action: "prepare_bot" }) });
      await load();
    } catch {
      setError("AI 비서 계정을 준비하지 못했습니다. 설정 문제를 확인해주세요.");
    } finally {
      setBusy(null);
    }
  };

  const runTrial = async () => {
    setBusy("trial");
    setError(null);
    try {
      const started = await requestJson("/api/admin/agent/community/run", {
        method: "POST", body: JSON.stringify({ action: "start", dryRun: true }),
      });
      let run = (started as { result?: unknown }).result as RunSnapshot | undefined;
      if (!run?.id) throw new Error("invalid_run");
      for (const stage of TRIAL_STAGES) {
        if (["ready", "deferred", "failed", "published"].includes(run.status)) break;
        const savedStage = run.stages[stage];
        if (savedStage?.status === "completed") continue;
        if (savedStage?.status === "running") throw new Error("trial_already_running");
        const stepped = await requestJson("/api/admin/agent/community/run", {
          method: "POST", body: JSON.stringify({ action: "step", runId: run.id, stage }),
        });
        run = (stepped as { result?: unknown }).result as RunSnapshot | undefined;
        if (!run?.id) throw new Error("invalid_run");
      }
      await load();
    } catch {
      setError("시험 실행을 완료하지 못했습니다. 발행 없이 중단되었으며 상태를 다시 확인해주세요.");
      await load(false);
    } finally {
      setBusy(null);
    }
  };

  const metrics = useMemo(() => {
    if (!status) return null;
    const today = dateKey();
    const todayRuns = status.runs.filter((run) => run.day === today);
    const sevenDayErrors = status.runs.filter((run) => run.status === "failed").length;
    return {
      publishedToday: todayRuns.filter((run) => run.status === "published").length,
      heldToday: todayRuns.filter((run) => run.status === "deferred").length,
      sevenDayErrors,
      publishedSevenDays: status.runs.filter((run) => run.status === "published").length,
      recordedTokens: status.usage.totalTokens || status.runs.reduce((total, run) => total + runUsage(run), 0),
    };
  }, [status]);

  if (!status) {
    return (
      <main className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100 sm:px-6">
        <section className="mx-auto max-w-5xl rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <h1 className="text-base font-semibold">커뮤니티 운영</h1>
          {error ? <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p> : <p className="mt-3 text-sm text-zinc-400">운영 상태를 확인하고 있습니다.</p>}
          {error && <button type="button" onClick={() => void load()} className="mt-4 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100">다시 시도</button>}
        </section>
      </main>
    );
  }

  const policy = status.policy;
  const currentRun = status.runs[0];
  const canTrial = policy.enabled && !policy.publishingEnabled;
  const setSources = (source: CollectSource, enabled: boolean) => void updatePolicy({ sourceEnabled: { ...policy.sourceEnabled, [source]: enabled } }, `source-${source}`);

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-5 text-zinc-100 sm:px-6 sm:py-7">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-amber-300">BGMS AI 비서</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight">커뮤니티 운영</h1>
            <p className="mt-1 text-sm text-zinc-400">수집과 발행을 분리해 운영합니다. 시험 실행은 게시하지 않습니다.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={busy !== null} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 disabled:opacity-50">새로고침</button>
        </header>

        {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}

        <section aria-label="운영 수치" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="오늘 발행" value={`${metrics!.publishedToday}건`} />
          <Metric label="오늘 보류" value={`${metrics!.heldToday}건`} />
          <Metric label="최근 7일 오류" value={`${metrics!.sevenDayErrors}건`} />
          <Metric label="최근 7일 발행" value={`${metrics!.publishedSevenDays}건`} />
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold">운영 순서</h2>
              <p className="mt-1 text-sm leading-5 text-zinc-400">계정 준비 → 출처 상태 확인 → 수집만 켜기 → 관리자 시험 실행 → 자동 게시 켜기</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void prepare()} disabled={busy !== null || Boolean(policy.botUserId)} className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50">{policy.botUserId ? "계정 준비됨" : "계정 준비"}</button>
              <button type="button" onClick={() => void updatePolicy({ enabled: !policy.enabled }, "enabled")} disabled={busy !== null} className="rounded-lg border border-zinc-600 px-3 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50">{policy.enabled ? "일시 중지" : "수집 재개"}</button>
              <button type="button" onClick={() => void runTrial()} disabled={busy !== null || !canTrial} className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-bold text-zinc-950 disabled:opacity-50">{busy === "trial" ? "시험 실행 중" : "관리자 시험 실행"}</button>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">중지는 수집과 자동 발행을 멈춥니다. 시험 실행은 수집·초안·검증까지만 수행하며 발행 단계는 호출하지 않습니다.</p>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
          <h2 className="font-semibold">발행 설정</h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <fieldset>
              <legend className="text-sm font-medium text-zinc-300">하루 발행 한도</legend>
              <div className="mt-2 flex gap-2">
                {[0, 1].map((limit) => <button key={limit} type="button" aria-pressed={policy.dailyPostLimit === limit} disabled={busy !== null} onClick={() => void updatePolicy({ dailyPostLimit: limit as 0 | 1 }, "limit")} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm aria-pressed:border-amber-400 aria-pressed:bg-amber-500/10 disabled:opacity-50">{limit}건</button>)}
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium text-zinc-300">카테고리</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["배그 소식", "자유"] as const).map((category) => {
                  const selected = policy.categories.includes(category);
                  return <button key={category} type="button" aria-pressed={selected} disabled={busy !== null || (selected && policy.categories.length === 1)} onClick={() => void updatePolicy({ categories: selected ? policy.categories.filter((value) => value !== category) : [...policy.categories, category] }, "categories")} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm aria-pressed:border-amber-400 aria-pressed:bg-amber-500/10 disabled:opacity-50">{category}</button>;
                })}
              </div>
            </fieldset>
            <div>
              <p className="text-sm font-medium text-zinc-300">자동 게시</p>
              <button type="button" aria-pressed={policy.publishingEnabled} disabled={busy !== null || !policy.enabled || policy.dailyPostLimit === 0} onClick={() => void updatePolicy({ publishingEnabled: !policy.publishingEnabled }, "publishing")} className="mt-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm aria-pressed:border-emerald-400 aria-pressed:bg-emerald-500/10 disabled:opacity-50">{policy.publishingEnabled ? "자동 게시 켜짐" : "자동 게시 켜기"}</button>
              <p className="mt-2 text-xs text-zinc-500">수집을 켜고 시험 실행을 확인한 뒤에만 켜세요.</p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
          <h2 className="font-semibold">출처 상태</h2>
          <div className="mt-3 divide-y divide-zinc-800">
            {SOURCE_ORDER.map((source) => {
              const item = status.sources.find((value) => value.id === source);
              const report = currentRun?.reports.find((value) => value.source === source);
              return <div key={source} className="flex flex-col gap-3 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <a href={SOURCE_META[source].href} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-amber-200 underline-offset-4 hover:underline">{sourceName(source)} <span className="text-xs text-zinc-500">출처 열기</span></a>
                  <p className="mt-1 text-xs text-zinc-400">상태: {sourceStateText(item?.state)}{item?.reason ? ` · ${reasonText(item.reason)}` : ""}{report ? ` · 보존 전 ${report.fetchedCount}건 / 보존 후 ${report.retainedCount}건` : ""}</p>
                  {source === "youtube" && report && <p className="mt-1 text-xs text-zinc-500">YouTube는 보존된 설명·댓글 기준 수치입니다.</p>}
                </div>
                <button type="button" aria-pressed={policy.sourceEnabled[source]} disabled={busy !== null} onClick={() => setSources(source, !policy.sourceEnabled[source])} className="w-fit rounded-lg border border-zinc-700 px-3 py-2 text-sm aria-pressed:border-emerald-400 aria-pressed:bg-emerald-500/10 disabled:opacity-50">{policy.sourceEnabled[source] ? "수집 사용" : "수집 안 함"}</button>
              </div>;
            })}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
            <h2 className="font-semibold">최근 7일 기록</h2>
            <p className="mt-2 text-sm text-zinc-300">기록된 토큰 {metrics!.recordedTokens.toLocaleString()} · 발행 {metrics!.publishedSevenDays}건 · 오류 {metrics!.sevenDayErrors}건</p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">기록된 토큰은 SDK 사용 메타데이터가 있을 때의 합계이며, 제공사 청구량을 보장하지 않습니다.</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
            <h2 className="font-semibold">저장 초안과 다음 예약</h2>
            {currentRun ? <p className="mt-2 text-xs text-zinc-400">최근 실행: {runStatusText(currentRun.status)}{currentRun.reason ? ` · ${reasonText(currentRun.reason)}` : ""}</p> : null}
            {currentRun?.draft ? <div className="mt-2 text-sm text-zinc-300"><p className="font-medium">{currentRun.draft.title}</p>{currentRun.draft.paragraphs.map((paragraph, index) => <p key={`${paragraph.text}-${index}`} className="mt-2 whitespace-pre-wrap text-zinc-400">{paragraph.text}</p>)}<p className="mt-2 text-zinc-400">질문: {currentRun.draft.question}</p></div> : <p className="mt-2 text-sm text-zinc-400">저장된 초안이 없습니다. 자료가 부족하면 발행을 보류합니다.</p>}
            <p className="mt-3 text-xs leading-5 text-zinc-500">다음 예약 기준: 매일 09:00 KST에 수집이 켜져 있고 하루 한도가 남아 있으며, 본문으로 확인한 자료와 검증을 통과한 초안이 있을 때만 발행합니다. 실행 시작은 지연될 수 있고, 429·한도 초과는 다음 예약으로 미룹니다.</p>
          </div>
        </section>

        {status.missingEnv.length > 0 && <details className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm"><summary className="cursor-pointer font-medium text-zinc-200">설정 문제 상세</summary><p className="mt-2 break-words text-zinc-400">필요한 환경변수: {status.missingEnv.join(", ")}</p></details>}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3"><p className="text-xs text-zinc-500">{label}</p><p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p></div>;
}
