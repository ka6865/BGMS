'use client';

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import MiniStatWidget from "@/components/stat/MiniStatWidget";
import ConfirmModal from "@/components/common/ConfirmModal";
import { 
  User as UserIcon, Save, LogOut, Trash2, AlertCircle,
  Gamepad2, Settings, ShieldCheck, ExternalLink,
  Mail, ChevronRight, Activity, MessageSquare, FileText, Heart
} from "lucide-react";



import type { UserProfile } from "@/types/map";
import type { User } from '@supabase/supabase-js';

interface MyPageProps {
  initialCurrentUser: User | null;
  initialUserProfile: UserProfile | null;
  initialActivityStats: {
    postCount: number;
    commentCount: number;
    likeCount: number;
  };
}

// 고급 섹션 카드 컴포넌트
function DashboardCard({ 
  children, 
  title, 
  icon: Icon,
  variant = 'default',
  style = {}
}: { 
  children: React.ReactNode; 
  title?: string;
  icon?: any;
  variant?: 'default' | 'highlight';
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      backgroundColor: variant === 'highlight' ? 'rgba(242,169,0,0.03)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${variant === 'highlight' ? 'rgba(242,169,0,0.15)' : 'rgba(255,255,255,0.05)'}`,
      borderRadius: "20px",
      padding: "24px",
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      transition: 'all 0.3s ease',
      backdropFilter: 'blur(10px)',
      boxShadow: '0 4px 30px rgba(0,0,0,0.1)',
      ...style
    }}>
      {(title || Icon) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          {Icon && <Icon size={18} style={{ color: variant === 'highlight' ? '#F2A900' : 'rgba(255,255,255,0.4)' }} />}
          {title && (
            <span style={{ 
              fontSize: "11px", 
              fontWeight: 800, 
              letterSpacing: "0.15em", 
              textTransform: "uppercase", 
              color: 'rgba(255,255,255,0.3)' 
            }}>
              {title}
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}



export default function MyPage({ initialCurrentUser, initialUserProfile, initialActivityStats }: MyPageProps) {
  const router = useRouter();
  const currentUser = initialCurrentUser;
  const [userProfile, setUserProfile] = useState<UserProfile | null>(initialUserProfile);
  
  const [editNickname, setEditNickname] = useState(initialUserProfile?.nickname || "");
  const [editPubgNickname, setEditPubgNickname] = useState(initialUserProfile?.pubg_nickname || "");
  const [editPubgPlatform, setEditPubgPlatform] = useState<"steam" | "kakao">(
    (initialUserProfile?.pubg_platform as "steam" | "kakao") || "steam"
  );
  const [isMobile, setIsMobile] = useState(false);
  
  // 실시간 활동 데이터 상태 (초기값은 서버에서 제공)
  const activityStats = initialActivityStats;

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const handleUpdateProfile = async () => {
    if (!currentUser) return;
    const newNickname = editNickname.trim();
    if (!newNickname || newNickname.length < 2) {
      toast.error("닉네임을 2자 이상 입력해주세요.");
      return;
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        nickname: newNickname,
        pubg_nickname: editPubgNickname.trim() || null,
        pubg_platform: editPubgPlatform,
        updated_at: new Date()
      })
      .eq('id', currentUser.id);

    if (error) {
      toast.error("업데이트 실패: " + error.message);
    } else {
      toast.success("프로필이 성공적으로 저장되었습니다.");
      
      // 재조회 로직 교체
      const { data } = await supabase.from("profiles").select("*").eq("id", currentUser.id).single();
      if (data) {
        setUserProfile(data as UserProfile);
      }
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/');
    window.location.reload();
  };

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteAccount = () => {
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch("/api/auth/delete-account", {
        method: "POST",
      });
      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "회원탈퇴 처리 중 오류가 발생했습니다.");
      }

      toast.success("회원탈퇴가 정상 처리되었습니다. 이용해 주셔서 감사합니다.");
      await supabase.auth.signOut();
      router.push("/");
      window.location.reload();
    } catch (error: any) {
      toast.error(error.message);
      setIsDeleting(false);
      setIsDeleteModalOpen(false);
    }
  };

  if (!currentUser) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80dvh' }}>
        <DashboardCard title="시스템 확인">
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <ShieldCheck size={48} style={{ color: '#F2A900', marginBottom: '20px', opacity: 0.5 }} />
            <h2 style={{ fontSize: '24px', fontWeight: 900, marginBottom: '12px' }}>로그인이 필요합니다</h2>
            <p style={{ color: 'rgba(255,255,255,0.4)', marginBottom: '32px' }}>마이페이지 접근을 위해 먼저 소셜 로그인을 진행해 주세요.</p>
            <button 
              onClick={() => router.push('/login')}
              style={{ padding: '16px 48px', backgroundColor: '#F2A900', border: 'none', borderRadius: '12px', fontWeight: 900, cursor: 'pointer' }}
            >
              로그인하기
            </button>
          </div>
        </DashboardCard>
      </div>
    );
  }

  return (
    <div style={{ 
      width: "100%", 
      maxWidth: "1350px", 
      margin: "0 auto", 
      padding: isMobile ? "24px 16px 120px" : "60px 40px",
      fontFamily: 'inherit',
      boxSizing: 'border-box',
      overflowX: 'hidden'
    }}>
      
      {/*  브레드크럼 (3열 그리드 밖 최상단 배치) */}
      {!isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'rgba(255,255,255,0.2)', fontSize: '12px', marginBottom: '24px', paddingLeft: '4px' }}>
          <span>Home</span> <ChevronRight size={10} /> <span>Account</span> <ChevronRight size={10} /> <span style={{ color: '#F2A900' }}>My Dashboard</span>
        </div>
      )}

      {/* ️ 대시보드 구조 (데스크톱: 3열 / 모바일: 1열) */}
      <div style={{ 
        display: "grid", 
        gridTemplateColumns: isMobile ? "1fr" : "340px 1fr 360px", 
        gap: isMobile ? "24px" : "32px",
        alignItems: "stretch" //  높이를 서로 맞춤
      }}>
        
        {/* 1️⃣ LEFT: Profile Summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <DashboardCard variant="highlight" style={{ flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '10px 0', height: '100%', justifyContent: 'center' }}>
              <div style={{ 
                width: '120px', 
                height: '120px', 
                borderRadius: '40px', 
                backgroundColor: '#121212', 
                border: '2px solid #F2A900',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '24px',
                boxShadow: '0 0 30px rgba(242,169,0,0.2)'
              }}>
                <UserIcon size={56} style={{ color: '#F2A900' }} />
              </div>
              <h1 style={{ fontSize: '28px', fontWeight: 900, margin: '0 0 8px 0', letterSpacing: '-0.5px' }}>
                {userProfile?.nickname || "게이머"}
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'rgba(255,255,255,0.3)', fontSize: '13px' }}>
                <Mail size={14} />
                {currentUser.email}
              </div>
            </div>
          </DashboardCard>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button 
              onClick={handleSignOut}
              style={{ 
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', 
                padding: '18px 20px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '14px', fontWeight: 600
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><LogOut size={16} /> 안전하게 로그아웃</div>
              <ChevronRight size={14} />
            </button>
            <button 
              onClick={handleDeleteAccount}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255,75,75,0.06)';
                e.currentTarget.style.borderColor = 'rgba(255,75,75,0.35)';
                e.currentTarget.style.color = 'rgba(255,75,75,1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.borderColor = 'rgba(255,75,75,0.15)';
                e.currentTarget.style.color = 'rgba(255,75,75,0.75)';
              }}
              style={{ 
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', 
                padding: '16px 20px', backgroundColor: 'transparent', border: '1px solid rgba(255,75,75,0.15)',
                borderRadius: '16px', color: 'rgba(255,75,75,0.75)', cursor: 'pointer', fontSize: '14px',
                fontWeight: 600, transition: 'all 0.25s ease'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><Trash2 size={16} /> 계정 삭제 (회원탈퇴)</div>
            </button>
          </div>
        </div>

        {/* 2️⃣ CENTER: Core Settings */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>

          <DashboardCard title="계정 정보 최적화" icon={Settings} style={{ flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', justifyContent: 'center' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'rgba(255,255,255,0.3)', marginBottom: '10px' }}>커뮤니티 활동 닉네임</label>
                <input 
                  value={editNickname}
                  onChange={(e) => setEditNickname(e.target.value)}
                  placeholder="닉네임을 입력하세요"
                  style={{ 
                    width: '100%', padding: '18px', backgroundColor: '#000', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '14px', color: 'white', outline: 'none', fontSize: '16px'
                  }}
                />
                <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.2)' }}>커뮤니티 작성글 및 댓글에 표시되는 이름입니다.</p>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'rgba(255,255,255,0.3)', marginBottom: '10px' }}>PUBG 인게임 연동</label>
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '12px' }}>
                  <input 
                    value={editPubgNickname}
                    onChange={(e) => setEditPubgNickname(e.target.value)}
                    placeholder="인게임 닉네임"
                    style={{ 
                      flex: isMobile ? 'none' : 1, width: '100%', padding: '18px', backgroundColor: '#000', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '14px', color: 'white', outline: 'none', fontSize: '16px', boxSizing: 'border-box'
                    }}
                  />
                  <div style={{ display: 'flex', backgroundColor: '#000', borderRadius: '14px', padding: '5px', border: '1px solid rgba(255,255,255,0.1)', width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', justifyContent: 'center' }}>
                    {['steam', 'kakao'].map(p => (
                      <button 
                        key={p}
                        onClick={() => setEditPubgPlatform(p as any)}
                        style={{ 
                          flex: isMobile ? 1 : 'none', padding: isMobile ? '12px 0' : '0 18px', borderRadius: '10px', border: 'none', backgroundColor: editPubgPlatform === p ? '#F2A900' : 'transparent',
                          color: editPubgPlatform === p ? 'black' : 'rgba(255,255,255,0.4)', fontWeight: 800, cursor: 'pointer', fontSize: '13px'
                        }}
                      >
                        {p.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>전적 검색 기본 계정으로 설정되며, 미접속 시에도 매일 과거 전적이 자동 기록 및 저장됩니다.</p>
              </div>

              <button 
                onClick={handleUpdateProfile}
                style={{ 
                  marginTop: '12px', width: '100%', padding: '20px', backgroundColor: '#F2A900', border: 'none', 
                  borderRadius: '16px', color: 'black', fontWeight: 900, fontSize: '17px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                  boxShadow: '0 10px 30px rgba(242,169,0,0.15)'
                }}
              >
                <Save size={18} /> 설정 저장하기
              </button>
            </div>
          </DashboardCard>

          <DashboardCard title="보안 및 연동" icon={ShieldCheck}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '44px', height: '44px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Gamepad2 size={22} />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>PUBG API 연동 상태</p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#10b981' }}>정상 (Connected)</p>
                </div>
              </div>
              <button style={{ padding: '10px 20px', backgroundColor: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: '10px', color: 'white', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
                재연동
              </button>
            </div>
          </DashboardCard>
        </div>

        {/* 3️⃣ RIGHT: Stats & Insights */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <DashboardCard title="데이터 인사이트" icon={Activity} style={{ flex: 1 }}>
             {userProfile?.pubg_nickname ? (
               <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', justifyContent: 'center' }}>
                  <MiniStatWidget 
                    pubgNickname={userProfile.pubg_nickname}
                    platform={userProfile.pubg_platform || "steam"}
                  />
                  <button 
                    onClick={() => router.push('/stats')}
                    style={{ 
                      width: '100%', padding: '16px', backgroundColor: 'rgba(255,255,255,0.05)', 
                      border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', 
                      color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                    }}
                  >
                    상세 전적 분석 보기 <ExternalLink size={14} />
                  </button>
               </div>
             ) : (
               <div style={{ textAlign: 'center', padding: '30px 0', opacity: 0.4, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <Gamepad2 size={40} style={{ marginBottom: '16px', alignSelf: 'center' }} />
                  <p style={{ fontSize: '13px', margin: 0, lineHeight: 1.6 }}>인게임 닉네임을 설정하면<br/>이곳에 실시간 전적이 나타납니다.</p>
               </div>
             )}
          </DashboardCard>

          <DashboardCard title="활동 요약" icon={Activity}>
             <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'rgba(255,255,255,0.4)' }}>
                    <FileText size={16} />
                    <span style={{ fontSize: '14px' }}>작성한 게시글</span>
                  </div>
                  <span style={{ fontWeight: 800, fontSize: '16px' }}>{activityStats.postCount}개</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'rgba(255,255,255,0.4)' }}>
                    <MessageSquare size={16} />
                    <span style={{ fontSize: '14px' }}>작성한 댓글</span>
                  </div>
                  <span style={{ fontWeight: 800, fontSize: '16px' }}>{activityStats.commentCount}개</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'rgba(255,255,255,0.4)' }}>
                    <Heart size={16} />
                    <span style={{ fontSize: '14px' }}>받은 좋아요</span>
                  </div>
                  <span style={{ fontWeight: 800, fontSize: '16px', color: '#F2A900' }}>{activityStats.likeCount}개</span>
                </div>
             </div>
          </DashboardCard>
        </div>
      </div>
      <ConfirmModal
        isOpen={isDeleteModalOpen}
        title="정말로 탈퇴하시겠습니까?"
        description="탈퇴 시 프로필 정보는 즉시 파기되지만, 작성하신 게시글과 댓글은 '탈퇴한 사용자' 상태로 안전하게 보존됩니다. 이 작업은 취소할 수 없습니다."
        confirmText="탈퇴하기"
        cancelText="취소"
        type="danger"
        isPending={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setIsDeleteModalOpen(false)}
      />
    </div>
  );
}
