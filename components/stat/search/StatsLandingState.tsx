"use client";

import { BarChart3, BrainCircuit, Swords } from "lucide-react";
import Link from "next/link";

export interface StatsLandingStateProps {
  onCompare(): void;
  authenticated: boolean;
  profileLoaded: boolean;
  hasRegisteredNickname: boolean;
}

const FEATURES = [
  { label: "전적 요약", description: "랭크와 핵심 지표를 한눈에 확인", icon: BarChart3 },
  { label: "AI 분석", description: "최근 경기의 전술 흐름과 개선점", icon: BrainCircuit },
  { label: "스쿼드 시너지", description: "팀 조합과 협동 지표 분석", icon: Swords },
] as const;

export function StatsLandingState({
  onCompare,
  authenticated,
  profileLoaded,
  hasRegisteredNickname,
}: StatsLandingStateProps) {
  return (
    <section className="mx-auto max-w-3xl rounded-2xl border border-white/5 bg-white/[0.02] p-5 md:p-7">
      <div className="mb-5 text-center">
        <h2 className="text-xl font-black text-white">내 PUBG 전적을 빠르게 확인하세요</h2>
        <p className="mt-2 text-sm text-gray-500">닉네임 검색으로 전적 요약부터 AI 스쿼드 분석까지 이어집니다.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {FEATURES.map((feature) => (
          <div key={feature.label} data-testid="stats-landing-feature" className="rounded-xl border border-white/5 bg-black/20 p-4">
            <feature.icon size={18} className="mb-3 text-amber-500" />
            <h3 className="text-sm font-black text-white">{feature.label}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-500">{feature.description}</p>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onCompare}
        className="mx-auto mt-5 flex min-h-11 items-center gap-2 rounded-lg border border-purple-500/30 bg-purple-600/20 px-4 py-2 text-sm font-black text-purple-300"
      >
        <Swords size={17} />
        1:1 전적 비교
      </button>
      {!authenticated && (
        <div className="mt-5 flex items-center justify-center gap-3 border-t border-white/5 pt-5 text-xs text-gray-500">
          <span>닉네임을 저장하고 빠르게 내 전적 보기</span>
          <Link href="/login" className="font-black text-amber-500 hover:text-amber-400">
            로그인
          </Link>
        </div>
      )}
      {authenticated && profileLoaded && !hasRegisteredNickname && (
        <div className="mt-5 flex items-center justify-center gap-3 border-t border-white/5 pt-5 text-xs text-gray-500">
          <span>내 PUBG 계정을 검색창에 자동으로 불러오세요.</span>
          <Link href="/mypage" className="font-black text-amber-500 hover:text-amber-400">
            PUBG 닉네임 등록
          </Link>
        </div>
      )}
    </section>
  );
}
