import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// Clean utility to safely strip any accidental quotes or trailing spaces from Vercel envs
const clean = (val: string | undefined) =>
  (val || "").replace(/['";\s]+/g, "").trim();

/**
 * @fileoverview Supabase JWT 인증 기반 하이브리드 서버 가드
 *
 * 서버 Route Handler(app/api)에서 로그인 세션을 검증하고,
 * 인증된 사용자만 데이터 변경(CUD) 작업을 수행할 수 있도록 방어합니다.
 *
 * 반환값:
 * - 인증 성공 시: { user, supabaseAdmin } (Service Role 클라이언트 포함)
 * - 인증 실패 시: { error: NextResponse } (401 응답 객체)
 */

type AuthGuardSuccess = {
  user: { id: string; email?: string };
  supabaseAdmin: ReturnType<typeof createAdminClient<any>>;
  error?: undefined;
};

type AuthGuardFailure = {
  user?: undefined;
  supabaseAdmin?: undefined;
  error: NextResponse;
};

export type AuthGuardResult = AuthGuardSuccess | AuthGuardFailure;

function invalidBearerResponse() {
  return NextResponse.json(
    { error: "인증 토큰이 유효하지 않습니다. 다시 로그인해 주세요." },
    { status: 401 },
  );
}

export async function withAuthGuard(): Promise<AuthGuardResult> {
  try {
    const cookieStore = await cookies();
    const headerStore = await headers();
    const authorization = headerStore.get("authorization");
    const bearerToken = getBearerToken(authorization);
    const supabaseAdmin = createAdminClient<any>(
      clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    );

    if (hasBearerAuthorization(authorization)) {
      if (!bearerToken) return { error: invalidBearerResponse() };
      const {
        data: { user },
        error: bearerError,
      } = await supabaseAdmin.auth.getUser(bearerToken);

      if (!bearerError && user) {
        return { user, supabaseAdmin };
      }
      // An explicitly supplied mobile token has precedence over a browser
      // cookie. Falling back here could execute a write as a different user.
      return { error: invalidBearerResponse() };
    }

    // 1. 쿠키 기반 Supabase SSR 클라이언트로 JWT 세션 복원
    const supabase = createServerClient(
      clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set({ name, value, ...options })
              );
            } catch {
              // Server Component에서 호출된 경우 무시
            }
          },
        },
      }
    );

    // 2. JWT AccessToken을 복호화하여 실제 인증된 사용자 정보 확인
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return {
        error: NextResponse.json(
          { error: "로그인이 필요합니다. 로그인 후 다시 시도해주세요." },
          { status: 401 }
        ),
      };
    }

    return { user, supabaseAdmin };
  } catch (err) {
    console.error("[withAuthGuard] 인증 처리 중 예외:", err);
    return {
      error: NextResponse.json(
        { error: "인증 처리 중 오류가 발생했습니다." },
        { status: 500 }
      ),
    };
  }
}

function getBearerToken(authorization: string | null) {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function hasBearerAuthorization(authorization: string | null) {
  return /^Bearer\b/i.test(authorization || "");
}

// 비회원도 통과 가능한 선택적 인증 가드
// 로그인 상태면 user 반환, 비로그인이어도 에러 없이 user: null 반환
type OptionalAuthSuccess = {
  user: { id: string; email?: string } | null;
  supabaseAdmin: ReturnType<typeof createAdminClient<any>>;
  error?: undefined;
};

type OptionalAuthFailure = {
  user?: undefined;
  supabaseAdmin?: undefined;
  error: NextResponse;
};

export type OptionalAuthResult = OptionalAuthSuccess | OptionalAuthFailure;

export async function withOptionalAuth(): Promise<OptionalAuthResult> {
  try {
    const cookieStore = await cookies();
    const headerStore = await headers();

    const supabase = createServerClient(
      clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set({ name, value, ...options })
              );
            } catch {
              // Server Component에서 호출된 경우 무시
            }
          },
        },
      }
    );

    // Service Role 클라이언트는 항상 생성 (비회원 INSERT에 사용)
    const supabaseAdmin = createAdminClient<any>(
      clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    );

    const authorization = headerStore.get("authorization");
    const bearerToken = getBearerToken(authorization);
    if (hasBearerAuthorization(authorization)) {
      if (!bearerToken) return { error: invalidBearerResponse() };
      const {
        data: { user },
        error,
      } = await supabaseAdmin.auth.getUser(bearerToken);
      if (!error && user) {
        return { user, supabaseAdmin };
      }
      return { error: invalidBearerResponse() };
    }

    // 세션이 없어도 에러 반환하지 않고 user: null로 통과
    const { data: { user } } = await supabase.auth.getUser();
    return { user: user ?? null, supabaseAdmin };
  } catch (err) {
    console.error("[withOptionalAuth] 처리 중 예외:", err);
    return {
      error: NextResponse.json(
        { error: "서버 오류가 발생했습니다." },
        { status: 500 }
      ),
    };
  }
}
