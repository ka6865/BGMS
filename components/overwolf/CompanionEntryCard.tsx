"use client";

/**
 * 전적 검색 초기 화면에 두는 Overwolf Companion 진입점.
 *
 * 앱 사용자는 데스크탑 창의 "내 세션 기록 열기" 로 세션 화면에 들어오지만,
 * 웹에서 먼저 온 사용자는 그 화면과 앱의 존재를 알 방법이 없었다.
 */

import React from "react";
import Link from "next/link";
import { ArrowRight, Crosshair, Map as MapIcon, Timer } from "lucide-react";

const POINTS = [
  {
    icon: Timer,
    title: "교전 시점 기록",
    body: "기절, 처치, 사망이 매치 몇 분에 있었는지 남습니다.",
  },
  {
    icon: MapIcon,
    title: "그 순간 맵 리플레이",
    body: "시점을 누르면 리플레이가 그 지점에서 열립니다.",
  },
  {
    icon: Crosshair,
    title: "게임이 안 보여주는 값",
    body: "매치 중 헤드샷 수와 최장 킬 거리를 오버레이로 봅니다.",
  },
] as const;

export default function CompanionEntryCard() {
  return (
    <section
      aria-labelledby="companion-entry-title"
      className="mx-auto mt-8 max-w-3xl rounded-lg border border-white/10 bg-[#161616] p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#F2A900]">
            Overwolf 앱
          </p>
          <h2 id="companion-entry-title" className="mt-1 text-base font-black text-white">
            BGMS Companion
          </h2>
        </div>

        <Link
          href="/overwolf/sessions"
          className="flex items-center gap-1.5 rounded border border-[#F2A900]/40 bg-[#F2A900]/10 px-3 py-2 text-xs font-bold text-[#F2A900] transition-colors hover:bg-[#F2A900]/20"
        >
          내 세션 기록 보기
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex flex-col gap-1">
            <dt className="flex items-center gap-1.5 text-xs font-bold text-white">
              <Icon className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />
              {title}
            </dt>
            <dd className="text-xs leading-relaxed text-white/50">{body}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-white/35">
        전송은 앱에서 직접 켜야 하며 기본값은 꺼짐입니다. 위치나 데미지 수치는 보내지 않습니다.
      </p>
    </section>
  );
}
