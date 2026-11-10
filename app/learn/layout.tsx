import type { Metadata } from "next";
import AdSenseBanner from "@/components/ads/AdSenseBanner";
import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function LearnLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1600px] xl:grid xl:grid-cols-[160px_minmax(0,1fr)_160px] xl:gap-5 xl:px-4">
      <div className="min-w-0 xl:col-start-2 xl:row-start-1">
        <p className="mx-auto mt-4 flex max-w-6xl items-start gap-2 px-4 text-xs leading-5 text-zinc-400 sm:px-8">
          <span className="shrink-0 rounded border border-amber-500/40 px-1.5 font-black text-amber-400">BETA</span>
          <span>경기 해설은 시범 운영 중입니다. 기록 해석과 화면 구성이 바뀔 수 있습니다.</span>
        </p>
        {children}
      </div>
      {/* 좌측 레일은 고정하지 않고 문서 흐름에 배치한다. 좌우 동시 고정 광고는 정책 위반이다. */}
      <aside className="hidden self-start pt-8 [@media(min-width:1280px)_and_(min-height:680px)]:block xl:col-start-1 xl:row-start-1" aria-label="광고">
        <div className="h-[600px] w-[160px]">
          <AdSenseBanner slot={ADSENSE_SLOTS.learnRailLeft} />
        </div>
      </aside>
      <aside className="hidden pt-8 [@media(min-width:1280px)_and_(min-height:680px)]:block xl:col-start-3 xl:row-start-1" aria-label="광고">
        <div className="sticky top-20 h-[600px] w-[160px]">
          <AdSenseBanner slot={ADSENSE_SLOTS.learnRailRight} />
        </div>
      </aside>
    </div>
  );
}
