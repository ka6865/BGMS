import { Metadata } from "next";
import { Suspense } from "react";
import OverwolfSessionList from "@/components/overwolf/OverwolfSessionList";

export const metadata: Metadata = {
  title: "Companion 세션 기록 | BGMS",
  description:
    "BGMS Companion(Overwolf 앱)이 매치 종료 후 전달한 세션 요약을 확인하고 공식 API 기반 전적 분석으로 이동합니다.",
  // 앱에서 전달한 닉네임 쿼리가 붙는 개인 조회 화면이므로 색인하지 않는다.
  robots: {
    index: false,
    follow: false,
  },
};

export default function OverwolfSessionsPage() {
  return (
    <div className="flex w-full min-h-full justify-center bg-[#0d0d0d]">
      <div className="w-full max-w-[1200px]">
        <Suspense
          fallback={
            <div className="px-4 py-6 text-sm text-white/40 sm:px-6">세션 기록을 준비하고 있습니다.</div>
          }
        >
          <OverwolfSessionList />
        </Suspense>
      </div>
    </div>
  );
}
