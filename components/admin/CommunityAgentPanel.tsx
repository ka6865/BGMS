"use client";

import { useEffect, useMemo, useState } from "react";
import CommunityReviewQueue from "@/components/admin/CommunityReviewQueue";
import type { CollectSource, CommunityAgentStatus, Policy, RunSnapshot, Stage } from "@/lib/community-agent/types";

const SOURCE_META: Record<CollectSource, { label: string; href: string }> = {
  dc: { label: "디시인사이드 배틀그라운드", href: "https://gall.dcinside.com/board/lists/?id=battlegrounds" },
  naver: { label: "네이버 배틀그라운드 공식 카페", href: "https://cafe.naver.com/playbattlegrounds" },
  youtube: { label: "PUBG: BATTLEGROUNDS Korea", href: "https://www.youtube.com/@PUBG_KR" },
};
const SOURCE_HELP: Record<CollectSource, { title: string; description: string; env: string[] }> = {
  dc: { title: "디시인사이드", description: "배틀그라운드 갤러리의 공개 글에서 최근 화제와 이용자 반응을 찾습니다.", env: [] },
  naver: { title: "네이버 카페", description: "배틀그라운드 공식 카페의 검색 결과를 참고합니다. 검색 요약만 읽으며 블로그는 수집하지 않습니다.", env: ["NAVER_SEARCH_CLIENT_ID", "NAVER_SEARCH_CLIENT_SECRET"] },
  youtube: { title: "유튜브", description: "배그 공식 한국 채널의 최근 영상 설명과 공개 댓글을 참고합니다.", env: ["YOUTUBE_DATA_API_KEY"] },
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
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);

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
        method: "POST", body: JSON.stringify(canRetry && todayRun
          ? { action: "retry", runId: todayRun.id }
          : { action: "start", dryRun: true }),
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
      setReviewRefreshKey((value) => value + 1);
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
  const todayRun = status.runs.find((run) => run.day === dateKey());
  const canRetry = Boolean(todayRun && ["deferred", "failed"].includes(todayRun.status));
  const todayFinished = Boolean(todayRun && ["ready", "published"].includes(todayRun.status));
  const manualMissingEnv = status.missingEnv.filter((name) => name !== "COMMUNITY_AGENT_WORKER_SECRET");
  const schedulerSecretMissing = status.missingEnv.includes("COMMUNITY_AGENT_WORKER_SECRET");
  const canTrial = policy.enabled && Boolean(policy.botUserId)
    && SOURCE_ORDER.some((source) => policy.sourceEnabled[source]) && !todayFinished;
  const setSources = (source: CollectSource, enabled: boolean) => void updatePolicy({ sourceEnabled: { ...policy.sourceEnabled, [source]: enabled } }, `source-${source}`);

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-5 text-zinc-100 sm:px-6 sm:py-7">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-amber-300">BGMS AI</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight">커뮤니티 운영</h1>
            <p className="mt-1 text-sm text-zinc-400">배그 커뮤니티 자료를 모아 Gemini로 게시글 초안을 만듭니다. 먼저 출처를 선택하세요.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={busy !== null} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 disabled:opacity-50">새로고침</button>
        </header>

        {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}

        <section aria-labelledby="community-sources" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
          <h2 id="community-sources" className="font-semibold">1. 수집할 사이트 선택</h2>
          <p className="mt-1 text-sm text-zinc-400">참고할 출처를 켜세요. 설정은 즉시 저장되며, 아래 ‘자료 수집·초안 만들기’를 누르면 실행합니다.</p>
          <div className="mt-4 grid gap-5 lg:grid-cols-3">
            {SOURCE_ORDER.map((source) => {
              const item = status.sources.find((value) => value.id === source);
              const report = currentRun?.reports.find((value) => value.source === source);
              const help = SOURCE_HELP[source];
              const missingKey = help.env.some((name) => status.missingEnv.includes(name));
              return <div key={source} className="flex min-w-0 flex-col gap-2 border-t border-zinc-800 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{help.title}</h3>
                  <span className={`text-xs ${policy.sourceEnabled[source] ? "text-emerald-300" : "text-zinc-400"}`}>{policy.sourceEnabled[source] ? "수집 켜짐" : "수집 꺼짐"}</span>
                </div>
                <p className="text-sm leading-6 text-zinc-400">{help.description}</p>
                <a href={SOURCE_META[source].href} target="_blank" rel="noopener noreferrer" className="text-xs leading-5 text-amber-200 underline underline-offset-4">{sourceName(source)} ↗</a>
                <p className={`text-xs ${missingKey ? "text-amber-300" : "text-emerald-300"}`}>{help.env.length === 0 ? "API 키 없이 이용" : missingKey ? "API 키 등록 필요 · 서버 설정에서 등록하세요" : "API 키 등록됨 · 실제 수집 결과는 실행 후 확인"}</p>
                <p className="text-xs leading-5 text-zinc-500">지난 수집 상태: {sourceStateText(item?.state)}{item?.reason ? ` · ${reasonText(item.reason)}` : ""}</p>
                {report && <p className="text-xs leading-5 text-zinc-500">{currentRun.day} 실행: 조회 {report.fetchedCount}건 · 채택 {report.retainedCount}건</p>}
                <button type="button" aria-label={`${help.title} 수집 ${policy.sourceEnabled[source] ? "끄기" : "켜기"}`} aria-pressed={policy.sourceEnabled[source]} disabled={busy !== null} onClick={() => setSources(source, !policy.sourceEnabled[source])} className="mt-auto min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium aria-pressed:border-emerald-400 aria-pressed:bg-emerald-500/10 disabled:opacity-50">{policy.sourceEnabled[source] ? "수집 끄기" : "수집 켜기"}</button>
              </div>;
            })}
          </div>
          <p className="mt-4 text-xs leading-5 text-zinc-500">키 등록 상태와 지난 수집 결과는 별개입니다. 키를 추가해도 과거 오류 기록은 남습니다. 선택한 자료로 BGMS 게시판의 글 초안을 만들며 외부 사이트에 글이나 댓글을 쓰지는 않습니다.</p>
        </section>

        <section aria-label="운영 수치" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="오늘 발행" value={`${metrics!.publishedToday}건`} />
          <Metric label="오늘 보류" value={`${metrics!.heldToday}건`} />
          <Metric label="최근 7일 오류" value={`${metrics!.sevenDayErrors}건`} />
          <Metric label="최근 7일 발행" value={`${metrics!.publishedSevenDays}건`} />
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold">2. 자료 수집·초안 만들기</h2>
              <p className="mt-1 text-sm leading-5 text-zinc-400">출처 선택 → 수집 허용 → 초안 만들기 → 아래 결과 확인</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void prepare()} disabled={busy !== null || Boolean(policy.botUserId)} className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50">{policy.botUserId ? "계정 준비됨" : "계정 준비"}</button>
              <button type="button" onClick={() => void updatePolicy(policy.enabled
                ? { enabled: false, publishingEnabled: false }
                : { enabled: true }, "enabled")} disabled={busy !== null} className="rounded-lg border border-zinc-600 px-3 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50">{policy.enabled ? "일시 중지" : "수집 허용 켜기"}</button>
              <button type="button" onClick={() => void runTrial()} disabled={busy !== null || !canTrial} className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-bold text-zinc-950 disabled:opacity-50">{busy === "trial" ? "자료 수집·초안 작성 중…" : canRetry ? "다시 수집·초안 만들기" : todayFinished ? "오늘 실행 완료" : "자료 수집·초안 만들기"}</button>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">버튼을 누르면 선택한 사이트 조회 → 주제 선정 → Gemini 초안 작성 → 근거 검증을 진행합니다. 이 과정에서는 게시하지 않으며, 자료가 부족하면 이유를 표시하고 보류합니다.</p>
          {todayFinished && <p role="status" className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-200">오늘 실행은 {runStatusText(todayRun!.status)} 상태입니다. 완성된 초안이나 발행된 글이 있어 추가 수집을 하지 않습니다. 하루 발행 한도는 1건입니다.</p>}
          {canRetry && <p role="status" className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-200">최근 실행이 {runStatusText(todayRun!.status)} 상태입니다. 키나 출처를 수정했다면 ‘다시 수집·초안 만들기’를 누르세요. 이전 기록은 보존하고 현재 설정으로 새 시험 실행을 시작합니다. 재실행마다 API와 Gemini 사용량이 발생할 수 있으며 자동으로 게시하지 않습니다.</p>}
          {!policy.botUserId && <p className="mt-2 text-sm text-amber-200">먼저 ‘계정 준비’를 눌러 글을 작성할 AI 비서 계정을 준비하세요.</p>}
          {!policy.enabled && <p className="mt-2 text-sm text-amber-200">‘수집 허용 켜기’를 누르면 초안을 만들 수 있습니다.</p>}
          {!SOURCE_ORDER.some((source) => policy.sourceEnabled[source]) && <p className="mt-2 text-sm text-amber-200">위에서 수집할 사이트를 하나 이상 켜세요.</p>}
          <a href="#community-reviews" className="mt-3 inline-block text-sm text-amber-200 underline underline-offset-4">승인 대기 초안 확인 ↓</a>
        </section>

        <CommunityReviewQueue refreshKey={reviewRefreshKey} />

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
          <h2 className="font-semibold">3. 운영 제한</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">모든 게시글과 답글은 BGMS AI 초안으로 저장됩니다. Discord 알림을 확인한 관리자가 승인하거나 거절하며, 자동 게시 설정은 사용하지 않습니다.</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
            <h2 className="font-semibold">최근 7일 기록</h2>
            <p className="mt-2 text-sm text-zinc-300">기록된 토큰 {metrics!.recordedTokens.toLocaleString()} · 발행 {metrics!.publishedSevenDays}건 · 오류 {metrics!.sevenDayErrors}건</p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">기록된 토큰은 SDK 사용 메타데이터가 있을 때의 합계이며, 제공사 청구량을 보장하지 않습니다.</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
            <h2 id="community-draft" className="scroll-mt-20 font-semibold">초안과 실행 결과</h2>
            {currentRun ? <p className="mt-2 text-xs text-zinc-400">최근 실행: {runStatusText(currentRun.status)}{currentRun.reason ? ` · ${reasonText(currentRun.reason)}` : ""}</p> : null}
            {currentRun?.draft ? <div className="mt-2 text-sm text-zinc-300"><p className="font-medium">{currentRun.draft.title}</p>{currentRun.draft.paragraphs.map((paragraph, index) => <p key={`${paragraph.text}-${index}`} className="mt-2 whitespace-pre-wrap text-zinc-400">{paragraph.text}</p>)}<p className="mt-2 text-zinc-400">질문: {currentRun.draft.question}</p></div> : <p className="mt-2 text-sm text-zinc-400">저장된 초안이 없습니다. 자료가 부족하면 발행을 보류합니다.</p>}
            <p className="mt-3 text-xs leading-5 text-zinc-500">예약 실행기는 한국 시간 기준으로 자료와 답글 후보를 확인할 수 있습니다. 검증을 통과해도 먼저 승인 대기 초안으로 저장되며, 관리자가 승인하기 전에는 게시하지 않습니다.</p>
          </div>
        </section>

        {schedulerSecretMissing && <details className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm"><summary className="cursor-pointer font-medium text-zinc-200">자동 예약 설정 · 수동 실행에는 필요 없음</summary><p className="mt-2 text-zinc-400">예약 실행기가 서버에 접속할 때 사용하는 내부 인증 암호가 아직 등록되지 않았습니다. 자동 예약을 연결할 때 서버와 예약 실행기에 같은 값을 설정합니다. 관리자 화면의 수집·재실행은 지금 사용할 수 있습니다.</p><code className="mt-2 block break-all text-xs text-zinc-500">COMMUNITY_AGENT_WORKER_SECRET</code></details>}
        {manualMissingEnv.length > 0 && <details className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm"><summary className="cursor-pointer font-medium text-zinc-200">설정 문제 상세</summary><p className="mt-2 break-words text-zinc-400">필요한 환경변수: {manualMissingEnv.join(", ")}</p></details>}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3"><p className="text-xs text-zinc-500">{label}</p><p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p></div>;
}
