"use client";

import { useMemo } from "react";
import { Comment } from "../types/board";
import type { CurrentUser } from "../types/map";

interface CommentSectionProps {
  comments: Comment[];
  currentUser: CurrentUser | null;
  newComment: string;
  setNewComment: (comment: string) => void;
  replyingTo: Comment | null;
  setReplyingTo: (comment: Comment | null) => void;
  handleSaveComment: () => void;
  handleDeleteComment: (commentId: number) => void;
  handleReportComment: (commentId: number) => void;
  /** 등록 요청 진행 여부. 중복 제출을 막기 위해 버튼을 비활성화한다. */
  isSubmitting?: boolean;
  // 비회원 입력 상태
  guestNickname: string;
  setGuestNickname: (v: string) => void;
  guestPassword: string;
  setGuestPassword: (v: string) => void;
  isAdmin: boolean;
  isMobile: boolean;
  formatTimeAgo: (dateString: string) => string;
}

const maskIp = (ip: string | null | undefined): string => {
  if (!ip) return "";
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length >= 2) {
      return `${parts[0]}.${parts[1]}`;
    }
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}`;
    }
  }
  return ip;
};

// 게시물 상세 화면 내 하위 댓글 및 대댓글 UI 출력 컴포넌트
export default function CommentSection({
  comments,
  currentUser,
  newComment,
  setNewComment,
  replyingTo,
  setReplyingTo,
  handleSaveComment,
  handleDeleteComment,
  handleReportComment,
  isSubmitting = false,
  guestNickname,
  setGuestNickname,
  guestPassword,
  setGuestPassword,
  isAdmin,
  isMobile,
  formatTimeAgo,
}: CommentSectionProps) {
  // 다중 계층 렌더링 성능 향상을 위한 부모 ID(parent_id) 기준 데이터 Map 구조화
  const commentsByParent = useMemo(() => {
    const map = new Map<number | null, Comment[]>();
    comments.forEach((c) => {
      const pid = c.parent_id || null;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(c);
    });
    return map;
  }, [comments]);

  // 대댓글 출력용 재귀 함수
  const renderComments = (parentId: number | null, depth = 0) => {
    const list = commentsByParent.get(parentId);
    if (!list || list.length === 0) return null;

    return list.map((c) => (
      <div
        key={c.id}
        className={`mt-[10px] ${
          depth > 0 ? (isMobile ? "ml-[10px]" : "ml-[20px]") : "ml-0"
        }`}
      >
        <div
          className={`p-[15px] rounded-[8px] ${
            depth > 0
              ? "bg-[#2a2a2a] border-l-[3px] border-[#F2A900]"
              : "bg-[#222] border-l-[3px] border-[#34A853]"
          }`}
        >
          <div className="flex justify-between mb-[6px]">
            <div className="flex items-center gap-[8px] flex-wrap">
              {depth > 0 && (
                <span className="text-[#F2A900] text-[12px]">ㄴ</span>
              )}
              <span
                className={`text-[13px] font-bold ${
                  depth > 0 ? "text-[#F2A900]" : "text-[#34A853]"
                }`}
              >
                {c.author}
              </span>
              {/* 비회원 IP 배지 */}
              {!c.user_id && c.ip_address && (
                <span className="text-[11px] text-white/30 font-mono">
                  ({maskIp(c.ip_address)})
                </span>
              )}
              <span className="text-[11px] text-[#666]">
                {formatTimeAgo(c.created_at)}
              </span>
            </div>

            <div className="flex gap-[10px]">
              {currentUser && (
                <button
                  onClick={() => {
                    setReplyingTo(c);
                    setNewComment("");
                  }}
                  className="bg-transparent border-none text-[#aaa] text-[12px] cursor-pointer underline hover:text-white transition-colors"
                >
                  답글
                </button>
              )}
              {/* 회원 본인 댓글 또는 어드민 삭제 */}
              {(currentUser?.id === c.user_id || isAdmin) && (
                <button
                  onClick={() => handleDeleteComment(c.id)}
                  className="bg-transparent border-none text-[#dc3545] text-[12px] cursor-pointer underline hover:text-[#ff4d4d] transition-colors"
                >
                  삭제
                </button>
              )}
              {/* 비회원 본인 댓글 삭제 (비밀번호 모달로 연동) */}
              {!c.user_id && !isAdmin && (
                <button
                  onClick={() => handleDeleteComment(c.id)}
                  className="bg-transparent border-none text-[#dc3545] text-[12px] cursor-pointer underline hover:text-[#ff4d4d] transition-colors"
                >
                  삭제
                </button>
              )}
              {/* 신고 버튼 (본인 댓글 제외) */}
              {currentUser?.id !== c.user_id && (
                <button
                  onClick={() => handleReportComment(c.id)}
                  className="bg-transparent border-none text-[#999] text-[12px] cursor-pointer underline hover:text-[#F2A900] transition-colors"
                >
                  신고
                </button>
              )}
            </div>
          </div>

          <div className="text-[14px] text-[#ddd] leading-[1.5] break-all">
            {c.content}
          </div>
        </div>
        {renderComments(c.id, depth + 1)}
      </div>
    ));
  };

  const isGuest = !currentUser;

  return (
    <div className="mt-[40px]">
      <h3 className="text-[#F2A900] m-0 mb-[20px] font-bold text-[18px]">
        댓글 ({comments.length})
      </h3>

      <div className="flex flex-col gap-[5px]">{renderComments(null, 0)}</div>

      {/* 댓글 작성 폼 - 회원/비회원 모두 가능 */}
      <div className="mt-[25px] flex flex-col gap-[10px]">
        {/* 비회원 전용: 닉네임/비밀번호 입력 필드 */}
        {isGuest && (
          <div className="flex gap-[8px]">
            <input
              type="text"
              value={guestNickname}
              onChange={(e) => setGuestNickname(e.target.value)}
              placeholder="닉네임 (최대 20자)"
              maxLength={20}
              className="flex-1 bg-[#111] border border-[#333] rounded-[4px] px-[10px] py-[8px] text-[13px] text-white outline-none focus:border-[#F2A900] transition-colors"
            />
            <input
              type="password"
              value={guestPassword}
              onChange={(e) => setGuestPassword(e.target.value)}
              placeholder="비밀번호 (4~20자)"
              maxLength={20}
              className="w-[140px] bg-[#111] border border-[#333] rounded-[4px] px-[10px] py-[8px] text-[13px] text-white outline-none focus:border-[#F2A900] transition-colors"
            />
          </div>
        )}

        {replyingTo && (
          <div className="text-[13px] text-[#F2A900] flex items-center gap-[10px]">
            <span>
              ㄴ <strong>{replyingTo.author}</strong>님에게 답글 중
            </span>
            <button
              onClick={() => {
                setReplyingTo(null);
                setNewComment("");
              }}
              className="bg-transparent border-none text-[#666] cursor-pointer text-[12px] hover:text-white transition-colors"
            >
              취소
            </button>
          </div>
        )}

        <div className="flex gap-[8px]">
          <div className="flex-1 flex bg-[#111] border border-[#333] rounded-[4px] focus-within:border-[#F2A900] transition-colors p-[10px] gap-[8px] items-start">
            {replyingTo && (
              <span className="text-[#F2A900] font-bold text-[13px] whitespace-nowrap pt-[2px] select-none">
                @{replyingTo.author}
              </span>
            )}

            <textarea
              id="comment-textarea"
              name="comment_content"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={
                replyingTo ? "답글 내용을 입력하세요..." : "댓글 입력..."
              }
              className="flex-1 h-[60px] bg-transparent border-none resize-none outline-none text-white p-0 m-0"
              spellCheck={false}
              style={{ color: "#ffffff", WebkitTextFillColor: "#ffffff" }}
            />
          </div>

          <button
            onClick={handleSaveComment}
            disabled={isSubmitting}
            className="bg-[#34A853] border-none rounded-[4px] w-[60px] font-bold text-[13px] hover:bg-[#2a9040] transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: "#ffffff", WebkitTextFillColor: "#ffffff" }}
          >
            {isSubmitting ? "전송" : replyingTo ? "답글" : "등록"}
          </button>
        </div>

        {isGuest && (
          <p className="text-[11px] text-white/30 m-0">
            비회원으로 작성 시 삭제를 위해 비밀번호가 필요합니다.
          </p>
        )}
      </div>
    </div>
  );
}
