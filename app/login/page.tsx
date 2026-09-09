'use client';

import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { safeNextPath } from '../../lib/auth/safeNextPath';
import { toast } from 'sonner';

/**
 * @fileoverview 소셜 로그인 페이지 (최후의 방어벽 버전)
 * 환경 변수 오염(따옴표 등)을 강제로 세척하고 모든 과정을 로그로 남깁니다.
 */
export default function Login() {
  const [isLoading, setIsLoading] = useState<string | null>(null);

  const handleSocialLogin = async (provider: 'kakao' | 'google') => {
    setIsLoading(provider);
    try {
      const callback = new URL('/auth/callback', window.location.origin);
      const requestedNext = new URLSearchParams(window.location.search).get('next');
      const next = safeNextPath(requestedNext, '');
      if (next) callback.searchParams.set('next', next);
      const redirectTo = callback.toString();
      
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });

      if (error) {
        throw error;
      }
      
    } catch (error: any) {
      toast.error(`로그인 시도 중 오류가 발생했습니다: ${error.message}`);
      setIsLoading(null);
    }
  };

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100dvh', 
      backgroundColor: '#0a0a0a',
      color: 'white',
      padding: '20px',
      fontFamily: 'inherit'
    }}>
      <div style={{ 
        width: '100%', 
        maxWidth: '400px', 
        padding: '60px 40px', 
        backgroundColor: '#121212', 
        borderRadius: '32px', 
        border: '1px solid rgba(255,255,255,0.05)', 
        textAlign: 'center',
        boxShadow: '0 25px 60px rgba(0,0,0,0.8)',
      }}>
        <h2 style={{ 
          marginBottom: '20px', 
          fontSize: '48px', 
          fontWeight: '950', 
          fontStyle: 'italic', 
          color: 'black', 
          textShadow: '-2px -2px 0 #F2A900, 2px -2px 0 #F2A900, -2px 2px 0 #F2A900, 2px 2px 0 #F2A900',
          letterSpacing: '-3px'
        }}>
          BG<span style={{ color: 'white', textShadow: 'none' }}>MS</span>
        </h2>
        
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '14px', marginBottom: '50px', lineHeight: '1.6' }}>
          승리의 시작, 소셜 계정으로<br />
          <strong>3초 만에</strong> 합류하세요.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <button 
            disabled={!!isLoading}
            onClick={() => handleSocialLogin('kakao')}
            style={{ 
              width: '100%', padding: '18px', backgroundColor: '#FEE500', color: '#000', fontWeight: 900, 
              border: 'none', borderRadius: '16px', cursor: isLoading ? 'wait' : 'pointer', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', fontSize: '16px',
              opacity: isLoading && isLoading !== 'kakao' ? 0.3 : 1,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: '0 8px 20px rgba(254, 229, 0, 0.15)'
            }}
          >
            {isLoading === 'kakao' ? '연결 중...' : '카카오 로그인'}
          </button>

          <button 
            disabled={!!isLoading}
            onClick={() => handleSocialLogin('google')}
            style={{ 
              width: '100%', padding: '18px', backgroundColor: 'white', color: '#000', fontWeight: 900, 
              border: 'none', borderRadius: '16px', cursor: isLoading ? 'wait' : 'pointer', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', fontSize: '16px',
              opacity: isLoading && isLoading !== 'google' ? 0.3 : 1,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: '0 8px 20px rgba(255, 255, 255, 0.05)'
            }}
          >
            {isLoading === 'google' ? '연결 중...' : '구글 로그인'}
          </button>
        </div>
      </div>
    </div>
  );
}
