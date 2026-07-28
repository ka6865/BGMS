"use client";

import { useState, useEffect, Suspense, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Camera, Copy, Download, Share2, Star, Clock, User, X } from "lucide-react";
import { STORAGE_KEY_RECENT, STORAGE_KEY_FAVORITES } from "../../../lib/pubg-analysis/constants";
import { trackEvent } from "@/lib/analytics";
import AdfitBanner from "@/components/ads/AdfitBanner";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

interface Comparison {
  key: string;
  label: string;
  icon: string;
  unit: string;
  v1: number;
  v2: number;
  winner: "nick1" | "nick2" | "draw";
}

interface BattleResult {
  nick1: string;
  nick2: string;
  platform1: string;
  platform2: string;
  tier1: string;
  tier2: string;
  matchCount1: number;
  matchCount2: number;
  availableMatchCount1: number;
  availableMatchCount2: number;
  comparisonMatchCount: number;
  comparisons: Comparison[];
  score: { nick1: number; nick2: number; draw: number };
  overallWinner: string;
}

type PlayerSuggestion = { nickname: string; platform: string };

const BATTLE_MOBILE_AD_UNIT = "DAN-tQGcqmddMC8tPpXA";
const BATTLE_DESKTOP_AD_UNIT = "DAN-RjyosR2uf8eSsVIC";

const normalizeBattlePlatform = (platform?: string | null) => {
  const value = String(platform || "").trim().toLowerCase();
  return value === "steam" || value === "kakao" ? value : "";
};

const getTierStyle = (t: string) => {
  const tier = t.toUpperCase();
  if (tier.startsWith('S')) return "bg-amber-500/20 border-amber-500/50 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.3)] font-black";
  if (tier.startsWith('A')) return "bg-indigo-500/20 border-indigo-500/50 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.15)]";
  if (tier.startsWith('B')) return "bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.15)]";
  if (tier.startsWith('C')) return "bg-blue-500/20 border-blue-500/50 text-blue-400";
  if (tier.startsWith('D')) return "bg-slate-500/20 border-slate-500/50 text-slate-400";
  return "bg-white/5 border-white/10 text-gray-400";
};

function BattleContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resultCardRef = useRef<HTMLDivElement | null>(null);
  const lastAutoBattleKeyRef = useRef<string>("");
  
  // URL 파라미터로 초기 상태 설정 (린트 에러 방지: useEffect 내 동기 setState 제거)
  const [nick1, setNick1] = useState(() => searchParams.get("nick1") || "");
  const [nick2, setNick2] = useState(() => searchParams.get("nick2") || "");
  const [platform1, setPlatform1] = useState(() => normalizeBattlePlatform(searchParams.get("platform1")));
  const [platform2, setPlatform2] = useState(() => normalizeBattlePlatform(searchParams.get("platform2")));
  const [matchType, setMatchType] = useState<"all" | "official" | "competitive">(() => (searchParams.get("matchType") as any) || "all");
  
  const [result, setResult] = useState<BattleResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState<"share" | "copy" | "download" | "image" | null>(null);

  // 로컬 스토리지 데이터 상태
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [showDropdown1, setShowDropdown1] = useState(false);
  const [showDropdown2, setShowDropdown2] = useState(false);

  // [V54.7] 자동완성 상태 추가
  const [suggestions1, setSuggestions1] = useState<PlayerSuggestion[]>([]);
  const [suggestions2, setSuggestions2] = useState<PlayerSuggestion[]>([]);
  const [isSuggesting1, setIsSuggesting1] = useState(false);
  const [isSuggesting2, setIsSuggesting2] = useState(false);

  // 초기 데이터 로드
  useEffect(() => {
    const savedRecent = localStorage.getItem(STORAGE_KEY_RECENT);
    const savedFavorites = localStorage.getItem(STORAGE_KEY_FAVORITES);
    try {
      if (savedRecent) setRecentSearches(JSON.parse(savedRecent));
    } catch {
      localStorage.removeItem(STORAGE_KEY_RECENT);
    }
    try {
      if (savedFavorites) setFavorites(JSON.parse(savedFavorites));
    } catch {
      localStorage.removeItem(STORAGE_KEY_FAVORITES);
    }
  }, []);
  
  // 즐겨찾기 데이터 저장
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favorites));
  }, [favorites]);

  const toggleFavorite = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [name, ...prev]
    );
  };

  const removeRecentSearch = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRecentSearches((prev) => {
      const updated = prev.filter((n) => n !== name);
      localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(updated));
      return updated;
    });
  };

  // 검색 기록 업데이트 함수
  const updateRecentSearches = useCallback((nick: string) => {
    if (!nick.trim()) return;
    setRecentSearches(prev => {
      const filtered = prev.filter(n => n !== nick);
      const next = [nick, ...filtered].slice(0, 10);
      localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(next));
      return next;
    });
  }, []);

  const buildShareUrl = (
    player1: string,
    player2: string,
    mode: string,
    playerPlatform1?: string,
    playerPlatform2?: string,
    score?: { nick1: number; nick2: number },
    winner?: string
  ) => {
    if (typeof window === "undefined") return "";
    const url = new URL("/stats/battle", window.location.origin);
    url.searchParams.set("nick1", player1);
    url.searchParams.set("nick2", player2);
    url.searchParams.set("matchType", mode);
    if (playerPlatform1) url.searchParams.set("platform1", playerPlatform1);
    if (playerPlatform2) url.searchParams.set("platform2", playerPlatform2);
    if (score !== undefined) {
      url.searchParams.set("score1", String(score.nick1));
      url.searchParams.set("score2", String(score.nick2));
    }
    if (winner) url.searchParams.set("winner", winner);

    //  [추가] GA4 UTM 파라미터 강제 주입 (바이럴 유입 추적)
    url.searchParams.set("utm_source", "user_share");
    url.searchParams.set("utm_medium", "social");
    url.searchParams.set("utm_campaign", "battle_share");

    return url.toString();
  };

  const clearShareMessageLater = () => {
    window.setTimeout(() => setShareMessage(null), 2500);
  };

  const buildBattlePath = (
    player1: string,
    player2: string,
    mode: string,
    playerPlatform1?: string,
    playerPlatform2?: string
  ) => {
    const params = new URLSearchParams({
      nick1: player1,
      nick2: player2,
      matchType: mode
    });
    if (playerPlatform1) params.set("platform1", playerPlatform1);
    if (playerPlatform2) params.set("platform2", playerPlatform2);
    return `/stats/battle?${params.toString()}`;
  };

  const runBattle = useCallback(async (
    player1: string,
    player2: string,
    mode: string,
    playerPlatform1?: string,
    playerPlatform2?: string
  ) => {
    const n1 = player1.trim();
    const n2 = player2.trim();
    const p1 = normalizeBattlePlatform(playerPlatform1);
    const p2 = normalizeBattlePlatform(playerPlatform2);
    if (!n1 || !n2) return;
    
    setLoading(true);
    setError(null);
    setResult(null);
    setShareMessage(null);

    //  [추가] [Analytics] 대결 시작
    trackEvent({
      name: "battle_started",
      params: {
        nick1: n1,
        nick2: n2,
        platform1: p1 || "unresolved",
        platform2: p2 || "unresolved",
        match_type: mode
      }
    });

    try {
      const params = new URLSearchParams({
        nick1: n1,
        nick2: n2,
        matchType: mode
      });
      if (p1) params.set("platform1", p1);
      if (p2) params.set("platform2", p2);

      const res = await fetch(`/api/pubg/battle?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "알 수 없는 오류");
      setResult(data);
      const resolvedPlatform1 = normalizeBattlePlatform(data.platform1);
      const resolvedPlatform2 = normalizeBattlePlatform(data.platform2);

      // [Analytics] 대결 완료
      trackEvent({
        name: "battle_completed",
        params: {
          nick1: data.nick1,
          nick2: data.nick2,
          platform1: resolvedPlatform1,
          platform2: resolvedPlatform2,
          match_type: mode,
          winner: data.overallWinner === "draw" ? "draw" : data.overallWinner,
          score1: data.score.nick1,
          score2: data.score.nick2,
        },
      });

      // [V54.7] 정확한 대소문자 닉네임으로 UI 동기화
      if (data.nick1 && data.nick1 !== n1) setNick1(data.nick1);
      if (data.nick2 && data.nick2 !== n2) setNick2(data.nick2);
      if (resolvedPlatform1) setPlatform1(resolvedPlatform1);
      if (resolvedPlatform2) setPlatform2(resolvedPlatform2);

      updateRecentSearches(data.nick1 || n1);
      updateRecentSearches(data.nick2 || n2);

      const finalNick1 = data.nick1 || n1;
      const finalNick2 = data.nick2 || n2;
      lastAutoBattleKeyRef.current = `${finalNick1}::${finalNick2}::${resolvedPlatform1 || p1}::${resolvedPlatform2 || p2}::${mode}`;

      // [V54.7] URL 업데이트 (새로고침/공유 대응)
      const newPath = buildBattlePath(finalNick1, finalNick2, mode, resolvedPlatform1 || p1, resolvedPlatform2 || p2);
      router.replace(newPath, { scroll: false });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [updateRecentSearches, router]);

  const handleBattle = useCallback(() => {
    void runBattle(nick1, nick2, matchType, platform1, platform2);
  }, [nick1, nick2, platform1, platform2, matchType, runBattle]);

  // 자동 검색 로직 (초기 로드 및 뒤로가기 대응)
  useEffect(() => {
    const n1 = searchParams.get("nick1");
    const n2 = searchParams.get("nick2");
    const p1 = normalizeBattlePlatform(searchParams.get("platform1"));
    const p2 = normalizeBattlePlatform(searchParams.get("platform2"));
    const m = searchParams.get("matchType") || "all";
    
    if (n1 && n2) {
      // 현재 상태와 URL이 다를 때만 상태 업데이트
      if (n1 !== nick1) setNick1(n1);
      if (n2 !== nick2) setNick2(n2);
      if (p1 !== platform1) setPlatform1(p1);
      if (p2 !== platform2) setPlatform2(p2);
      if (m !== matchType) setMatchType(m as any);

      const battleKey = `${n1}::${n2}::${p1}::${p2}::${m}`;
      if (lastAutoBattleKeyRef.current === battleKey) return;
      
      lastAutoBattleKeyRef.current = battleKey;
      void runBattle(n1, n2, m, p1, p2);
    }
  }, [searchParams, runBattle, nick1, nick2, platform1, platform2, matchType]);

  // 필터(matchType) 변경 시 즉시 대결 트리거
  const handleFilterChange = (newMode: string) => {
    if (newMode === matchType) return;
    setMatchType(newMode as any);
    
    // 닉네임이 입력되어 있다면 즉시 대결 시작
    const n1 = nick1.trim();
    const n2 = nick2.trim();
    
    if (n1 && n2) {
      // URL 업데이트
      const newPath = buildBattlePath(n1, n2, newMode, platform1, platform2);
      router.replace(newPath, { scroll: false });
      
      // API 호출 (상태 업데이트 기다리지 않고 새 모드 주입)
      void runBattle(n1, n2, newMode, platform1, platform2);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBattle();
      setShowDropdown1(false);
      setShowDropdown2(false);
    }
  };

  const createShareImageBlob = async () => {
    if (!resultCardRef.current) throw new Error("공유할 결과 카드가 없습니다.");
    const { toPng } = await import("html-to-image");
    const dataUrl = await toPng(resultCardRef.current, {
      cacheBust: true,
      pixelRatio: 2,
      backgroundColor: "#080810",
    });
    const response = await fetch(dataUrl);
    return response.blob();
  };

  const handleCopyLink = async () => {
    if (!result) return;
    try {
      setShareBusy("copy");
      await navigator.clipboard.writeText(
        buildShareUrl(result.nick1, result.nick2, matchType, result.platform1, result.platform2, result.score, result.overallWinner)
      );
      // [Analytics]
      trackEvent({ name: "share_clicked", params: { method: "link_copy", page: "battle" } });
      setShareMessage("공유 링크를 복사했어요.");
      clearShareMessageLater();
    } catch {
      setShareMessage("링크 복사에 실패했습니다.");
    } finally {
      setShareBusy(null);
    }
  };

  const handleShareLink = async () => {
    if (!result) return;
    const shareUrl = buildShareUrl(
      result.nick1,
      result.nick2,
      matchType,
      result.platform1,
      result.platform2,
      result.score,
      result.overallWinner
    );

    try {
      setShareBusy("share");
      if (navigator.share) {
        await navigator.share({
          title: `${result.nick1} vs ${result.nick2} 전적 비교 | BGMS`,
          url: shareUrl,
        });
        // [Analytics]
        trackEvent({ name: "share_clicked", params: { method: "link_share", page: "battle" } });
        setShareMessage("공유 시트를 열었어요.");
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setShareMessage("공유 기능이 없어 링크를 대신 복사했어요.");
      }
      clearShareMessageLater();
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        setShareMessage("링크 공유에 실패했습니다.");
      }
    } finally {
      setShareBusy(null);
    }
  };

  const handleDownloadImage = async () => {
    if (!result) return;

    try {
      setShareBusy("download");
      const blob = await createShareImageBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bgms-battle-${result.nick1}-vs-${result.nick2}.png`;
      link.click();
      URL.revokeObjectURL(url);
      // [Analytics]
      trackEvent({ name: "share_clicked", params: { method: "image_download", page: "battle" } });
      setShareMessage("비교 이미지를 저장했어요.");
      clearShareMessageLater();
    } catch {
      setShareMessage("이미지 저장에 실패했습니다.");
    } finally {
      setShareBusy(null);
    }
  };

  const handleShareImage = async () => {
    if (!result) return;

    try {
      setShareBusy("image");
      const blob = await createShareImageBlob();
      const file = new File([blob], `bgms-battle-${result.nick1}-vs-${result.nick2}.png`, { type: "image/png" });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: "BGMS 전적 비교",
          text: `${result.nick1} vs ${result.nick2} 전적 비교 결과`,
          files: [file],
        });
        // [Analytics]
        trackEvent({ name: "share_clicked", params: { method: "image_share", page: "battle" } });
        setShareMessage("이미지 공유 시트를 열었어요.");
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        URL.revokeObjectURL(url);
        setShareMessage("이미지 공유가 지원되지 않아 파일로 저장했어요.");
      }
      clearShareMessageLater();
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        setShareMessage("이미지 공유에 실패했습니다.");
      }
    } finally {
      setShareBusy(null);
    }
  };

  const setNicknameValue = (idx: 1 | 2, val: string, selectedPlatform?: string) => {
    const nextPlatform = normalizeBattlePlatform(selectedPlatform);
    if (idx === 1) {
      setNick1(val);
      setPlatform1(nextPlatform);
    } else {
      setNick2(val);
      setPlatform2(nextPlatform);
    }
  };

  const getDropdownItems = () => {
    const items: { name: string; type: "favorite" | "recent" }[] = [];
    favorites.forEach(name => items.push({ name, type: "favorite" }));
    recentSearches
      .filter(name => !favorites.includes(name))
      .forEach(name => items.push({ name, type: "recent" }));
    return items;
  };

  // 드롭다운 외부 클릭 감지용 Ref
  const dropdownRef1 = useRef<HTMLDivElement>(null);
  const dropdownRef2 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef1.current && !dropdownRef1.current.contains(event.target as Node)) {
        setShowDropdown1(false);
      }
      if (dropdownRef2.current && !dropdownRef2.current.contains(event.target as Node)) {
        setShowDropdown2(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // [V54.7] 자동완성 Fetch (Debounced) - Nick1
  useEffect(() => {
    if (!nick1 || nick1.length < 2) {
      setSuggestions1([]);
      return;
    }
    const controller = new AbortController();
    const query = nick1;
    const timer = setTimeout(async () => {
      setIsSuggesting1(true);
      try {
        const res = await fetch(`/api/pubg/suggest?q=${encodeURIComponent(query)}`, {
          signal: controller.signal
        });
        const data = await res.json();
        setSuggestions1(data.suggestions || []);
      } catch (error: any) {
        if (error.name === "AbortError") return;
        setSuggestions1([]);
      } finally {
        if (controller.signal.aborted) return;
        setIsSuggesting1(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [nick1]);

  // [V54.7] 자동완성 Fetch (Debounced) - Nick2
  useEffect(() => {
    if (!nick2 || nick2.length < 2) {
      setSuggestions2([]);
      return;
    }
    const controller = new AbortController();
    const query = nick2;
    const timer = setTimeout(async () => {
      setIsSuggesting2(true);
      try {
        const res = await fetch(`/api/pubg/suggest?q=${encodeURIComponent(query)}`, {
          signal: controller.signal
        });
        const data = await res.json();
        setSuggestions2(data.suggestions || []);
      } catch (error: any) {
        if (error.name === "AbortError") return;
        setSuggestions2([]);
      } finally {
        if (controller.signal.aborted) return;
        setIsSuggesting2(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [nick2]);

  return (
    <main className="min-h-screen bg-[#080810] text-white px-4 py-12">
      <div className="relative max-w-2xl mx-auto flex flex-col gap-8">

        {/* 헤더 */}
        <div className="text-center">
          <Link href="/stats" className="text-xs text-gray-600 hover:text-gray-400 transition-colors mb-4 inline-block">
            ← 전적 검색으로 돌아가기
          </Link>
          <BgmsIcon name="battle" size={52} className="mx-auto mb-4 text-indigo-300" />
          <h1 className="text-3xl font-black tracking-tight mb-2">전적 비교 배틀</h1>
          <p className="text-gray-500 text-sm">두 플레이어의 BGMS 분석 데이터를 항목별로 대결시킵니다</p>
          <div className="mt-2 flex flex-col gap-0.5">
            <p className="text-gray-600 text-[10px]">※ 최근 최대 20경기 중 더 적은 플레이어의 경기 수에 맞춰 비교합니다</p>
            <p className="text-gray-600 text-[10px]">※ 벤치마커 수집 조건: 5분 이상 생존한 경기만 포함됩니다</p>
          </div>
        </div>

        {/* 입력폼 */}
        <div className="p-6 bg-white/5 border border-white/10 rounded-3xl flex flex-col gap-4 relative z-40">
          <div className="flex flex-col md:flex-row items-center gap-4">
            {/* 플레이어 1 입력 */}
            <div className="w-full md:flex-1 relative" ref={dropdownRef1}>
              <input
                value={nick1}
                onChange={(e) => setNicknameValue(1, e.target.value)}
                onFocus={() => { setShowDropdown1(true); setShowDropdown2(false); }}
                onKeyDown={handleKeyDown}
                placeholder="내 닉네임"
                className="w-full p-4 bg-black/40 border border-indigo-500/30 rounded-2xl text-white placeholder:text-gray-600 font-bold focus:outline-none focus:border-indigo-500/70 transition-colors"
              />
              {showDropdown1 && (recentSearches.length > 0 || favorites.length > 0 || suggestions1.length > 0) && (
                <NicknameDropdown 
                  nickname={nick1}
                  suggestions={suggestions1}
                  isSuggesting={isSuggesting1}
                  recentSearches={recentSearches}
                  favorites={favorites}
                  items={getDropdownItems()} 
                  onSelect={(val, selectedPlatform) => { setNicknameValue(1, val, selectedPlatform); setShowDropdown1(false); }} 
                  onToggleFavorite={toggleFavorite}
                  onRemoveRecent={removeRecentSearch}
                  onClose={() => setShowDropdown1(false)}
                />
              )}
            </div>

            <div className="text-xl font-black text-gray-600 shrink-0 md:rotate-0">VS</div>

            {/* 플레이어 2 입력 */}
            <div className="w-full md:flex-1 relative" ref={dropdownRef2}>
              <input
                value={nick2}
                onChange={(e) => setNicknameValue(2, e.target.value)}
                onFocus={() => { setShowDropdown2(true); setShowDropdown1(false); }}
                onKeyDown={handleKeyDown}
                placeholder="상대 닉네임"
                className="w-full p-4 bg-black/40 border border-rose-500/30 rounded-2xl text-white placeholder:text-gray-600 font-bold focus:outline-none focus:border-rose-500/70 transition-colors"
              />
              {showDropdown2 && (recentSearches.length > 0 || favorites.length > 0 || suggestions2.length > 0) && (
                <NicknameDropdown 
                  nickname={nick2}
                  suggestions={suggestions2}
                  isSuggesting={isSuggesting2}
                  recentSearches={recentSearches}
                  favorites={favorites}
                  items={getDropdownItems()} 
                  onSelect={(val, selectedPlatform) => { setNicknameValue(2, val, selectedPlatform); setShowDropdown2(false); }} 
                  onToggleFavorite={toggleFavorite}
                  onRemoveRecent={removeRecentSearch}
                  onClose={() => setShowDropdown2(false)}
                />
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-2 md:gap-4 text-[10px] font-bold uppercase tracking-wide text-gray-500">
            <div className="text-center md:text-left">
              플랫폼: {platform1 ? platform1.toUpperCase() : "자동 확인"}
            </div>
            <div className="hidden md:block w-6" />
            <div className="text-center md:text-right">
              플랫폼: {platform2 ? platform2.toUpperCase() : "자동 확인"}
            </div>
          </div>
          {/* 게임 모드 필터 */}
          <div className="flex bg-black/40 p-1 rounded-xl border border-white/5">
            {[
              { id: "all", label: "전체" },
              { id: "competitive", label: "랭크" },
              { id: "official", label: "일반" },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => handleFilterChange(m.id)}
                className={`flex-1 py-2 text-xs font-black rounded-lg transition-all ${
                  matchType === m.id
                    ? "bg-white/10 text-white shadow-lg"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => {
              handleBattle();
              setShowDropdown1(false);
              setShowDropdown2(false);
            }}
            disabled={loading || !nick1.trim() || !nick2.trim()}
            className="w-full py-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 rounded-2xl font-black text-lg tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
          >
            <InlineIconLabel
              icon={loading ? "loader" : "battle"}
              iconClassName={loading ? "animate-spin" : ""}
              className="justify-center"
              iconSize={20}
            >
              {loading ? "분석 중..." : "대결 시작!"}
            </InlineIconLabel>
          </button>
        </div>

        <div className="flex justify-center xl:hidden" aria-label="광고">
          <AdfitBanner
            adUnit={BATTLE_MOBILE_AD_UNIT}
            adWidth={320}
            adHeight={100}
            className="max-w-full"
          />
        </div>

        {/* 에러 */}
        {error && (
          <div className="p-5 bg-red-500/10 border border-red-500/30 rounded-2xl text-red-400 text-sm font-bold [overflow-wrap:anywhere] [word-break:break-word] whitespace-normal">
            <InlineIconLabel icon="error">{error}</InlineIconLabel>
          </div>
        )}

        {/* 결과 */}
        {result && (
          <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div
              ref={resultCardRef}
              className="flex flex-col gap-4 rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.14),_transparent_35%),radial-gradient(circle_at_bottom,_rgba(244,63,94,0.16),_transparent_32%),rgba(3,7,18,0.95)] p-2 shadow-[0_30px_120px_rgba(0,0,0,0.35)]"
            >
              {/* 총 스코어 */}
              <div className="p-6 bg-black/60 rounded-3xl border border-white/10 backdrop-blur-xl">
                <div className="flex items-center justify-between mb-6">
                  {/* 플레이어 1 */}
                  <div className="text-center flex-1 min-w-0 flex flex-col items-center">
                    <div className={`inline-block px-3 py-1 rounded-xl border text-[10px] md:text-xs font-black italic tracking-tighter mb-2 shrink-0 ${getTierStyle(result.tier1)}`}>
                      {result.tier1} Tier
                    </div>
                    <div className="mb-1 text-[9px] font-black uppercase tracking-wider text-indigo-200/50">{result.platform1}</div>
                    <div className="font-black text-base md:text-xl text-indigo-300 truncate w-full max-w-[80px] xs:max-w-[120px] md:max-w-none px-1" title={result.nick1}>
                      {result.nick1}
                    </div>
                    <div className="text-[9px] md:text-[10px] text-gray-600 font-medium shrink-0">{result.matchCount1}경기 비교</div>
                  </div>

                  {/* 스코어 */}
                  <div className="flex items-center gap-2 md:gap-4 px-2 md:px-4 shrink-0 mx-auto">
                    <div className="text-3xl md:text-5xl font-black text-indigo-400 drop-shadow-[0_0_15px_rgba(99,102,241,0.4)]">{result.score.nick1}</div>
                    <div className="text-sm md:text-lg text-gray-700 font-black">VS</div>
                    <div className="text-3xl md:text-5xl font-black text-rose-400 drop-shadow-[0_0_15px_rgba(244,63,94,0.4)]">{result.score.nick2}</div>
                  </div>

                  {/* 플레이어 2 */}
                  <div className="text-center flex-1 min-w-0 flex flex-col items-center">
                    <div className={`inline-block px-3 py-1 rounded-xl border text-[10px] md:text-xs font-black italic tracking-tighter mb-2 shrink-0 ${getTierStyle(result.tier2)}`}>
                      {result.tier2} Tier
                    </div>
                    <div className="mb-1 text-[9px] font-black uppercase tracking-wider text-rose-200/50">{result.platform2}</div>
                    <div className="font-black text-base md:text-xl text-rose-300 truncate w-full max-w-[80px] xs:max-w-[120px] md:max-w-none px-1" title={result.nick2}>
                      {result.nick2}
                    </div>
                    <div className="text-[9px] md:text-[10px] text-gray-600 font-medium shrink-0">{result.matchCount2}경기 비교</div>
                  </div>
                </div>

                {/* 최종 승자 배너 */}
                <div className={`p-4 rounded-2xl text-center font-black text-sm transition-all duration-700 animate-pulse-slow ${
                  result.overallWinner === result.nick1 ? "bg-indigo-500/25 border border-indigo-500/40 text-indigo-200 shadow-[0_0_20px_rgba(99,102,241,0.2)]" :
                  result.overallWinner === result.nick2 ? "bg-rose-500/25 border border-rose-500/40 text-rose-200 shadow-[0_0_20px_rgba(244,63,94,0.2)]" :
                  "bg-yellow-500/15 border border-yellow-500/30 text-yellow-300 shadow-[0_0_20px_rgba(234,179,8,0.1)]"
                }`}>
                  {result.overallWinner === "draw"
                    ? "무승부 - 두 플레이어의 실력이 비슷합니다"
                    : `${result.overallWinner} 승리! (${Math.max(result.score.nick1, result.score.nick2)}항목 우세)`}
                </div>
                {(result.availableMatchCount1 !== result.comparisonMatchCount || result.availableMatchCount2 !== result.comparisonMatchCount) && (
                  <div className="mt-3 text-center text-[10px] text-gray-600 font-bold">
                    보유 데이터: {result.nick1} {result.availableMatchCount1}경기 / {result.nick2} {result.availableMatchCount2}경기 → 최근 {result.comparisonMatchCount}경기 기준 비교
                  </div>
                )}
              </div>

              {/* 항목별 비교 */}
              <div className="flex flex-col gap-3 px-2 pb-2">
                {result.comparisons.map((c) => {
                  const n1Wins = c.winner === "nick1";
                  const n2Wins = c.winner === "nick2";
                  return (
                    <div
                      key={c.key}
                      className={`p-3 md:p-4 rounded-2xl border flex items-center gap-2 md:gap-4 transition-all ${
                        n1Wins ? "border-indigo-500/40 bg-indigo-500/10 shadow-[inset_0_0_12px_rgba(99,102,241,0.1)]" :
                        n2Wins ? "border-rose-500/40 bg-rose-500/10 shadow-[inset_0_0_12px_rgba(244,63,94,0.1)]" :
                                 "border-white/10 bg-white/5"
                      }`}
                    >
                      <div className={`flex-1 text-right font-black text-lg md:text-2xl tracking-tighter ${n1Wins ? "text-indigo-400" : "text-white/30"}`}>
                        {typeof c.v1 === "number" ? c.v1.toFixed(1) : c.v1}<span className="text-[10px] md:text-xs ml-0.5 opacity-60">{c.unit}</span>
                      </div>

                      <div className="w-20 md:w-32 text-center shrink-0">
                        <div className="text-[9px] md:text-[10px] text-gray-500 font-black uppercase tracking-widest mb-1">{c.label}</div>
                        <div className="flex items-center justify-center gap-1 md:gap-2 mt-1">
                          <div className={`w-1.5 h-1.5 md:w-2.5 md:h-2.5 rounded-full transition-all ${n1Wins ? "bg-indigo-400 shadow-[0_0_10px_rgba(99,102,241,1)] scale-110" : "bg-white/10"}`} />
                          <div className={`text-[10px] md:text-xs font-black transition-colors ${
                            n1Wins ? "text-indigo-400" :
                            n2Wins ? "text-rose-400" :
                            "text-gray-700"
                          }`}>
                            {n1Wins ? "◀" : n2Wins ? "▶" : "—"}
                          </div>
                          <div className={`w-1.5 h-1.5 md:w-2.5 md:h-2.5 rounded-full transition-all ${n2Wins ? "bg-rose-400 shadow-[0_0_10px_rgba(244,63,94,1)] scale-110" : "bg-white/10"}`} />
                        </div>
                      </div>

                      <div className={`flex-1 text-left font-black text-lg md:text-2xl tracking-tighter ${n2Wins ? "text-rose-400" : "text-white/30"}`}>
                        {typeof c.v2 === "number" ? c.v2.toFixed(1) : c.v2}<span className="text-[10px] md:text-xs ml-0.5 opacity-60">{c.unit}</span>
                      </div>
                    </div>
                  );
                })}

                {result.score.draw > 0 && (
                  <div className="text-center text-xs text-gray-600">
                    {result.score.draw}개 항목은 차이가 적어 무승부 처리되었습니다
                  </div>
                )}

                <div className="px-2 pt-1 pb-2 text-center text-[11px] font-black tracking-[0.2em] text-white/35">
                  BGMS BATTLE SHARE CARD
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm font-black text-white">공유하기</div>
                  <div className="text-xs text-gray-500 mt-1">링크 공유, 링크 복사, 결과 이미지 저장까지 바로 할 수 있어요.</div>
                </div>
                {shareMessage && (
                  <div className="text-xs font-bold text-emerald-300">{shareMessage}</div>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                <button
                  onClick={handleShareLink}
                  disabled={shareBusy !== null}
                  className="h-12 rounded-2xl border border-sky-400/20 bg-sky-500/10 text-sky-200 font-black text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Share2 size={16} />
                  {shareBusy === "share" ? "공유 중..." : "링크 공유"}
                </button>
                <button
                  onClick={handleCopyLink}
                  disabled={shareBusy !== null}
                  className="h-12 rounded-2xl border border-white/10 bg-white/5 text-white font-black text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Copy size={16} />
                  {shareBusy === "copy" ? "복사 중..." : "링크 복사"}
                </button>
                <button
                  onClick={handleShareImage}
                  disabled={shareBusy !== null}
                  className="h-12 rounded-2xl border border-rose-400/20 bg-rose-500/10 text-rose-200 font-black text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Camera size={16} />
                  {shareBusy === "image" ? "생성 중..." : "이미지 공유"}
                </button>
                <button
                  onClick={handleDownloadImage}
                  disabled={shareBusy !== null}
                  className="h-12 rounded-2xl border border-amber-400/20 bg-amber-500/10 text-amber-200 font-black text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Download size={16} />
                  {shareBusy === "download" ? "저장 중..." : "이미지 저장"}
                </button>
              </div>
            </div>
          </div>
        )}

        <aside className="hidden xl:block absolute left-[calc(100%+24px)] top-0 w-[160px] h-full" aria-label="광고">
          <div className="sticky top-24">
            <AdfitBanner
              adUnit={BATTLE_DESKTOP_AD_UNIT}
              adWidth={160}
              adHeight={600}
            />
          </div>
        </aside>
      </div>
    </main>
  );
}

function NicknameDropdown({ 
  nickname,
  suggestions,
  isSuggesting,
  recentSearches,
  favorites,
  items, 
  onSelect, 
  onToggleFavorite,
  onRemoveRecent,
  onClose 
}: { 
  nickname: string;
  suggestions: PlayerSuggestion[];
  isSuggesting: boolean;
  recentSearches: string[];
  favorites: string[];
  items: { name: string; type: "favorite" | "recent" }[];
  onSelect: (val: string, platform?: string) => void;
  onToggleFavorite: (name: string, e: React.MouseEvent) => void;
  onRemoveRecent: (name: string, e: React.MouseEvent) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute top-full left-0 right-0 mt-2 bg-[#0a0a1a]/95 border border-white/10 rounded-2xl overflow-hidden shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl z-50 animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
        {/* 자동완성 결과 */}
        {nickname.length >= 2 && suggestions.length > 0 && (
          <div className="pb-2">
            <div className="px-4 py-2 text-[10px] font-black text-amber-500/50 uppercase tracking-widest border-b border-white/5 bg-white/2">추천 플레이어</div>
            {suggestions.map((s, i) => {
              const isRecent = recentSearches.includes(s.nickname);
              const isFav = favorites.includes(s.nickname);
              return (
                <div
                  key={`suggest-${s.nickname}-${i}`}
                  onClick={() => {
                    onSelect(s.nickname, s.platform);
                    onClose();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-amber-500/10 transition-colors text-left border-b border-white/5 last:border-0 group cursor-pointer"
                >
                  <div className="relative">
                    <User size={14} className={`${isRecent ? 'text-blue-400' : 'text-amber-500'} shrink-0`} />
                    {isRecent && <div className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full border border-[#0a0a1a]" />}
                  </div>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-200 group-hover:text-white truncate">{s.nickname}</span>
                      {isRecent && (
                        <span className="px-1 py-0.5 bg-blue-500/20 text-blue-400 text-[8px] font-black rounded uppercase tracking-tighter border border-blue-500/30">최근</span>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-500 uppercase">{s.platform}</span>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={(e) => onToggleFavorite(s.nickname, e)}
                      className={`p-1.5 rounded-lg transition-all ${isFav ? "text-yellow-400 bg-yellow-400/10" : "text-gray-600 hover:text-yellow-400 hover:bg-yellow-400/10"}`}
                    >
                      <Star size={14} fill={isFav ? "currentColor" : "none"} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 최근 검색 및 즐겨찾기 */}
        {(nickname.length < 2 || suggestions.length === 0) && (
          <>
            {nickname.length >= 2 && suggestions.length === 0 && !isSuggesting && (
              <div className="px-4 py-4 text-center text-xs text-gray-500 italic border-b border-white/5">검색 결과가 없습니다.</div>
            )}
            {items.map((item, i) => {
              const isFav = favorites.includes(item.name);
              return (
                <div
                  key={`${item.name}-${i}`}
                  onClick={() => {
                    onSelect(item.name);
                    onClose();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/5 transition-colors text-left border-b border-white/5 last:border-0 group cursor-pointer"
                >
                  {item.type === "favorite" ? (
                    <Star size={14} className="text-yellow-400 fill-yellow-400 shrink-0" />
                  ) : (
                    <Clock size={14} className="text-gray-500 shrink-0" />
                  )}
                  <span className="text-sm font-bold text-gray-300 group-hover:text-white truncate">{item.name}</span>
                  
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={(e) => onToggleFavorite(item.name, e)}
                      className={`p-1.5 rounded-lg transition-all ${isFav ? "text-yellow-400 bg-yellow-400/10" : "text-gray-600 hover:text-yellow-400 hover:bg-yellow-400/10"}`}
                    >
                      <Star size={14} fill={isFav ? "currentColor" : "none"} />
                    </button>
                    {item.type === "recent" && (
                      <button
                        onClick={(e) => onRemoveRecent(item.name, e)}
                        className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
                      >
                        <X size={14} />
                      </button>
                    ) || (
                      <User size={12} className="text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export default function BattlePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#080810] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    }>
      <BattleContent />
    </Suspense>
  );
}
