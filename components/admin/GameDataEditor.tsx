"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import getApiUrl from "../../lib/api-config";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";
import { toast } from "sonner";
import { ItemCategory, GameItem, Vehicle, Weapon } from "@/types/game-data";
import ConfirmModal from "@/components/common/ConfirmModal";
import { resolveCrateAssetFields } from "@/lib/crates/assetMapping";

export default function GameDataEditor() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [activeCategory, setActiveCategory] = useState<ItemCategory>("weapons");
  const [items, setItems] = useState<any[]>([]);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [flushNickname, setFlushNickname] = useState("");
  const [flushMatchId, setFlushMatchId] = useState("");

  // 3단계 모달화 상태
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const [isSyncConfirmOpen, setIsSyncConfirmOpen] = useState(false);
  const [syncTargetUrl, setSyncTargetUrl] = useState<string | null>(null);

  const [isFlushCacheConfirmOpen, setIsFlushCacheConfirmOpen] = useState(false);
  const [isResetBenchmarkConfirmOpen, setIsResetBenchmarkConfirmOpen] = useState(false);

  const [isFlushUserConfirmOpen, setIsFlushUserConfirmOpen] = useState(false);
  const [flushUserTarget, setFlushUserTarget] = useState("");

  const [isFlushMatchConfirmOpen, setIsFlushMatchConfirmOpen] = useState(false);
  const [flushMatchTarget, setFlushMatchTarget] = useState("");

  const [dashboardData, setDashboardData] = useState<any>(null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showUserListOnMobile, setShowUserListOnMobile] = useState(false);

  // 전역 공지 설정 상태
  const [noticeActiveId, setNoticeActiveId] = useState("");
  const [noticeDisplayDays, setNoticeDisplayDays] = useState("7");
  const [isFetchingSettings, setIsFetchingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // 카테고리 변경 시 모바일 유저 목록 보기 상태 초기화
  useEffect(() => {
    setShowUserListOnMobile(false);
  }, [activeCategory]);

  // 모바일 해상도 감지
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const fetchDashboardData = useCallback(async () => {
    setIsLoadingDashboard(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch("/api/admin/dashboard", {
        headers: {
          "Authorization": `Bearer ${session?.access_token}`
        }
      });
      if (!response.ok) throw new Error("대시보드 데이터 로드 실패");
      const data = await response.json();
      setDashboardData(data);
    } catch (err: any) {
      console.error("[Dashboard Load Error]", err.message);
    } finally {
      setIsLoadingDashboard(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    setIsFetchingSettings(true);
    try {
      const response = await fetch("/api/admin/settings");
      if (!response.ok) throw new Error("시스템 설정 로드 실패");
      const data = await response.json();
      if (data.success && data.settings) {
        setNoticeActiveId(data.settings.notice_active_id || "");
        setNoticeDisplayDays(data.settings.notice_display_days || "7");
      }
    } catch (err: any) {
      console.error("[Settings Load Error]", err.message);
      toast.error("시스템 설정 로드 오류: " + err.message);
    } finally {
      setIsFetchingSettings(false);
    }
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);
    const toastId = toast.loading("시스템 설정 저장 중...");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch("/api/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({
          settings: {
            notice_active_id: noticeActiveId,
            notice_display_days: noticeDisplayDays
          }
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "시스템 설정 저장 실패");
      toast.success("시스템 설정이 저장되었습니다.", { id: toastId });
      fetchSettings();
    } catch (err: any) {
      toast.error("설정 저장 오류: " + err.message, { id: toastId });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const timeAgo = useCallback((dateStr: string | null) => {
    if (!dateStr) return "접속 기록 없음";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "방금 전";
    if (diffMins < 60) return `${diffMins}분 전`;
    if (diffHours < 24) return `${diffHours}시간 전`;
    return `${diffDays}일 전`;
  }, []);

  const formatBytes = useCallback((bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }, []);

  const formatPercent = useCallback((value: number | undefined | null) => {
    return `${Number(value || 0).toFixed(2)}%`;
  }, []);

  const usageStatusLabel = useCallback((status: string | undefined | null) => {
    if (status === "critical") return "위험";
    if (status === "warn") return "주의";
    if (status === "unavailable") return "확인 필요";
    return "안정";
  }, []);

  const usageStatusClass = useCallback((status: string | undefined | null) => {
    if (status === "critical") return "text-red-400 bg-red-500/10 border-red-500/30";
    if (status === "warn") return "text-amber-300 bg-amber-500/10 border-amber-500/30";
    if (status === "unavailable") return "text-gray-300 bg-gray-500/10 border-gray-500/30";
    return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  }, []);

  const userStats = useMemo(() => {
    if (activeCategory !== "users" || !items || items.length === 0) return null;
    
    const total = items.length;
    const missing = items.filter(u => u.is_missing_profile).length;
    const emailConfirmed = items.filter(u => u.email_confirmed).length;
    
    const providers: Record<string, number> = {};
    const platforms: Record<string, number> = {};
    
    items.forEach(u => {
      const prov = u.provider || "unknown";
      providers[prov] = (providers[prov] || 0) + 1;
      
      const plat = u.pubg_platform || "unlinked";
      platforms[plat] = (platforms[plat] || 0) + 1;
    });
    
    const recent = [...items]
      .filter(u => u.last_active_at || u.last_sign_in_at)
      .sort((a, b) => {
        const timeA = new Date(a.last_active_at || a.last_sign_in_at).getTime();
        const timeB = new Date(b.last_active_at || b.last_sign_in_at).getTime();
        return timeB - timeA;
      })
      .slice(0, 10);
      
    return {
      total,
      missing,
      emailConfirmed,
      providers,
      platforms,
      recent
    };
  }, [items, activeCategory]);

  const missingProfilesCount = useMemo(() => {
    if (activeCategory !== "users") return 0;
    return items.filter(item => (item as any).is_missing_profile).length;
  }, [items, activeCategory]);

  const handleSyncMissingProfiles = async () => {
    setIsSaving(true);
    const toastId = toast.loading("누락된 회원 프로필 동기화 중...");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({ action: "sync" })
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "동기화 실패");
      
      toast.success(`${result.count}명의 누락된 회원 프로필이 성공적으로 복구되었습니다!`, { id: toastId });
      fetchItems();
    } catch (err: any) {
      toast.error("동기화 오류: " + err.message, { id: toastId });
    } finally {
      setIsSaving(false);
    }
  };

  // 은신처 상점 전용 상태 선언
  const [selectedCrateDetail, setSelectedCrateDetail] = useState<{
    template: any;
    items: any[];
    prime_parcel_items: any[];
    bonus_items: any[];
  } | null>(null);
  const [crateEditorTab, setCrateEditorTab] = useState<"items" | "prime" | "bonus">("items");

  const getCrateUploadSource = (
    target: "template" | "items" | "prime" | "bonus",
    index?: number
  ) => {
    if (!selectedCrateDetail) return null;
    if (target === "template") return selectedCrateDetail.template;
    if (target === "items" && index !== undefined) return selectedCrateDetail.items[index];
    if (target === "prime" && index !== undefined) return selectedCrateDetail.prime_parcel_items[index];
    if (target === "bonus" && index !== undefined) return selectedCrateDetail.bonus_items[index];
    return null;
  };

  const withCrateAssetFields = (row: any, result?: any) => {
    const merged = {
      ...row,
      image_url: result?.url || row.image_url || "",
      asset_key: result?.asset_key || row.asset_key,
      r2_key: result?.r2_key || row.r2_key,
    };
    return {
      ...merged,
      ...resolveCrateAssetFields(merged),
    };
  };

  // R2 이미지 업로드 공통 핸들러
  const handleImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    target: "template" | "items" | "prime" | "bonus",
    index?: number
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const toastId = toast.loading("R2 이미지 전송 중...");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append("file", file);
      const uploadSource = getCrateUploadSource(target, index);
      const assetFields = resolveCrateAssetFields(uploadSource || { name: file.name });
      formData.append("displayName", uploadSource?.name || file.name);
      if (assetFields.asset_key) formData.append("assetKey", assetFields.asset_key);

      const response = await fetch("/api/admin/crates/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session?.access_token}`
        },
        body: formData
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "R2 업로드 실패");

      toast.success("R2 업로드 성공!", { id: toastId });

      if (target === "template") {
        if (selectedCrateDetail) {
          setSelectedCrateDetail({
            ...selectedCrateDetail,
            template: {
              ...selectedCrateDetail.template,
              ...withCrateAssetFields(selectedCrateDetail.template, result)
            }
          });
        }
      } else if (target === "items" && index !== undefined) {
        if (selectedCrateDetail) {
          const updatedItems = [...selectedCrateDetail.items];
          updatedItems[index] = withCrateAssetFields(updatedItems[index], result);
          setSelectedCrateDetail({ ...selectedCrateDetail, items: updatedItems });
        }
      } else if (target === "prime" && index !== undefined) {
        if (selectedCrateDetail) {
          const updatedPrime = [...selectedCrateDetail.prime_parcel_items];
          updatedPrime[index] = withCrateAssetFields(updatedPrime[index], result);
          setSelectedCrateDetail({ ...selectedCrateDetail, prime_parcel_items: updatedPrime });
        }
      } else if (target === "bonus" && index !== undefined) {
        if (selectedCrateDetail) {
          const updatedBonus = [...selectedCrateDetail.bonus_items];
          updatedBonus[index] = withCrateAssetFields(updatedBonus[index], result);
          setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updatedBonus });
        }
      }
    } catch (err: any) {
      toast.error("R2 업로드 오류: " + err.message, { id: toastId });
    }
  };

  // 은신처 상자 세부 정보 로드 핸들러
  const fetchCrateDetail = useCallback(async (crateId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/admin/crates/data?id=${crateId}`, {
        headers: {
          "Authorization": `Bearer ${session?.access_token}`
        }
      });
      if (!response.ok) throw new Error("상자 데이터를 가져올 수 없습니다.");
      const data = await response.json();
      setSelectedCrateDetail(data);
    } catch (err: any) {
      toast.error("상자 로딩 오류: " + err.message);
    }
  }, [setSelectedCrateDetail]);

  useEffect(() => {
    const checkAdmin = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("관리자 로그인이 필요합니다.");
        router.push("/login");
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();

      if (profile?.role !== "admin") {
        toast.warning("관리자 권한이 없습니다.");
        router.push("/");
        return;
      }
      setIsAuthorized(true);
      fetchDashboardData();
    };
    checkAdmin();
  }, [router, fetchDashboardData]);

  const fetchItems = useCallback(async () => {
    if (activeCategory === "system") {
      setItems([]);
      fetchDashboardData();
      fetchSettings();
      return;
    }

    if (activeCategory === "users") {
      fetchDashboardData();
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const response = await fetch("/api/admin/users", {
          headers: {
            "Authorization": `Bearer ${session?.access_token}`
          }
        });
        if (!response.ok) throw new Error("유저 목록 로드 실패");
        const data = await response.json();
        setItems(data || []);
        setSelectedCrateDetail(null);
        setSelectedItem(null);
      } catch (err: any) {
        toast.error(err.message);
      }
      return;
    }

    if (activeCategory === "crates") {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const response = await fetch("/api/admin/crates/data", {
          headers: {
            "Authorization": `Bearer ${session?.access_token}`
          }
        });
        if (!response.ok) throw new Error("은신처 상점 목록 로드 실패");
        const data = await response.json();
        setItems(data || []);
        setSelectedCrateDetail(null);
        setSelectedItem(null);
      } catch (err: any) {
        toast.error(err.message);
      }
      return;
    }

    const { data, error } = await supabase
      .from(activeCategory)
      .select("*")
      .order("name", { ascending: true });

    if (error) {
      console.error("Fetch error:", error);
    } else {
      setItems((data as GameItem[]) || []);
      setSelectedItem(null);
      setSelectedCrateDetail(null);
    }
  }, [activeCategory, fetchDashboardData, fetchSettings, setItems, setSelectedCrateDetail, setSelectedItem]);

  useEffect(() => {
    if (isAuthorized) {
      fetchItems();
    }
  }, [isAuthorized, activeCategory, fetchItems]);

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const matchText = activeCategory === "users"
        ? ((item as any).nickname || "")
        : ((item as any).name || "");
      const matchId = item.id || "";
      return matchText.toLowerCase().includes(searchTerm.toLowerCase()) ||
             matchId.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [items, searchTerm, activeCategory]);

  // 모바일/데스크탑 레이아웃 노출 플래그 연산
  const shouldShowAside = useMemo(() => {
    if (activeCategory === "system") return false;
    if (!isMobile) return true;
    if (activeCategory === "users") {
      return showUserListOnMobile && !selectedItem;
    }
    return !selectedItem;
  }, [activeCategory, isMobile, showUserListOnMobile, selectedItem]);

  const shouldShowMain = useMemo(() => {
    if (activeCategory === "system") return true;
    if (!isMobile) return true;
    if (selectedItem) return true;
    if (activeCategory === "users") {
      return !showUserListOnMobile;
    }
    return false;
  }, [activeCategory, isMobile, selectedItem, showUserListOnMobile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedItem) return;

    setIsSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (activeCategory === "users") {
        const response = await fetch("/api/admin/users", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session?.access_token}`
          },
          body: JSON.stringify({
            id: selectedItem.id,
            role: (selectedItem as any).role,
            pubg_nickname: (selectedItem as any).pubg_nickname,
            pubg_platform: (selectedItem as any).pubg_platform
          })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "유저 정보 저장 실패");
        toast.success("유저 프로필이 성공적으로 변경되었습니다.");
        fetchItems();
        return;
      }

      if (activeCategory === "crates") {
        if (!selectedCrateDetail) return;
        const response = await fetch("/api/admin/crates/data", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session?.access_token}`
          },
          body: JSON.stringify(selectedCrateDetail)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "저장 실패");

        toast.success("은신처 상자 정보가 저장되었습니다!");
        fetchItems();
        return;
      }

      const apiUrl = getApiUrl("/api/admin/game-data");
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({ category: activeCategory, item: selectedItem })
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "저장 실패");

      toast.success("변경 사항이 저장되었습니다!");
      fetchItems();
    } catch (err: any) {
      toast.error("저장 중 오류 발생: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = (id: string) => {
    setDeleteTargetId(id);
    setIsDeleteConfirmOpen(true);
  };

  const executeDelete = async () => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setIsDeleteConfirmOpen(false);

    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (activeCategory === "users") {
        const response = await fetch(`/api/admin/users?id=${id}`, {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${session?.access_token}`
          }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "유저 삭제 실패");

        toast.success(result.deletedAuthUser
          ? "유저 계정과 프로필이 성공적으로 삭제되었습니다."
          : "유령 프로필이 성공적으로 정리되었습니다.");
        fetchItems();
        return;
      }

      if (activeCategory === "crates") {
        const response = await fetch(`/api/admin/crates/data?id=${id}`, {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${session?.access_token}`
          }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "삭제 실패");

        toast.success("은신처 상자가 성공적으로 삭제되었습니다.");
        fetchItems();
        return;
      }

      const apiUrl = getApiUrl(`/api/admin/game-data?category=${activeCategory}&id=${id}`);
      const response = await fetch(apiUrl, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${session?.access_token}`
        }
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "삭제 실패");

      toast.success("항목이 성공적으로 삭제되었습니다.");
      fetchItems();
    } catch (err: any) {
      toast.error("삭제 중 오류 발생: " + err.message);
    } finally {
      setDeleteTargetId(null);
    }
  };

  const executeSync = async () => {
    setIsSyncConfirmOpen(false);
    setIsSaving(true);
    const manualUrl = syncTargetUrl || "";
    const urlInput = document.getElementById("manual-sync-url") as HTMLInputElement;

    try {
      const apiUrl = `/api/admin/patch-notes/sync`;
      const res = await fetch(apiUrl, { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: manualUrl })
      });
      const result = await res.json();
      
      if (result.success) {
        toast.success("동기화 완료! (" + (result.details?.join(", ") || "내역 없음") + ")");
        if (urlInput) urlInput.value = ""; // 성공 시 비우기
        router.push("/board");
      } else {
        toast.error("동기화 실패: " + (result.error || result.message || "알 수 없는 오류"));
      }
    } catch (err) {
      console.error("Sync error:", err);
      toast.error("연동 통신 중 오류가 발생했습니다.");
    } finally {
      setIsSaving(false);
      setSyncTargetUrl(null);
    }
  };

  const executeFlushCache = async () => {
    setIsFlushCacheConfirmOpen(false);
    setIsSaving(true);
    try {
      const res = await fetch("/api/admin/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "flush_old_cache" })
      });
      const data = await res.json();
      if (data.success) toast.success(data.message);
      else throw new Error(data.error);
    } catch (err: any) {
      toast.error("처리 중 오류: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const executeResetBenchmark = async () => {
    setIsResetBenchmarkConfirmOpen(false);
    setIsSaving(true);
    try {
      const res = await fetch("/api/admin/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_benchmarks" })
      });
      const data = await res.json();
      if (data.success) toast.success(data.message);
      else throw new Error(data.error);
    } catch (err: any) {
      toast.error("처리 중 오류: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const executeFlushUser = async () => {
    setIsFlushUserConfirmOpen(false);
    setIsSaving(true);
    try {
      const res = await fetch("/api/admin/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "flush_player_cache", nickname: flushUserTarget })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        setFlushNickname("");
      } else throw new Error(data.error);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSaving(false);
      setFlushUserTarget("");
    }
  };

  const executeFlushMatch = async () => {
    setIsFlushMatchConfirmOpen(false);
    setIsSaving(true);
    try {
      const res = await fetch("/api/admin/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "flush_match_cache", matchId: flushMatchTarget })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        setFlushMatchId("");
      } else throw new Error(data.error);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSaving(false);
      setFlushMatchTarget("");
    }
  };

  const createNewItem = () => {
    if (activeCategory === "users") {
      toast.warning("유저 추가는 소셜 로그인을 통한 회원가입으로만 자동 생성됩니다.");
      return;
    }
    const newId = `new_${Date.now()}`;
    
    if (activeCategory === "crates") {
      const newId = crypto.randomUUID();
      setSelectedCrateDetail({
        template: {
          id: newId,
          name: "새 은신처 상자",
          type: "contraband",
          price_gcoin: 200,
          bundle_price_gcoin: 1800,
          price_bp: 8000,
          price_bp_limit: 50,
          ticket_currency_code: "contraband_coupon",
          ticket_price_single: 10,
          ticket_price_bundle: 100,
          bonus_currency_code: "contraband_scrap",
          bonus_amount_single: 1,
          bonus_amount_bundle: 10,
          image_url: "",
          description: "",
          active: true,
          end_date: ""
        },
        items: [],
        prime_parcel_items: [],
        bonus_items: []
      });
      setSelectedItem({ id: newId, name: "새 은신처 상자" } as any);
      return;
    }

    if (activeCategory === "vehicles") {
      setSelectedItem({ 
        id: newId, 
        name: "새 항목", 
        patch_notes: "", 
        trunk_capacity: 200 
      } as Vehicle);
    } else if (activeCategory === "weapons") {
      setSelectedItem({ 
        id: newId, 
        name: "새 항목", 
        patch_notes: "", 
        weight: 0, 
        can_be_in_backpack: true,
        type: "AR",
        damage: 0,
        ammo: "5.56mm",
        bullet_speed: 0,
        availability: "월드 스폰"
      } as Weapon);
    } else if (activeCategory === "ammo") {
      setSelectedItem({ 
        id: newId, 
        name: "새 항목", 
        patch_notes: "", 
        weight: 0, 
        can_be_in_backpack: true,
        type: "탄약"
      } as GameItem);
    } else {
      setSelectedItem({ 
        id: newId, 
        name: "새 항목", 
        patch_notes: "", 
        weight: 0, 
        can_be_in_backpack: true 
      } as GameItem);
    }
  };

  if (!isAuthorized) return null;

  return (
    <div className="flex flex-col h-screen text-gray-200">
      <header className="flex flex-col md:flex-row items-center justify-between min-h-[60px] py-3 md:py-0 px-6 bg-[#1a1a1a] border-b border-[#333] gap-3 md:gap-0">
        <div className="flex flex-col md:flex-row items-center gap-3 md:gap-6 w-full md:w-auto">
          <div className="text-xl font-black text-[#F2A900] italic self-start md:self-auto">배그<span className="text-white"> 데이터 관리자</span></div>
          {isMobile ? (
            <select
              value={activeCategory}
              onChange={(e) => setActiveCategory(e.target.value as ItemCategory)}
              className="w-full bg-[#252525] text-white border border-[#444] rounded px-3 py-2 text-xs font-bold focus:outline-none focus:border-[#F2A900]"
            >
              {[
                { id: "weapons", label: "무기" },
                { id: "consumables", label: "회복템" },
                { id: "throwables", label: "투척무기" },
                { id: "attachments", label: "파츠" },
                { id: "ammo", label: "탄약" },
                { id: "vehicles", label: "차량" },
                { id: "crates", label: "은신처 상점" },
                { id: "users", label: "유저 관리" },
                { id: "system", label: "시스템/캐시" }
              ].map(cat => (
                <option key={cat.id} value={cat.id}>
                  {cat.label}
                </option>
              ))}
            </select>
          ) : (
            <nav className="flex flex-wrap gap-2">
              {[
                { id: "weapons", label: "무기" },
                { id: "consumables", label: "회복템" },
                { id: "throwables", label: "투척무기" },
                { id: "attachments", label: "파츠" },
                { id: "ammo", label: "탄약" },
                { id: "vehicles", label: "차량" },
                { id: "crates", label: "은신처 상점" },
                { id: "users", label: "유저 관리" },
                { id: "system", label: "시스템/캐시" }
              ].map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id as ItemCategory)}
                  className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                    activeCategory === cat.id ? "bg-[#F2A900] text-black" : "bg-[#252525] text-gray-400 hover:bg-[#333]"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="flex items-center justify-between w-full md:w-auto md:justify-end gap-4 shrink-0">
          {isMobile && (selectedItem || (activeCategory === "users" && showUserListOnMobile)) && (
            <button
              onClick={() => {
                if (selectedItem) {
                  setSelectedItem(null);
                } else {
                  setShowUserListOnMobile(false);
                }
              }}
              className="text-xs font-bold text-[#F2A900] border border-[#F2A900]/30 bg-[#F2A900]/10 px-3 py-1.5 rounded hover:bg-[#F2A900]/20 transition-all"
            >
              {selectedItem ? "← 리스트 보기" : "← 대시보드"}
            </button>
          )}
          <button onClick={() => router.push("/")} className="text-sm font-bold text-gray-400 hover:text-white transition-colors ml-auto md:ml-0">
            나가기
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className={`w-full md:w-[300px] bg-[#141414] border-r border-[#333] flex-col ${shouldShowAside ? 'flex' : 'hidden'}`}>
          {isMobile && activeCategory === "users" && showUserListOnMobile && (
            <div className="px-4 pt-4">
              <button
                type="button"
                onClick={() => setShowUserListOnMobile(false)}
                className="w-full py-2 bg-[#252525] border border-[#333] hover:bg-[#333] text-gray-400 hover:text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1"
              >
                ← 대시보드로 돌아가기
              </button>
            </div>
          )}
          <div className="p-4 border-b border-[#222]">
            <input
              id="admin-search"
              name="admin_q"
              type="text"
              placeholder="검색..."
              className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#F2A900]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button
              onClick={createNewItem}
              className="w-full mt-3 bg-[#34A853] hover:bg-[#2a8a43] text-white text-xs font-bold py-2 rounded transition-colors"
            >
              + 새 항목 추가
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredItems.map(item => (
              <div
                key={item.id}
                onClick={async () => {
                  setSelectedItem(item);
                  if (activeCategory === "crates") {
                    await fetchCrateDetail(item.id);
                  }
                }}
                className={`p-4 border-b border-[#222] cursor-pointer transition-colors hover:bg-[#1a1a1a] ${
                  selectedItem?.id === item.id 
                    ? "bg-[#1a1a1a] border-l-4 border-l-[#F2A900]" 
                    : (activeCategory === "users" && (item as any).is_orphan_profile)
                      ? "bg-purple-950/20 border-l-4 border-l-purple-500/50"
                      : (activeCategory === "users" && (item as any).is_missing_profile)
                        ? "bg-red-950/20 border-l-4 border-l-red-500/50"
                        : ""
                }`}
              >
                <div className="font-bold text-sm flex items-center justify-between gap-2">
                  <span className="truncate">
                    {activeCategory === "users" ? ((item as any).nickname || "닉네임 없음") : (item as any).name}
                  </span>
                  {activeCategory === "users" && (item as any).is_missing_profile && (
                    <span className="text-[9px] bg-red-950 text-red-400 border border-red-900/60 px-1.5 py-0.5 rounded font-bold shrink-0">
                      누락
                    </span>
                  )}
                  {activeCategory === "users" && (item as any).is_orphan_profile && (
                    <span className="text-[9px] bg-purple-950 text-purple-300 border border-purple-900/60 px-1.5 py-0.5 rounded font-bold shrink-0">
                      Auth 없음
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-gray-500 font-mono mt-1">{item.id}</div>
              </div>
            ))}
          </div>
        </aside>

        <main className={`flex-1 bg-[#0d0d0d] p-4 md:p-8 overflow-y-auto ${shouldShowMain ? 'block' : 'hidden'}`}>
          {isMobile && selectedItem && (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                className="w-full py-2.5 bg-[#252525] border border-[#333] hover:bg-[#333] text-gray-400 hover:text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1"
              >
                ← 리스트로 돌아가기
              </button>
            </div>
          )}
          {isMobile && !selectedItem && activeCategory === "users" && (
            <div className="mb-6 max-w-[750px] mx-auto">
              <button
                type="button"
                onClick={() => setShowUserListOnMobile(true)}
                className="w-full py-3 bg-[#F2A900] text-black hover:bg-[#d99700] rounded-xl text-xs font-black transition-all flex items-center justify-center gap-2 shadow-lg shadow-amber-950/20"
              >
                전체 회원 목록 및 검색 보기
              </button>
            </div>
          )}
          {activeCategory === "users" ? (
            <>
              {missingProfilesCount > 0 && (
                <div className="max-w-[700px] mx-auto mb-6 bg-red-950/20 border border-red-900/40 p-4 rounded-xl flex items-center justify-between gap-4 animate-pulse animate-duration-1000">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl"></span>
                    <div>
                      <h4 className="text-sm font-bold text-red-400">데이터 불일치 (프로필 누락 가입자 감지)</h4>
                      <p className="text-xs text-gray-400 mt-1">
                        가입 계정은 있으나 DB 프로필 테이블에 생성되지 않은 유저가 <strong>{missingProfilesCount}명</strong> 존재합니다.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSyncMissingProfiles}
                    disabled={isSaving}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-800 text-white text-xs font-bold rounded-lg shadow-lg shadow-red-950/40 transition-all shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSaving ? "동기화 중..." : "일괄 복구 동기화"}
                  </button>
                </div>
              )}

              {selectedItem ? (
                <div className="max-w-[650px] mx-auto pb-10">
                  <div className="flex justify-between items-center mb-8 border-b border-[#333] pb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full overflow-hidden border border-[#444] bg-[#222] flex items-center justify-center shrink-0">
                        {(selectedItem as any).avatar_url ? (
                          <img src={(selectedItem as any).avatar_url} alt="Avatar" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[#F2A900] font-black text-lg"></span>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[9px] bg-amber-950 text-amber-400 border border-amber-900 px-2 py-0.5 rounded-full font-bold">회원 상세</span>
                          {(selectedItem as any).role === "admin" && (
                            <span className="text-[9px] bg-red-950 text-red-400 border border-red-900 px-2 py-0.5 rounded-full font-bold">ADMIN</span>
                          )}
                        </div>
                        <h2 className="text-2xl font-black text-white inline-block">{(selectedItem as any).nickname || "닉네임 없음"}</h2>
                        
                        {/* 관리자 퀵 액션 */}
                        <div className="flex flex-wrap gap-2 mt-2">
                          {(selectedItem as any).pubg_nickname ? (
                            <button
                              type="button"
                              onClick={() => {
                                router.push(`/stats/${(selectedItem as any).pubg_platform}/${(selectedItem as any).pubg_nickname}`);
                              }}
                              className="text-[10px] bg-sky-950 hover:bg-sky-900 text-sky-400 border border-sky-850 px-2.5 py-1 rounded-lg font-bold transition-colors flex items-center gap-1"
                            >
                              배그 전적 조회
                            </button>
                          ) : (
                            <span className="text-[10px] text-gray-600 border border-gray-800/40 px-2.5 py-1 rounded-lg">배그 연동 대기중</span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              router.push(`/board?q=${(selectedItem as any).nickname || ''}`);
                            }}
                            className="text-[10px] bg-emerald-950 hover:bg-emerald-900 text-emerald-400 border border-emerald-850 px-2.5 py-1 rounded-lg font-bold transition-colors flex items-center gap-1"
                          >
                            작성한 글 검색
                          </button>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(selectedItem.id)}
                      className="bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold px-4 py-2 rounded border border-red-500/30 transition-all"
                    >
                      강제 탈퇴
                    </button>
                  </div>

                  <form onSubmit={handleSave} className="space-y-6">
                    <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                      <h3 className="text-sm font-black text-[#F2A900] uppercase tracking-wider">프로필 및 로그인 연동</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">가입 계정 (ID)</label>
                          <input
                            type="text"
                            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-gray-400 cursor-not-allowed font-mono text-[11px]"
                            value={selectedItem.id}
                            disabled
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">이메일 주소</label>
                          <input
                            type="text"
                            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                            value={(selectedItem as any).email || "소셜 간편 로그인"}
                            disabled
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">닉네임</label>
                          <input
                            type="text"
                            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                            value={(selectedItem as any).nickname || "이름 없음"}
                            disabled
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">가입 일자</label>
                          <input
                            type="text"
                            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                            value={
                              (selectedItem as any).created_at 
                                ? new Date((selectedItem as any).created_at).toLocaleString() 
                                : "기록 없음"
                            }
                            disabled
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">마지막 로그인</label>
                          <input
                            type="text"
                            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                            value={
                              (selectedItem as any).last_sign_in_at 
                                ? new Date((selectedItem as any).last_sign_in_at).toLocaleString() 
                                : "기록 없음"
                            }
                            disabled
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">최근 활동 시각</label>
                          <input
                            type="text"
                            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                            value={
                              (selectedItem as any).last_active_at 
                                ? new Date((selectedItem as any).last_active_at).toLocaleString() 
                                : (selectedItem as any).last_sign_in_at
                                  ? new Date((selectedItem as any).last_sign_in_at).toLocaleString() + " (로그인 시점)"
                                  : "기록 없음"
                            }
                            disabled
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">계정 상태 및 연동</label>
                          <div className="flex flex-wrap gap-2 pt-1">
                            {/* 로그인 제공처 뱃지 */}
                            {(() => {
                              const p = (selectedItem as any).provider;
                              if (p === "google") {
                                return <span className="text-[10px] bg-red-950/40 text-red-400 border border-red-900/50 px-2.5 py-1 rounded-full font-bold">Google 로그인</span>;
                              } else if (p === "kakao") {
                                return <span className="text-[10px] bg-amber-950/40 text-[#F2A900] border border-amber-900/60 px-2.5 py-1 rounded-full font-bold">Kakao 로그인</span>;
                              } else {
                                return <span className="text-[10px] bg-gray-900 text-gray-400 border border-gray-800 px-2.5 py-1 rounded-full font-bold">{p || "unknown"} 로그인</span>;
                              }
                            })()}

                            {/* 이메일 인증 여부 뱃지 */}
                            {(selectedItem as any).email_confirmed ? (
                              <span className="text-[10px] bg-emerald-950/40 text-emerald-400 border border-emerald-900/50 px-2.5 py-1 rounded-full font-bold font-sans">이메일 인증완료</span>
                            ) : (
                              <span className="text-[10px] bg-amber-950/40 text-amber-500 border border-amber-900/50 px-2.5 py-1 rounded-full font-bold font-sans">이메일 미인증</span>
                            )}

                            {/* 프로필 존재 여부 뱃지 */}
                            {(selectedItem as any).is_orphan_profile ? (
                              <span className="text-[10px] bg-purple-950/50 text-purple-300 border border-purple-900/60 px-2.5 py-1 rounded-full font-bold font-sans">Auth 계정 없음</span>
                            ) : (selectedItem as any).is_missing_profile ? (
                              <span className="text-[10px] bg-rose-950/50 text-rose-400 border border-rose-900/60 px-2.5 py-1 rounded-full font-bold font-sans">DB 프로필 누락</span>
                            ) : (
                              <span className="text-[10px] bg-indigo-950/40 text-indigo-400 border border-indigo-900/50 px-2.5 py-1 rounded-full font-bold font-sans">✓ DB 프로필 정상</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                      <h3 className="text-sm font-black text-[#F2A900] uppercase tracking-wider">인프라 관리 및 게임 연동</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">관리자 권한 (Role)</label>
                          <select
                            className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                            value={(selectedItem as any).role || "user"}
                            onChange={(e) => {
                              setSelectedItem({
                                ...selectedItem,
                                role: e.target.value
                              });
                            }}
                          >
                            <option value="user">일반 유저 (user)</option>
                            <option value="admin">관제탑 관리자 (admin)</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">배그 연동 닉네임</label>
                          <input
                            type="text"
                            className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                            placeholder="배틀그라운드 닉네임"
                            value={(selectedItem as any).pubg_nickname || ""}
                            onChange={(e) => {
                              setSelectedItem({
                                ...selectedItem,
                                pubg_nickname: e.target.value
                              });
                            }}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">배그 연동 플랫폼</label>
                          <select
                            className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                            value={(selectedItem as any).pubg_platform || ""}
                            onChange={(e) => {
                              setSelectedItem({
                                ...selectedItem,
                                pubg_platform: e.target.value
                              });
                            }}
                          >
                            <option value="">연동 안함</option>
                            <option value="steam">Steam (PC)</option>
                            <option value="kakao">Kakao (PC)</option>
                            <option value="xbox">Xbox (Console)</option>
                            <option value="psn">PlayStation (Console)</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-4">
                      <button
                        type="submit"
                        disabled={isSaving}
                        className="flex-1 py-3 bg-[#F2A900] hover:bg-[#d99700] text-black font-extrabold rounded-lg shadow-lg active:scale-95 transition-all text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isSaving ? "저장 중..." : "유저 연동정보 저장"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedItem(null)}
                        className="py-3 px-6 bg-transparent border border-[#555] hover:bg-[#222] text-gray-400 hover:text-white font-bold rounded-lg transition-colors text-sm"
                      >
                        취소
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="max-w-[750px] mx-auto space-y-8">
                  <div className="flex justify-between items-center border-b border-[#333] pb-4">
                    <div>
                      <h2 className="text-2xl font-black text-white">종합 회원 인사이트 대시보드</h2>
                      <p className="text-xs text-gray-500 mt-1">회원가입 현황, 프로필 누락 복구 상태 및 최근 가입 유저 요약</p>
                    </div>
                  </div>

                  {/* 3종 메트릭 카드 */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-[#1a1a1a] p-5 rounded-2xl border border-[#333] relative overflow-hidden">
                      <div className="text-2xl absolute top-4 right-4 opacity-10"></div>
                      <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">총 가입 회원</span>
                      <div className="text-3xl font-black text-white mt-2 font-mono">{userStats?.total || 0}명</div>
                    </div>
                    <div className={`p-5 rounded-2xl border relative overflow-hidden ${
                      (userStats?.missing || 0) > 0 
                        ? "bg-red-950/10 border-red-500/20 shadow-lg shadow-red-950/10" 
                        : "bg-[#1a1a1a] border-[#333]"
                    }`}>
                      <div className="text-2xl absolute top-4 right-4 opacity-10"></div>
                      <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">프로필 누락 경고</span>
                      <div className={`text-3xl font-black mt-2 font-mono ${
                        (userStats?.missing || 0) > 0 ? "text-red-400" : "text-white"
                      }`}>{userStats?.missing || 0}명</div>
                      {(userStats?.missing || 0) > 0 && (
                        <span className="absolute top-4 right-4 flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                        </span>
                      )}
                    </div>
                    <div className="bg-[#1a1a1a] p-5 rounded-2xl border border-[#333] relative overflow-hidden">
                      <div className="text-2xl absolute top-4 right-4 opacity-10"></div>
                      <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">이메일 인증률</span>
                      <div className="text-3xl font-black text-white mt-2 font-mono">
                        {userStats?.total ? Math.round((userStats.emailConfirmed / userStats.total) * 100) : 0}%
                      </div>
                    </div>
                  </div>

                  {/* 비율 가로형 HSL 바 차트 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* 소셜 로그인 제공처 비율 */}
                    <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                      <h3 className="text-sm font-black text-[#F2A900] uppercase tracking-wider">소셜 로그인 제공처 비율</h3>
                      <div className="space-y-4 pt-2">
                        {(() => {
                          const google = userStats?.providers["google"] || 0;
                          const kakao = userStats?.providers["kakao"] || 0;
                          const total = google + kakao || 1;
                          const googlePct = Math.round((google / total) * 100);
                          const kakaoPct = Math.round((kakao / total) * 100);
                          return (
                            <div className="space-y-3">
                              {/* 바 그래프 */}
                              <div className="w-full h-4 rounded-full overflow-hidden flex border border-[#222]">
                                <div className="bg-red-650 transition-all" style={{ width: `${googlePct}%` }} title={`Google: ${googlePct}%`} />
                                <div className="bg-amber-400 transition-all" style={{ width: `${kakaoPct}%` }} title={`Kakao: ${kakaoPct}%`} />
                              </div>
                              {/* 라벨 */}
                              <div className="flex justify-between text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className="w-2.5 h-2.5 bg-red-650 rounded-full inline-block" />
                                  <span className="text-gray-400">Google:</span>
                                  <span className="font-bold text-white">{googlePct}% ({google}명)</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span className="w-2.5 h-2.5 bg-amber-400 rounded-full inline-block" />
                                  <span className="text-gray-400">Kakao:</span>
                                  <span className="font-bold text-white">{kakaoPct}% ({kakao}명)</span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* 배그 플랫폼 연동 비율 */}
                    <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                      <h3 className="text-sm font-black text-[#F2A900] uppercase tracking-wider">배그 연동 플랫폼 비율</h3>
                      <div className="space-y-4 pt-2">
                        {(() => {
                          const steam = userStats?.platforms["steam"] || 0;
                          const kakao = userStats?.platforms["kakao"] || 0;
                          const unlinked = userStats?.platforms["unlinked"] || 0;
                          const total = steam + kakao + unlinked || 1;
                          
                          const steamPct = Math.round((steam / total) * 100);
                          const kakaoPct = Math.round((kakao / total) * 100);
                          const unlinkedPct = 100 - steamPct - kakaoPct;
                          
                          return (
                            <div className="space-y-3">
                              <div className="w-full h-4 rounded-full overflow-hidden flex border border-[#222]">
                                <div className="bg-sky-500 transition-all" style={{ width: `${steamPct}%` }} />
                                <div className="bg-amber-500 transition-all" style={{ width: `${kakaoPct}%` }} />
                                <div className="bg-gray-700 transition-all" style={{ width: `${unlinkedPct}%` }} />
                              </div>
                              <div className="grid grid-cols-3 gap-1 text-[10px] text-gray-455">
                                <div className="flex items-center gap-1">
                                  <span className="w-2 h-2 bg-sky-500 rounded-full inline-block" />
                                  <span>Steam: {steamPct}%</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className="w-2 h-2 bg-amber-500 rounded-full inline-block" />
                                  <span>Kakao: {kakaoPct}%</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className="w-2 h-2 bg-gray-700 rounded-full inline-block" />
                                  <span>미연동: {unlinkedPct}%</span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* 최근 활동 유저 Top 10 */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <h3 className="text-sm font-black text-[#F2A900] uppercase tracking-wider">실시간 최근 활동 유저 Top 10</h3>
                    <div className="divide-y divide-[#222]">
                      {userStats?.recent && userStats.recent.length > 0 ? (
                        userStats.recent.map((u: any, idx: number) => (
                          <div 
                            key={idx} 
                            onClick={() => setSelectedItem(u)}
                            className="py-3 flex items-center justify-between first:pt-0 last:pb-0 cursor-pointer hover:bg-white/5 px-2 rounded-xl transition-all"
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full overflow-hidden border border-[#333] bg-[#222] flex items-center justify-center shrink-0">
                                {u.avatar_url ? (
                                  <img src={u.avatar_url} alt="Avatar" className="w-full h-full object-cover" />
                                ) : (
                                  <span className="text-[#F2A900] font-black text-sm"></span>
                                )}
                              </div>
                              <div>
                                <div className="text-sm font-bold text-white flex items-center gap-2">
                                  {u.nickname || "닉네임 없음"}
                                  {u.role === "admin" && (
                                    <span className="text-[8px] bg-red-950 text-red-400 border border-red-900/60 px-1 py-0.2 rounded font-black">ADMIN</span>
                                  )}
                                </div>
                                <div className="text-[10px] text-gray-500">{u.email}</div>
                              </div>
                            </div>
                            
                            <div className="text-right flex flex-col items-end gap-1">
                              <span className="text-xs text-gray-400 font-bold">{timeAgo(u.last_active_at || u.last_sign_in_at)}</span>
                              {u.pubg_nickname ? (
                                <span className="text-[9px] bg-sky-950/40 text-sky-400 border border-sky-900/50 px-1.5 py-0.5 rounded font-mono">
                                  {u.pubg_nickname} ({u.pubg_platform})
                                </span>
                              ) : (
                                <span className="text-[9px] text-gray-600">배그 연동 정보 없음</span>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                         <div className="text-xs text-gray-600 italic py-4 text-center">최근 활동 기록이 존재하지 않습니다.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : activeCategory === "system" ? (
            <div className="max-w-[750px] mx-auto space-y-8">
              <h2 className="text-2xl font-black text-white border-b border-[#333] pb-4">시스템 통합 관제탑 및 캐시 관리</h2>
              
              {/* 시스템 모니터링 대시보드 */}
              {isLoadingDashboard && !dashboardData ? (
                <div className="bg-[#1a1a1a] p-8 rounded-2xl border border-[#333] flex flex-col items-center justify-center gap-3">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F2A900]"></div>
                  <span className="text-xs text-gray-400">실시간 시스템 메트릭 조회 중...</span>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* 저장소 용량 상태 */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-xs font-black text-gray-500 uppercase tracking-wider">저장소 용량 및 캐시 상태</h3>
                      <span className={`text-[10px] px-2 py-1 rounded border font-black ${usageStatusClass(dashboardData?.storageHealth?.database?.status)}`}>
                        DB {usageStatusLabel(dashboardData?.storageHealth?.database?.status)}
                      </span>
                    </div>
                    <div className="space-y-4 pt-1">
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Supabase DB</span>
                          <span className="font-bold font-mono text-white">
                            {formatBytes(dashboardData?.storageHealth?.database?.usedBytes || 0)} / {formatBytes(dashboardData?.storageHealth?.database?.limitBytes || 0)}
                          </span>
                        </div>
                        <div className="w-full bg-[#111] h-2 rounded-full overflow-hidden border border-[#222]">
                          <div
                            className={`h-full transition-all duration-500 ${
                              dashboardData?.storageHealth?.database?.status === "critical"
                                ? "bg-red-500"
                                : dashboardData?.storageHealth?.database?.status === "warn"
                                  ? "bg-amber-500"
                                  : "bg-emerald-500"
                            }`}
                            style={{ width: `${Math.min(dashboardData?.storageHealth?.database?.usagePercent || 0, 100)}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-gray-500 text-right font-mono">
                          {formatPercent(dashboardData?.storageHealth?.database?.usagePercent)}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">R2 텔레메트리 캐시</span>
                          <span className="font-bold font-mono text-white">
                            {formatBytes(dashboardData?.r2Cache?.totalSizeBytes || 0)} / {formatBytes(dashboardData?.storageHealth?.r2?.limitBytes || 0)}
                          </span>
                        </div>
                        <div className="w-full bg-[#111] h-2 rounded-full overflow-hidden border border-[#222]">
                          <div
                            className={`h-full transition-all duration-500 ${
                              dashboardData?.storageHealth?.r2?.status === "critical"
                                ? "bg-red-500"
                                : dashboardData?.storageHealth?.r2?.status === "warn"
                                  ? "bg-amber-500"
                                  : "bg-sky-500"
                            }`}
                            style={{ width: `${Math.min(dashboardData?.storageHealth?.r2?.usagePercent || 0, 100)}%` }}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-500 font-mono">
                          <span>{dashboardData?.r2Cache?.fileCount || 0}개 파일</span>
                          <span className="text-right">{formatPercent(dashboardData?.storageHealth?.r2?.usagePercent)}</span>
                        </div>
                      </div>

                      <div className="border-t border-[#222] pt-3 space-y-1.5">
                        {(dashboardData?.storageHealth?.tables || []).slice(0, 4).map((table: any) => (
                          <div key={table.table} className="flex justify-between text-[10px]">
                            <span className="text-gray-500">{table.table}</span>
                            <span className="font-mono text-gray-300">{table.count?.toLocaleString?.() || 0} rows</span>
                          </div>
                        ))}
                      </div>

                      <div className="text-[10px] text-gray-500 leading-relaxed">
                        * 로컬 analytics 이벤트는 기본 차단되며, R2는 페이지네이션으로 전수 집계합니다.
                        {dashboardData?.r2Cache?.truncated ? " 집계 상한 초과로 일부 객체는 제외되었습니다." : ""}
                      </div>
                    </div>
                  </div>

                  {/* 마커 제보 승인 대기 */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] flex flex-col justify-between">
                    <div>
                      <h3 className="text-xs font-black text-gray-500 uppercase tracking-wider">마커 제보 승인 대기</h3>
                      <div className="text-3xl font-black font-mono text-white mt-4">
                        {dashboardData?.pendingMarkersCount || 0} <span className="text-xs text-gray-500 font-normal">건</span>
                      </div>
                      <p className="text-[10px] text-gray-550 mt-2">
                        유저들이 지도 시뮬레이터에 등록한 전술 마커가 승인 대기 중입니다.
                      </p>
                    </div>
                    {dashboardData?.pendingMarkersCount > 0 && (
                      <button
                        onClick={() => router.push("/admin/review")}
                        className="w-full mt-4 py-2 bg-amber-600/20 text-[#F2A900] border border-[#F2A900]/30 hover:bg-amber-600/30 text-[11px] font-bold rounded transition-all text-center"
                      >
                        제보 검토하러 가기
                      </button>
                    )}
                  </div>

                  {/* PUBG API Rate Limit */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <h3 className="text-xs font-black text-gray-500 uppercase tracking-wider">PUBG API Rate Limit 상태</h3>
                    <div className="pt-2">
                      {dashboardData?.pubgApi ? (
                        <div className="space-y-3">
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-400">남은 호출 횟수</span>
                            <span className="font-bold font-mono">
                              {dashboardData.pubgApi.remaining} / {dashboardData.pubgApi.limit}
                            </span>
                          </div>
                          {(() => {
                            const pct = (dashboardData.pubgApi.remaining / dashboardData.pubgApi.limit) * 100;
                            const color = pct > 50 ? "bg-emerald-500" : pct > 20 ? "bg-amber-500" : "bg-red-500";
                            return (
                              <div className="w-full bg-[#111] h-2 rounded-full overflow-hidden border border-[#222]">
                                <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
                              </div>
                            );
                          })()}
                          <div className="grid grid-cols-2 gap-2 text-[9px] text-gray-500 font-mono mt-2">
                            <div>리셋: {new Date(dashboardData.pubgApi.resetAt).toLocaleTimeString()}</div>
                            <div className="text-right">갱신: {timeAgo(dashboardData.pubgApi.updatedAt)}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-gray-600 italic py-4 text-center">PUBG API 트래킹 정보가 아직 없습니다.</div>
                      )}
                    </div>
                  </div>

                  {/* AI 사용량 및 누적 비용 */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <h3 className="text-xs font-black text-gray-500 uppercase tracking-wider">AI (Gemini) 토큰 분석 비용 (최근 7일)</h3>
                    {dashboardData?.aiUsage && (
                      <div className="space-y-2 pt-2">
                        <div className="text-xs font-bold text-gray-400 flex justify-between">
                          <span>누적 소요 비용:</span>
                          <span className="text-[#34A853] font-black">${dashboardData.aiUsage.reduce((sum: number, u: any) => sum + u.cost, 0).toFixed(4)} USD</span>
                        </div>
                        <div className="flex items-end gap-1.5 h-16 pt-2 px-1">
                          {dashboardData.aiUsage.map((u: any, idx: number) => {
                            const maxCost = Math.max(...dashboardData.aiUsage.map((x: any) => x.cost), 0.001);
                            const percent = Math.min((u.cost / maxCost) * 100, 100);
                            return (
                              <div key={idx} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                                <div className="absolute bottom-full mb-1 bg-black text-[9px] text-white p-1.5 rounded border border-[#333] hidden group-hover:block whitespace-nowrap z-10">
                                  {u.date}<br/>
                                  비용: ${u.cost.toFixed(4)}<br/>
                                  토큰: {u.promptTokens + u.completionTokens}T
                                </div>
                                <div 
                                  className="w-full rounded-t bg-gradient-to-t from-emerald-600/30 to-emerald-500 transition-all hover:brightness-125" 
                                  style={{ height: `${percent}%` }}
                                />
                                <span className="text-[7px] text-gray-600 mt-1 font-mono">{u.date.substring(5)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 스쿼드 시너지 분석 통계 */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <h3 className="text-xs font-black text-gray-500 uppercase tracking-wider">스쿼드 시너지 분석 통계</h3>
                    <div className="space-y-3 pt-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">총 매치 / 스쿼드 매치</span>
                        <span className="font-bold font-mono text-white">
                          {dashboardData?.squadStats?.totalMatches || 0} / {dashboardData?.squadStats?.squadMatches || 0}
                        </span>
                      </div>
                      {(() => {
                        const total = dashboardData?.squadStats?.totalMatches || 0;
                        const squad = dashboardData?.squadStats?.squadMatches || 0;
                        const pct = total > 0 ? (squad / total) * 100 : 0;
                        return (
                          <div className="space-y-1">
                            <div className="w-full bg-[#111] h-2 rounded-full overflow-hidden border border-[#222]">
                              <div className="h-full bg-purple-500 transition-all duration-500" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="text-[10px] text-gray-500 text-right font-mono">
                              스쿼드 매치 비율: {pct.toFixed(1)}%
                            </div>
                          </div>
                        );
                      })()}
                      <div className="flex justify-between text-xs pt-1 border-t border-[#222]">
                        <span className="text-gray-400">고유 파티 수 (최근 100경기 기준)</span>
                        <span className="font-bold font-mono text-white">
                          {dashboardData?.squadStats?.estimatedSquadGroups || 0} 개 조합
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* API 최적화 세이브 */}
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <h3 className="text-xs font-black text-gray-500 uppercase tracking-wider">PUBG API 효율성 및 트래픽 절약</h3>
                    <div className="space-y-3 pt-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">누적 절약 API 호출 횟수</span>
                        <span className="font-bold font-mono text-emerald-400">
                          {dashboardData?.squadStats?.savedApiCalls || 0} 회 절약
                        </span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">누적 절약 트래픽 대역폭</span>
                        <span className="font-bold font-mono text-emerald-400">
                          {formatBytes(dashboardData?.squadStats?.savedBandwidthBytes || 0)}
                        </span>
                      </div>
                      <div className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                        * Telemetry 2차 가공 적재 및 캐싱 처리를 통해 PUBG Rate Limit 제한을 예방하고 있으며, 프로덕션 키 심사 증빙 수치로 활용 가능합니다.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 기존 데이터 조작 카드 목록 */}
              <div className="grid grid-cols-1 gap-6 pt-4">
                {/* 패치노트 데이터 동기화 관리 */}
                <div className="bg-[#1a1a1a] p-6 rounded-xl border border-[#333] space-y-4">
                  <h3 className="text-lg font-bold text-[#F2A900]">패치노트 데이터 수동 동기화</h3>
                  <p className="text-sm text-gray-400">
                    공식 PUBG 패치노트 뉴스를 크롤링하여 무기 및 아이템 스탯 데이터를 동기화합니다.<br/>
                    특정 뉴스 URL을 입력하거나 빈칸으로 제출하여 전체 자동 동기화를 진행할 수 있습니다.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3 max-w-[600px]">
                    <input
                      id="manual-sync-url"
                      name="manual_url"
                      type="text"
                      placeholder="수동 동기화 뉴스 URL (선택사항)"
                      className="flex-1 bg-[#222] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const btn = document.getElementById("sync-btn");
                          if (btn) btn.click();
                        }
                      }}
                    />
                    <button
                      id="sync-btn"
                      onClick={() => {
                        const urlInput = document.getElementById("manual-sync-url") as HTMLInputElement;
                        const manualUrl = urlInput?.value.trim() || "";
                        setSyncTargetUrl(manualUrl);
                        setIsSyncConfirmOpen(true);
                      }}
                      disabled={isSaving}
                      className={`px-6 py-2.5 rounded-lg text-sm font-bold border transition-all whitespace-nowrap cursor-pointer ${
                        isSaving 
                          ? "bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed" 
                          : "bg-blue-600/20 border-blue-600/30 text-blue-400 hover:bg-blue-600/30"
                      }`}
                    >
                      {isSaving ? "동기화 중..." : "데이터 동기화 실행"}
                    </button>
                  </div>
                </div>
                <div className="bg-[#1a1a1a] p-6 rounded-xl border border-[#333]">
                  <h3 className="text-lg font-bold text-[#F2A900] mb-2">전체 분석 캐시 초기화</h3>
                  <p className="text-sm text-gray-400 mb-4">
                    데이터베이스에 저장된 모든 분석 결과값(processed_match_telemetry)을 삭제합니다.<br/>
                    원본 데이터는 보존되며, 사용자가 전적을 조회할 때 최신 엔진으로 다시 계산됩니다.
                  </p>
                  <button
                    onClick={() => {
                      setIsFlushCacheConfirmOpen(true);
                    }}
                    disabled={isSaving}
                    className="px-6 py-3 bg-red-600/20 text-red-500 border border-red-600/30 rounded-lg font-bold hover:bg-red-600/30 transition-all"
                  >
                    전체 분석 데이터 삭제 (초기화)
                  </button>
                </div>

                <div className="bg-[#1a1a1a] p-6 rounded-xl border border-[#333]">
                  <h3 className="text-lg font-bold text-[#F2A900] mb-2">글로벌 벤치마크 초기화</h3>
                  <p className="text-sm text-gray-400 mb-4">
                    엘리트 선수들의 통계 데이터(global_benchmarks)를 모두 비웁니다.<br/>
                    수행 후 &apos;벤치마커 스크립트&apos;를 다시 돌려야 최신 데이터로 채워집니다.
                  </p>
                  <button
                    onClick={() => {
                      setIsResetBenchmarkConfirmOpen(true);
                    }}
                    disabled={isSaving}
                    className="px-6 py-3 bg-orange-600/20 text-orange-500 border border-orange-600/30 rounded-lg font-bold hover:bg-orange-600/30 transition-all"
                  >
                    벤치마크 데이터 전체 초기화
                  </button>
                </div>

                <div className="bg-[#1a1a1a] p-6 rounded-xl border border-[#333]">
                  <h3 className="text-lg font-bold text-[#F2A900] mb-2">플레이어/매치 정밀 초기화</h3>
                  <p className="text-sm text-gray-400 mb-6">
                    특정 플레이어나 매치의 데이터만 골라서 삭제합니다. 버그 수정 후 테스트 시 유용합니다.
                  </p>
                  
                  <div className="space-y-4">
                    <div className="flex gap-2">
                      <input 
                        type="text"
                        placeholder="플레이어 닉네임 (예: KangHeeSung_)"
                        className="flex-1 bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                        value={flushNickname}
                        onChange={(e) => setFlushNickname(e.target.value)}
                      />
                      <button
                        onClick={() => {
                          if (!flushNickname) return toast.error("닉네임을 입력하세요.");
                          setFlushUserTarget(flushNickname);
                          setIsFlushUserConfirmOpen(true);
                        }}
                        disabled={isSaving}
                        className="px-4 py-2 bg-blue-600/20 text-blue-400 border border-blue-600/30 rounded font-bold hover:bg-blue-600/30 transition-all text-sm"
                      >
                        유저 데이터 삭제
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <input 
                        type="text"
                        placeholder="매치 ID (Match ID)"
                        className="flex-1 bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                        value={flushMatchId}
                        onChange={(e) => setFlushMatchId(e.target.value)}
                      />
                      <button
                        onClick={() => {
                          if (!flushMatchId) return toast.error("매치 ID를 입력하세요.");
                          setFlushMatchTarget(flushMatchId);
                          setIsFlushMatchConfirmOpen(true);
                        }}
                        disabled={isSaving}
                        className="px-4 py-2 bg-purple-600/20 text-purple-400 border border-purple-600/30 rounded font-bold hover:bg-purple-600/30 transition-all text-sm"
                      >
                        매치 데이터 삭제
                      </button>
                    </div>
                  </div>
                </div>

                {/* 전역 공지 노출 설정 */}
                <div className="bg-[#1a1a1a] p-6 rounded-xl border border-[#333] space-y-4">
                  <h3 className="text-lg font-bold text-[#F2A900] mb-2">전역 공지 노출 제어</h3>
                  <p className="text-sm text-gray-400 mb-4">
                    지도의 상단 배너에 노출될 공지사항의 글 ID와 노출 기한을 설정합니다.<br />
                    노출 기한이 0일인 경우 영구 노출되며, <strong>공지글 ID에 -1 또는 none 입력 시 공지가 완전히 숨겨집니다.</strong>
                  </p>
                  
                  {isFetchingSettings ? (
                    <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#F2A900]"></div>
                      <span>설정 불러오는 중...</span>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveSettings} className="space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">공지글 ID (notice_active_id)</label>
                          <input 
                            type="text"
                            placeholder="예: 42 (최근 자동 노출 시 빈칸, 숨김 시 -1 또는 none)"
                            className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                            value={noticeActiveId}
                            onChange={(e) => setNoticeActiveId(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 mb-2">노출 기한 (일 기준, 0은 무제한)</label>
                          <input 
                            type="number"
                            min="0"
                            placeholder="예: 7"
                            className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#F2A900] focus:outline-none"
                            required
                            value={noticeDisplayDays}
                            onChange={(e) => setNoticeDisplayDays(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="flex justify-end pt-2">
                        <button
                          type="submit"
                          disabled={isSavingSettings}
                          className={`px-5 py-2 rounded-lg text-sm font-bold border transition-all whitespace-nowrap cursor-pointer ${
                            isSavingSettings 
                              ? "bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed" 
                              : "bg-[#F2A900] border-[#F2A900]/30 text-black hover:bg-[#d89700]"
                          }`}
                        >
                          {isSavingSettings ? "저장 중..." : "공지 설정 저장"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </div>
          ) : activeCategory === "crates" ? (
            selectedCrateDetail ? (
              <div className="max-w-[850px] mx-auto pb-10">
                <div className="flex justify-between items-center mb-8 border-b border-[#333] pb-4">
                  <div>
                    <span className="text-[10px] bg-indigo-950 text-indigo-400 border border-indigo-900 px-2 py-0.5 rounded-full font-bold mr-2">Crate Editor</span>
                    <h2 className="text-2xl font-black text-white inline-block">{selectedCrateDetail.template.name || "새 은신처 상자"}</h2>
                  </div>
                  <button
                    onClick={() => handleDelete(selectedCrateDetail.template.id)}
                    className="bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold px-4 py-2 rounded border border-red-500/30 transition-all"
                  >
                    상자 삭제
                  </button>
                </div>

                <form onSubmit={handleSave} className="space-y-8">
                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <h3 className="text-sm font-black text-[#F2A900] uppercase tracking-wider">상자 기본 정보</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">상자 이름</label>
                        <input
                          type="text"
                          required
                          value={selectedCrateDetail.template.name}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, name: e.target.value }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">상자 종류</label>
                        <select
                          value={selectedCrateDetail.template.type}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, type: e.target.value }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        >
                          <option value="contraband">밀수품 상자 (contraband)</option>
                          <option value="loot_crate">콜라보 전리품 상자 (loot_crate)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">1회 가격 (G-Coin)</label>
                        <input
                          type="number"
                          required
                          value={selectedCrateDetail.template.price_gcoin}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, price_gcoin: Number(e.target.value) }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">10회 가격 (G-Coin)</label>
                        <input
                          type="number"
                          required
                          value={selectedCrateDetail.template.bundle_price_gcoin}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, bundle_price_gcoin: Number(e.target.value) }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">BP 가격 (1회)</label>
                        <input
                          type="number"
                          value={selectedCrateDetail.template.price_bp !== null && selectedCrateDetail.template.price_bp !== undefined ? selectedCrateDetail.template.price_bp : ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, price_bp: e.target.value ? Number(e.target.value) : null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">BP 구매 평생 한도</label>
                        <input
                          type="number"
                          value={selectedCrateDetail.template.price_bp_limit !== null && selectedCrateDetail.template.price_bp_limit !== undefined ? selectedCrateDetail.template.price_bp_limit : ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, price_bp_limit: e.target.value ? Number(e.target.value) : null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">티켓/쿠폰 재화 코드</label>
                        <select
                          value={selectedCrateDetail.template.ticket_currency_code || ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, ticket_currency_code: e.target.value || null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        >
                          <option value="">없음 (비활성화)</option>
                          <option value="blackmarket_ticket">2026 블랙 마켓 티켓 (blackmarket_ticket)</option>
                          <option value="contraband_coupon">밀수품 쿠폰 (contraband_coupon)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">티켓 1회 가격</label>
                        <input
                          type="number"
                          value={selectedCrateDetail.template.ticket_price_single !== null && selectedCrateDetail.template.ticket_price_single !== undefined ? selectedCrateDetail.template.ticket_price_single : ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, ticket_price_single: e.target.value ? Number(e.target.value) : null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">티켓 10회 가격</label>
                        <input
                          type="number"
                          value={selectedCrateDetail.template.ticket_price_bundle !== null && selectedCrateDetail.template.ticket_price_bundle !== undefined ? selectedCrateDetail.template.ticket_price_bundle : ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, ticket_price_bundle: e.target.value ? Number(e.target.value) : null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">보너스 재화 코드</label>
                        <select
                          value={selectedCrateDetail.template.bonus_currency_code || ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, bonus_currency_code: e.target.value || null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        >
                          <option value="">없음 (비활성화)</option>
                          <option value="blackmarket_token">2026 블랙 마켓 토큰 (blackmarket_token)</option>
                          <option value="contraband_scrap">밀수품 스크랩 (contraband_scrap)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">1회 개봉 보너스 수량</label>
                        <input
                          type="number"
                          value={selectedCrateDetail.template.bonus_amount_single !== null && selectedCrateDetail.template.bonus_amount_single !== undefined ? selectedCrateDetail.template.bonus_amount_single : ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, bonus_amount_single: e.target.value ? Number(e.target.value) : null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 mb-2">10회 개봉 보너스 수량</label>
                        <input
                          type="number"
                          value={selectedCrateDetail.template.bonus_amount_bundle !== null && selectedCrateDetail.template.bonus_amount_bundle !== undefined ? selectedCrateDetail.template.bonus_amount_bundle : ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, bonus_amount_bundle: e.target.value ? Number(e.target.value) : null }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-bold text-gray-500 mb-2">판매 종료일 (타임스탬프: YYYY-MM-DD HH:MM:SS+09)</label>
                        <input
                          type="text"
                          placeholder="예: 2026-06-17 09:00:00+09"
                          value={selectedCrateDetail.template.end_date || ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, end_date: e.target.value }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-bold text-gray-500 mb-2">상자 설명</label>
                        <textarea
                          rows={2}
                          value={selectedCrateDetail.template.description || ""}
                          onChange={(e) => setSelectedCrateDetail({
                            ...selectedCrateDetail,
                            template: { ...selectedCrateDetail.template, description: e.target.value }
                          })}
                          className="w-full bg-[#111] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900] resize-none"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-bold text-gray-500 mb-2">상자 이미지 및 R2 업로드</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={selectedCrateDetail.template.image_url || ""}
                            onChange={(e) => setSelectedCrateDetail({
                              ...selectedCrateDetail,
                              template: { ...selectedCrateDetail.template, image_url: e.target.value }
                            })}
                            className="flex-1 bg-[#111] border border-[#333] rounded px-4 py-2 text-sm focus:outline-none focus:border-[#F2A900]"
                          />
                          <div className="relative">
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => handleImageUpload(e, "template")}
                              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                            />
                            <button
                              type="button"
                              className="px-4 py-2 bg-[#252525] border border-[#333] hover:bg-[#333] rounded text-xs font-bold h-full whitespace-nowrap"
                            >
                              이미지 업로드
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="col-span-2 pt-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedCrateDetail.template.active}
                            onChange={(e) => setSelectedCrateDetail({
                              ...selectedCrateDetail,
                              template: { ...selectedCrateDetail.template, active: e.target.checked }
                            })}
                            className="w-4 h-4 rounded border-[#333] bg-[#1a1a1a] text-[#F2A900] focus:ring-[#F2A900]"
                          />
                          <span className="text-xs font-bold text-gray-400">상점 노출 활성화</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="bg-[#1a1a1a] p-6 rounded-2xl border border-[#333] space-y-4">
                    <div className="flex justify-between items-center border-b border-[#222] pb-2">
                      <nav className="flex gap-2">
                        {[
                          { id: "items", label: "1차 구성품" },
                          ...(selectedCrateDetail.template.type === "loot_crate" ? [{ id: "prime", label: "최고급 꾸러미" }] : []),
                          { id: "bonus", label: "보너스 드롭" }
                        ].map(tab => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setCrateEditorTab(tab.id as any)}
                            className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                              crateEditorTab === tab.id ? "bg-[#F2A900] text-black" : "bg-[#222] text-gray-400 hover:bg-[#2a2a2a]"
                            }`}
                          >
                            {tab.label} ({
                              tab.id === "items" 
                                ? selectedCrateDetail.items.length 
                                : tab.id === "prime" 
                                  ? selectedCrateDetail.prime_parcel_items.length 
                                  : selectedCrateDetail.bonus_items.length
                            })
                          </button>
                        ))}
                      </nav>

                      <button
                        type="button"
                        onClick={() => {
                          if (crateEditorTab === "items") {
                            setSelectedCrateDetail({
                              ...selectedCrateDetail,
                              items: [...selectedCrateDetail.items, { name: "새 구성품", rarity: "LEGENDARY", probability: 0.1, image_url: "", is_prime_parcel: false, token_count: 0 }]
                            });
                          } else if (crateEditorTab === "prime") {
                            setSelectedCrateDetail({
                              ...selectedCrateDetail,
                              prime_parcel_items: [...selectedCrateDetail.prime_parcel_items, { name: "새 꾸러미 아이템", rarity: "ULTIMATE", probability: 0.1, image_url: "" }]
                            });
                          } else {
                            setSelectedCrateDetail({
                              ...selectedCrateDetail,
                              bonus_items: [...selectedCrateDetail.bonus_items, { name: "새 보너스 아이템", probability: 0.1, token_count: 0, is_prime_parcel: false, is_extra_crate: false, image_url: "" }]
                            });
                          }
                        }}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-1.5 rounded"
                      >
                        + 아이템 추가
                      </button>
                    </div>

                    <div className="space-y-4 max-h-[400px] overflow-y-auto pr-1">
                      {crateEditorTab === "items" && (
                        <div className="space-y-3">
                          {selectedCrateDetail.items.map((item, idx) => (
                            <div key={idx} className="bg-[#111] p-4 rounded-xl border border-[#222] space-y-3 relative">
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = selectedCrateDetail.items.filter((_, i) => i !== idx);
                                  setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                }}
                                className="absolute top-2 right-2 text-gray-500 hover:text-red-450 font-bold text-xs"
                              >
                                삭제
                              </button>
                              <div className="grid grid-cols-12 gap-3 items-end">
                                <div className="col-span-12 md:col-span-4">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">아이템 명칭</label>
                                  <input
                                    type="text"
                                    value={item.name}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.items];
                                      updated[idx] = { ...updated[idx], name: e.target.value };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-2">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">등급</label>
                                  <select
                                    value={item.rarity}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.items];
                                      updated[idx] = { ...updated[idx], rarity: e.target.value };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  >
                                    {["ULTIMATE", "LEGENDARY", "EPIC", "RARE"].map(r => (
                                      <option key={r} value={r}>{r}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="col-span-6 md:col-span-2">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">확률</label>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    value={item.probability}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.items];
                                      updated[idx] = { ...updated[idx], probability: Number(e.target.value) };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-2">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">토큰 보상</label>
                                  <input
                                    type="number"
                                    value={item.token_count || 0}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.items];
                                      updated[idx] = { ...updated[idx], token_count: Number(e.target.value) };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-2 flex items-center h-full pb-2">
                                  <label className="flex items-center gap-1 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={item.is_prime_parcel || false}
                                      onChange={(e) => {
                                        const updated = [...selectedCrateDetail.items];
                                        updated[idx] = { ...updated[idx], is_prime_parcel: e.target.checked };
                                        setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                      }}
                                      className="w-3.5 h-3.5 rounded border-[#333] bg-[#1c1c1c] text-[#F2A900] focus:ring-0"
                                    />
                                    <span className="text-[10px] text-gray-400 font-bold">꾸러미</span>
                                  </label>
                                </div>
                                <div className="col-span-12">
                                  <label className="block text-[9px] text-gray-500 mb-1 font-bold">이미지 URL / R2 업로드</label>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      placeholder="/images/crates/파일명.png"
                                      value={item.image_url || ""}
                                      onChange={(e) => {
                                        const updated = [...selectedCrateDetail.items];
                                        updated[idx] = { ...updated[idx], image_url: e.target.value };
                                        setSelectedCrateDetail({ ...selectedCrateDetail, items: updated });
                                      }}
                                      className="flex-1 bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                    />
                                    <div className="relative">
                                      <input
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => handleImageUpload(e, "items", idx)}
                                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                      />
                                      <button
                                        type="button"
                                        className="px-3 py-1.5 bg-[#252525] border border-[#333] hover:bg-[#333] rounded text-[10px] font-bold"
                                      >
                                        업로드
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {crateEditorTab === "prime" && (
                        <div className="space-y-3">
                          {selectedCrateDetail.prime_parcel_items.map((pItem, idx) => (
                            <div key={idx} className="bg-[#111] p-4 rounded-xl border border-[#222] space-y-3 relative">
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = selectedCrateDetail.prime_parcel_items.filter((_, i) => i !== idx);
                                  setSelectedCrateDetail({ ...selectedCrateDetail, prime_parcel_items: updated });
                                }}
                                className="absolute top-2 right-2 text-gray-500 hover:text-red-450 font-bold text-xs"
                              >
                                삭제
                              </button>
                              <div className="grid grid-cols-12 gap-3 items-end">
                                <div className="col-span-12 md:col-span-5">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">꾸러미 획득품 명칭</label>
                                  <input
                                    type="text"
                                    value={pItem.name}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.prime_parcel_items];
                                      updated[idx] = { ...updated[idx], name: e.target.value };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, prime_parcel_items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-3">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">등급</label>
                                  <select
                                    value={pItem.rarity}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.prime_parcel_items];
                                      updated[idx] = { ...updated[idx], rarity: e.target.value };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, prime_parcel_items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  >
                                    {["ULTIMATE", "LEGENDARY", "EPIC", "RARE"].map(r => (
                                      <option key={r} value={r}>{r}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="col-span-6 md:col-span-4">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">확률</label>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    value={pItem.probability}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.prime_parcel_items];
                                      updated[idx] = { ...updated[idx], probability: Number(e.target.value) };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, prime_parcel_items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-12">
                                  <label className="block text-[9px] text-gray-500 mb-1 font-bold">이미지 URL / R2 업로드</label>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      placeholder="/images/crates/파일명.png"
                                      value={pItem.image_url || ""}
                                      onChange={(e) => {
                                        const updated = [...selectedCrateDetail.prime_parcel_items];
                                        updated[idx] = { ...updated[idx], image_url: e.target.value };
                                        setSelectedCrateDetail({ ...selectedCrateDetail, prime_parcel_items: updated });
                                      }}
                                      className="flex-1 bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                    />
                                    <div className="relative">
                                      <input
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => handleImageUpload(e, "prime", idx)}
                                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                      />
                                      <button
                                        type="button"
                                        className="px-3 py-1.5 bg-[#252525] border border-[#333] hover:bg-[#333] rounded text-[10px] font-bold"
                                      >
                                        업로드
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {crateEditorTab === "bonus" && (
                        <div className="space-y-3">
                          {selectedCrateDetail.bonus_items.map((bItem, idx) => (
                            <div key={idx} className="bg-[#111] p-4 rounded-xl border border-[#222] space-y-3 relative">
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = selectedCrateDetail.bonus_items.filter((_, i) => i !== idx);
                                  setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                }}
                                className="absolute top-2 right-2 text-gray-500 hover:text-red-450 font-bold text-xs"
                              >
                                삭제
                              </button>
                              <div className="grid grid-cols-12 gap-3 items-end">
                                <div className="col-span-12 md:col-span-5">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">보너스 아이템 명칭</label>
                                  <input
                                    type="text"
                                    value={bItem.name}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.bonus_items];
                                      updated[idx] = { ...updated[idx], name: e.target.value };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-3">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">확률</label>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    value={bItem.probability}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.bonus_items];
                                      updated[idx] = { ...updated[idx], probability: Number(e.target.value) };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-2">
                                  <label className="block text-[10px] text-gray-500 mb-1 font-bold">토큰 보상</label>
                                  <input
                                    type="number"
                                    value={bItem.token_count || 0}
                                    onChange={(e) => {
                                      const updated = [...selectedCrateDetail.bonus_items];
                                      updated[idx] = { ...updated[idx], token_count: Number(e.target.value) };
                                      setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                    }}
                                    className="w-full bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div className="col-span-6 md:col-span-2 flex flex-col gap-1 items-start justify-center h-full pb-1">
                                  <label className="flex items-center gap-1 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={bItem.is_prime_parcel || false}
                                      onChange={(e) => {
                                        const updated = [...selectedCrateDetail.bonus_items];
                                        updated[idx] = { ...updated[idx], is_prime_parcel: e.target.checked };
                                        setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                      }}
                                      className="w-3 h-3 rounded border-[#333] bg-[#1c1c1c] text-[#F2A900] focus:ring-0"
                                    />
                                    <span className="text-[9px] text-gray-400 font-bold">꾸러미</span>
                                  </label>
                                  <label className="flex items-center gap-1 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={bItem.is_extra_crate || false}
                                      onChange={(e) => {
                                        const updated = [...selectedCrateDetail.bonus_items];
                                        updated[idx] = { ...updated[idx], is_extra_crate: e.target.checked };
                                        setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                      }}
                                      className="w-3 h-3 rounded border-[#333] bg-[#1c1c1c] text-[#F2A900] focus:ring-0"
                                    />
                                    <span className="text-[9px] text-gray-400 font-bold">상자</span>
                                  </label>
                                </div>
                                <div className="col-span-12">
                                  <label className="block text-[9px] text-gray-500 mb-1 font-bold">이미지 URL / R2 업로드</label>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      placeholder="/images/crates/파일명.png"
                                      value={bItem.image_url || ""}
                                      onChange={(e) => {
                                        const updated = [...selectedCrateDetail.bonus_items];
                                        updated[idx] = { ...updated[idx], image_url: e.target.value };
                                        setSelectedCrateDetail({ ...selectedCrateDetail, bonus_items: updated });
                                      }}
                                      className="flex-1 bg-[#1c1c1c] border border-[#333] rounded px-3 py-1.5 text-xs text-slate-200"
                                    />
                                    <div className="relative">
                                      <input
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => handleImageUpload(e, "bonus", idx)}
                                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                      />
                                      <button
                                        type="button"
                                        className="px-3 py-1.5 bg-[#252525] border border-[#333] hover:bg-[#333] rounded text-[10px] font-bold"
                                      >
                                        업로드
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="pt-4">
                    <button
                      type="submit"
                      disabled={isSaving}
                      className={`w-full py-4 rounded-2xl font-black text-xl shadow-lg transition-all ${
                        isSaving
                          ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                          : "bg-[#F2A900] text-slate-950 hover:bg-[#cc8b00] active:scale-95 cursor-pointer shadow-[#F2A900]/10"
                      }`}
                    >
                      {isSaving ? "저장 중..." : "은신처 상점 모든 변경사항 저장하기"}
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-4">
                <div className="text-6xl text-gray-800"></div>
                <div className="font-bold">편집할 은신처 상자를 왼쪽 목록에서 선택해 주세요.</div>
              </div>
            )
          ) : selectedItem ? (
            <div className="max-w-[700px] mx-auto">
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-2xl font-black text-white">{selectedItem.name || "항목 편집"}</h2>
                <button
                  onClick={() => handleDelete(selectedItem.id)}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold px-4 py-2 rounded border border-red-500/30 transition-all"
                >
                  아이템 삭제
                </button>
              </div>

              <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-gray-500 mb-2">항목 ID</label>
                  <input
                    id="item-id"
                    name="id"
                    type="text"
                    required
                    value={selectedItem.id}
                    onChange={(e) => setSelectedItem({...selectedItem, id: e.target.value})}
                    className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                  />
                </div>
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-gray-500 mb-2">이름</label>
                  <input
                    id="item-name"
                    name="name"
                    type="text"
                    required
                    value={selectedItem.name}
                    onChange={(e) => setSelectedItem({...selectedItem, name: e.target.value})}
                    className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                  />
                </div>

                {activeCategory === "vehicles" ? (
                  <div className="col-span-1">
                    <label className="block text-xs font-bold text-gray-500 mb-2">트렁크 용량</label>
                    <input
                      id="vehicle-trunk"
                      name="trunk_capacity"
                      type="number"
                      required
                      value={(selectedItem as Vehicle).trunk_capacity || 0}
                      onChange={(e) => setSelectedItem({...selectedItem, trunk_capacity: Number(e.target.value)} as Vehicle)}
                      className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                    />
                  </div>
                ) : (
                  <>
                    <div className="col-span-1">
                      <label className="block text-xs font-bold text-gray-500 mb-2">무게</label>
                      <input
                        id="item-weight"
                        name="weight"
                        type="number"
                        step="0.1"
                        required
                        value={selectedItem.weight || 0}
                        onChange={(e) => setSelectedItem({...selectedItem, weight: Number(e.target.value)})}
                        className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      />
                    </div>
                    <div className="col-span-1 pt-6">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          id="item-backpack-check"
                          name="can_be_in_backpack"
                          type="checkbox"
                          checked={selectedItem.can_be_in_backpack || false}
                          onChange={(e) => setSelectedItem({...selectedItem, can_be_in_backpack: e.target.checked})}
                          className="w-4 h-4 rounded border-[#333] bg-[#1a1a1a] text-[#F2A900] focus:ring-[#F2A900]"
                        />
                        <span className="text-xs font-bold text-gray-500">배낭 수납 가능</span>
                      </label>
                    </div>
                  </>
                )}

                {activeCategory === "weapons" && (
                  <>
                    <div className="col-span-1">
                      <label className="block text-xs font-bold text-gray-500 mb-2">공격력 (Damage)</label>
                      <input
                        id="weapon-damage"
                        name="damage"
                        type="number"
                        value={(selectedItem as Weapon).damage || 0}
                        onChange={(e) => setSelectedItem({...selectedItem, damage: Number(e.target.value)} as Weapon)}
                        className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs font-bold text-gray-500 mb-2">탄약 종류</label>
                      <input
                        id="weapon-ammo"
                        name="ammo"
                        type="text"
                        value={(selectedItem as Weapon).ammo || ""}
                        onChange={(e) => setSelectedItem({...selectedItem, ammo: e.target.value} as Weapon)}
                        className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs font-bold text-gray-500 mb-2">무기 분류</label>
                      <select
                        id="weapon-type-select"
                        name="type"
                        value={(selectedItem as Weapon).type || "AR"}
                        onChange={(e) => setSelectedItem({...selectedItem, type: e.target.value} as Weapon)}
                        className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      >
                        {["AR", "DMR", "SR", "SMG", "SG", "HG", "LMG", "Melee", "Other"].map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs font-bold text-gray-500 mb-2">탄속 (Bullet Speed)</label>
                      <input
                        id="weapon-bullet-speed"
                        name="bullet_speed"
                        type="number"
                        value={(selectedItem as Weapon).bullet_speed || 0}
                        onChange={(e) => setSelectedItem({...selectedItem, bullet_speed: Number(e.target.value)} as Weapon)}
                        className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs font-bold text-gray-500 mb-2">획득처 (Availability)</label>
                      <input
                        id="weapon-availability"
                        name="availability"
                        type="text"
                        value={(selectedItem as Weapon).availability || ""}
                        onChange={(e) => setSelectedItem({...selectedItem, availability: e.target.value} as Weapon)}
                        className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                      />
                    </div>
                  </>
                )}

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 mb-2">항목 분류 (Type)</label>
                  <input
                    id="item-subtype"
                    name="type"
                    type="text"
                    value={(selectedItem as any).type || ""}
                    onChange={(e) => setSelectedItem({...selectedItem, type: e.target.value} as any)}
                    placeholder="아이템의 세부 분류를 입력하세요 (예: 탄약, 탄창, 손잡이 등)"
                    className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900]"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 mb-2">패치 노 트 / 설명</label>
                  <textarea
                    id="item-patch-notes"
                    name="patch_notes"
                    rows={4}
                    value={selectedItem.patch_notes || ""}
                    onChange={(e) => setSelectedItem({...selectedItem, patch_notes: e.target.value})}
                    placeholder="최근 업데이트 내용이나 아이템 특징을 적어주세요."
                    className="w-full bg-[#1a1a1a] border border-[#333] rounded px-4 py-2.5 text-sm focus:outline-none focus:border-[#F2A900] resize-none"
                  ></textarea>
                </div>

                <div className="col-span-2 pt-6">
                  <button
                    type="submit"
                    disabled={isSaving}
                    className={`w-full py-4 rounded-xl font-black text-lg transition-all ${
                      isSaving ? "bg-gray-700 text-gray-500" : "bg-[#F2A900] text-black hover:bg-[#cc8b00] active:scale-[0.98]"
                    }`}
                  >
                    {isSaving ? "서버에 전송 중..." : "변경 사항 저장하기"}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-4">
              <div className="text-6xl text-gray-800"></div>
              <div className="font-bold">편집할 아이템을 왼쪽 목록에서 선택해 주세요.</div>
            </div>
          )}
        </main>
      </div>

      {/* 3단계 모달 현대화 모달 마운트 */}
      <ConfirmModal
        isOpen={isDeleteConfirmOpen}
        onCancel={() => {
          setIsDeleteConfirmOpen(false);
          setDeleteTargetId(null);
        }}
        onConfirm={executeDelete}
        title="항목 삭제 확인"
        type="danger"
        description={
          activeCategory === "users"
            ? (selectedItem as any)?.is_orphan_profile
              ? "Auth 계정 없이 남아 있는 유령 프로필을 정리하시겠습니까? 프로필 행이 영구 삭제됩니다."
              : "해당 유저를 강제 탈퇴(삭제) 처리하시겠습니까? Auth 계정과 프로필 정보가 영구히 소멸됩니다."
            : "정말 삭제하시겠습니까? 관련 시뮬레이션에 영향이 있을 수 있습니다."
        }
      />

      <ConfirmModal
        isOpen={isSyncConfirmOpen}
        onCancel={() => {
          setIsSyncConfirmOpen(false);
          setSyncTargetUrl(null);
        }}
        onConfirm={executeSync}
        title="패치노트 동기화"
        type="info"
        description={
          syncTargetUrl
            ? `입력하신 URL(${syncTargetUrl})로 강제 동기화를 진행할까요?`
            : "모든 공식 뉴스를 훑어보고 최신 패치노트 전 내용을 동기화할까요?"
        }
      />

      <ConfirmModal
        isOpen={isFlushCacheConfirmOpen}
        onCancel={() => setIsFlushCacheConfirmOpen(false)}
        onConfirm={executeFlushCache}
        title="전체 분석 캐시 초기화"
        type="danger"
        description="정말 모든 분석 캐시를 삭제하시겠습니까? (복구 불가능)"
      />

      <ConfirmModal
        isOpen={isResetBenchmarkConfirmOpen}
        onCancel={() => setIsResetBenchmarkConfirmOpen(false)}
        onConfirm={executeResetBenchmark}
        title="글로벌 벤치마크 초기화"
        type="danger"
        description="벤치마크 데이터를 초기화하시겠습니까? (복구 불가능)"
      />

      <ConfirmModal
        isOpen={isFlushUserConfirmOpen}
        onCancel={() => {
          setIsFlushUserConfirmOpen(false);
          setFlushUserTarget("");
        }}
        onConfirm={executeFlushUser}
        title="플레이어 분석 데이터 삭제"
        type="danger"
        description={`${flushUserTarget}님의 모든 분석 데이터를 삭제하시겠습니까?`}
      />

      <ConfirmModal
        isOpen={isFlushMatchConfirmOpen}
        onCancel={() => {
          setIsFlushMatchConfirmOpen(false);
          setFlushMatchTarget("");
        }}
        onConfirm={executeFlushMatch}
        title="매치 분석 데이터 삭제"
        type="danger"
        description={`해당 매치(${flushMatchTarget})의 모든 분석 데이터를 삭제하시겠습니까?`}
      />
    </div>
  );
}
