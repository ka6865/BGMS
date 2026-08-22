'use client';

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import DOMPurify from "dompurify";
import "react-quill-new/dist/quill.snow.css";
import Image from "next/image";
import CommentSection from "../CommentSection";
import { AdminBadge } from "./AdminBadge";
import { BoardPostPromotionState, Post, Comment } from "@/types/board";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/components/AuthProvider";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics";
import ConfirmModal from "../common/ConfirmModal";
import TurnstileWidget from "./TurnstileWidget";
import { TURNSTILE_ACTIONS } from "@/lib/board/turnstileContract";
import AdfitBanner from "@/components/ads/AdfitBanner";
import AdSenseBanner from "@/components/ads/AdSenseBanner";
import { rewriteBoardImageUrls, toBoardImageProxyUrl } from "@/lib/board-image-proxy";
import { AppModal } from "@/components/common/AppModal";

interface BoardDetailClientProps {
  initialPost: Post;
  initialComments: Comment[];
  promoteExpectedParentRevision: BoardPostPromotionState["expectedParentRevision"];
  initialCommentsHasError?: boolean;
}

const sanitizeHTML = (html: string, isMounted: boolean) => {
  if (!html) return "";
  // SSR 단계 혹은 클라이언트 마운트 전에는 Hydration Mismatch를 막기 위해 원본 html을 그대로 반환합니다.
  if (typeof window === "undefined" || !isMounted) {
    return html;
  }
  // 클라이언트 마운트 완료 후에만 브라우저 전용 dompurify로 안전하게 정화합니다.
  if (DOMPurify && typeof DOMPurify.sanitize === "function") {
    return DOMPurify.sanitize(html, { 
      ALLOWED_TAGS: [
        "p", "br", "strong", "em", "u", "s", "ul", "ol", "li", 
        "h1", "h2", "h3", "blockquote", "img", "a", "span", "iframe", "div"
      ],
      ALLOWED_ATTR: ["href", "target", "rel", "src", "style", "class", "width", "height", "alt", "title", "frameborder", "allow", "allowfullscreen"]
    });
  }
  return html;
};

export default function BoardDetailClient({
  initialPost,
  initialComments,
  promoteExpectedParentRevision,
  initialCommentsHasError = false,
}: BoardDetailClientProps) {
  const router = useRouter();
  const { user } = useAuth();

  const [post, setPost] = useState<Post>(initialPost);
  const [comments, setComments] = useState<Comment[]>(initialComments);
  const [newComment, setNewComment] = useState("");
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [postImageFailed, setPostImageFailed] = useState(false);

  // 비회원 댓글/게시글 작성용 상태
  const [guestNickname, setGuestNickname] = useState("");
  const [guestPassword, setGuestPassword] = useState("");
  // 비회원 게시글 삭제용 비밀번호 모달 상태
  const [guestDeleteModal, setGuestDeleteModal] = useState<{
    isOpen: boolean;
    targetType: 'post' | 'comment';
    targetId: number;
  } | null>(null);
  const [guestDeletePassword, setGuestDeletePassword] = useState("");

  const [showCaptcha, setShowCaptcha] = useState(false);
  // 느린 네트워크에서 연속 클릭 시 중복 등록되는 것을 막는다.
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isLikingPost, setIsLikingPost] = useState(false);

  //  초안 승격 및 AI 피드백 모달용 상태 추가
  const [isPromoting, setIsPromoting] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    description: string;
    confirmText?: string;
    onConfirm: () => void;
    type?: 'warning' | 'danger' | 'info';
  }>({
    isOpen: false,
    title: '',
    description: '',
    onConfirm: () => {},
  });

  // 초안 승격(실제 게시판 발행) 처리 함수
  const handlePromotePost = async () => {
    if (!isAdmin) return;
    const expectedParentRevision = promoteExpectedParentRevision;
    if (expectedParentRevision === null || !Number.isSafeInteger(expectedParentRevision) || expectedParentRevision < 0) {
      toast.error("원본 게시글 버전을 확인하지 못했습니다. 새로고침 후 다시 시도해주세요.");
      return;
    }
    setIsPromoting(true);
    try {
      const response = await fetch("/api/posts/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postId: post.id,
          expectedParentRevision,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || "승격 실패");
      }
      toast.success(result.message || "성공적으로 승격되었습니다.");
      
      trackEvent({
        name: "post_action",
        params: {
          action: "promote_post",
          status: "success",
          post_id: String(post.id)
        }
      });

      router.push(`/board/${result.data?.id || ""}`);
    } catch (e: any) {
      toast.error(e.message || "승격 중 오류가 발생했습니다.");
    } finally {
      setIsPromoting(false);
    }
  };

  // AI 재수정 피드백 전달 모사 함수
  const handleSendFeedbackToAI = () => {
    if (!feedbackText.trim()) return toast.warning("피드백 내용을 입력해주세요.");
    
    toast.success("AI 비서에게 수정 피드백이 전달되었습니다!");
    setShowFeedbackModal(false);
    setFeedbackText("");
    
    // 어드민 봇 페이지로 자연스럽게 전환
    setTimeout(() => {
      router.push(`/admin/bot?action=feedback&postId=${post.id}&text=${encodeURIComponent(feedbackText)}`);
    }, 1200);
  };

  useEffect(() => {
    trackEvent({
      name: "post_viewed",
      params: {
        post_id: String(post.id),
        category: post.category
      }
    });
  }, [post.id, post.category]);

  useEffect(() => {
    setPostImageFailed(false);
  }, [post.id, post.image_url]);

  useEffect(() => {
    setMounted(true);
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const handleTurnstileVerify = (token: string) => {
    setShowCaptcha(false);
    void handleSaveComment(token);
  };


  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    const fetchProfile = async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      if (data) {
        setIsAdmin(data.role === "admin");
      }
    };
    fetchProfile();
  }, [user]);

  // 조회수 증가 및 동기화
  useEffect(() => {
    const viewedKey = `viewed_post_${post.id}`;
    if (!sessionStorage.getItem(viewedKey)) {
      supabase.rpc("increment_views", { row_id: post.id }).then(() => {
        sessionStorage.setItem(viewedKey, "true");
        setPost(prev => ({ ...prev, views: prev.views + 1 }));
      });
    }
  }, [post.id]);

  const fetchComments = async () => {
    const { data } = await supabase
      .from("comments")
      .select("*, profiles(nickname, role)")
      .eq("post_id", post.id)
      .order("created_at", { ascending: true });
    if (data) {
      setComments(
        data.map((c: any) => ({
          ...c,
          author: c.user_id
            ? (c.profiles?.nickname || c.author || "알 수 없음")
            : (c.author || "익명"),
          profiles: c.profiles || null,
          ip_address: c.ip_address ? c.ip_address.split(".").slice(0, 2).join(".") : null,
        }))
      );
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');

    // SSR 단계 및 Hydration 시점에는 locale이나 dynamic time에 무관한 결정론적 날짜를 출력하여 에러를 원천 봉쇄합니다.
    if (!mounted) {
      return `${y}. ${m}. ${d}.`;
    }

    const diff = (new Date().getTime() - date.getTime()) / 1000;
    if (diff < 60) return "방금 전";
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    return `${y}. ${m}. ${d}.`;
  };

  const handleLikePost = async () => {
    if (!user) return toast.error("로그인 후 이용 가능합니다.");
    if (isLikingPost) return;

    setIsLikingPost(true);
    try {
      const { data } = await supabase
        .from("post_likes")
        .select("post_id")
        .eq("post_id", post.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        toast.info("이미 추천하신 게시글입니다.");
        return;
      }

      // 추천 기록 삽입이 실패하면 카운트를 올리지 않는다.
      // 동시 클릭 시 unique 제약 위반이 발생하면 이 지점에서 중단된다.
      const { error: insertError } = await supabase
        .from("post_likes")
        .insert([{ post_id: post.id, user_id: user.id }]);
      if (insertError) {
        toast.info("이미 추천하신 게시글입니다.");
        return;
      }

      const { error: incrementError } = await supabase.rpc("increment_likes", { row_id: post.id });
      if (incrementError) {
        toast.error("추천 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }

      setPost(prev => ({ ...prev, likes: prev.likes + 1 }));
      toast.success("게시글을 추천했습니다!");
    } catch {
      toast.error("추천 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setIsLikingPost(false);
    }
  };

  const handleSaveComment = async (verifiedToken?: string) => {
    if (isSubmittingComment) return;

    if (!newComment.trim()) {
      toast.warning("댓글 내용을 입력해주세요.");
      return;
    }

    if (!user && !guestNickname.trim()) {
      toast.warning("닉네임을 입력해주세요.");
      return;
    }
    if (!user && !guestPassword) {
      toast.warning("비밀번호를 입력해주세요.");
      return;
    }
    if (!user && !verifiedToken) {
      setShowCaptcha(true);
      return;
    }

    setIsSubmittingComment(true);
    try {
      const res = await fetch("/api/board/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post_id: post.id,
          author: user ? null : guestNickname.trim(),
          password: user ? null : guestPassword,
          content: newComment.trim(),
          parent_id: replyingTo?.id ?? null,
          turnstileToken: user ? null : verifiedToken,
        }),
      });
      const result = await res.json() as { error?: string };
      if (!res.ok) {
        trackEvent({ name: "post_action", params: { action: "create_comment", status: "fail" } });
        toast.error(result.error || "댓글 저장 실패");
        return;
      }

      trackEvent({ name: "post_action", params: { action: "create_comment", status: "success" } });
      toast.success("댓글이 등록되었습니다.");
      setNewComment("");
      setReplyingTo(null);
      void fetchComments();
    } catch {
      trackEvent({ name: "post_action", params: { action: "create_comment", status: "fail" } });
      toast.error("댓글 저장 중 오류가 발생했습니다.");
    } finally {
      setIsSubmittingComment(false);
    }
  };


  const handleDeleteComment = (commentId: number) => {
    const targetComment = comments.find((c) => c.id === commentId);

    // 비회원 댓글: 비밀번호 입력 모달로 처리
    if (targetComment && !targetComment.user_id) {
      setGuestDeleteModal({ isOpen: true, targetType: 'comment', targetId: commentId });
      setGuestDeletePassword("");
      return;
    }

    // 회원 댓글: 기존 확인 모달 후 직접 삭제
    setConfirmModal({
      isOpen: true,
      title: "댓글 삭제",
      description: "정말로 이 댓글을 삭제하시겠습니까? 삭제된 댓글은 복구할 수 없습니다.",
      confirmText: "삭제",
      type: "danger",
      onConfirm: async () => {
        const { error } = await supabase.from("comments").delete().eq("id", commentId);
        if (!error) {
          fetchComments();
          toast.success("댓글이 삭제되었습니다.");
        } else {
          toast.error("댓글 삭제 실패");
        }
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      }
    });
  };

  const handleReportComment = (commentId: number) => {
    setConfirmModal({
      isOpen: true,
      title: "댓글 신고",
      description: "이 댓글을 부적절한 내용으로 신고하시겠습니까?",
      confirmText: "신고하기",
      type: "warning",
      onConfirm: async () => {
        const res = await fetch("/api/board/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_type: "comment", target_id: commentId, reason: "부적절한 내용" }),
        });
        if (res.ok) toast.success("신고가 접수되었습니다.");
        else {
          const data = await res.json();
          toast.error(data.error || "신고 접수 실패");
        }
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      }
    });
  };

  const handleDeletePost = () => {
    // 비회원 게시글: 비밀번호 입력 모달로 처리
    if (!post.user_id) {
      setGuestDeleteModal({ isOpen: true, targetType: 'post', targetId: post.id });
      setGuestDeletePassword("");
      return;
    }

    if (comments.length > 0 && !isAdmin) return toast.warning("댓글이 작성된 게시글은 삭제할 수 없습니다.");
    
    setConfirmModal({
      isOpen: true,
      title: "게시글 삭제",
      description: "정말로 이 게시글을 삭제하시겠습니까? 삭제된 게시글과 모든 데이터는 복구할 수 없습니다.",
      confirmText: "삭제",
      type: "danger",
      onConfirm: async () => {
        try {
          if (isAdmin) {
            const adminRes = await fetch(`/api/admin/posts/delete?postId=${post.id}`, { method: "DELETE" });
            if (!adminRes.ok) throw new Error("관리자 삭제 실패");
          } else {
            const { error } = await supabase.from("posts").delete().eq("id", post.id);
            if (error) throw error;
          }
          toast.success("삭제되었습니다.");
          router.push("/board");
        } catch {
          toast.error("삭제 실패");
        }
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      }
    });
  };

  const handleReportPost = () => {
    setConfirmModal({
      isOpen: true,
      title: "게시글 신고",
      description: "이 게시글을 부적절한 내용으로 신고하시겠습니까?",
      confirmText: "신고하기",
      type: "warning",
      onConfirm: async () => {
        const res = await fetch("/api/board/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_type: "post", target_id: post.id, reason: "부적절한 내용" }),
        });
        if (res.ok) toast.success("신고가 접수되었습니다.");
        else {
          const data = await res.json();
          toast.error(data.error || "신고 접수 실패");
        }
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      }
    });
  };

  // 비회원 게시글/댓글 비밀번호 확인 후 삭제
  const handleGuestDeleteConfirm = async () => {
    if (!guestDeleteModal || !guestDeletePassword) {
      toast.warning("비밀번호를 입력해주세요.");
      return;
    }
    const { targetType, targetId } = guestDeleteModal;
    const endpoint = targetType === 'post'
      ? "/api/board/posts/delete"
      : "/api/board/comments/delete";
    const body = targetType === 'post'
      ? { postId: targetId, password: guestDeletePassword }
      : { commentId: targetId, password: guestDeletePassword };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) {
      toast.error(result.error || "삭제 실패");
    } else {
      toast.success("삭제되었습니다.");
      setGuestDeleteModal(null);
      if (targetType === 'post') {
        router.push("/board");
      } else {
        fetchComments();
      }
    }
  };

  const processedContent = useMemo(() => {
    let sanitizedContent = sanitizeHTML(post.content || "", mounted);
    sanitizedContent = rewriteBoardImageUrls(sanitizedContent);
    sanitizedContent = sanitizedContent
      .replace(/<p>\s*<\/p>/g, '<p class="board-empty-line"><br/></p>')
      .replace(/<p><br><\/p>/g, '<p class="board-empty-line"><br/></p>')
      .replace(/<p>&nbsp;<\/p>/g, '<p class="board-empty-line"><br/></p>')
      .replace(/<div>\s*<\/div>/g, '<div class="board-empty-line"><br/></div>');

    return sanitizedContent.replace(
      /<img/gi,
      '<img style="max-width:100%!important;height:auto!important;display:block;border-radius:8px;margin:20px auto;"'
    );
  }, [post.content, mounted]);

  const postImageUrl = toBoardImageProxyUrl(post.image_url);

  return (
    <div className="w-full flex justify-center pb-20">
      <div className="w-full max-w-[1320px] px-4 min-[1880px]:grid min-[1880px]:grid-cols-[160px_minmax(0,900px)_160px] min-[1880px]:justify-center min-[1880px]:gap-5">
        {/* 본문 영역 */}
        <div className="w-full min-w-0 min-[1880px]:col-start-2">
        {/*  어드민 승인 대기 초안 프리뷰 배너 렌더링 */}
        {post.status === 'draft' && isAdmin && (
          <div className="w-full bg-[#1e1e1e] border border-[#F2A900]/30 rounded-xl p-5 mb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-[0_0_20px_rgba(242,169,0,0.1)]">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="px-2 py-0.5 bg-[#F2A900] text-black text-[11px] font-extrabold rounded">
                  DRAFT
                </span>
                <h4 className="text-white text-base font-bold">어드민 승인 대기 초안</h4>
              </div>
              <p className="text-white/70 text-xs leading-relaxed">
                {post.parent_id 
                  ? "이미 발행된 게시글의 수정본(Shadow Draft)입니다. 승격 시 본문이 원본 글에 적용됩니다." 
                  : "신규 게시글 초안입니다. 승격 시 전체 게시판에 노출됩니다."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5 w-full md:w-auto justify-end">
              <button
                onClick={() => setShowFeedbackModal(true)}
                className="px-4 py-2.5 bg-[#252525] border border-white/20 text-white/90 text-xs font-bold rounded-lg hover:bg-[#333] hover:border-white/30 transition-all active:scale-95 shrink-0"
              >
                AI 재수정 요청
              </button>
              <button
                onClick={() => router.push(`/board/write?edit=${post.id}`)}
                className="px-4 py-2.5 bg-[#252525] border border-[#34A853]/40 text-[#34A853] text-xs font-bold rounded-lg hover:bg-[#34A853]/10 transition-all active:scale-95 shrink-0"
              >
                직접 수정
              </button>
              <button
                disabled={isPromoting}
                onClick={handlePromotePost}
                className="px-5 py-2.5 bg-[#F2A900] text-black text-xs font-black rounded-lg hover:bg-[#d49400] transition-all active:scale-95 disabled:opacity-50 shrink-0"
              >
                {isPromoting ? "승격 중..." : "실제 게시판에 승격"}
              </button>
            </div>
          </div>
        )}

        <article className={`bg-[#1a1a1a] rounded-[8px] border border-[#333] w-full box-border ${isMobile ? "p-[15px]" : "p-[30px]"}`}>
          <div className="mb-[20px]">
            <span className="text-[#F2A900] text-[13px] font-bold">[{post.category}]</span>
            <h1 className={`mt-[10px] text-white break-all font-bold ${isMobile ? "text-[24px]" : "text-[32px]"}`}>{post.title}</h1>
            <div className="text-[12px] text-[#888] mt-[12px] flex items-center gap-[10px] flex-wrap">
              <span className="inline-flex items-center gap-1.5">
                글쓴이: <span className={post.profiles?.role === "admin" ? "text-[#F2A900] font-bold" : "text-white/80"}>{post.author}</span>
                {post.profiles?.role === "admin" && <AdminBadge />}
              </span>
              <span>작성: {formatTimeAgo(post.created_at)}</span>
              <span>조회: {post.views}</span>
            </div>

            {post.discord_url && (
              <div className="mt-[20px]">
                <a
                  href={post.discord_url.startsWith('http') ? post.discord_url : `https://${post.discord_url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-[20px] py-[12px] bg-[#5865F2] hover:bg-[#4752C4] text-white font-bold rounded-[8px] no-underline shadow-lg"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-3.5485-13.6604a.061.061 0 00-.0312-.0286z" />
                  </svg>
                  디스코드 음성 채널 입장하기
                </a>
              </div>
            )}

            {post.clan_info && (
              <div className="mt-[20px] bg-gradient-to-r from-amber-500/10 via-[#F2A900]/5 to-transparent border border-[#F2A900]/30 rounded-xl p-5 flex items-center gap-4 shadow-xl max-w-2xl">
                {/* 클랜 마크/로고 데코레이션 */}
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-[#F2A900] to-amber-600 flex items-center justify-center text-black font-black text-lg shadow-[0_0_15px_rgba(242,169,0,0.3)] shrink-0">
                  {post.clan_info.tag.substring(0, 3).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 bg-[#F2A900] text-black text-[11px] font-extrabold rounded">
                      [{post.clan_info.tag}]
                    </span>
                    <h3 className="text-white text-base font-bold leading-none">{post.clan_info.name}</h3>
                    <span className="text-white/40 text-[11px]">Lv. {post.clan_info.level}</span>
                  </div>
                  {/* 멤버 현황 프로그레스 바 */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="w-28 bg-white/5 h-1.5 rounded-full overflow-hidden">
                      <div 
                        className="bg-[#F2A900] h-full rounded-full" 
                        style={{ width: `${Math.min(100, (post.clan_info.memberCount / 100) * 100)}%` }}
                      />
                    </div>
                    <span className="text-white/50 text-[11px] font-medium">멤버 {post.clan_info.memberCount} / 100명</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-y border-[#333] py-[30px] min-h-[200px] text-[#e5e5e5]">
            {post.image_url && !postImageFailed && !(post.content || "").includes(post.image_url) && (
              <Image
                priority={true}
                src={postImageUrl}
                alt="기본 이미지"
                width={800}
                height={450}
                className="w-full h-auto mb-[20px] rounded-[8px]"
                onError={() => setPostImageFailed(true)}
              />
            )}
            
            <style>{`
              .board-content { white-space: normal !important; word-break: break-word !important; font-family: inherit !important; color: #e5e5e5 !important; letter-spacing: 0 !important; line-height: 1.7 !important; }
              .board-content > * { margin-bottom: 0.95rem !important; line-height: inherit !important; }
              .board-content .board-empty-line { height: 0.65rem !important; min-height: 0 !important; margin-bottom: 0.65rem !important; line-height: 0.65rem !important; }
              .board-content .board-empty-line br { display: none !important; }
              .board-content p:empty::before, .board-content div:empty::before { content: "\\00a0" !important; display: inline-block !important; width: 100% !important; height: 0.65rem !important; }
              .board-content ul, .board-content ol { padding-left: 1.5rem !important; list-style-position: outside !important; margin-bottom: 1.1rem !important; }
              .board-content ul { list-style-type: disc !important; }
              .board-content ol { list-style-type: decimal !important; }
              .board-content li { margin-bottom: 0.45rem !important; display: list-item !important; }
              .board-content strong { color: #F2A900 !important; font-weight: 800 !important; }
              .board-content a { color: #F2A900 !important; text-decoration: underline !important; text-underline-offset: 4px !important; transition: opacity 0.2s !important; }
              .board-content a:hover { opacity: 0.7 !important; }
              
              /* 패치노트 전용 AI 요약 영역 격리 리셋 */
              .board-content .patch-note-container { white-space: normal !important; }
              .board-content .patch-note-container * { white-space: normal !important; }
              .board-content .patch-note-container p,
              .board-content .patch-note-container div,
              .board-content .patch-note-container ul,
              .board-content .patch-note-container li,
              .board-content .patch-note-container h3,
              .board-content .patch-note-container a {
                margin-bottom: 0 !important;
                line-height: inherit !important;
              }
              .board-content .patch-note-container a {
                color: #000000 !important;
                text-decoration: none !important;
              }
              .board-content .patch-note-container a:hover {
                color: #000000 !important;
                opacity: 0.8 !important;
              }
              .board-content .patch-note-container ul {
                list-style-type: none !important;
                padding-left: 0 !important;
                margin-bottom: 0 !important;
              }
              .board-content .patch-note-container li {
                display: block !important;
                margin-bottom: 0 !important;
              }
              
              .ql-snow .ql-editor { background-color: transparent !important; color: inherit !important; padding: 0 !important; }
              .ql-container.ql-snow { border: none !important; }
            `}</style>
            
            <div className="ql-container ql-snow" style={{ border: 'none', font: 'inherit', color: 'inherit' }}>
              <div dangerouslySetInnerHTML={{ __html: processedContent }} className="ql-editor board-content text-[16px]" style={{ padding: 0 }} />
            </div>
          </div>

          <div className="flex justify-end mt-[20px]">
            <button
              onClick={handleLikePost}
              disabled={isLikingPost}
              className="px-[16px] py-[8px] bg-[#252525] border border-[#F2A900] text-[#F2A900] rounded-[20px] text-[13px] hover:bg-[#F2A900] hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              추천 {post.likes}
            </button>
          </div>

          {/* 광고 — 댓글 섹션 위 (데스크톱 xl 크기 이상에서는 숨김) */}
          <div className="my-5 flex justify-center xl:hidden">
            <AdfitBanner
              adUnit="DAN-tQGcqmddMC8tPpXA"
              adWidth={320}
              adHeight={100}
            />
          </div>

          {initialCommentsHasError && (
            <div className="mb-5 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-center">
              <p className="text-sm text-red-200">댓글을 불러오는 중 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
              <button
                type="button"
                onClick={() => router.refresh()}
                className="mt-3 rounded-lg border border-red-400/30 px-3 py-1.5 text-xs font-bold text-red-200 transition-colors hover:bg-red-400/10"
              >
                다시 시도
              </button>
            </div>
          )}

          <CommentSection
            comments={comments}
            currentUser={user}
            newComment={newComment}
            setNewComment={setNewComment}
            replyingTo={replyingTo}
            setReplyingTo={setReplyingTo}
            handleDeleteComment={handleDeleteComment}
            handleReportComment={handleReportComment}
            isAdmin={isAdmin}
            handleSaveComment={() => void handleSaveComment()}
            isSubmitting={isSubmittingComment}
            isMobile={isMobile}
            formatTimeAgo={formatTimeAgo}
            guestNickname={guestNickname}
            setGuestNickname={setGuestNickname}
            guestPassword={guestPassword}
            setGuestPassword={setGuestPassword}
          />

          <div className="mt-[40px] flex gap-[10px]">
            <button onClick={() => router.push("/board")} className="flex-1 p-[12px] bg-[#333] text-white border-none rounded-[4px] hover:bg-[#444] transition-colors text-[14px]">
              목록으로
            </button>

            {/* 신고 버튼: 본인 글이 아닌 경우 표시 */}
            {user?.id !== post.user_id && post.user_id && (
              <button
                onClick={handleReportPost}
                className="px-[20px] py-[12px] bg-[#252525] border border-[#dc3545]/50 text-[#dc3545] border-solid rounded-[4px] hover:bg-[#dc3545]/10 transition-colors text-[14px]"
              >
                게시글 신고
              </button>
            )}

            {(user?.id === post.user_id || isAdmin) && (
              <button
                onClick={() => router.push(`/board/write?edit=${post.id}`)}
                className="px-[20px] py-[12px] bg-[#34A853] text-white border-none rounded-[4px] hover:bg-[#2a9040] transition-colors text-[14px]"
              >
                수정
              </button>
            )}

            {/* 삭제 버튼: 회원 본인 or 어드민 or 비회원 게시글(비밀번호 확인 모달) */}
            {(user?.id === post.user_id || isAdmin || !post.user_id) && (
              <button
                onClick={handleDeletePost}
                className="px-[20px] py-[12px] bg-[#dc3545] text-white border-none rounded-[4px] hover:bg-[#c82333] transition-colors text-[14px]"
              >
                삭제
              </button>
            )}
          </div>
        </article>
      </div>

      {/*  AI 피드백 전달 모달 창 */}
      <AppModal isOpen={showFeedbackModal} title="AI 재수정 피드백" onClose={() => { setShowFeedbackModal(false); setFeedbackText(""); }} panelClassName="max-w-lg">
          <div className="bg-[#1a1a1a] border border-[#333] rounded-2xl max-w-lg w-full p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div>
              <h3 className="text-lg font-black text-white">AI 재수정 피드백</h3>
              <p className="text-white/60 text-xs mt-1">
                AI 비서가 피드백을 기반으로 글을 다시 수정할 수 있도록 구체적으로 입력해 주세요.
              </p>
            </div>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="예: '무기 순위 분석에서 AR 카테고리의 1위 무기 장점을 표로 다시 작성해줘. 어투는 공식적인 톤으로 변경해줘.'"
              className="w-full h-32 bg-[#121212] border border-[#333] rounded-lg p-3 text-white text-sm focus:border-[#F2A900] focus:outline-none resize-none placeholder-white/20"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => {
                  setShowFeedbackModal(false);
                  setFeedbackText("");
                }}
                className="px-4 py-2.5 bg-[#252525] text-white/75 font-bold rounded-lg hover:bg-[#333] transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSendFeedbackToAI}
                className="px-4 py-2.5 bg-[#F2A900] text-black font-black rounded-lg hover:bg-[#d49400] transition-all active:scale-95"
              >
                피드백 전송
              </button>
            </div>
          </div>
      </AppModal>
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        description={confirmModal.description}
        confirmText={confirmModal.confirmText}
        type={confirmModal.type}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />

      {/* 비회원 게시글/댓글 삭제 비밀번호 확인 모달 */}
      <AppModal isOpen={Boolean(guestDeleteModal?.isOpen)} title="비밀번호 확인" onClose={() => setGuestDeleteModal(null)} panelClassName="max-w-sm">
          <div className="bg-[#1a1a1a] border border-[#333] rounded-2xl max-w-sm w-full p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-lg font-black text-white">비밀번호 확인</h3>
            <p className="text-white/60 text-sm">작성 시 등록한 비밀번호를 입력하세요.</p>
            <input
              type="password"
              value={guestDeletePassword}
              onChange={(e) => setGuestDeletePassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGuestDeleteConfirm()}
              placeholder="비밀번호"
              className="w-full bg-[#121212] border border-[#333] rounded-lg px-4 py-3 text-white text-sm focus:border-[#F2A900] focus:outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setGuestDeleteModal(null)}
                className="px-4 py-2.5 bg-[#252525] text-white/75 font-bold rounded-lg hover:bg-[#333] transition-colors text-sm"
              >
                취소
              </button>
              <button
                onClick={handleGuestDeleteConfirm}
                className="px-4 py-2.5 bg-[#dc3545] text-white font-black rounded-lg hover:bg-[#c82333] transition-all active:scale-95 text-sm"
              >
                삭제
              </button>
            </div>
          </div>
      </AppModal>

      {/* 비회원 댓글 Turnstile 보안 인증 모달 */}
      <AppModal isOpen={showCaptcha} title="보안 인증" onClose={() => setShowCaptcha(false)} panelClassName="max-w-sm">
          <div className="bg-[#1a1a1a] border border-[#333] rounded-2xl max-w-sm w-full p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div>
              <h3 className="text-base font-black text-white">보안 인증</h3>
              <p className="text-white/50 text-xs mt-1">
                비회원 댓글을 등록하려면 보안 인증을 완료해주세요.
              </p>
            </div>
            <TurnstileWidget
              action={TURNSTILE_ACTIONS.comment}
              onVerify={handleTurnstileVerify}
              onError={() => {
                toast.error("보안 인증 중 오류가 발생했습니다.");
                setShowCaptcha(false);
              }}
            />
            <button
              onClick={() => {
                setShowCaptcha(false);
              }}
              className="text-xs text-white/30 hover:text-white/60 transition-colors text-center"
            >
              취소
            </button>
          </div>
      </AppModal>
      {/* 좌우 레일은 같은 기준과 sticky 오프셋을 사용해 스크롤 위치를 맞춘다. */}
      <aside
        className="hidden min-[1880px]:block min-[1880px]:col-start-1 min-[1880px]:row-start-1"
        aria-label="광고"
      >
        <div className="sticky top-20 h-[600px] w-[160px]">
          <AdSenseBanner client="ca-pub-3993032200487955" slot="7728921550" />
        </div>
      </aside>
      <aside
        className="hidden min-[1880px]:block min-[1880px]:col-start-3 min-[1880px]:row-start-1"
        aria-label="광고"
      >
        <div className="sticky top-20 h-[600px] w-[160px]">
          <AdfitBanner adUnit="DAN-RjyosR2uf8eSsVIC" adWidth={160} adHeight={600} />
        </div>
      </aside>
    </div>
  </div>
  );
}
