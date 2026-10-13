import { NextResponse } from "next/server";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(req: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const adminError = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
    if (adminError) return adminError;

    const body = await req.json();
    const { action, nickname, matchId } = body;
    const supabaseAdmin = auth.supabaseAdmin;

    if (action === "flush_old_cache") {
      // 🚀 모든 분석 완료 데이터(가공된 데이터)만 삭제
      const { count, error } = await supabaseAdmin
        .from("processed_match_telemetry")
        .delete({ count: "exact" })
        .neq("match_id", "_dummy_");

      if (error) throw error;

      return NextResponse.json({
        success: true,
        message: `모든 분석 데이터 캐시 ${count || 0}개가 삭제되었습니다.`
      });
    }

    if (action === "flush_player_cache") {
      if (!nickname) throw new Error("플레이어 닉네임이 필요합니다.");
      const lowerNickname = nickname.toLowerCase().trim();
      
      // 1. 분석 결과 삭제
      const { count, error } = await supabaseAdmin
        .from("processed_match_telemetry")
        .delete({ count: "exact" })
        .eq("player_id", lowerNickname);

      // 2. [V12.6] 해당 유저의 모든 매치 텔레메트리 캐시(Storage)도 삭제 시도
      // (현 구조상 매치별 파일명이 matchId이므로 유저별 일괄 삭제는 DB 조회가 선행되어야 함)
      // 여기서는 우선 DB 캐시만 확실히 지우고, 개별 매치 캐시 삭제를 권장함

      if (error) throw error;

      return NextResponse.json({ success: true, message: `${nickname}님의 분석 데이터 캐시 ${count || 0}개가 삭제되었습니다.` });
    }

    if (action === "flush_match_cache") {
      if (!matchId) throw new Error("매치 ID가 필요합니다.");
      
      // 1. 분석 결과 삭제
      let query = supabaseAdmin.from("processed_match_telemetry").delete({ count: "exact" }).eq("match_id", matchId);
      if (nickname) query = query.eq("player_id", nickname.toLowerCase().trim());
      
      const { count, error } = await query;

      if (error) throw error;
      
      // 2. [V12.6] 원본 데이터(Storage) 캐시 파일 삭제
      // 파일명 형식: telemetry/{matchId}.json
      const { error: storageError } = await supabaseAdmin.storage
        .from("telemetry")
        .remove([`${matchId}.json`]);

      return NextResponse.json({ 
        success: true,
        message: storageError
          ? `매치 ${matchId}의 분석 결과(${count || 0}개)는 삭제되었지만 원본 Storage 캐시 삭제에 실패했습니다. 다시 시도해 주세요.`
          : `매치 ${matchId}의 분석 결과(${count || 0}개) 및 원본 데이터 캐시가 삭제되었습니다.`,
        storageCleared: !storageError,
        ...(storageError ? { partial: true, retryable: true } : {})
      });
    }

    if (action === "reset_benchmarks") {
      // 벤치마크 테이블 전체 삭제
      const { count, error } = await supabaseAdmin
        .from("global_benchmarks")
        .delete({ count: "exact" })
        .neq("id", -1); // 전체 삭제를 위한 트릭 (bigint 타입 호환)

      if (error) throw error;
      return NextResponse.json({ 
        success: true, 
        message: `벤치마크 데이터 ${count || 0}개가 성공적으로 초기화되었습니다.` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("Admin action error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
