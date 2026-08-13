"use client";

import React, { useState, useMemo } from "react";
import {
  Activity,
  Search,
  RefreshCw,
  Shield,
  AlertTriangle,
  Clock,
  Trash2,
  Save,
  X,
  Compass,
  Calendar
} from "lucide-react";
import { toast } from "sonner";
import ConfirmModal from "@/components/common/ConfirmModal";

export interface ActivityEventItem {
  id: string;
  createdAt: string;
  eventName: string;
  label: string;
  details: string;
  pagePath: string | null;
}

export interface UserActivity7D {
  totalEvents: number;
  lastEventAt: string | null;
  statsSearchCount: number;
  topPages: Array<{ path: string; label: string; count: number }>;
  summaryBadges: string[];
  events: ActivityEventItem[];
  aiRequests: number;
  aiSuccessCount: number;
  aiFailedCount: number;
  aiSuccessRate: number;
  aiCostUsd: number;
  aiErrors: Array<{ code: string; label: string; count: number }>;
  aiRecentErrors: Array<{ code: string; label: string; message: string; createdAt: string }>;
}

export interface CommandCenterUser {
  id: string;
  nickname: string | null;
  avatar_url?: string | null;
  role: string | null;
  pubg_nickname: string | null;
  pubg_platform: string | null;
  last_active_at?: string | null;
  updated_at: string | null;
  email?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  provider?: string;
  email_confirmed?: boolean;
  is_missing_profile?: boolean;
  is_orphan_profile?: boolean;
  activity7d?: UserActivity7D;
}

export interface CommandCenterMetrics {
  active7dUsers: number;
  topSearchUsers: Array<{ nickname: string; count: number }>;
  topPages: Array<{ name: string; count: number }>;
  providers: Record<string, number>;
  topAiUsers?: Array<{ userId: string; nickname: string; count: number }>;
  ai24h?: AiWindowSummary;
  ai7d?: AiWindowSummary;
  pubgApi24h?: PubgErrorSummary;
  pubgApi7d?: PubgErrorSummary;
}

export interface AiWindowSummary {
  windowHours: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number;
  uniqueUsers: number;
  memberUsageRate?: number;
  guestRequests: number;
  totalCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  averageDurationMs: number | null;
  byType: Record<string, number>;
  errorsByReason: Array<{ code: string; label: string; count: number; lastAt: string | null }>;
  recentErrors: Array<{
    id: string;
    createdAt: string;
    analysisType: string;
    errorCode: string;
    errorLabel: string;
    message: string;
    userId: string | null;
    durationMs: number | null;
    platform: string | null;
    requestId: string | null;
  }>;
}

export interface PubgErrorSummary {
  total: number;
  byStatus: Record<string, number>;
  byReason: Array<{ reason: string; count: number; lastAt: string | null }>;
  recent: Array<{
    id: string;
    createdAt: string;
    route: string;
    status: number | null;
    reason: string;
    failureStage: string | null;
    platform: string | null;
    durationMs: number | null;
  }>;
}

export interface CommandCenterAccounts {
  totalUsers: number;
  authUsers: number;
  profiles: number;
  missingProfiles: number;
  orphanProfiles: number;
  admins: number;
}

export interface AdminUserCommandCenterProps {
  users: CommandCenterUser[];
  metrics?: CommandCenterMetrics | null;
  accounts?: CommandCenterAccounts | null;
  isRefreshing?: boolean;
  isSaving?: boolean;
  onRefresh?: () => void;
  onSyncMissingProfiles?: () => void;
  onSaveUser?: (userData: { id: string; role: string; pubg_nickname?: string; pubg_platform?: string }) => Promise<void>;
  onDeleteUser?: (id: string) => Promise<void>;
}

type SortOption = "recent" | "events" | "searches" | "issues";
type FilterOption = "all" | "user" | "admin" | "issues";

function formatRelativeTime(dateString?: string | null): string {
  if (!dateString) return "기록 없음";
  const time = Date.parse(dateString);
  if (!Number.isFinite(time)) return "기록 없음";
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 60) return "방금 전";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}일 전`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}달 전`;
  return `${Math.floor(diffMonth / 12)}년 전`;
}

function formatDateGroupHeader(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "오늘";
  if (date.toDateString() === yesterday.toDateString()) return "어제";
  return date.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}

function formatTimeOnly(dateString: string): string {
  return new Date(dateString).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function AiObservabilityPanel({ metrics }: { metrics?: CommandCenterMetrics | null }) {
  const [windowKey, setWindowKey] = useState<"ai24h" | "ai7d">("ai24h");
  const [errorFilter, setErrorFilter] = useState<"all" | "ai" | "pubg">("all");
  const ai = metrics?.[windowKey];
  const pubg = windowKey === "ai24h" ? metrics?.pubgApi24h : metrics?.pubgApi7d;
  const errors = errorFilter === "pubg" ? (pubg?.byReason || []).map((item) => ({ code: item.reason, label: item.reason, count: item.count })) : errorFilter === "ai" ? (ai?.errorsByReason || []) : [
    ...(ai?.errorsByReason || []),
    ...(pubg?.byReason || []).map((item) => ({ code: `pubg:${item.reason}`, label: `PUBG · ${item.reason}`, count: item.count, lastAt: item.lastAt })),
  ].sort((a, b) => b.count - a.count);

  return (
    <section className="space-y-3 rounded-2xl border border-indigo-500/20 bg-[#131321] p-4 shadow-lg" aria-label="AI 및 API 오류 관제">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-black text-white">AI 사용률 · 오류 관제</h3>
          <p className="mt-1 text-[10px] font-bold text-white/40">AI 비용 로그와 PUBG API 오류 로그를 분리 집계합니다.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="AI 관제 기간" value={windowKey} onChange={(e) => setWindowKey(e.target.value as "ai24h" | "ai7d")} className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs font-bold text-white">
            <option value="ai24h">최근 24시간</option>
            <option value="ai7d">최근 7일</option>
          </select>
          <select aria-label="오류 종류" value={errorFilter} onChange={(e) => setErrorFilter(e.target.value as "all" | "ai" | "pubg")} className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs font-bold text-white">
            <option value="all">AI + PUBG 오류</option>
            <option value="ai">AI 오류만</option>
            <option value="pubg">PUBG API 오류만</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <ObsMetric label="AI 요청" value={ai?.totalRequests ?? 0} />
        <ObsMetric label="성공률" value={`${ai?.successRate ?? 0}%`} tone="success" />
        <ObsMetric label="AI 오류" value={ai?.failedRequests ?? 0} tone="danger" />
        <ObsMetric label="AI 사용률" value={`${ai?.memberUsageRate ?? 0}% (${ai?.uniqueUsers ?? 0}명)`} />
        <ObsMetric label="AI 비용" value={`$${(ai?.totalCostUsd ?? 0).toFixed(4)}`} />
        <ObsMetric label="PUBG 오류" value={pubg?.total ?? 0} tone={pubg?.total ? "danger" : "success"} />
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_1.4fr]">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="mb-2 text-[11px] font-black text-white/65">오류 이유</p>
          {errors.length ? <div className="space-y-1.5">{errors.slice(0, 8).map((error) => <div key={error.code} className="flex items-center justify-between gap-3 text-xs"><span className="truncate text-white/70">{error.label}</span><strong className="text-rose-300">{error.count}건</strong></div>)}</div> : <p className="text-xs text-white/35">선택 기간 오류 없음</p>}
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="mb-2 text-[11px] font-black text-white/65">최근 오류 사례</p>
          {ai?.recentErrors?.length || pubg?.recent?.length ? (
            <div className="max-h-36 space-y-1.5 overflow-y-auto">{[
              ...(errorFilter !== "pubg" ? (ai?.recentErrors || []).map((error) => ({ id: `ai-${error.id}`, at: error.createdAt, label: `AI · ${error.errorLabel}`, detail: error.message })) : []),
              ...(errorFilter !== "ai" ? (pubg?.recent || []).map((error) => ({ id: `pubg-${error.id}`, at: error.createdAt, label: `PUBG · ${error.route}`, detail: `${error.status ?? "?"} · ${error.reason}` })) : []),
            ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10).map((error) => <div key={error.id} className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5 text-[10px]"><div className="flex justify-between gap-2"><strong className="truncate text-rose-200">{error.label}</strong><span className="shrink-0 text-white/30">{formatRelativeTime(error.at)}</span></div><p className="truncate text-white/55">{error.detail}</p></div>)}</div>
          ) : <p className="text-xs text-white/35">선택 기간 오류 없음</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold text-white/40">
        <span>분석: {Object.entries(ai?.byType || {}).map(([type, count]) => `${type} ${count}`).join(" · ") || "없음"}</span>
        <span>평균 응답: {ai?.averageDurationMs ? `${ai.averageDurationMs}ms` : "기록 없음"}</span>
        <span>상위 AI 사용자: {metrics?.topAiUsers?.slice(0, 3).map((user) => `${user.nickname} ${user.count}회`).join(" · ") || "없음"}</span>
      </div>
    </section>
  );
}

function ObsMetric({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "success" | "danger" }) {
  const color = tone === "success" ? "text-emerald-300" : tone === "danger" ? "text-rose-300" : "text-white";
  return <div className="rounded-xl border border-white/10 bg-black/20 p-2.5"><span className="block text-[10px] font-bold text-white/40">{label}</span><strong className={`mt-1 block text-sm font-black ${color}`}>{value}</strong></div>;
}

export function AdminUserCommandCenter({
  users = [],
  metrics,
  accounts,
  isRefreshing = false,
  isSaving = false,
  onRefresh,
  onSyncMissingProfiles,
  onSaveUser,
  onDeleteUser,
}: AdminUserCommandCenterProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [filterBy, setFilterBy] = useState<FilterOption>("all");
  const [selectedUser, setSelectedUser] = useState<CommandCenterUser | null>(null);

  // 선택된 유저 편집 상태
  const [editRole, setEditRole] = useState("user");
  const [editPubgNick, setEditPubgNick] = useState("");
  const [editPubgPlatform, setEditPubgPlatform] = useState("steam");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleSelectUser = (user: CommandCenterUser) => {
    setSelectedUser(user);
    setEditRole(user.role || "user");
    setEditPubgNick(user.pubg_nickname || "");
    setEditPubgPlatform(user.pubg_platform || "steam");
  };

  const handleSaveSelected = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser || !onSaveUser) return;
    try {
      await onSaveUser({
        id: selectedUser.id,
        role: editRole,
        pubg_nickname: editPubgNick,
        pubg_platform: editPubgPlatform,
      });
      toast.success(`${selectedUser.nickname || "유저"} 프로필이 수정되었습니다.`);
    } catch (err: any) {
      toast.error(err.message || "저장에 실패했습니다.");
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteConfirmId || !onDeleteUser) return;
    const targetId = deleteConfirmId;
    setDeleteConfirmId(null);
    try {
      await onDeleteUser(targetId);
      if (selectedUser?.id === targetId) setSelectedUser(null);
      toast.success("유저 계정이 성공적으로 삭제되었습니다.");
    } catch (err: any) {
      toast.error(err.message || "유저 삭제 실패");
    }
  };

  // 정제 및 검색/필터링
  const filteredUsers = useMemo(() => {
    let result = [...users];

    // 검색어 필터
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (u) =>
          (u.nickname || "").toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q) ||
          (u.pubg_nickname || "").toLowerCase().includes(q) ||
          (u.id || "").toLowerCase().includes(q)
      );
    }

    // 조건 필터
    if (filterBy === "admin") {
      result = result.filter((u) => u.role === "admin");
    } else if (filterBy === "user") {
      result = result.filter((u) => u.role !== "admin" && !u.is_missing_profile && !u.is_orphan_profile);
    } else if (filterBy === "issues") {
      result = result.filter((u) => u.is_missing_profile || u.is_orphan_profile);
    }

    // 정렬
    result.sort((a, b) => {
      if (sortBy === "recent") {
        const timeA = Math.max(
          Date.parse(a.activity7d?.lastEventAt || "0") || 0,
          Date.parse(a.last_active_at || "0") || 0,
          Date.parse(a.last_sign_in_at || "0") || 0
        );
        const timeB = Math.max(
          Date.parse(b.activity7d?.lastEventAt || "0") || 0,
          Date.parse(b.last_active_at || "0") || 0,
          Date.parse(b.last_sign_in_at || "0") || 0
        );
        return timeB - timeA;
      }
      if (sortBy === "events") {
        return (b.activity7d?.totalEvents || 0) - (a.activity7d?.totalEvents || 0);
      }
      if (sortBy === "searches") {
        return (b.activity7d?.statsSearchCount || 0) - (a.activity7d?.statsSearchCount || 0);
      }
      if (sortBy === "issues") {
        if (a.is_orphan_profile && !b.is_orphan_profile) return -1;
        if (!a.is_orphan_profile && b.is_orphan_profile) return 1;
        if (a.is_missing_profile && !b.is_missing_profile) return -1;
        if (!a.is_missing_profile && b.is_missing_profile) return 1;
      }
      return 0;
    });

    return result;
  }, [users, searchQuery, filterBy, sortBy]);

  // 타임라인 일자별 그룹화
  const selectedUserTimelineGroups = useMemo(() => {
    if (!selectedUser?.activity7d?.events) return [];
    const groupsMap = new Map<string, ActivityEventItem[]>();

    selectedUser.activity7d.events.forEach((evt) => {
      const header = formatDateGroupHeader(evt.createdAt);
      const group = groupsMap.get(header) || [];
      group.push(evt);
      groupsMap.set(header, group);
    });

    return Array.from(groupsMap.entries()).map(([dateHeader, events]) => ({
      dateHeader,
      events,
    }));
  }, [selectedUser]);

  return (
    <div className="space-y-6">
      {/* 1. Header Metrics Bar */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Metric 1: 7일 활성 회원 */}
        <div className="rounded-2xl border border-white/10 bg-[#161616] p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white/50">7일 활성 회원</span>
            <Activity size={18} className="text-emerald-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <strong className="text-2xl font-black text-white">
              {metrics?.active7dUsers ?? 0}
            </strong>
            <span className="text-xs font-bold text-white/40">
              / 전체 {accounts?.totalUsers ?? users.length}명
            </span>
          </div>
          <p className="mt-1 text-[10px] font-bold text-emerald-400/80">
            {accounts?.totalUsers ? Math.round(((metrics?.active7dUsers ?? 0) / accounts.totalUsers) * 100) : 0}% 서비스 이용률
          </p>
        </div>

        {/* Metric 2: 최다 전적 검색 회원 */}
        <div className="rounded-2xl border border-white/10 bg-[#161616] p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white/50">최다 전적 검색 회원 Top 3</span>
            <Search size={18} className="text-indigo-400" />
          </div>
          <div className="mt-2 space-y-1">
            {metrics?.topSearchUsers && metrics.topSearchUsers.length > 0 ? (
              metrics.topSearchUsers.slice(0, 3).map((item, i) => (
                <div key={i} className="flex justify-between text-xs font-bold">
                  <span className="truncate text-white/80">{item.nickname}</span>
                  <span className="text-indigo-300">{item.count}회</span>
                </div>
              ))
            ) : (
              <span className="text-xs text-white/30">검색 집계 대기 중</span>
            )}
          </div>
        </div>

        {/* Metric 3: 인기 방문 메뉴 */}
        <div className="rounded-2xl border border-white/10 bg-[#161616] p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white/50">인기 방문 메뉴 Top 3</span>
            <Compass size={18} className="text-amber-400" />
          </div>
          <div className="mt-2 space-y-1">
            {metrics?.topPages && metrics.topPages.length > 0 ? (
              metrics.topPages.slice(0, 3).map((page, i) => (
                <div key={i} className="flex justify-between text-xs font-bold">
                  <span className="truncate text-white/80">{page.name}</span>
                  <span className="text-amber-300">{page.count}회</span>
                </div>
              ))
            ) : (
              <span className="text-xs text-white/30">방문 집계 대기 중</span>
            )}
          </div>
        </div>

        {/* Metric 4: 계정 상태 현황 */}
        <div className="rounded-2xl border border-white/10 bg-[#161616] p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white/50">계정 소셜 / 점검 상태</span>
            <Shield size={18} className="text-purple-400" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-black">
            {Object.entries(metrics?.providers || {}).map(([p, count]) => (
              <span key={p} className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-white/70">
                {p.toUpperCase()}: {count}
              </span>
            ))}
            {accounts?.missingProfiles ? (
              <span className="rounded-md border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-rose-300">
                점검대상: {accounts.missingProfiles}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <AiObservabilityPanel metrics={metrics} />

      {/* 2. Control Bar (Search, Sort, Filter, Sync) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-white/10 bg-[#161616] p-3 shadow-lg">
        {/* Search */}
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            placeholder="닉네임, PUBG 닉네임, 이메일, ID 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/40 py-2 pl-9 pr-3 text-xs font-bold text-white placeholder-white/30 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Sort & Filter Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Sort selection */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white focus:outline-none"
          >
            <option value="recent">최근 활동순</option>
            <option value="events">7일 사용량순</option>
            <option value="searches">전적 검색순</option>
            <option value="issues">점검 대상 우선</option>
          </select>

          {/* Filter selection */}
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as FilterOption)}
            className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white focus:outline-none"
          >
            <option value="all">전체 회원</option>
            <option value="user">일반 회원</option>
            <option value="admin">관리자</option>
            <option value="issues">점검/누락 계정</option>
          </select>

          {/* Sync Missing Profiles Button */}
          {accounts?.missingProfiles ? (
            <button
              type="button"
              onClick={onSyncMissingProfiles}
              disabled={isSaving}
              className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/15 px-3 py-2 text-xs font-black text-rose-200 transition-colors hover:bg-rose-500/25"
            >
              <AlertTriangle size={14} />
              누락 프로필 복구 ({accounts.missingProfiles})
            </button>
          ) : null}

          {/* Refresh Button */}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/10"
            >
              <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
            </button>
          )}
        </div>
      </div>

      {/* 3. Main Split Container (User Matrix + Side Timeline Panel) */}
      <div className="flex gap-4 items-start">
        {/* Left: User Grid / Card List */}
        <div className="flex-1 space-y-3 min-w-0">
          <div className="flex items-center justify-between text-xs font-bold text-white/50 px-1">
            <span>관제 회원 목록 ({filteredUsers.length}명)</span>
            <span>선택 시 7일 활동 타임라인이 펼쳐집니다</span>
          </div>

          {filteredUsers.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-[#161616] p-12 text-center text-xs font-bold text-white/40">
              조건에 일치하는 관제 회원이 없습니다.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredUsers.map((u) => {
                const isSelected = selectedUser?.id === u.id;
                const lastActiveText = formatRelativeTime(
                  u.activity7d?.lastEventAt || u.last_active_at || u.last_sign_in_at
                );

                return (
                  <div
                    key={u.id}
                    onClick={() => handleSelectUser(u)}
                    className={`group relative cursor-pointer rounded-2xl border p-4 transition-all duration-200 shadow-md ${
                      isSelected
                        ? "border-indigo-500/60 bg-[#1e1b2e] ring-2 ring-indigo-500/30"
                        : "border-white/10 bg-[#161616] hover:border-white/20 hover:bg-[#1a1a1a]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 font-black text-sm border border-indigo-500/20">
                          {(u.nickname || u.email || "U").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <strong className="truncate text-sm text-white font-black">
                              {u.nickname || "User"}
                            </strong>
                            {u.role === "admin" && (
                              <span className="shrink-0 rounded bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.2 text-[9px] font-black text-amber-300">
                                ADMIN
                              </span>
                            )}
                            {u.is_missing_profile && (
                              <span className="shrink-0 rounded bg-rose-500/20 border border-rose-500/30 px-1.5 py-0.2 text-[9px] font-black text-rose-300">
                                프로필누락
                              </span>
                            )}
                          </div>
                          <p className="truncate text-[11px] font-bold text-white/40">
                            {u.email}
                          </p>
                        </div>
                      </div>

                      <span className="shrink-0 text-[10px] font-bold text-white/40">
                        {lastActiveText}
                      </span>
                    </div>

                    {/* PUBG Nickname info */}
                    {u.pubg_nickname && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-indigo-300/80 bg-indigo-500/10 rounded-lg px-2.5 py-1 border border-indigo-500/15">
                        <span className="text-[10px] uppercase font-black opacity-60">
                          {u.pubg_platform || "STEAM"}:
                        </span>
                        <span className="truncate">{u.pubg_nickname}</span>
                      </div>
                    )}

                    {/* 7일 주요 행동 요약 뱃지 */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {u.activity7d?.summaryBadges && u.activity7d.summaryBadges.length > 0 ? (
                        u.activity7d.summaryBadges.map((badge, i) => (
                          <span
                            key={i}
                            className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-white/70"
                          >
                            {badge}
                          </span>
                        ))
                      ) : (
                        <span className="text-[10px] font-bold text-white/25">
                          최근 7일 수집된 로그 없음
                        </span>
                      )}
                      {u.activity7d && u.activity7d.aiRequests > 0 && (
                        <span className="rounded-md border border-indigo-500/25 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold text-indigo-200">
                          AI {u.activity7d.aiRequests}회 · 성공률 {u.activity7d.aiSuccessRate}%
                        </span>
                      )}
                      {u.activity7d && u.activity7d.aiFailedCount > 0 && (
                        <span className="rounded-md border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-200">
                          AI 오류 {u.activity7d.aiFailedCount}건
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Side-Split Timeline Drawer Panel */}
        {selectedUser && (
          <div className="w-full lg:w-[420px] shrink-0 rounded-2xl border border-white/15 bg-[#121212] p-5 shadow-2xl space-y-5 sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto custom-scrollbar">
            {/* Drawer Header */}
            <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="truncate text-base font-black text-white">
                    {selectedUser.nickname || "User"}
                  </h4>
                  {selectedUser.role === "admin" && (
                    <span className="rounded bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-black text-amber-300">
                      ADMIN
                    </span>
                  )}
                </div>
                <p className="truncate text-xs font-bold text-white/40 mt-0.5">
                  {selectedUser.email}
                </p>
                <p className="text-[10px] font-bold text-white/30 mt-1">
                  ID: {selectedUser.id}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setSelectedUser(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-white/50 hover:bg-white/10 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>

            {/* Quick Profile Edit Controls */}
            <form onSubmit={handleSaveSelected} className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3.5">
              <span className="text-xs font-black text-indigo-300 flex items-center gap-1.5">
                <Shield size={14} /> 회원 권한 및 PUBG 연동 설정
              </span>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-bold text-white/40 block mb-1">권한 (Role)</label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/60 px-2.5 py-1.5 text-xs font-bold text-white focus:outline-none"
                  >
                    <option value="user">일반 회원 (user)</option>
                    <option value="admin">관리자 (admin)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-white/40 block mb-1">플랫폼</label>
                  <select
                    value={editPubgPlatform}
                    onChange={(e) => setEditPubgPlatform(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/60 px-2.5 py-1.5 text-xs font-bold text-white focus:outline-none"
                  >
                    <option value="steam">Steam</option>
                    <option value="kakao">Kakao</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-white/40 block mb-1">PUBG 닉네임</label>
                <input
                  type="text"
                  placeholder="PUBG 연동 닉네임"
                  value={editPubgNick}
                  onChange={(e) => setEditPubgNick(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/60 px-2.5 py-1.5 text-xs font-bold text-white focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmId(selectedUser.id)}
                  disabled={isSaving}
                  className="flex items-center gap-1 text-[11px] font-bold text-rose-400 hover:text-rose-300"
                >
                  <Trash2 size={13} /> 회원 강제 탈퇴
                </button>

                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-black text-white hover:bg-indigo-500"
                >
                  <Save size={13} /> 변경 저장
                </button>
              </div>
            </form>

            <div className="space-y-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-indigo-200">최근 7일 AI 사용</span>
                <span className="text-[10px] font-bold text-white/40">비용 ${selectedUser.activity7d?.aiCostUsd.toFixed(4) || "0.0000"}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-black/20 p-2"><strong className="block text-sm text-white">{selectedUser.activity7d?.aiRequests || 0}</strong><span className="text-[10px] text-white/45">요청</span></div>
                <div className="rounded-lg bg-black/20 p-2"><strong className="block text-sm text-emerald-300">{selectedUser.activity7d?.aiSuccessRate || 0}%</strong><span className="text-[10px] text-white/45">성공률</span></div>
                <div className="rounded-lg bg-black/20 p-2"><strong className="block text-sm text-rose-300">{selectedUser.activity7d?.aiFailedCount || 0}</strong><span className="text-[10px] text-white/45">오류</span></div>
              </div>
              {selectedUser.activity7d?.aiErrors?.length ? (
                <div className="space-y-1 text-[11px] text-white/65">
                  {selectedUser.activity7d.aiErrors.map((error) => <div key={error.code} className="flex justify-between"><span>{error.label}</span><strong>{error.count}건</strong></div>)}
                </div>
              ) : <p className="text-[11px] text-white/35">최근 7일 AI 오류 없음</p>}
              {selectedUser.activity7d?.aiRecentErrors?.length ? (
                <div className="space-y-1 border-t border-white/10 pt-2">
                  {selectedUser.activity7d.aiRecentErrors.slice(0, 3).map((error) => <div key={`${error.code}-${error.createdAt}`} className="text-[10px] text-rose-200"><strong>{error.label}</strong><p className="truncate text-white/50">{error.message}</p></div>)}
                </div>
              ) : null}
            </div>

            {/* 7-Day Activity Timeline Section */}
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-white flex items-center gap-1.5">
                  <Clock size={14} className="text-emerald-400" /> 최근 7일 상세 활동 타임라인
                </span>
                <span className="text-[10px] font-bold text-white/40">
                  총 {selectedUser.activity7d?.totalEvents || 0}건 기록
                </span>
              </div>

              {selectedUserTimelineGroups.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-white/5 p-8 text-center text-xs font-bold text-white/30">
                  최근 7일간 수집된 활동 로그가 없습니다.
                </div>
              ) : (
                <div className="space-y-4">
                  {selectedUserTimelineGroups.map((group, idx) => (
                    <div key={idx} className="space-y-2">
                      <div className="flex items-center gap-2 text-[11px] font-black text-indigo-300/90 bg-indigo-500/10 px-2.5 py-1 rounded-md border border-indigo-500/15">
                        <Calendar size={12} />
                        <span>{group.dateHeader}</span>
                      </div>

                      <div className="space-y-1.5 pl-2 border-l border-white/10 ml-2">
                        {group.events.map((evt) => (
                          <div
                            key={evt.id}
                            className="relative pl-4 py-1.5 text-xs rounded-lg hover:bg-white/5 transition-colors"
                          >
                            <span className="absolute -left-[5px] top-2.5 h-2 w-2 rounded-full bg-indigo-400" />
                            <div className="flex items-center justify-between text-[11px]">
                              <strong className="text-white font-bold">{evt.label}</strong>
                              <span className="text-white/40 text-[10px]">{formatTimeOnly(evt.createdAt)}</span>
                            </div>
                            <p className="text-[11px] font-semibold text-white/60 truncate mt-0.5">
                              {evt.details}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Delete User Confirmation Modal */}
      {deleteConfirmId && (
        <ConfirmModal
          isOpen={Boolean(deleteConfirmId)}
          title="회원 강제 탈퇴"
          description="해당 유저를 완전히 삭제하시겠습니까? Auth 계정과 profiles 데이터가 모두 삭제되며 되돌릴 수 없습니다."
          confirmText="강제 탈퇴 실행"
          cancelText="취소"
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
    </div>
  );
}
