"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Check, Clock3, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import type { MatchData } from "@/types/stat";
import type { StatsPlatform } from "@/types/stats-page";
import type { BanStatus } from "@/lib/pubg/banStatus";
import type { BanStatusEvent, BanStatusRow, BanWatchItem } from "@/lib/pubg/banWatch";
import type { DeathEncounter } from "@/lib/pubg/deathEncounters";

export interface BanWatchPanelProps {
  platform?: StatsPlatform;
  matchId?: string;
  nickname?: string;
  subjectAccountId?: string;
  match?: Pick<MatchData, "mapName" | "createdAt"> | MatchData | null;
  /** Used by cached/basic-only match cards that have no original telemetry. */
  sourceUnavailable?: boolean;
}

type PanelStatus = BanStatus | "";

type BanWatchPayload = {
  items?: BanWatchItem[];
  statuses?: BanStatusRow[];
  events?: BanStatusEvent[];
};

type HttpError = Error & { status?: number; code?: string };

const ROLE_LABEL: Record<DeathEncounter["role"], string> = {
  killer: "처치",
  finisher: "마무리",
  knocker: "기절시킴",
};

const STATUS_LABEL: Record<BanStatus, string> = {
  none: "현재 제재 표시 없음",
  temporary: "임시 제재 확인",
  permanent: "영구 제재 확인",
  unknown: "제재 상태 확인 실패",
};

function isRawAccountId(value: unknown): value is string {
  return typeof value === "string"
    && /^account\.[A-Za-z0-9._:-]+$/u.test(value)
    && !/^[a-f0-9]{32}$/u.test(value);
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "정보 없음";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "정보 없음";
  return new Date(timestamp).toLocaleString("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizePayload(value: unknown): BanWatchPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const payload = value as Record<string, unknown>;
  const nested = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  return {
    items: Array.isArray(nested.items) ? nested.items as BanWatchItem[] : [],
    statuses: Array.isArray(nested.statuses) ? nested.statuses as BanStatusRow[] : [],
    events: Array.isArray(nested.events) ? nested.events as BanStatusEvent[] : [],
  };
}

function errorFromResponse(response: Response, payload: unknown): HttpError {
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const error = new Error(typeof body.error === "string" ? body.error : "제재 추적 요청에 실패했습니다.") as HttpError;
  error.status = response.status;
  if (typeof body.code === "string") error.code = body.code;
  return error;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers || {}) },
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // An empty body is still represented by the HTTP status below.
  }
  if (!response.ok) throw errorFromResponse(response, payload);
  return payload;
}

type EnrichedWatchItem = BanWatchItem & {
  currentStatus?: BanStatus;
  currentCheckedAt?: string | null;
  currentError?: string | null;
};

function statusFor(
  item: BanWatchItem,
  statuses: BanStatusRow[],
): BanStatusRow | null {
  const found = statuses.find((row) => row.platform === item.platform && row.accountId === item.targetAccountId);
  if (found) return found;
  const enriched = item as EnrichedWatchItem;
  if (!enriched.currentStatus) return null;
  return {
    accountId: item.targetAccountId,
    platform: item.platform,
    status: enriched.currentStatus,
    rawType: null,
    checkedAt: enriched.currentCheckedAt || "",
    lastAttemptAt: null,
    lastError: enriched.currentError || null,
    nextCheckAt: null,
    updatedAt: enriched.currentCheckedAt || item.createdAt,
  };
}

function statusValue(row: BanStatusRow | null): PanelStatus {
  if (!row) return "";
  const value = (row.status || (row as BanStatusRow & { normalizedStatus?: BanStatus }).normalizedStatus) as unknown;
  return value === "none" || value === "temporary" || value === "permanent" || value === "unknown" ? value : "unknown";
}

function statusTone(status: PanelStatus): string {
  switch (status) {
    case "temporary":
    case "permanent":
      return "border-rose-400/30 bg-rose-500/10 text-rose-200";
    case "none":
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-200";
    default:
      return "border-amber-400/20 bg-amber-500/10 text-amber-100";
  }
}

function statusText(row: BanStatusRow | null): string {
  const status = statusValue(row);
  if (!status) return "확인 대기";
  if (row?.lastError) {
    const prior = status === "unknown" ? "이전 확인 상태 유지" : STATUS_LABEL[status];
    return `확인 실패 · ${prior}`;
  }
  return STATUS_LABEL[status];
}

function eventsFor(item: BanWatchItem, events: BanStatusEvent[]): BanStatusEvent[] {
  return events
    .filter((event) => event.platform === item.platform && event.accountId === item.targetAccountId)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
}


function firstPermanentCopy(item: BanWatchItem, event: BanStatusEvent | null): string | null {
  if (!event || event.observedStatus !== "permanent" || event.previousStatus !== null) return null;
  const createdAt = Date.parse(item.createdAt);
  const observedAt = Date.parse(event.observedAt);
  if (Number.isFinite(createdAt) && Number.isFinite(observedAt) && observedAt < createdAt) {
    return "등록 시 이미 영구 제재 상태";
  }
  return "등록 후 영구 제재 상태를 처음 확인했습니다";
}

function encounterKey(encounter: DeathEncounter): string {
  return `${encounter.targetAccountId}:${encounter.eventAt}:${encounter.role}`;
}

export function BanWatchPanel({
  platform,
  matchId,
  nickname,
  subjectAccountId,
  match,
  sourceUnavailable = false,
}: BanWatchPanelProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [items, setItems] = useState<BanWatchItem[]>([]);
  const [statuses, setStatuses] = useState<BanStatusRow[]>([]);
  const [events, setEvents] = useState<BanStatusEvent[]>([]);
  const [encounters, setEncounters] = useState<DeathEncounter[]>([]);
  const [loading, setLoading] = useState(false);
  const [encountersLoading, setEncountersLoading] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [unavailable, setUnavailable] = useState(sourceUnavailable);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const [registerRole, setRegisterRole] = useState<Record<string, DeathEncounter["role"]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renderedAt] = useState(() => Date.now());
  const listRequestId = useRef(0);

  const hasMatchContext = Boolean(platform && matchId);
  const resolvedSubjectAccountId = isRawAccountId(subjectAccountId) ? subjectAccountId : undefined;
  const mapName = match?.mapName || null;
  const playedAt = match?.createdAt || null;

  const loadList = useCallback(async () => {
    if (!user) return;
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    setSignedOut(false);
    try {
      const payload = normalizePayload(await requestJson("/api/pubg/ban-watch"));
      if (requestId !== listRequestId.current) return;
      setItems(payload.items || []);
      setStatuses(payload.statuses || []);
      setEvents(payload.events || []);
    } catch (caught) {
      if (requestId !== listRequestId.current) return;
      const requestError = caught as HttpError;
      if (requestError.status === 401) setSignedOut(true);
      else setError("제재 추적 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      if (requestId === listRequestId.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    listRequestId.current += 1;
    setItems([]);
    setStatuses([]);
    setEvents([]);
    setNotes({});
    if (!user) {
      setSignedOut(true);
      setItems([]);
      return;
    }
    void loadList();
    return () => { listRequestId.current += 1; };
  }, [authLoading, loadList, user]);

  useEffect(() => {
    setUnavailable(sourceUnavailable);
    setEncounters([]);
    setError(null);
  }, [sourceUnavailable, platform, matchId, nickname]);

  useEffect(() => {
    if (authLoading || !user || !hasMatchContext || unavailable || !platform || !matchId) return;
    const controller = new AbortController();
    setEncountersLoading(true);
    setError(null);
    const body: Record<string, string> = { platform, matchId };
    if (resolvedSubjectAccountId) body.subjectAccountId = resolvedSubjectAccountId;
    if (nickname?.trim()) body.nickname = nickname.trim();
    void requestJson("/api/pubg/ban-watch/encounters", {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    }).then((payload) => {
      if (controller.signal.aborted) return;
      const response = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const source = response.source && typeof response.source === "object" ? response.source as Record<string, unknown> : null;
      if (source?.kind === "unavailable") {
        setUnavailable(true);
        setEncounters([]);
        return;
      }
      setEncounters(Array.isArray(response.encounters) ? response.encounters as DeathEncounter[] : []);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      const requestError = caught as HttpError;
      if (requestError.status === 401) setSignedOut(true);
      else if (requestError.status === 404 || requestError.status === 503 || requestError.code === "encounter_source_unavailable") setUnavailable(true);
      else setError(requestError.message || "사망 경기 원본을 확인하지 못했습니다.");
    }).finally(() => {
      if (!controller.signal.aborted) setEncountersLoading(false);
    });
    return () => controller.abort();
  }, [authLoading, hasMatchContext, matchId, nickname, platform, resolvedSubjectAccountId, unavailable, user]);

  const registerEncounter = async (encounter: DeathEncounter) => {
    const verifiedSubject = isRawAccountId(encounter.subjectAccountId) ? encounter.subjectAccountId : resolvedSubjectAccountId;
    if (!user || !platform || !matchId || !verifiedSubject) {
      setError("공식 계정 확인이 끝난 뒤 추적을 등록할 수 있습니다.");
      return;
    }
    const key = encounterKey(encounter);
    setRegistering(key);
    setError(null);
    try {
      await requestJson("/api/pubg/ban-watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          subjectAccountId: verifiedSubject,
          subjectNicknameAtMatch: nickname || null,
          targetAccountId: encounter.targetAccountId,
          matchId,
          eventAt: encounter.eventAt,
          role: encounter.role,
          nicknameAtMatch: encounter.nicknameAtMatch,
          weapon: encounter.weapon,
          mapName,
          note: notes[key] || null,
        }),
      });
      setNotes((current) => ({ ...current, [key]: "" }));
      await loadList();
    } catch (caught) {
      const requestError = caught as HttpError;
      if (requestError.status === 401) setSignedOut(true);
      else if (requestError.status === 404 || requestError.status === 503 || requestError.code === "encounter_source_unavailable" || requestError.code === "migration_unavailable") setUnavailable(true);
      else setError(requestError.message || "추적 등록에 실패했습니다.");
    } finally {
      setRegistering(null);
    }
  };

  const updateItem = async (item: BanWatchItem, update: Record<string, unknown>) => {
    setActionId(item.id);
    setError(null);
    try {
      const payload = await requestJson("/api/pubg/ban-watch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, ...update }),
      });
      const updated = payload && typeof payload === "object" && "item" in payload
        ? (payload as { item?: BanWatchItem }).item
        : undefined;
      if (updated) setItems((current) => current.map((candidate) => candidate.id === item.id ? updated : candidate));
      if (update.refresh) setNotice("다음 확인을 예약했습니다. 실제 상태 조회는 서버 작업 시점에 진행됩니다.");
      if (update.extend) setNotice("추적 기간을 30일 연장했습니다.");
      if (update.markViewed) setNotice("새 상태 변화를 읽음 처리했습니다.");
      if (update.refresh || update.extend || update.markViewed) await loadList();
    } catch (caught) {
      const requestError = caught as HttpError;
      if (requestError.status === 401) setSignedOut(true);
      else setError(requestError.message || "추적 항목을 변경하지 못했습니다.");
    } finally {
      setActionId(null);
      setSavingNote(null);
    }
  };

  const deleteItem = async (item: BanWatchItem) => {
    setActionId(item.id);
    setError(null);
    try {
      await requestJson(`/api/pubg/ban-watch?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (caught) {
      const requestError = caught as HttpError;
      if (requestError.status === 401) setSignedOut(true);
      else setError(requestError.message || "추적 항목을 삭제하지 못했습니다.");
    } finally {
      setActionId(null);
    }
  };

  const encounterKeys = useMemo(() => new Set(items.map((item) => `${item.targetAccountId}:${item.eventAt}:${item.role}`)), [items]);

  return (
    <section
      data-testid="ban-watch-panel"
      aria-label="제재 추적"
      className="mt-5 overflow-hidden rounded-[1.5rem] border border-indigo-400/20 bg-indigo-500/[0.06] md:mt-6 md:rounded-[1.75rem]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 p-4 md:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-400/10 text-indigo-200">
            <Ban size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-black text-white">관심 등록</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/55">사망 경기의 공식 계정 후보를 개인 목록에 저장하고 확인 시각과 상태 변화를 기록합니다.</p>
          </div>
        </div>
        {user && !loading && (
          <button
            type="button"
            aria-label="제재 추적 목록 새로고침"
            data-testid="ban-watch-refresh-list"
            onClick={() => void loadList()}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {signedOut && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 md:p-5" data-testid="ban-watch-login">
          <p className="text-sm font-bold text-white/80">로그인하면 사망 상대를 개인 목록에서 추적할 수 있습니다.</p>
          <button type="button" onClick={() => router.push("/login")} className="min-h-11 rounded-xl bg-indigo-400/20 px-4 text-xs font-black text-indigo-100 hover:bg-indigo-400/30">로그인</button>
        </div>
      )}

      {unavailable && !signedOut && (
        <div role="status" data-testid="ban-watch-unavailable" className="p-4 text-sm leading-relaxed text-sky-100 md:p-5">
          선택한 경기의 원본을 사용할 수 없어 제재 추적 후보를 확인할 수 없습니다. 저장된 추적 목록은 계속 확인할 수 있습니다.
        </div>
      )}

      {error && !signedOut && (
        <div role="alert" data-testid="ban-watch-error" className="border-b border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-100 md:p-5">{error}</div>
      )}

      {!signedOut && hasMatchContext && !unavailable && (
        <div className="border-b border-white/10 p-4 md:p-5" data-testid="ban-watch-encounters">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-black text-white">이 경기에서 확인된 사망 상대</h4>
              <p className="mt-1 text-[11px] text-white/45">역할은 원본 이벤트 그대로 표시되며 서로 합치지 않습니다.</p>
            </div>
            {encountersLoading && <span className="text-xs text-white/45">원본 확인 중…</span>}
          </div>
          {!encountersLoading && encounters.length === 0 && <p className="text-xs text-white/50">추적할 수 있는 공식 계정 후보가 없습니다.</p>}
          <div className="grid gap-2">
            {encounters.map((encounter) => {
              const key = encounterKey(encounter);
              const relatedEncounters = encounters.filter((candidate) => candidate.targetAccountId === encounter.targetAccountId && candidate.eventAt === encounter.eventAt);
              const alreadyRegistered = encounterKeys.has(key);
              const selectedRole = registerRole[key] || encounter.role;
              const selectedEncounter = relatedEncounters.find((candidate) => candidate.role === selectedRole) || encounter;
              return (
                <div key={key} data-testid="ban-watch-encounter" className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-black text-white">{encounter.nicknameAtMatch || "정보 없음"}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-white/55">
                        <span>{ROLE_LABEL[encounter.role]}</span>
                        <span>{encounter.weapon || "정보 없음"}</span>
                        <span>{dateLabel(encounter.eventAt)}</span>
                      </div>
                    </div>
                    {alreadyRegistered ? (
                      <span className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 text-[11px] font-black text-emerald-200"><Check size={13} aria-hidden="true" />추적 중</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        {relatedEncounters.length > 1 && <>
                          <label className="sr-only" htmlFor={`ban-role-${key}`}>추적 역할</label>
                          <select
                            id={`ban-role-${key}`}
                            aria-label={`${encounter.nicknameAtMatch || "상대"} 추적 역할`}
                            value={selectedRole}
                            onChange={(event) => setRegisterRole((current) => ({ ...current, [key]: event.target.value as DeathEncounter["role"] }))}
                            className="min-h-9 rounded-lg border border-white/10 bg-[#252525] px-2 text-xs font-bold text-white"
                          >
                            {relatedEncounters.map((candidate) => <option key={candidate.role} value={candidate.role}>{ROLE_LABEL[candidate.role]}</option>)}
                          </select>
                        </>}
                        <button
                          type="button"
                          data-testid="ban-watch-register"
                          onClick={() => void registerEncounter(selectedEncounter)}
                          disabled={Boolean(registering)}
                          className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-indigo-400/20 px-3 text-[11px] font-black text-indigo-100 disabled:opacity-50"
                        >
                          <UserPlus size={13} aria-hidden="true" />{registering === key ? "등록 중…" : "추적 등록"}
                        </button>
                      </div>
                    )}
                  </div>
                  {!alreadyRegistered && (
                    <input
                      value={notes[key] || ""}
                      onChange={(event) => setNotes((current) => ({ ...current, [key]: event.target.value.slice(0, 200) }))}
                      maxLength={200}
                      aria-label={`${encounter.nicknameAtMatch || "상대"} 메모`}
                      placeholder="메모 (선택, 200자 이내)"
                      className="mt-3 min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-xs text-white placeholder:text-white/35"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!signedOut && (
        <div className="p-4 md:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="text-xs font-black text-white">내 추적 목록</h4>
            {loading && <span className="text-xs text-white/45">불러오는 중…</span>}
          </div>
          {!loading && items.length === 0 ? (
            <p className="text-xs text-white/50">아직 등록한 상대가 없습니다.</p>
          ) : (
            <div className="grid gap-3">
              {items.map((item) => {
                const status = statusFor(item, statuses);
                const currentStatus = statusValue(status);
                const itemEvents = eventsFor(item, events);
                const latestEvent = itemEvents[0] || null;
                const permanentCopy = firstPermanentCopy(item, latestEvent);
                const hasUnreadEvent = Boolean(latestEvent && (!item.lastViewedAt || Date.parse(latestEvent.observedAt) > Date.parse(item.lastViewedAt)));
                const baselineStatus = item.baselineStatus;
                const changed = baselineStatus && currentStatus && baselineStatus !== currentStatus;
                const activeUntil = Date.parse(item.activeUntil);
                const expired = Number.isFinite(activeUntil) && activeUntil <= renderedAt;
                const noteValue = notes[item.id] ?? item.note ?? "";
                return (
                  <article key={item.id} data-testid="ban-watch-item" className="rounded-xl border border-white/10 bg-black/20 p-3 md:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h5 className="truncate text-sm font-black text-white">{item.nicknameAtMatch || "정보 없음"}</h5>
                        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-white/55">
                          <span>{ROLE_LABEL[item.role]}</span>
                          <span>{item.weapon || "정보 없음"}</span>
                          <span>{item.mapName || "맵 정보 없음"}</span>
                          <span>{dateLabel(item.eventAt || playedAt)}</span>
                          <span className={expired ? "text-rose-200" : ""}>{expired ? "추적 만료" : `추적 만료 ${dateLabel(item.activeUntil)}`}</span>
                        </div>
                      </div>
                      <div className={`rounded-lg border px-2.5 py-1.5 text-right text-[11px] font-black ${statusTone(currentStatus)}`}>
                        <div>{statusText(status)}</div>
                        <div className="mt-0.5 text-[10px] font-bold opacity-70">{currentStatus ? `마지막 확인 ${dateLabel(status?.checkedAt)}` : "확인 대기"}</div>
                      </div>
                    </div>
                    {changed && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-100">상태 변화: {STATUS_LABEL[baselineStatus]} → {STATUS_LABEL[currentStatus]}</p>}
                    {permanentCopy && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-100">{permanentCopy}</p>}
                    {hasUnreadEvent && <p className="mt-2 text-xs font-bold text-indigo-100">새 상태 변화가 확인되었습니다.</p>}
                    {itemEvents.length > 1 && <p className="mt-2 text-xs text-white/55">최근 관찰 {itemEvents.slice(0, 3).map((event) => `${STATUS_LABEL[event.observedStatus]} · ${dateLabel(event.observedAt)}`).join(" · ")}</p>}
                    {status?.lastError && <p className="mt-2 text-xs text-amber-100/80">다음 확인을 기다리는 동안 이전 상태를 유지합니다.</p>}
                    {notice && <p className="mt-2 text-xs text-teal-100/80" role="status">{notice}</p>}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={noteValue}
                        onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value.slice(0, 200) }))}
                        maxLength={200}
                        aria-label={`${item.nicknameAtMatch || "상대"} 메모 수정`}
                        placeholder="메모 (선택, 200자 이내)"
                        className="min-h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 text-xs text-white placeholder:text-white/35"
                      />
                      <button
                        type="button"
                        onClick={() => { setSavingNote(item.id); void updateItem(item, { note: noteValue }); }}
                        disabled={actionId === item.id}
                        className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-black text-white/75 disabled:opacity-50"
                      >
                        {savingNote === item.id ? "저장 중…" : "메모 저장"}
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => void updateItem(item, { extend: true })} disabled={actionId === item.id} className="min-h-10 inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 text-[11px] font-black text-white/70 disabled:opacity-50"><Clock3 size={13} aria-hidden="true" />30일 연장</button>
                      <button type="button" data-testid="ban-watch-refresh" onClick={() => void updateItem(item, { refresh: true })} disabled={actionId === item.id} className="min-h-10 inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 text-[11px] font-black text-white/70 disabled:opacity-50"><RefreshCw size={13} aria-hidden="true" />다시 확인</button>
                      {hasUnreadEvent && <button type="button" onClick={() => void updateItem(item, { markViewed: true })} disabled={actionId === item.id} className="min-h-10 rounded-lg border border-indigo-400/20 px-3 text-[11px] font-black text-indigo-100 disabled:opacity-50">읽음</button>}
                      <button type="button" data-testid="ban-watch-delete" onClick={() => void deleteItem(item)} disabled={actionId === item.id} className="min-h-10 inline-flex items-center gap-1 rounded-lg border border-rose-400/20 px-3 text-[11px] font-black text-rose-200 disabled:opacity-50"><Trash2 size={13} aria-hidden="true" />삭제</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default BanWatchPanel;
