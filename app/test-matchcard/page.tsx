"use client";

import React from "react";
import { MatchCard } from "@/components/stat/MatchCard";

export default function TestMatchCardPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-white p-4 md:p-8 font-sans selection:bg-emerald-500/30 selection:text-emerald-400">
      <div className="max-w-4xl mx-auto mb-8">
        <header className="flex flex-col gap-2 border-b border-white/10 pb-6">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span className="text-xs font-black uppercase tracking-widest text-emerald-400">UI Validation Sandbox</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight bg-gradient-to-r from-white via-neutral-200 to-neutral-500 bg-clip-text text-transparent">
            무기 교전 분석 및 아군 기여도 실증 테스트
          </h1>
          <p className="text-sm text-neutral-400 leading-relaxed max-w-2xl">
            로컬 DB 장애 상황을 우회하여, 실측 텔레메트리 기반 가공 데이터(<code className="text-emerald-400 font-mono text-xs">mock_gold_match_data.json</code>)를 매치카드 UI에 직접 주입하여 고정밀 무기 교전 통계(Weapon Mastery & Squad Armory)를 시연합니다.
          </p>
        </header>

        <main className="mt-8">
          <div className="bg-neutral-900/50 border border-white/5 rounded-[2.5rem] p-6 md:p-8 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <MatchCard
              matchId="match-gold-simulation-1234"
              nickname="forever_zhiqiu"
              platform="steam"
              isMobile={false}
              index={0}
            />
          </div>
        </main>

        <footer className="mt-8 text-center text-xs text-neutral-500 font-medium">
          BGMS Project Lead Senior AI Engineer • Premium Tactical Dashboard Validation
        </footer>
      </div>
    </div>
  );
}
