'use client';

import React, { useState, useEffect, startTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, User, Hammer, Database, LogIn, Settings, Bot } from 'lucide-react';
import { useAuth } from "../AuthProvider";
import { supabase } from "@/lib/supabase";
import NotificationDropdown from "../map/NotificationDropdown";
import type { NotificationItem, UserProfile } from "@/types/map";
import { useRealtimeToast } from "@/hooks/useRealtimeToast";
import { toast } from "sonner";


const MAP_LIST = [
  { id: "Erangel", label: "에란겔" },
  { id: "Miramar", label: "미라마" },
  { id: "Taego", label: "태이고" },
  { id: "Rondo", label: "론도" },
  { id: "Vikendi", label: "비켄디" },
  { id: "Deston", label: "데스턴" },
];

export default function GlobalHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotiDropdown, setShowNotiDropdown] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useRealtimeToast();

  // 반응형 감지
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // 유저 정보 & 알림 로드
  useEffect(() => {
    if (!user) {
      //  React 19: 비긴급 업데이트로 분류하여 연쇄적 렌더링 방지 및 UI 응답성 유지
      startTransition(() => {
        setUserProfile(null);
        setProfileUserId(null);
        setNotifications([]);
      });
      return;
    }

    const fetchUserData = async () => {
      // 1. 프로필
      const { data: profile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();
      
      startTransition(() => {
        setUserProfile(profile ? profile as UserProfile : null);
        setProfileUserId(user.id);
      });

      // 2. 알림
      const { data: notis } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
        
      if (notis) setNotifications(notis as NotificationItem[]);
    };

    fetchUserData();
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`user-notifications-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const newNoti = payload.new as NotificationItem;

          // Bell 배지 즉시 활성화
          setNotifications((prev) => [newNoti, ...prev]);

          // 제보 Toast처럼 우측 상단 팝업 알림 표시
          const label = newNoti.type === 'reply' ? '답글' : '댓글';
          toast.info(`${newNoti.sender_name}님이 내 글에 ${label}을 달았습니다.`, {
            description: newNoti.preview_text || '',
            duration: 5000,
            position: 'top-right',
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const activeMapId = pathname.startsWith("/maps/") 
    ? pathname.replace("/maps/", "").charAt(0).toUpperCase() + pathname.replace("/maps/", "").slice(1)
    : "";

  const isBoardActive = pathname.startsWith("/board");
  const isStatsActive = pathname.startsWith("/stats");
  const isWeaponsActive = pathname.startsWith("/weapons");
  const isBackpackActive = pathname.startsWith("/backpack");
  const isRankingsActive = pathname.startsWith("/rankings");
  const isCratesActive = pathname.startsWith("/crates");

  const hasCurrentUserProfile = profileUserId === user?.id;
  const displayName = hasCurrentUserProfile ? userProfile?.nickname || "익명" : null;
  const isAdmin = hasCurrentUserProfile && userProfile?.role === "admin";

  const markAllAsRead = async () => {
    if (!user) return;
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user.id)
      .eq("is_read", false);
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
  };

  const handleNotiClick = async (noti: NotificationItem) => {
    if (!noti.is_read) {
      await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", noti.id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === noti.id ? { ...n, is_read: true } : n))
      );
    }
    setShowNotiDropdown(false);
    router.push(`/board/${noti.post_id}`);
  };

  const formatNotiTime = (dateString: string) => {
    const diff = (new Date().getTime() - new Date(dateString).getTime()) / 1000;
    if (diff < 60) return "방금 전";
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
    return new Date(dateString).toLocaleDateString();
  };

  // 3D 리플레이 등 전체 화면 전술 페이지에서는 상단 헤더를 숨겨 전체 뷰포트 영역을 확보
  if (pathname.startsWith('/replay/')) {
    return null;
  }

  return (
    <header className="flex items-center justify-between min-h-[56px] h-auto px-4 bg-[#F2A900] border-b-2 border-[#cc8b00] z-[6000] safe-top shadow-md select-none shrink-0 w-full">
      <div className="flex items-center gap-3 overflow-hidden flex-1">
        
        <Link href="/" className="flex items-center cursor-pointer group flex-shrink-0">
          <span className="text-[20px] md:text-[22px] font-black italic tracking-tighter text-black uppercase group-active:scale-95 transition-transform flex items-center">
            BG<span className="text-white">MS</span>
          </span>
        </Link>
        
        {/* 데스크톱 네비게이션 */}
        {!isMobile && (
          <nav className="flex items-center gap-0.5 ml-4 overflow-x-auto no-scrollbar">
            {MAP_LIST.map((m) => {
              const isActive = activeMapId.toLowerCase() === m.id.toLowerCase() || (pathname === '/' && m.id === 'Erangel');
              return (
                <Link key={m.id} href={`/?tab=${m.id}`} className="shrink-0">
                  <button
                    className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                      isActive
                        ? "bg-black/90 text-white shadow-sm"
                        : "text-black/60 hover:bg-black/10 hover:text-black/80"
                    }`}
                  >
                    {m.label}
                    {isActive && (
                      <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                    )}
                  </button>
                </Link>
              );
            })}
            <div className="w-[1.5px] h-3.5 bg-black/15 mx-2 rounded-full shrink-0" />
            
            <Link href="/board" className="shrink-0">
              <button
                className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                  isBoardActive
                    ? "bg-black/90 text-[#F2A900] shadow-sm"
                    : "text-black/60 hover:bg-black/10 hover:text-black/80"
                }`}
              >
                커뮤니티
                {isBoardActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>
            
            <Link href="/stats" className="shrink-0">
              <button
                className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                  isStatsActive
                    ? "bg-black/90 text-[#F2A900] shadow-sm"
                    : "text-black/60 hover:bg-black/10 hover:text-black/80"
                }`}
              >
                AI 전적 검색
                {isStatsActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>

            <Link href="/rankings" className="shrink-0">
              <button
                className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                  isRankingsActive
                    ? "bg-black/90 text-[#F2A900] shadow-sm"
                    : "text-black/60 hover:bg-black/10 hover:text-black/80"
                }`}
              >
                랭킹
                {isRankingsActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>

            <Link href="/weapons" className="shrink-0">
              <button className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                isWeaponsActive ? "bg-black/90 text-[#F2A900] shadow-sm" : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}>
                무기 도감
                {isWeaponsActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>

            <Link href="/backpack" className="shrink-0">
              <button className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                isBackpackActive ? "bg-black/90 text-[#F2A900] shadow-sm" : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}>
                가방 시뮬
                {isBackpackActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>

            <Link href="/crates" className="shrink-0">
              <button className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                isCratesActive ? "bg-black/90 text-[#F2A900] shadow-sm" : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}>
                상자 시뮬
                {isCratesActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>
          </nav>
        )}
      </div>

      {/* 우측 사용자 액션 */}
      <div className="flex items-center gap-4 flex-shrink-0">
        {!mounted || authLoading ? (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/5 rounded-xl border border-black/5 animate-pulse">
            <div className="w-4 h-4 rounded-full bg-black/10" />
            <div className="w-12 h-3 bg-black/10 rounded" />
          </div>
        ) : user ? (
          <>
            {isAdmin && !isMobile && (
              <div className="flex gap-2 mr-2">
                <Link href="/map-editor">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-black text-[#F2A900] border border-black/10 rounded-lg font-black text-[10px] uppercase">
                    <Hammer size={12} />
                    <span>맵 에디터</span>
                  </button>
                </Link>
                <Link href="/admin/game-data">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-[#34A853] text-white rounded-lg font-black text-[10px] uppercase shadow-sm">
                    <Database size={12} />
                    <span>데이터 관리</span>
                  </button>
                </Link>
                <Link href="/admin/map-settings">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg font-black text-[10px] uppercase shadow-sm">
                    <Settings size={12} />
                    <span>맵 설정</span>
                  </button>
                </Link>
                <Link href="/admin/bot">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-zinc-950 rounded-lg font-black text-[10px] uppercase shadow-sm">
                    <Bot size={12} />
                    <span>AI 비서</span>
                  </button>
                </Link>
              </div>
            )}

            <div className="relative">
              <button
                onClick={() => setShowNotiDropdown(!showNotiDropdown)}
                className="p-2 text-black/80 hover:text-black active:scale-90 transition-transform relative"
              >
                <Bell size={22} strokeWidth={2.5} />
                {notifications.some((n) => !n.is_read) && (
                  <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-red-600 border-2 border-[#F2A900] rounded-full" />
                )}
              </button>

              <NotificationDropdown
                notifications={notifications}
                isOpen={showNotiDropdown}
                onClose={() => setShowNotiDropdown(false)}
                onMarkAllAsRead={markAllAsRead}
                onNotificationClick={handleNotiClick}
                formatNotiTime={formatNotiTime}
              />
            </div>

            <Link href="/mypage" className="flex items-center gap-2 group active:scale-95 transition-transform">
              <div className="w-8 h-8 rounded-xl bg-black/10 flex items-center justify-center border border-black/5 group-active:bg-black/20">
                <User size={18} strokeWidth={2.5} className="text-black/80" />
              </div>
              {!isMobile && (
                displayName ? (
                  <span className="font-black text-black text-sm tracking-tight">
                    {displayName}
                  </span>
                ) : (
                  <span
                    aria-label="프로필 로드 중"
                    className="h-3 w-12 animate-pulse rounded bg-black/10"
                  />
                )
              )}
            </Link>
          </>
        ) : (
          <Link href="/login">
            <button className="flex items-center gap-2 px-4 py-2 bg-white text-black font-black text-xs rounded-xl shadow-sm border border-black/5 active:scale-95 transition-transform">
              <LogIn size={14} strokeWidth={3} />
              <span>로그인</span>
            </button>
          </Link>
        )}
      </div>
    </header>
  );
}
