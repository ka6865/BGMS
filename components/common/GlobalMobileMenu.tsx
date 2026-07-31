import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { X, User, LogOut, Sword, Package, Trophy, Box, Bot } from 'lucide-react';
import { useAuth } from '../AuthProvider';
import { supabase } from '@/lib/supabase';
import { Drawer } from 'vaul';


interface GlobalMobileMenuProps {
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
  activeMapId: string;
  isAdmin?: boolean;
}

export default function GlobalMobileMenu({ isOpen, setIsOpen, activeMapId, isAdmin }: GlobalMobileMenuProps) {
  const router = useRouter();
  const { user } = useAuth();
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  const visibleUser = mounted ? user : null;
  const visibleIsAdmin = Boolean(visibleUser && isAdmin);
  
  const displayName = React.useSyncExternalStore(
    (callback) => {
      window.addEventListener('storage', callback);
      return () => window.removeEventListener('storage', callback);
    },
    () => typeof window !== 'undefined' ? localStorage.getItem('user_nickname') || '' : '',
    () => ''
  );

  useEffect(() => {
    if (user) {
      supabase.from('profiles').select('nickname').eq('id', user.id).single().then(({data}) => {
        if (data && data.nickname && data.nickname !== displayName) {
          localStorage.setItem('user_nickname', data.nickname);
          window.dispatchEvent(new Event('storage'));
        }
      });
    } else if (displayName !== '') {
      localStorage.removeItem('user_nickname');
      window.dispatchEvent(new Event('storage'));
    }
  }, [user, displayName]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  return (
    <Drawer.Root open={isOpen} onOpenChange={setIsOpen}>
      <Drawer.Portal>
        <Drawer.Overlay 
          className="fixed inset-0 bg-black/60 z-[5000] backdrop-blur-[2px]" 
          onClick={() => setIsOpen(false)}
        />
        <Drawer.Content className="bg-[#121212] flex flex-col rounded-t-[32px] h-auto max-h-[92%] fixed bottom-0 left-0 right-0 z-[5001] outline-none border-t border-[#333] safe-bottom">
          <div className="flex-1 overflow-y-auto p-5 rounded-t-[32px]">
            {/* 드래그 핸들 */}
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-[#333] mb-6" />
            
            <div className="max-w-md mx-auto">
              <div className="flex items-center justify-between mb-6">
                <Drawer.Title asChild>
                  <h2 className="text-[#F2A900] font-black text-2xl italic tracking-tighter uppercase">
                    BGMS Menu
                  </h2>
                </Drawer.Title>
                <Drawer.Description className="sr-only">
                  BGMS 서비스 메뉴 및 맵 선택 도구입니다.
                </Drawer.Description>
                <button 
                  onClick={() => setIsOpen(false)} 
                  className="p-2 bg-[#222] rounded-full text-[#666] active:bg-[#333] transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="flex flex-col gap-8">
                {/* Profile Card */}
                <div className="bg-[#1a1a1a] p-5 rounded-2xl border border-[#333] flex flex-col gap-4">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-[#252525] rounded-full flex items-center justify-center border-2 border-[#F2A900]/30 shadow-inner">
                      <User size={30} className="text-[#F2A900]" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-white font-black text-lg">{visibleUser ? (displayName || "게이머") : "익명 사용자"}</span>
                      <span className="text-[#666] text-xs">BGMS에 오신 것을 환영합니다</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => { router.push(visibleUser ? '/mypage' : '/login'); setIsOpen(false); }}
                      className="flex-1 bg-[#F2A900] text-black py-3 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-transform"
                    >
                      {visibleUser ? "마이페이지" : "로그인하기"}
                    </button>
                    {visibleUser && (
                      <button 
                        onClick={handleLogout}
                        className="px-4 bg-[#222] text-[#888] py-3 rounded-xl font-bold text-sm border border-[#333] flex items-center justify-center gap-2 active:bg-[#2a2a2a]"
                      >
                        <LogOut size={16} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Map Selection Section */}
                <div className="flex flex-col gap-4">
                  <h3 className="text-[#666] text-[11px] font-black uppercase tracking-widest ml-1">Map Selection</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: "Erangel", label: "에란겔" },
                      { id: "Miramar", label: "미라마" },
                      { id: "Taego", label: "태이고" },
                      { id: "Rondo", label: "론도" },
                      { id: "Vikendi", label: "비켄디" },
                      { id: "Deston", label: "데스턴" },
                    ].map((m) => (
                      <button
                        key={m.id}
                        onClick={() => { router.push(`/maps/${m.id.toLowerCase()}`); setIsOpen(false); }}
                        className={`text-[13px] font-bold py-3.5 rounded-xl border active:scale-95 transition-all ${
                          activeMapId === m.id 
                            ? 'bg-[#F2A900] text-black border-[#F2A900] shadow-[0_5px_15px_rgba(242,169,0,0.3)]' 
                            : 'bg-[#1a1a1a] text-white border-[#333] hover:border-[#444]'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tools Section */}
                <div className="flex flex-col gap-4">
                  <h3 className="text-[#666] text-[11px] font-black uppercase tracking-widest ml-1">Tactical Tools</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={() => { router.push('/weapons'); setIsOpen(false); }}
                      className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-[#333] flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                    >
                      <div className="p-2 bg-blue-500/10 rounded-xl">
                        <Sword size={20} className="text-blue-500" />
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-white font-bold text-xs">무기 도감</span>
                        <span className="text-[#666] text-[9px] mt-0.5 leading-none">스탯 비교</span>
                      </div>
                    </button>

                    <button 
                      onClick={() => { router.push('/backpack'); setIsOpen(false); }}
                      className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-[#333] flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                    >
                      <div className="p-2 bg-green-500/10 rounded-xl">
                        <Package size={20} className="text-green-500" />
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-white font-bold text-xs">가방 시뮬</span>
                        <span className="text-[#666] text-[9px] mt-0.5 leading-none">무게 계산</span>
                      </div>
                    </button>

                    <button 
                      onClick={() => { router.push('/rankings'); setIsOpen(false); }}
                      className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-[#333] flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                    >
                      <div className="p-2 bg-yellow-500/10 rounded-xl">
                        <Trophy size={20} className="text-yellow-500" />
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-white font-bold text-xs">랭킹</span>
                        <span className="text-[#666] text-[9px] mt-0.5 leading-none">주간 순위</span>
                      </div>
                    </button>

                    <button 
                      onClick={() => { router.push('/crates'); setIsOpen(false); }}
                      className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-[#333] flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                    >
                      <div className="p-2 bg-amber-500/10 rounded-xl">
                        <Box size={20} className="text-amber-500" />
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-white font-bold text-xs">상자 시뮬</span>
                        <span className="text-[#666] text-[9px] mt-0.5 leading-none">상자깡 및 확률</span>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Admin Console Section (관리자 전용) */}
                {visibleIsAdmin && (
                  <div className="flex flex-col gap-4">
                    <h3 className="text-red-500 text-[11px] font-black uppercase tracking-widest ml-1">Admin Console</h3>
                    <div className="grid grid-cols-2 gap-2">
                      <button 
                        onClick={() => { router.push('/admin/game-data'); setIsOpen(false); }}
                        className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-red-900/30 flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                      >
                        <div className="p-2 bg-green-500/10 rounded-xl">
                          <Box size={20} className="text-green-500" />
                        </div>
                        <span className="text-white font-bold text-xs">데이터 관리</span>
                      </button>

                      <button 
                        onClick={() => { router.push('/map-editor'); setIsOpen(false); }}
                        className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-red-900/30 flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                      >
                        <div className="p-2 bg-amber-500/10 rounded-xl">
                          <Sword size={20} className="text-amber-500" />
                        </div>
                        <span className="text-white font-bold text-xs">맵 에디터</span>
                      </button>

                      <button 
                        onClick={() => { router.push('/admin/map-settings'); setIsOpen(false); }}
                        className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-red-900/30 flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                      >
                        <div className="p-2 bg-blue-500/10 rounded-xl">
                          <Trophy size={20} className="text-blue-500" />
                        </div>
                        <span className="text-white font-bold text-xs">맵 설정</span>
                      </button>

                      <button 
                        onClick={() => { router.push('/admin/bot'); setIsOpen(false); }}
                        className="bg-[#1a1a1a] p-3.5 rounded-2xl border border-red-900/30 flex flex-col gap-2.5 items-center text-center active:bg-[#222] transition-colors"
                      >
                        <div className="p-2 bg-amber-500/10 rounded-xl">
                          <Bot size={20} className="text-amber-500" />
                        </div>
                        <span className="text-white font-bold text-xs">AI 비서</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Support Section */}
                <div className="flex flex-col gap-4 mb-4">
                  <h3 className="text-[#666] text-[11px] font-black uppercase tracking-widest ml-1">Support</h3>
                  <a 
                    href="https://discord.gg/T97MR78awb"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-[#1a1a1a] p-5 rounded-2xl border border-[#333] flex items-center justify-between active:bg-[#222] transition-colors group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="p-2.5 bg-[#5865F2]/10 rounded-xl group-hover:bg-[#5865F2]/20 transition-colors">
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="#5865F2">
                          <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
                        </svg>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-white font-bold text-sm">Discord Community</span>
                        <span className="text-[#666] text-[10px]">문의 및 업데이트 소식 확인</span>
                      </div>
                    </div>
                    <ChevronRight size={18} className="text-[#444]" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

const ChevronRight = ({ size, className }: { size: number, className: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m9 18 6-6-6-6"/>
  </svg>
);
