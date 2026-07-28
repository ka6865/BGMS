'use client';

import React, { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import BoardWrite from "../BoardWrite";
import { useAuth } from "../AuthProvider";
import { supabase } from "@/lib/supabase";
import { validatePost, extractImageUrl, sanitizeTitle } from "@/lib/board-utils";
import { toast } from "sonner";
import type { ClanInfo } from "@/types/board";
import { trackEvent } from "@/lib/analytics";
import TurnstileWidget from "./TurnstileWidget";
import { TURNSTILE_ACTIONS } from "@/lib/board/turnstileContract";
import { svgIcon, type SvgIconName } from "@/lib/ui/icon-svg";

export default function BoardWriteClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editPostId = searchParams?.get("edit");
  const { user } = useAuth();

  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState("자유");
  const [newDiscordUrl, setNewDiscordUrl] = useState("");
  const [newDiscordChannelId, setNewDiscordChannelId] = useState("");
  const [newIsNotice, setNewIsNotice] = useState(false);
  const [newClanInfo, setNewClanInfo] = useState<ClanInfo | null>(null); // 🌟 추가
  const [isLoading, setIsLoading] = useState(false);
  
  // 🌟 비회원용 상태 추가
  const [guestNickname, setGuestNickname] = useState("");
  const [guestPassword, setGuestPassword] = useState("");
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileGeneration, setTurnstileGeneration] = useState(0);

  const [isAdmin, setIsAdmin] = useState(false);
  const [displayName, setDisplayName] = useState("익명");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (user) {
      supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => {
        if (data) {
          setIsAdmin(data.role === "admin");
          setDisplayName(data.nickname || "익명");
        }
      });
    }
  }, [user]);

  // 수정 모드일 때 기존 데이터 페칭
  useEffect(() => {
    if (editPostId) {
      supabase.from("posts").select("*, revision").eq("id", editPostId).single().then(({ data }) => {
        if (data) {
          setNewTitle(data.title);
          setNewContent(data.content || "");
          setNewCategory(data.category);
          setNewDiscordUrl(data.discord_url || "");
          setNewDiscordChannelId(data.discord_channel_id || "");
          setNewIsNotice(data.is_notice);
          setNewClanInfo(data.clan_info || null); // 🌟 추가
          setThumbnailUrl(data.image_url || ""); // 🌟 추가
          setExpectedRevision(typeof data.revision === "number" ? data.revision : null);
        }
      });
    }
  }, [editPostId]);

  const handleSavePost = async (images: { contentImageIds: string[]; thumbnailImageId: string | null }): Promise<boolean> => {
    const isGuest = !user;
    const validationError = validatePost(newTitle, newContent, user, isGuest, guestNickname, guestPassword);
    if (validationError) {
      toast.error(validationError);
      return false;
    }
    if (!user && !editPostId && !turnstileToken) {
      toast.warning("비회원 글쓰기를 위해 보안 인증을 완료해주세요.");
      return false;
    }

    setIsLoading(true);

    try {
      const trimmedTitle = sanitizeTitle(newTitle);
      // 🌟 AI 요약본 HTML 구조 복원 적용
      const finalContent = restoreAiSummaryHtml(newContent);
      // 🌟 수동 지정 썸네일 우선 적용, 없으면 본문 첫 이미지 자동 추출
      const finalImageUrl = thumbnailUrl || extractImageUrl(finalContent);

      const payload = {
        title: trimmedTitle,
        content: finalContent,
        category: newCategory,
        image_url: finalImageUrl,
        is_notice: isAdmin ? newIsNotice : false,
        author: user ? displayName : guestNickname,
        user_id: user ? user.id : null,
        password: user ? null : guestPassword, // 🌟 비회원 비밀번호 추가
        editingPostId: editPostId ? Number(editPostId) : null,
        discord_url: newDiscordUrl,
        discord_channel_id: newDiscordChannelId,
        clan_info: newClanInfo, // 🌟 추가
        turnstileToken: user || editPostId ? null : turnstileToken,
        expectedRevision: editPostId ? expectedRevision : null,
        contentImageIds: user ? images.contentImageIds : [],
        thumbnailImageId: user ? images.thumbnailImageId : null,
      };

      const response = await fetch("/api/posts/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        throw new Error(result.error || "서버 저장 중 오류가 발생했습니다.");
      }

      trackEvent({
        name: "post_action",
        params: {
          action: "create_post",
          status: "success"
        }
      });

      toast.success(editPostId ? "게시글이 수정되었습니다." : "새 게시글이 등록되었습니다.");
      
      // 🌟 API 응답 구조({ data: { id } })에 맞게 수정
      const newPostId = result.data?.id || editPostId;
      
      if (newPostId) {
        // 수정 완료 후에는 깨끗한 URL로 이동
        router.push(`/board/${newPostId}`);
      } else {
        router.push("/board");
      }
      return true;
    } catch (error: any) {
      trackEvent({
        name: "post_action",
        params: {
          action: "create_post",
          status: "fail",
          error_type: error.message || "Unknown error"
        }
      });
      toast.error(error.message || "게시글을 저장하지 못했습니다.");
      return false;
    } finally {
      setIsLoading(false);
      if (!user && !editPostId) {
        setTurnstileToken(null);
        setTurnstileGeneration((value) => value + 1);
      }
    }
  };

  const handleSetIsWriting = (val: boolean) => {
    if (!val) {
      router.back();
    }
  };

  return (
    <div className="w-full flex justify-center pb-6 pt-3 bg-[#121212] min-h-[calc(100vh-56px)]">
      <div className="w-full max-w-[900px]">
        {!user && !editPostId && (
          <section
            aria-label="비회원 보안 인증"
            className="mb-3 rounded-lg border border-white/10 bg-[#1a1a1a] p-3"
          >
            <TurnstileWidget
              key={turnstileGeneration}
              action={TURNSTILE_ACTIONS.post}
              onVerify={setTurnstileToken}
              onError={() => setTurnstileToken(null)}
            />
          </section>
        )}
        <BoardWrite
          newTitle={newTitle}
          setNewTitle={setNewTitle}
          newContent={newContent}
          setNewContent={setNewContent}
          newCategory={newCategory}
          setNewCategory={setNewCategory}
          newDiscordUrl={newDiscordUrl}
          setNewDiscordUrl={setNewDiscordUrl}
          newDiscordChannelId={newDiscordChannelId}
          setNewDiscordChannelId={setNewDiscordChannelId}
          newIsNotice={newIsNotice}
          setNewIsNotice={setNewIsNotice}
          newClanInfo={newClanInfo} // 🌟 추가
          setNewClanInfo={setNewClanInfo} // 🌟 추가
          thumbnailUrl={thumbnailUrl} // 🌟 추가
          setThumbnailUrl={setThumbnailUrl} // 🌟 추가
          handleSavePost={handleSavePost}
          setIsWriting={handleSetIsWriting}
          isAdmin={isAdmin}
          isLoading={isLoading}
          isMobile={isMobile}
          isEditing={!!editPostId}
          isGuest={!user}
          guestNickname={guestNickname}
          setGuestNickname={setGuestNickname}
          guestPassword={guestPassword}
          setGuestPassword={setGuestPassword}
        />
      </div>
    </div>
  );
}

/**
 * Quill 에디터가 날려버린 AI 요약본 테일윈드 반응형 HTML 구조를
 * 저장 직전 DOM 파서를 통해 정밀 역파싱하여 이쁜 그리드 카드로 강제 재조립하는 헬퍼 함수
 */
function restoreAiSummaryHtml(content: string): string {
  // 만약 AI 요약 영역이 아예 없거나 이미 깨끗한 패치노트 구조가 감싸져 있다면 원본 그대로 반환
  if (!content.includes("BGMS AI") || content.includes("patch-note-container")) {
    return content;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    
    // AI 요약 타이틀 헤더 찾기
    const allHeaders = Array.from(doc.querySelectorAll('h2, h3, h4, p, div'));
    const titleEl = allHeaders.find(el => {
      const text = el.textContent || "";
      return text.includes("BGMS AI") || text.includes("핵심 요약");
    });

    if (!titleEl) return content;

    const sections: { title: string; items: string[] }[] = [];
    let currentTitle = "";
    let currentItems: string[] = [];
    
    // 제거할 엘리먼트들을 담아둘 배열
    const elementsToRemove: Element[] = [];

    // AI 요약 타이틀 노드 다음의 형제 엘리먼트들을 순회하며 섹션과 불렛포인트 파싱
    let sibling = titleEl.nextElementSibling;
    while (sibling) {
      const text = (sibling.textContent || "").trim();
      const tagName = sibling.tagName.toLowerCase();

      // 만약 공식 사이트 링크(a)나 하단 종료 멘트가 감지되면 수집을 중단
      if (text.includes("더 자세한 내용은") || sibling.querySelector('a[href*="pubg.com"]') || text.includes("원문 보러가기")) {
        break;
      }

      const isSectionTitle = 
        (tagName.startsWith('h') && text.includes('[') && text.includes(']')) ||
        (tagName === 'p' && (
          /^[🔹⚙️⚖️🛠️🗺️🔫]/u.test(text) ||
          (text.startsWith('[') && text.endsWith(']'))
        ));

      if (isSectionTitle) {
        if (currentTitle) {
          sections.push({ title: currentTitle, items: [...currentItems] });
        }
        currentTitle = text;
        currentItems = [];
        elementsToRemove.push(sibling);
      } else if (tagName === 'ul') {
        const lis = sibling.querySelectorAll('li');
        lis.forEach(li => {
          let liHtml = li.innerHTML || "";
          // 앞부분의 불필요한 마커들(✓, -, *, • 및 공백 문자 등) 제거
          liHtml = liHtml
            .replace(/^[✓\-\*•\s&nbsp;]+/g, "")
            .trim();
          if (liHtml && !/^[#\s]+$/.test(liHtml)) {
            currentItems.push(liHtml);
          }
        });
        elementsToRemove.push(sibling);
      } else if (tagName === 'p' && text.length > 0) {
        // 간혹 ul이 아니라 일반 p 문단으로 리스트가 들어오는 경우 대응
        let pText = sibling.innerHTML || "";
        pText = pText.replace(/^[✓\-\*•\s&nbsp;]+/g, "").trim();
        if (pText && !/^[#\s]+$/.test(pText)) {
          currentItems.push(pText);
        }
        elementsToRemove.push(sibling);
      }
      
      sibling = sibling.nextElementSibling;
    }

    if (currentTitle) {
      sections.push({ title: currentTitle, items: [...currentItems] });
    }

    // 파싱된 데이터가 하나도 없으면 원본 그대로 반환
    if (sections.length === 0) return content;

    // 파싱에 사용된 기존 노드들 제거
    elementsToRemove.forEach(el => el.remove());

    const getSectionIconName = (title: string): SvgIconName => {
      if (title.includes("의도") || title.includes("배경") || title.includes("목표")) return "info";
      if (title.includes("일반전") || title.includes("경쟁전") || title.includes("모드")) return "map";
      if (title.includes("피해") || title.includes("시스템") || title.includes("데미지")) return "zap";
      if (title.includes("무기") || title.includes("아이템")) return "weapon";
      if (title.includes("맵") || title.includes("월드")) return "map";
      return "info";
    };

    // 2열 그리드로 정렬하여 HTML 조립
    const cardsHtml = sections.map(sec => {
      // 괄호 및 기존 이모지 다듬기
      let rawTitle = sec.title.replace(/[\[\]]/g, "").trim();
      const matchedEmoji = rawTitle.match(/^[🔹⚙️⚖️🛠️🗺️🔫]\ufe0f?/u);
      if (matchedEmoji) {
        rawTitle = rawTitle.replace(/^[🔹⚙️⚖️🛠️🗺️🔫]\ufe0f?\s*/u, "").trim();
      }
      const sectionIcon = svgIcon(getSectionIconName(rawTitle), {
        color: "#F2A900",
        size: 15,
      });

      const itemsHtml = sec.items.map(item => {
        // 볼드 마커(**텍스트**)가 깨져서 문단에 남아있을 경우 strong 태그로 치환
        const highlighted = item.replace(/\*\*(.*?)\*\*/g, '<strong class="text-[#F2A900] font-black">$1</strong>');
        return `
          <li class="relative pl-4 text-gray-300 text-xs md:text-sm leading-normal mb-1.5 list-none">
            <span class="absolute left-0 top-0 text-[#F2A900] font-bold">✓</span>
            ${highlighted}
          </li>
        `;
      }).join("");

      return `
        <div class="bg-[#1a1a1a] border border-white/5 rounded-lg p-4 shadow-md transition-all hover:border-white/10 hover:shadow-lg">
          <div class="text-[#F2A900] text-sm md:text-base font-black mb-2 flex items-center gap-1.5 border-b border-white/5 pb-1.5">
            ${sectionIcon} ${rawTitle}
          </div>
          <ul class="space-y-1 m-0 p-0">${itemsHtml}</ul>
        </div>
      `;
    }).join("");

    // 원문 링크 주소 찾기
    const aLink = doc.querySelector('a[href*="pubg.com"]');
    const originUrl = aLink ? aLink.getAttribute('href') : "";

    // 마무리 문구와 원문 링크 노드들 일괄 제거
    let linkSibling = titleEl.nextElementSibling;
    while (linkSibling) {
      const next = linkSibling.nextElementSibling;
      linkSibling.remove();
      linkSibling = next;
    }

    // 테일윈드 코드로 조립
    const restoredLayout = `
      <div class="patch-note-container space-y-4">
        <div class="bg-[#F2A900]/10 border border-[#F2A900]/30 rounded-lg p-4 mb-1">
          <h3 class="flex items-center gap-1.5 text-[#F2A900] font-black text-base md:text-lg">
            ${svgIcon("zap", { color: "#F2A900", size: 16 })} BGMS AI 배그 소식 핵심 요약
          </h3>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${cardsHtml}
        </div>

        <div class="flex flex-col items-center justify-center p-6 bg-[#1a1a1a] rounded-lg border border-white/5">
          <p class="text-gray-400 text-xs mb-3">더 자세한 내용은 공식 원문에서 확인하실 수 있습니다.</p>
          <a href="${originUrl || 'https://pubg.com/ko/news'}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-6 py-2.5 bg-[#F2A900] text-black font-black text-sm rounded hover:bg-[#cc8b00] transition-all transform active:scale-95 shadow-md shadow-[#F2A900]/20">${svgIcon("info", { color: "currentColor", size: 14 })} 원문 보러가기</a>
        </div>
      </div>
    `;

    // titleEl 자리를 복원된 레이아웃으로 치환
    titleEl.outerHTML = "<!-- RESTORED_AI_SUMMARY -->";
    
    let finalHtml = doc.body.innerHTML;
    finalHtml = finalHtml.replace("<!-- RESTORED_AI_SUMMARY -->", restoredLayout);
    
    return finalHtml;
  } catch {
    return content;
  }
}
