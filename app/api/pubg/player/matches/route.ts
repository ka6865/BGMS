 import { NextRequest, NextResponse } from "next/server";
 import { createClient } from "@supabase/supabase-js";
 import { fetchPlayerMatchesPaginated } from "@/lib/pubg/playerMatches";
 
 export const dynamic = "force-dynamic";
 export const runtime = "nodejs";
 
 function getAdminClient() {
   const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
   const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
   if (!url || !key) return null;
   return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
 }
 
 export async function GET(request: NextRequest) {
   const { searchParams } = request.nextUrl;
   const nickname = searchParams.get("nickname");
   const platform = searchParams.get("platform") || "steam";
   const cursor = searchParams.get("cursor");
 
   if (!nickname) {
     return NextResponse.json({ error: "닉네임을 입력해주세요." }, { status: 400 });
   }
 
   const supabase = getAdminClient();
   if (!supabase) {
     return NextResponse.json({ error: "DB credentials missing" }, { status: 500 });
   }
 
   try {
     const result = await fetchPlayerMatchesPaginated(supabase, nickname, platform, cursor, 20);
     return NextResponse.json(result);
   } catch (error: any) {
     return NextResponse.json({ error: error.message || "과거 매치 조회 실패" }, { status: 500 });
   }
 }
