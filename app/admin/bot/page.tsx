"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import AdminAgentChat from "@/components/admin/AdminAgentChat";
import CommunityAgentPanel from "@/components/admin/CommunityAgentPanel";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export default function AdminBotPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [prefillPrompt, setPrefillPrompt] = useState("");
  const [prefillVersion, setPrefillVersion] = useState(0);
  const [autoSend, setAutoSend] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "community">("chat");

  useEffect(() => {
    async function checkAdmin() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .maybeSingle();

      if (profile?.role === "admin") {
        setIsAdmin(true);
      } else {
        setIsAdmin(false);
        toast.error("관리자 권한이 없습니다.");
        router.push("/");
      }
    }

    checkAdmin();
  }, [router]);

  useEffect(() => {
    if (!isAdmin) return;

    const params = new URLSearchParams(window.location.search);
    const approvalId = params.get("approval");
    const section = params.get("section");
    const prompt = params.get("prompt");
    const action = params.get("action");
    const postId = params.get("postId");
    const text = params.get("text");

    if (approvalId) {
      router.replace(`/admin/dashboard?section=approvals&approval=${encodeURIComponent(approvalId)}`);
      return;
    }

    if (section && ["approvals", "status", "memories", "guide", "today"].includes(section)) {
      router.replace(`/admin/dashboard?section=${encodeURIComponent(section)}`);
      return;
    }

    if (action === "feedback" && postId && text) {
      const fetchAndSetPrompt = async () => {
        try {
          // 1. 현재 수정하려는 초안(또는 원본) 글 조회
          const { data: post } = await supabase
            .from("posts")
            .select("title, content, parent_id")
            .eq("id", Number(postId))
            .single();

          const originalTitle = post?.title || "";
          const originalContent = post?.content || "";
          let rootOriginalContent = "";

          // 2. 만약 수정 초안(parent_id 존재)이라면 최상위 원본 글(published이거나 parent_id가 없는 글)을 찾을 때까지 거슬러 올라가며 본문 조회
          let currentParentId = post?.parent_id;
          let rootPostData = null;

          while (currentParentId) {
            const { data: parentPost } = await supabase
              .from("posts")
              .select("id, content, parent_id, status")
              .eq("id", currentParentId)
              .single();

            if (!parentPost) break;
            rootPostData = parentPost;

            if (parentPost.status === "published" || !parentPost.parent_id) {
              break;
            }
            currentParentId = parentPost.parent_id;
          }

          if (rootPostData) {
            rootOriginalContent = rootPostData.content || "";
          }

          const feedbackPrompt = `[게시글 수정 피드백]
- 대상 게시글 ID: ${postId}
- 현재 수정 대상 제목: ${originalTitle}
- 현재 수정 대상 본문(HTML):
${originalContent}

${rootOriginalContent ? `- 최상위 원본 본문(원래 포함되었던 이미지 태그 참고용):
${rootOriginalContent}
` : ""}
- 피드백 및 지시사항: ${text}

위 피드백 사항을 반영하여 해당 게시글의 본문을 수정(update_board_post)해줘.

[반드시 준수해야 할 정밀 제약조건]
1. 이미지 보존: 원본 본문(또는 최상위 원본 본문)에 포함되어 있는 기존 이미지 태그(<img src="...">)는 주소를 제멋대로 가상의 임시 주소(example.com 등)로 가공하거나 누락하지 말고, 원래의 Supabase/R2 스토리지 이미지 주소 그대로 위치를 유지하여 본문 중간에 반드시 포함해야 해. <img> 태그를 누락하거나 주소를 변조하면 스토리지에서 이미지가 영구 삭제되니 절대 주의해.
2. 본문 내용 보존: 기존 본문의 유익하고 상세한 설명(내용)을 제멋대로 축약하거나 잘라먹어 너무 짧게 만들지 말고, 전체 글의 뼈대와 상세 텍스트 흐름을 그대로 유지하면서 피드백의 지시사항만 자연스럽게 반영해줘.`;

          setPrefillPrompt(feedbackPrompt);
          setPrefillVersion((value) => value + 1);
          setAutoSend(true);
        } catch (err) {
          console.error("Failed to fetch post context for feedback:", err);
          // 실패 시 최소한의 피드백 프롬프트로 폴백
          const fallbackPrompt = `[게시글 수정 피드백]
- 대상 게시글 ID: ${postId}
- 피드백 내용: ${text}

위 피드백 사항을 반영하여 해당 게시글의 본문을 수정(update_board_post)해줘. 기존 내용 및 원본 <img> 태그들을 반드시 누락 없이 복사하여 유지해야 해.`;
          setPrefillPrompt(fallbackPrompt);
          setPrefillVersion((value) => value + 1);
          setAutoSend(true);
        }
      };

      fetchAndSetPrompt();

      // 주소창의 쿼리 스트링 청소
      const newUrl = window.location.pathname;
      window.history.replaceState({}, "", newUrl);
      return;
    }

    if (prompt) {
      setPrefillPrompt(prompt);
      setPrefillVersion((value) => value + 1);
      setAutoSend(false);

      const newUrl = window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, [isAdmin, router]);

  if (isAdmin === null) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-950 text-zinc-400">
        <Loader2 className="mr-2 h-6 w-6 animate-spin text-amber-500" />
        <span className="text-sm font-medium">관리자 권한 조회 중...</span>
      </div>
    );
  }

  return (
    <>
      <nav aria-label="관리 비서 화면" className="sticky top-0 z-20 flex gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 sm:px-4">
        <button type="button" aria-pressed={activeTab === "chat"} onClick={() => setActiveTab("chat")} className="rounded-lg px-3 py-2 aria-pressed:bg-amber-500/15 aria-pressed:text-amber-200">관리자 대화</button>
        <button type="button" aria-pressed={activeTab === "community"} onClick={() => setActiveTab("community")} className="rounded-lg px-3 py-2 aria-pressed:bg-amber-500/15 aria-pressed:text-amber-200">커뮤니티 운영</button>
      </nav>
      {activeTab === "community" ? <CommunityAgentPanel /> : (
        <AdminAgentChat
          mode="page"
          prefillPrompt={prefillPrompt}
          prefillVersion={prefillVersion}
          autoSend={autoSend}
          onBack={() => router.push("/admin/dashboard")}
          onOpenDashboard={() => router.push("/admin/dashboard")}
          onOpenApprovals={(approvalId) => {
            if (approvalId) {
              router.push(`/admin/dashboard?section=approvals&approval=${encodeURIComponent(approvalId)}`);
              return;
            }
            router.push("/admin/dashboard?section=approvals");
          }}
        />
      )}
    </>
  );
}
