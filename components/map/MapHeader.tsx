'use client';

import React, { memo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import NotificationDropdown from "./NotificationDropdown";
import { Bell, User, Menu, Hammer, Database, LogIn } from 'lucide-react';
import type { MapTab, NotificationItem, CurrentUser } from "../../types/map";

interface MapHeaderProps {
  activeMapId: string;
  isMobile: boolean;
  isAuthLoading: boolean;
  isAdmin: boolean;
  currentUser: CurrentUser | null;
  notifications: NotificationItem[];
  showNotiDropdown: boolean;
  displayName: string;
  mapList: MapTab[];
  onTabClick: (id: string) => void;
  onToggleSidebar: () => void;
  onToggleNoti: () => void;
  onCloseNoti: () => void;
  onMarkAllAsRead: () => void;
  onNotiClick: (noti: NotificationItem) => void;
  onMyPageClick: () => void;
  formatNotiTime: (date: string) => string;
}

const MapHeader = memo(({
  activeMapId,
  isMobile,
  isAuthLoading,
  isAdmin,
  currentUser,
  notifications,
  showNotiDropdown,
  displayName,
  mapList,
  onTabClick,
  onToggleSidebar,
  onToggleNoti,
  onCloseNoti,
  onMarkAllAsRead,
  onNotiClick,
  onMyPageClick,
  formatNotiTime,
}: MapHeaderProps) => {
  const pathname = usePathname();
  const isWeaponsActive = pathname === "/weapons";
  const isBackpackActive = pathname === "/backpack";

  return (
    <header className="flex items-center justify-between min-h-[56px] h-auto px-4 bg-[#F2A900] border-b-2 border-[#cc8b00] z-[6000] safe-top shadow-md select-none">
      <div className="flex items-center gap-3 overflow-hidden flex-1">
        {/* 모바일 햄버거 메뉴 (필요 시) */}
        {!isMobile && activeMapId !== "Stats" && activeMapId !== "Board" && (
          <button
            onClick={onToggleSidebar}
            className="p-2 -ml-2 text-black/80 hover:text-black transition-colors"
          >
            <Menu size={22} strokeWidth={2.5} />
          </button>
        )}

        {/* 로고 영역 */}
        <div
          onClick={() => (window.location.href = "/")}
          className="flex items-center cursor-pointer group flex-shrink-0"
        >
          <span className="text-[20px] md:text-[22px] font-black italic tracking-tighter text-black uppercase group-active:scale-95 transition-transform flex items-center">
            BG<span className="text-white">MS</span>
          </span>
        </div>
        
        {/* 데스크톱 네비게이션 */}
        {!isMobile && (
          <nav className="flex items-center gap-0.5 ml-4 overflow-x-auto no-scrollbar">
            {mapList.map((m) => (
              <button
                key={m.id}
                onClick={() => onTabClick(m.id)}
                className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                  activeMapId === m.id
                    ? "bg-black/90 text-white shadow-sm"
                    : "text-black/60 hover:bg-black/10 hover:text-black/80"
                }`}
              >
                {m.label}
                {activeMapId === m.id && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            ))}
            <div className="w-[1.5px] h-3.5 bg-black/15 mx-2 rounded-full" />
            
            <button
              onClick={() => onTabClick("Board")}
              className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                activeMapId === "Board"
                  ? "bg-black/90 text-[#F2A900] shadow-sm"
                  : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}
            >
              커뮤니티
              {activeMapId === "Board" && (
                <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
              )}
            </button>
            
            <button
              onClick={() => onTabClick("Stats")}
              className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                activeMapId === "Stats"
                  ? "bg-black/90 text-[#F2A900] shadow-sm"
                  : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}
            >
              AI 전적 검색
              {activeMapId === "Stats" && (
                <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
              )}
            </button>
            
            <Link href="/weapons">
              <button className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                isWeaponsActive ? "bg-black/90 text-[#F2A900] shadow-sm" : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}>
                무기 도감
                {isWeaponsActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>

            <Link href="/backpack">
              <button className={`relative h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase whitespace-nowrap transition-all tracking-wide ${
                isBackpackActive ? "bg-black/90 text-[#F2A900] shadow-sm" : "text-black/60 hover:bg-black/10 hover:text-black/80"
              }`}>
                가방 시뮬
                {isBackpackActive && (
                  <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#F2A900]" />
                )}
              </button>
            </Link>

            <a href="https://discord.gg/T97MR78awb" target="_blank" rel="noopener noreferrer" className="ml-1">
                <button className="h-8 px-3 rounded-lg font-extrabold text-[11px] uppercase text-[#5865F2] flex items-center gap-1.5 hover:bg-[#5865F2]/10 transition-colors tracking-wide">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                        <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
                    </svg>
                    <span>Discord</span>
                </button>
            </a>
          </nav>
        )}
      </div>

      {/* 우측 사용자 액션 */}
      <div className="flex items-center gap-4 flex-shrink-0">
        {isAuthLoading ? (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/5 rounded-xl border border-black/5 animate-pulse">
            <div className="w-4 h-4 rounded-full bg-black/10" />
            <div className="w-12 h-3 bg-black/10 rounded" />
          </div>
        ) : currentUser ? (
          <>
            {/* 관리자 퀵 메뉴 (데스크톱) */}
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
              </div>
            )}

            {/* 알림 버튼 */}
            <div className="relative">
              <button
                aria-label="알림"
                onClick={onToggleNoti}
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
                onClose={onCloseNoti}
                onMarkAllAsRead={onMarkAllAsRead}
                onNotificationClick={onNotiClick}
                formatNotiTime={formatNotiTime}
              />
            </div>

            {/* 프로필 버튼 */}
            <button
              onClick={onMyPageClick}
              className="flex items-center gap-2 group active:scale-95 transition-transform"
            >
              <div className="w-8 h-8 rounded-xl bg-black/10 flex items-center justify-center border border-black/5 group-active:bg-black/20">
                <User size={18} strokeWidth={2.5} className="text-black/80" />
              </div>
              {!isMobile && (
                <span className="font-black text-black text-sm tracking-tight">
                  {displayName}
                </span>
              )}
            </button>
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
});

MapHeader.displayName = "MapHeader";
export default MapHeader;
