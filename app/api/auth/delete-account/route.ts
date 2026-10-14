import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { createServerClient } from '@supabase/ssr';
import { headers } from 'next/headers';

// Vercel envs 클린 유틸리티 (서버 전용)
const clean = (val: string | undefined) => (val || '').replace(/['";\s]+/g, '').trim();

export async function POST() {
  try {
    const supabaseUrl = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { error: '서버 환경 변수가 누락되었습니다. 관리자에게 문의해 주세요.' },
        { status: 500 }
      );
    }

    const adminClient = createServerClient(
      supabaseUrl,
      serviceRoleKey,
      {
        cookies: {
          getAll() { return []; },
          setAll() {}
        }
      }
    );

    // 1. 현재 사용자 세션 확인: 웹 쿠키 세션과 모바일 Bearer 토큰을 모두 지원합니다.
    const headerStore = await headers();
    const bearerToken = getBearerToken(headerStore.get('authorization'));
    let user: { id: string } | null = null;
    let supabase: Awaited<ReturnType<typeof createClient>> | null = null;

    if (bearerToken) {
      const { data, error } = await adminClient.auth.getUser(bearerToken);
      if (!error && data.user) {
        user = data.user;
      }
    } else {
      supabase = await createClient();
      const { data, error } = await supabase.auth.getUser();
      if (!error && data.user) {
        user = data.user;
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: '인증되지 않았거나 잘못된 세션입니다. 다시 로그인해 주세요.' },
        { status: 401 }
      );
    }

    // 3. auth.users 테이블에서 사용자 삭제
    // ON DELETE CASCADE 제약조건에 의해 public.profiles는 자동 삭제되며,
    // posts와 comments 테이블의 user_id는 ON DELETE SET NULL에 의해 익명화 처리됩니다.
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);

    if (deleteError) {
      console.error("[delete-account] 계정 삭제 실패:", deleteError);
      return NextResponse.json(
        { error: "계정 삭제에 실패했습니다. 잠시 후 다시 시도해 주세요." },
        { status: 500 }
      );
    }

    // 4. 로컬 세션 쿠키 정리 (Sign Out 호출)
    if (supabase) {
      await supabase.auth.signOut();
    }

    return NextResponse.json(
      { success: true, message: '회원탈퇴가 성공적으로 완료되었습니다. 데이터가 익명화 처리되었습니다.' },
      { status: 200 }
    );
  } catch (error) {
    console.error("[delete-account] 처리 실패:", error);
    return NextResponse.json(
      { error: "서버 내부 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

function getBearerToken(authorization: string | null) {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
