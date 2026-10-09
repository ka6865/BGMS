type UserProfileRow = {
  id: string;
  nickname: string | null;
  role: string | null;
  pubg_nickname: string | null;
  last_active_at: string | null;
  updated_at: string | null;
};

type AuthUserRow = {
  id: string;
  email?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  deleted_at?: string | null;
};

type AnalyticsUserRow = {
  event_name: string;
  session_id: string | null;
  user_id: string | null;
  page_path: string | null;
  params: Record<string, unknown> | null;
  created_at: string;
};

export type UserMetricsSummary = {
  generatedAt: string;
  status: "ready" | "partial" | "unavailable";
  windowHours: number;
  accounts: {
    authUsers: number;
    authUsersNotDeleted: number;
    profiles: number;
    authLinkedProfiles: number;
    adminProfiles: number;
    nonAdminProfiles: number;
    missingProfiles: number;
    orphanProfiles: number;
  };
  activity: {
    authSignedInUsers: number;
    profileActiveUsers: number;
    analyticsSessions: number;
    analyticsGuestSessions: number;
    analyticsMemberSessions: number;
    analyticsLoggedInUsers: number;
    analyticsEvents: number;
  };
  topActiveUsers: Array<{
    userId: string;
    label: string;
    lastActiveAt: string | null;
    lastSignInAt: string | null;
  }>;
  topSearchedTargets: Array<{
    nickname: string;
    platform: string | null;
    count: number;
    matchingProfileLabels: string[];
  }>;
  notes: string[];
  error?: string;
};

export async function buildUserMetricsSummary(supabase: any, windowHours = 24): Promise<UserMetricsSummary> {
  const generatedAt = new Date().toISOString();
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  try {
    const [authResult, profileResult, analyticsResult] = await Promise.all([
      fetchAllAuthUsers(supabase),
      fetchProfiles(supabase),
      fetchAnalyticsRows(supabase, since)
    ]);
    const authUsers = authResult.rows;
    const profiles = profileResult.rows;
    const analyticsRows = analyticsResult.rows;
    const partialSources = [
      authResult.partial ? "Auth 유저" : null,
      profileResult.partial ? "profiles" : null,
      analyticsResult.partial ? "analytics_events" : null
    ].filter(Boolean);

    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    const authUsersNotDeleted = authUsers.filter((user) => !user.deleted_at);
    const activeAuthIds = new Set(authUsersNotDeleted.map((user) => user.id));
    const authLinkedProfiles = profiles.filter((profile) => activeAuthIds.has(profile.id));
    const adminProfiles = authLinkedProfiles.filter((profile) => profile.role === "admin");
    const adminProfileIds = new Set(adminProfiles.map((profile) => profile.id));
    const nonAdminProfiles = authLinkedProfiles.filter((profile) => profile.role !== "admin");
    const activeProfileIds = new Set(
      nonAdminProfiles
        .filter((profile) => isSince(profile.last_active_at, since))
        .map((profile) => profile.id)
    );
    const signedInAuthIds = new Set(
      authUsers
        .filter((user) => !user.deleted_at)
        .filter((user) => !adminProfileIds.has(user.id))
        .filter((user) => !profileResult.partial || profilesById.has(user.id))
        .filter((user) => isSince(user.last_sign_in_at, since))
        .map((user) => user.id)
    );

    const nonAdminAnalyticsRows = analyticsRows.filter((row) => !row.user_id || (
      profilesById.get(row.user_id)?.role !== "admin" && (!profileResult.partial || profilesById.has(row.user_id))
    ));
    const sessionHasUser = new Map<string, boolean>();
    const analyticsUserIds = new Set<string>();
    const topSearchedTargets = buildTopSearchedTargets(nonAdminAnalyticsRows, nonAdminProfiles);

    nonAdminAnalyticsRows.forEach((row) => {
      if (row.session_id) {
        sessionHasUser.set(row.session_id, Boolean(sessionHasUser.get(row.session_id) || row.user_id));
      }
      if (row.user_id) analyticsUserIds.add(row.user_id);
    });

    const topActiveUsers = nonAdminProfiles
      .filter((profile) => profile.last_active_at || authUsers.find((user) => user.id === profile.id)?.last_sign_in_at)
      .map((profile) => {
        const authUser = authUsers.find((user) => user.id === profile.id);
        return {
          userId: profile.id,
          label: profile.nickname || profile.pubg_nickname || `회원 ${profile.id.slice(0, 8)}`,
          lastActiveAt: profile.last_active_at,
          lastSignInAt: authUser?.last_sign_in_at || null
        };
      })
      .sort((a, b) => latestTime(b) - latestTime(a))
      .slice(0, 5);

    const missingProfiles = authUsersNotDeleted.filter((user) => !profilesById.has(user.id)).length;
    const orphanProfiles = profiles.filter((profile) => !activeAuthIds.has(profile.id)).length;
    const memberSessions = Array.from(sessionHasUser.values()).filter(Boolean).length;
    const guestSessions = Array.from(sessionHasUser.values()).filter((hasUser) => !hasUser).length;
    const notes = buildUserMetricNotes({
      missingProfiles: authResult.partial || profileResult.partial ? 0 : missingProfiles,
      orphanProfiles: authResult.partial || profileResult.partial ? 0 : orphanProfiles,
      analyticsLoggedInUsers: analyticsUserIds.size,
      analyticsEvents: nonAdminAnalyticsRows.length,
      profileActiveUsers: activeProfileIds.size
    });
    if (partialSources.length) notes.unshift(`부분 집계: ${partialSources.join(", ")} 전체 조회를 확인하지 못했습니다. 반환된 데이터만 집계했으므로 전체 수치와 다를 수 있습니다.`);
    if (profileResult.partial) notes.push("역할을 확인하지 못한 회원 이벤트와 로그인 기록은 관리자 활동이 섞이지 않도록 제외했습니다.");

    return {
      generatedAt,
      status: partialSources.length ? "partial" : "ready",
      windowHours,
      accounts: {
        authUsers: authUsers.length,
        authUsersNotDeleted: authUsersNotDeleted.length,
        profiles: profiles.length,
        authLinkedProfiles: authLinkedProfiles.length,
        adminProfiles: adminProfiles.length,
        nonAdminProfiles: nonAdminProfiles.length,
        missingProfiles,
        orphanProfiles
      },
      activity: {
        authSignedInUsers: signedInAuthIds.size,
        profileActiveUsers: activeProfileIds.size,
        analyticsSessions: sessionHasUser.size,
        analyticsGuestSessions: guestSessions,
        analyticsMemberSessions: memberSessions,
        analyticsLoggedInUsers: analyticsUserIds.size,
        analyticsEvents: nonAdminAnalyticsRows.length
      },
      topActiveUsers,
      topSearchedTargets,
      notes
    };
  } catch (error: any) {
    return {
      generatedAt,
      status: "unavailable",
      windowHours,
      accounts: {
        authUsers: 0,
        authUsersNotDeleted: 0,
        profiles: 0,
        authLinkedProfiles: 0,
        adminProfiles: 0,
        nonAdminProfiles: 0,
        missingProfiles: 0,
        orphanProfiles: 0
      },
      activity: {
        authSignedInUsers: 0,
        profileActiveUsers: 0,
        analyticsSessions: 0,
        analyticsGuestSessions: 0,
        analyticsMemberSessions: 0,
        analyticsLoggedInUsers: 0,
        analyticsEvents: 0
      },
      topActiveUsers: [],
      topSearchedTargets: [],
      notes: ["유저 집계를 조회할 수 없습니다."],
      error: error.message || String(error)
    };
  }
}

export function renderUserMetricsSummaryText(summary: UserMetricsSummary) {
  if (summary.status === "unavailable") {
    return `유저 권한/집계를 조회할 수 없습니다. 원인: ${summary.error || "알 수 없는 오류"}`;
  }

  const topUsers = summary.topActiveUsers
    .slice(0, 3)
    .map((user) => `${user.label}${user.lastActiveAt ? `(${formatDateTime(user.lastActiveAt)})` : ""}`)
    .join(", ") || "최근 활동 회원 없음";
  const topTargets = summary.topSearchedTargets
    .slice(0, 3)
    .map((target) => {
      const platform = target.platform ? `/${target.platform}` : "";
      const matched = target.matchingProfileLabels.length > 0 ? "프로필 닉네임 일치" : "프로필 미일치";
      return `${target.nickname}${platform} ${target.count}회(${matched})`;
    })
    .join(", ") || "전적 검색 대상 없음";

  return [
    summary.status === "partial" ? "부분 집계입니다. 아래 수치는 전체 가입자나 전체 활동을 확정하는 데 사용할 수 없습니다." : null,
    `가입자 기준: Supabase Auth 유저 ${summary.accounts.authUsersNotDeleted}명, Auth와 연결된 profiles ${summary.accounts.authLinkedProfiles}개입니다.`,
    `관리자 제외 실제 회원 프로필은 ${summary.accounts.nonAdminProfiles}개이고, 관리자 프로필은 ${summary.accounts.adminProfiles}개입니다. profiles 원본 행은 ${summary.accounts.profiles}개입니다.`,
    `최근 ${summary.windowHours}시간 활동 기준: 로그인 기록 ${summary.activity.authSignedInUsers}명, profile last_active ${summary.activity.profileActiveUsers}명, 수집 세션 ${summary.activity.analyticsSessions}개입니다.`,
    `현재 수집된 analytics 이벤트 기준 세션은 회원 ${summary.activity.analyticsMemberSessions}개, 비회원 ${summary.activity.analyticsGuestSessions}개이며, user_id가 붙은 로그인 회원 이벤트는 ${summary.activity.analyticsLoggedInUsers}명 기준입니다.`,
    `최근 활동 회원: ${topUsers}`,
    `많이 조회된 전적 대상: ${topTargets}. 이 값은 조회 대상 닉네임이며 해당 회원의 로그인 활동으로 해석하지 않습니다.`,
    summary.notes.length > 0 ? `주의: ${summary.notes.join(" / ")}` : null
  ].filter(Boolean).join("\n");
}

async function fetchAllAuthUsers(supabase: any): Promise<{ rows: AuthUserRow[]; partial: boolean }> {
  if (!supabase.auth?.admin?.listUsers) {
    throw new Error("service role auth.admin.listUsers 권한이 없습니다.");
  }

  const users: AuthUserRow[] = [];
  const perPage = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const pageUsers = (data?.users || []) as AuthUserRow[];
    users.push(...pageUsers);
    if (pageUsers.length < perPage) return { rows: users, partial: false };
  }
  return { rows: users, partial: true };
}

async function fetchProfiles(supabase: any): Promise<{ rows: UserProfileRow[]; partial: boolean }> {
  const { data, error, count } = await supabase
    .from("profiles")
    .select("id, nickname, role, pubg_nickname, last_active_at, updated_at", { count: "exact" })
    .range(0, 9999);
  if (error) throw error;
  const rows = (data || []) as UserProfileRow[];
  return { rows, partial: count == null || count > rows.length };
}

async function fetchAnalyticsRows(supabase: any, since: string): Promise<{ rows: AnalyticsUserRow[]; partial: boolean }> {
  const { data, error, count } = await supabase
    .from("analytics_events")
    .select("event_name, session_id, user_id, page_path, params, created_at", { count: "exact" })
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) throw error;
  const rows = (data || []) as AnalyticsUserRow[];
  return { rows, partial: count == null || count > rows.length };
}

function buildUserMetricNotes(input: {
  missingProfiles: number;
  orphanProfiles: number;
  analyticsLoggedInUsers: number;
  analyticsEvents: number;
  profileActiveUsers: number;
}) {
  const notes = [];
  if (input.missingProfiles > 0) notes.push(`Auth 유저 중 profiles 누락 ${input.missingProfiles}명`);
  if (input.orphanProfiles > 0) notes.push(`Auth에 없는 profiles ${input.orphanProfiles}개`);
  if (input.analyticsEvents > 0 && input.analyticsLoggedInUsers === 0) {
    notes.push("현재까지 수집된 analytics_events에는 로그인 user_id가 없습니다. 로컬/비로그인 이벤트가 섞였을 수 있으므로 새 배포 후 로그인 사용자 이벤트를 다시 확인하세요.");
  }
  if (input.profileActiveUsers === 0) notes.push("최근 profile last_active_at 갱신 유저가 없습니다.");
  return notes;
}

function buildTopSearchedTargets(rows: AnalyticsUserRow[], profiles: UserProfileRow[]) {
  const counts = new Map<string, { nickname: string; platform: string | null; count: number }>();
  rows.forEach((row) => {
    const target = extractStatsTarget(row);
    if (!target) return;
    const key = `${target.platform || "unknown"}:${target.nickname.toLowerCase()}`;
    const current = counts.get(key);
    counts.set(key, {
      nickname: current?.nickname || target.nickname,
      platform: current?.platform || target.platform,
      count: (current?.count || 0) + 1
    });
  });

  return Array.from(counts.values())
    .map((target) => ({
      ...target,
      matchingProfileLabels: findMatchingProfileLabels(target.nickname, profiles)
    }))
    .sort((a, b) => b.count - a.count || a.nickname.localeCompare(b.nickname))
    .slice(0, 5);
}

function extractStatsTarget(row: AnalyticsUserRow) {
  const paramNickname = typeof row.params?.nickname === "string" ? row.params.nickname.trim() : "";
  if (row.event_name === "stats_searched" && paramNickname) {
    return {
      nickname: paramNickname,
      platform: typeof row.params?.platform === "string" ? row.params.platform.trim() || null : null
    };
  }

  const match = row.page_path?.match(/^\/stats\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return {
    platform: safeDecode(match[1]),
    nickname: safeDecode(match[2])
  };
}

function findMatchingProfileLabels(nickname: string, profiles: UserProfileRow[]) {
  const normalized = nickname.toLowerCase();
  return profiles
    .filter((profile) => {
      const nicknames = [profile.nickname, profile.pubg_nickname]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return nicknames.includes(normalized);
    })
    .map((profile) => profile.nickname || profile.pubg_nickname || `회원 ${profile.id.slice(0, 8)}`)
    .slice(0, 3);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSince(value: string | null | undefined, since: string) {
  if (!value) return false;
  return Date.parse(value) >= Date.parse(since);
}

function latestTime(user: { lastActiveAt: string | null; lastSignInAt: string | null }) {
  return Math.max(Date.parse(user.lastActiveAt || "0") || 0, Date.parse(user.lastSignInAt || "0") || 0);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
