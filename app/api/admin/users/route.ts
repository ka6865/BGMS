import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

const USERS_PAGE_SIZE = 1000;
const PROFILES_PAGE_SIZE = 1000;

async function verifyAdmin() {
  const supabaseServer = await createClient();
  const { data: { user } } = await supabaseServer.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabaseServer
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  
  if (profile?.role === "admin") {
    const supabaseAdmin = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    return { user, supabaseAdmin };
  }
  return null;
}

async function listAllAuthUsers(supabaseAdmin: any) {
  const users: any[] = [];
  let page = 1;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: USERS_PAGE_SIZE,
    });
    if (error) throw error;

    const pageUsers = data?.users || [];
    users.push(...pageUsers);

    if (pageUsers.length < USERS_PAGE_SIZE) break;
    page++;
  }

  return users;
}

async function listAllProfiles(supabaseAdmin: any) {
  const profiles: any[] = [];
  let from = 0;

  while (true) {
    const to = from + PROFILES_PAGE_SIZE - 1;
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .range(from, to);
    if (error) throw error;

    const pageProfiles = data || [];
    profiles.push(...pageProfiles);

    if (pageProfiles.length < PROFILES_PAGE_SIZE) break;
    from += PROFILES_PAGE_SIZE;
  }

  return profiles;
}

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
}

function formatEventLabel(eventName: string, pagePath: string | null, params: any): { label: string; details: string } {
  const path = pagePath || "";
  const paramNickname = typeof params?.nickname === "string" ? params.nickname.trim() : "";
  const paramPlatform = typeof params?.platform === "string" ? params.platform.trim() : "";

  if (eventName === "stats_searched" || path.startsWith("/stats/")) {
    const match = path.match(/^\/stats\/([^/]+)\/([^/?#]+)/);
    const platform = paramPlatform || (match ? decodeURIComponent(match[1]) : "");
    const nickname = paramNickname || (match ? decodeURIComponent(match[2]) : "");
    if (nickname) {
      return {
        label: "전적 검색",
        details: (platform ? platform.toUpperCase() + " / " : "") + nickname + " 전적 조회"
      };
    }
    return { label: "전적 페이지 방문", details: path };
  }

  if (path.startsWith("/replay")) return { label: "3D 리플레이 분석", details: path };
  if (path.startsWith("/maps")) return { label: "인게임 지도 방문", details: path };
  if (path.startsWith("/crates")) return { label: "상자깡 시뮬레이터", details: "상자 개봉 시뮬레이션" };
  if (path.startsWith("/weapons")) return { label: "무기도감 방문", details: "무기 정보 및 파츠 비교" };
  if (path.startsWith("/rankings")) return { label: "랭킹 페이지 방문", details: "주간 딜량/킬/티어 랭킹" };
  if (path.startsWith("/board")) return { label: "게시판 이용", details: path };
  if (path.startsWith("/admin")) return { label: "관리자 페이지", details: path };

  return { label: eventName || "페이지 방문", details: path || "서비스 이용" };
}

function getPageName(path: string): string {
  if (path.startsWith("/stats")) return "전적 검색";
  if (path.startsWith("/replay")) return "3D 리플레이";
  if (path.startsWith("/maps")) return "인게임 지도";
  if (path.startsWith("/backpack")) return "가방 계산기";
  if (path.startsWith("/crates")) return "상자깡";
  if (path.startsWith("/weapons")) return "무기도감";
  if (path.startsWith("/rankings")) return "랭킹";
  if (path.startsWith("/board")) return "게시판";
  if (path.startsWith("/admin")) return "관리자";
  return path || "메인";
}

export async function GET() {
  const adminContext = await verifyAdmin();
  if (!adminContext) {
    return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
  }

  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const fetchAnalytics = async () => {
      try {
        const fromRes = adminContext.supabaseAdmin.from("analytics_events");
        if (!fromRes || typeof fromRes.select !== "function") return [];
        const selectRes = fromRes.select("event_name, session_id, user_id, page_path, params, created_at");
        if (!selectRes || typeof selectRes.gte !== "function") return [];
        const gteRes = selectRes.gte("created_at", since7d);
        if (!gteRes || typeof gteRes.order !== "function") return [];
        const orderRes = gteRes.order("created_at", { ascending: false });
        if (!orderRes || typeof orderRes.limit !== "function") return [];
        const limitRes = await orderRes.limit(10000);
        return limitRes?.data || [];
      } catch {
        return [];
      }
    };

    const [profiles, users, analyticsRows] = await Promise.all([
      listAllProfiles(adminContext.supabaseAdmin),
      listAllAuthUsers(adminContext.supabaseAdmin),
      fetchAnalytics()
    ]);

    const activityMap = new Map<string, {
      totalEvents: number;
      lastEventAt: string | null;
      statsSearchCount: number;
      pageCounts: Map<string, number>;
      events: ActivityEventItem[];
    }>();

    const globalPageCounts = new Map<string, number>();

    for (let i = 0; i < analyticsRows.length; i++) {
      const row = analyticsRows[i];
      const userId = row.user_id;
      const path = row.page_path || "";
      if (path) {
        const pageName = getPageName(path);
        globalPageCounts.set(pageName, (globalPageCounts.get(pageName) || 0) + 1);
      }

      if (!userId) continue;

      let userAct = activityMap.get(userId);
      if (!userAct) {
        userAct = {
          totalEvents: 0,
          lastEventAt: null,
          statsSearchCount: 0,
          pageCounts: new Map<string, number>(),
          events: []
        };
        activityMap.set(userId, userAct);
      }

      userAct.totalEvents += 1;
      if (!userAct.lastEventAt || new Date(row.created_at) > new Date(userAct.lastEventAt)) {
        userAct.lastEventAt = row.created_at;
      }

      const isSearch = row.event_name === "stats_searched" || path.startsWith("/stats/");
      if (isSearch) userAct.statsSearchCount += 1;

      if (path) {
        const pageName = getPageName(path);
        userAct.pageCounts.set(pageName, (userAct.pageCounts.get(pageName) || 0) + 1);
      }

      if (userAct.events.length < 50) {
        const { label, details } = formatEventLabel(row.event_name, row.page_path, row.params);
        userAct.events.push({
          id: "evt-" + i + "-" + Date.now(),
          createdAt: row.created_at,
          eventName: row.event_name,
          label,
          details,
          pagePath: row.page_path
        });
      }
    }

    const authUserIds = new Set(users.map(u => u.id));
    const profileById = new Map(profiles.map(p => [p.id, p]));
    const providerCounts = new Map<string, number>();

    const mergedUsers = users.map(authUser => {
      const profile = profileById.get(authUser.id);
      const provider = authUser.app_metadata?.provider || 
                       (authUser as any).raw_app_meta_data?.provider || 
                       (authUser as any).identities?.[0]?.provider || 
                       "email";
      providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);

      const userActRaw = activityMap.get(authUser.id);
      const topPages = userActRaw?.pageCounts
        ? Array.from(userActRaw.pageCounts.entries())
            .map(([path, count]) => ({ path, label: path, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3)
        : [];

      const summaryBadges: string[] = [];
      if (userActRaw?.statsSearchCount) summaryBadges.push("전적 검색 " + userActRaw.statsSearchCount + "회");
      if (topPages.length > 0) summaryBadges.push("주요 이용: " + topPages[0].label);
      if (userActRaw && userActRaw.totalEvents > 0) summaryBadges.push("7일 활동 " + userActRaw.totalEvents + "건");

      const activity7d: UserActivity7D = {
        totalEvents: userActRaw?.totalEvents || 0,
        lastEventAt: userActRaw?.lastEventAt || null,
        statsSearchCount: userActRaw?.statsSearchCount || 0,
        topPages,
        summaryBadges,
        events: userActRaw?.events || []
      };

      if (profile) {
        return {
          ...profile,
          email: authUser.email || "소셜 로그인 유저 (이메일 미공개)",
          created_at: authUser.created_at || profile.updated_at,
          last_sign_in_at: authUser.last_sign_in_at || null,
          provider,
          email_confirmed: !!authUser.email_confirmed_at,
          is_missing_profile: false,
          is_orphan_profile: false,
          activity7d
        };
      }

      const meta = authUser.user_metadata || {};
      const fallbackNickname = meta.full_name || meta.user_name || meta.name || meta.nickname || authUser.email?.split("@")[0] || "User";
      const fallbackAvatar = meta.avatar_url || meta.avatar || null;

      return {
        id: authUser.id,
        nickname: fallbackNickname,
        avatar_url: fallbackAvatar,
        role: "user",
        pubg_nickname: null,
        pubg_platform: null,
        updated_at: null,
        email: authUser.email || "소셜 로그인 유저 (이메일 미공개)",
        created_at: authUser.created_at,
        last_sign_in_at: authUser.last_sign_in_at || null,
        provider,
        email_confirmed: !!authUser.email_confirmed_at,
        is_missing_profile: true,
        is_orphan_profile: false,
        activity7d
      };
    });

    const orphanProfiles = profiles
      .filter(profile => !authUserIds.has(profile.id))
      .map(profile => ({
        ...profile,
        email: "Auth 계정 없음",
        created_at: profile.updated_at || null,
        last_sign_in_at: null,
        provider: "orphan",
        email_confirmed: false,
        is_missing_profile: false,
        is_orphan_profile: true,
        activity7d: {
          totalEvents: 0,
          lastEventAt: null,
          statsSearchCount: 0,
          topPages: [],
          summaryBadges: [],
          events: []
        }
      }));

    const usersWithConsistencyFlags = [...orphanProfiles, ...mergedUsers];

    usersWithConsistencyFlags.sort((a, b) => {
      if (a.is_orphan_profile && !b.is_orphan_profile) return -1;
      if (!a.is_orphan_profile && b.is_orphan_profile) return 1;
      if (a.is_missing_profile && !b.is_missing_profile) return -1;
      if (!a.is_missing_profile && b.is_missing_profile) return 1;

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
    });

    const active7dCount = usersWithConsistencyFlags.filter(u => {
      const last = Math.max(
        Date.parse(u.activity7d?.lastEventAt || "0") || 0,
        Date.parse(u.last_active_at || "0") || 0,
        Date.parse(u.last_sign_in_at || "0") || 0
      );
      return last >= Date.parse(since7d);
    }).length;

    const topSearchUsers = [...usersWithConsistencyFlags]
      .filter(u => u.activity7d?.statsSearchCount > 0)
      .sort((a, b) => b.activity7d.statsSearchCount - a.activity7d.statsSearchCount)
      .slice(0, 3)
      .map(u => ({
        nickname: u.nickname || u.email || u.id.slice(0, 8),
        count: u.activity7d.statsSearchCount
      }));

    const topPagesGlobal = Array.from(globalPageCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const accounts = {
      totalUsers: usersWithConsistencyFlags.length,
      authUsers: users.length,
      profiles: profiles.length,
      missingProfiles: mergedUsers.filter(u => u.is_missing_profile).length,
      orphanProfiles: orphanProfiles.length,
      admins: mergedUsers.filter(u => u.role === "admin").length
    };

    const metrics = {
      active7dUsers: active7dCount,
      topSearchUsers,
      topPages: topPagesGlobal,
      providers: Object.fromEntries(providerCounts)
    };

    return NextResponse.json({
      accounts,
      metrics,
      users: usersWithConsistencyFlags
    });
  } catch (error: any) {
    console.error("Fetch admin users error:", error);
    return NextResponse.json({ error: error.message || "유저 정보를 불러올 수 없습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const adminContext = await verifyAdmin();
  if (!adminContext) {
    return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { action, id, role, pubg_nickname, pubg_platform } = body;

    if (action === "sync") {
      const users = await listAllAuthUsers(adminContext.supabaseAdmin);

      const { data: profiles, error: pErr } = await adminContext.supabaseAdmin
        .from("profiles")
        .select("id");
      if (pErr) throw pErr;

      const profileIds = new Set(profiles.map(p => p.id));
      const missingUsers = users.filter(u => !profileIds.has(u.id));

      if (missingUsers.length === 0) {
        return NextResponse.json({ success: true, message: "동기화할 누락된 회원이 없습니다." });
      }

      const insertData = missingUsers.map(u => {
        const meta = u.user_metadata || {};
        return {
          id: u.id,
          nickname: meta.full_name || meta.user_name || meta.name || meta.nickname || u.email?.split("@")[0] || "User",
          avatar_url: meta.avatar_url || meta.avatar || null,
          role: "user",
          updated_at: new Date().toISOString()
        };
      });

      const { error: insertErr } = await adminContext.supabaseAdmin
        .from("profiles")
        .insert(insertData);
      
      if (insertErr) throw insertErr;

      return NextResponse.json({ success: true, count: insertData.length });
    }

    if (!id) {
      return NextResponse.json({ error: "수정 대상 유저 ID가 필요합니다." }, { status: 400 });
    }

    const { data: existingProfile } = await adminContext.supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", id)
      .single();

    if (!existingProfile) {
      const { error: insertErr } = await adminContext.supabaseAdmin
        .from("profiles")
        .insert({
          id,
          role: role || "user",
          pubg_nickname: pubg_nickname || null,
          pubg_platform: pubg_platform || null,
          nickname: "User",
          updated_at: new Date().toISOString()
        });
      if (insertErr) throw insertErr;
    } else {
      const { error: updateErr } = await adminContext.supabaseAdmin
        .from("profiles")
        .update({
          role,
          pubg_nickname: pubg_nickname || null,
          pubg_platform: pubg_platform || null,
          updated_at: new Date().toISOString()
        })
        .eq("id", id);
      if (updateErr) throw updateErr;
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Save admin user error:", error);
    return NextResponse.json({ error: error.message || "유저 정보 저장 실패" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const adminContext = await verifyAdmin();
  if (!adminContext) {
    return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "삭제할 유저 ID가 필요합니다." }, { status: 400 });
  }

  try {
    if (id === adminContext.user.id) {
      return NextResponse.json({ error: "현재 로그인한 관리자 계정은 여기서 삭제할 수 없습니다." }, { status: 400 });
    }

    const { data: profileBeforeDelete } = await adminContext.supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    const users = await listAllAuthUsers(adminContext.supabaseAdmin);
    const authUserExists = users.some(user => user.id === id);

    if (authUserExists) {
      const { error: deleteErr } = await adminContext.supabaseAdmin.auth.admin.deleteUser(id);
      if (deleteErr) throw deleteErr;
    }

    const { error: profileDeleteErr } = await adminContext.supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", id);
    if (profileDeleteErr) throw profileDeleteErr;

    return NextResponse.json({
      success: true,
      deletedAuthUser: authUserExists,
      deletedProfile: Boolean(profileBeforeDelete)
    });
  } catch (error: any) {
    console.error("Delete admin user error:", error);
    return NextResponse.json({ error: error.message || "유저 삭제 실패" }, { status: 500 });
  }
}
