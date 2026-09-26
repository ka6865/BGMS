'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Map, BarChart2, MessageSquare, Trophy, Menu } from 'lucide-react';
import GlobalMobileMenu from './GlobalMobileMenu';
import { useAuth } from '../AuthProvider';
import { supabase } from '@/lib/supabase';

export const isStatsPath = (pathname: string) =>
  pathname === '/stats' || pathname.startsWith('/stats/');

export default function BottomNav() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const activeTab = pathname.startsWith('/maps/') 
    ? pathname.replace('/maps/', '').charAt(0).toUpperCase() + pathname.replace('/maps/', '').slice(1)
    : (searchParams?.get('tab') || 'Erangel');
  
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(pathname);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    const checkAdmin = async () => {
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      setIsAdmin(data?.role === 'admin');
    };
    checkAdmin();
  }, [user]);

  // 라우트 변경 시 메뉴 자동 닫기
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setIsMenuOpen(false);
  }

  // 3D 리플레이와 어드민 도구 페이지에서는 하단 탭바를 숨겨 작업 화면을 보장
  if (pathname.startsWith('/replay/') || pathname.startsWith('/admin/')) {
    return null;
  }

  const bottomNavItems = [
    {
      id: 'Home',
      label: '지도',
      icon: Map,
      onClick: () => router.push('/maps/erangel'),
      active: pathname.startsWith('/maps') && !isMenuOpen,
    },
    {
      id: 'Stats',
      label: 'AI 전적',
      icon: BarChart2,
      onClick: () => router.push('/stats'),
      active: isStatsPath(pathname) && !isMenuOpen,
    },
    {
      id: 'Rankings',
      label: '랭킹',
      icon: Trophy,
      onClick: () => router.push('/rankings'),
      active: pathname.startsWith('/rankings') && !isMenuOpen,
    },
    {
      id: 'Board',
      label: '커뮤니티',
      icon: MessageSquare,
      onClick: () => router.push('/board'),
      active: pathname.startsWith('/board') && !isMenuOpen,
    },
    {
      id: 'Menu',
      label: '메뉴',
      icon: Menu,
      onClick: (e?: React.MouseEvent) => {
        if (e) (e.currentTarget as HTMLButtonElement).blur();
        setIsMenuOpen(true);
      },
      active: isMenuOpen,
    },
  ];

  return (
    <>
      <nav
        className="fixed bottom-0 left-0 right-0 z-[5000] md:hidden safe-bottom"
        style={{
          /* 글래스모피즘 배경 */
          background: "rgba(13, 13, 13, 0.85)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: "1px solid rgba(255, 255, 255, 0.07)",
          boxShadow: "0 -8px 32px rgba(0, 0, 0, 0.5)",
        }}
      >
        <div className="flex justify-around items-center h-[56px] px-2">
          {bottomNavItems.map((item) => (
            <button
              key={item.id}
              onClick={(e) => item.onClick(e)}
              className="flex flex-col items-center justify-center w-full gap-[3px] relative"
              style={{
                color: item.active ? '#F2A900' : 'rgba(255,255,255,0.4)',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                transform: item.active ? 'scale(1.08)' : 'scale(1)',
              }}
            >
              {/* 액티브 인디케이터 닷 */}
              {item.active && (
                <span
                  style={{
                    position: 'absolute',
                    top: '4px',
                    width: '4px',
                    height: '4px',
                    borderRadius: '50%',
                    backgroundColor: '#F2A900',
                    boxShadow: '0 0 6px rgba(242, 169, 0, 0.8)',
                  }}
                />
              )}
              <item.icon
                size={20}
                strokeWidth={item.active ? 2.5 : 1.8}
                style={{ marginTop: item.active ? '8px' : '0' }}
              />
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: item.active ? 700 : 500,
                  letterSpacing: '0.02em',
                }}
              >
                {item.label}
              </span>
            </button>
          ))}
        </div>
      </nav>
      <GlobalMobileMenu isOpen={isMenuOpen} setIsOpen={setIsMenuOpen} activeMapId={activeTab} isAdmin={isAdmin} />
    </>
  );
}
