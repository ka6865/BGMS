"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

// 전적 화면과 같은 /stats/<플랫폼>/<닉네임> 주소로 바로 이동한다.
export default function HomeStatsSearch() {
  const router = useRouter();
  const [platform, setPlatform] = useState<"steam" | "kakao">("steam");
  const [name, setName] = useState("");

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    const nickname = name.trim();
    if (nickname) router.push(`/stats/${platform}/${encodeURIComponent(nickname)}`);
  }

  return (
    <form role="search" aria-label="배틀그라운드 전적 검색" onSubmit={submit} className="flex gap-2">
      <label htmlFor="home-stats-platform" className="sr-only">플랫폼</label>
      <select
        id="home-stats-platform" value={platform} onChange={(event) => setPlatform(event.target.value === "kakao" ? "kakao" : "steam")}
        className="min-h-11 shrink-0 rounded-lg border border-white/10 bg-[var(--color-bg-elevated)] px-2 text-sm font-semibold text-white"
      >
        <option value="steam">스팀</option>
        <option value="kakao">카카오</option>
      </select>
      <label htmlFor="home-stats-name" className="sr-only">닉네임</label>
      <input
        id="home-stats-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="닉네임 검색" maxLength={40}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-[var(--color-bg-elevated)] px-3 text-base text-white placeholder:text-white/40"
      />
      <button type="submit" className="min-h-11 shrink-0 rounded-lg bg-[#F2A900] px-4 text-sm font-bold text-black transition hover:brightness-110">
        검색
      </button>
    </form>
  );
}
