import React from 'react';
import Link from 'next/link';
import { Image } from 'lucide-react';
import { InlineIconLabel } from '@/components/common/InlineIconLabel';
import { Post } from '@/types/board';

const ImageIcon = () => (
  <Image size={13} className="text-emerald-400 ml-[5px] shrink-0 inline-block" aria-label="이미지 포함" />
);

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

interface PostItemProps {
  post: Post;
  isMobile: boolean;
  onClickDesktop: () => void;
  formatTimeAgo: (dateString: string) => string;
}

export default function PostItem({ post, isMobile, onClickDesktop, formatTimeAgo }: PostItemProps) {
  const isPubgNews = post.category === "배그 소식";

  if (isMobile) {
    return (
      <li className={`border-b border-white/5 ${post.is_notice ? "bg-[#F2A900]/5" : ""}`}>
        <Link href={`/board/${post.id}`} className="flex flex-col gap-2 p-4 px-5 active:bg-white/5 transition-colors">
          <div className="flex justify-between items-center mb-0.5">
            <span className={`text-[10px] font-bold tracking-wider uppercase px-2.5 py-0.5 rounded-full ${
              post.is_notice 
                ? 'text-[#F2A900] bg-[#F2A900]/20 border border-[#F2A900]/30' 
                : isPubgNews 
                  ? 'text-white/70 bg-white/10 border border-white/20'
                  : 'text-white/40 bg-white/5 border border-white/10'
            }`}>
              {post.is_notice ? (
                <InlineIconLabel icon="message" iconSize={11}>공지</InlineIconLabel>
              ) : post.category}
            </span>
            <span className="text-[11px] text-white/30 font-medium">{formatTimeAgo(post.created_at)}</span>
          </div>
          <div className="flex items-start gap-1.5">
            <span className={`text-[15px] leading-snug break-all ${post.is_notice ? "text-[#F2A900] font-bold" : "text-white/90 font-semibold"}`}>
              {post.title}
            </span>
            {post.image_url && <ImageIcon />}
            {(post.comment_count || 0) > 0 && (
              <span className="text-[12px] text-[#F2A900]/60 mt-0.5 flex items-center gap-0.5 font-bold">
                [{post.comment_count}]
              </span>
            )}
          </div>
          <div className="flex justify-between items-center text-[11.5px] mt-1">
            <div className="flex items-center gap-1.5">
              <span className="text-white/50 font-medium">{post.author}</span>
              {/* 비회원 게시글 IP 배지 */}
              {!post.user_id && post.ip_address && (
                <span className="text-[10px] text-white/25 font-mono">({maskIp(post.ip_address)})</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-white/30">
              <span>조회 {post.views}</span>
              <span className="w-0.5 h-0.5 rounded-full bg-white/20"></span>
              <span>추천 {post.likes}</span>
            </div>
          </div>
        </Link>
      </li>
    );
  }

  return (
    <tr 
      className={`border-b border-white/5 hover:bg-white/[0.03] transition-all cursor-pointer group ${
        post.is_notice ? "bg-[#F2A900]/5" : ""
      }`} 
      onClick={onClickDesktop}
    >
      <td className={`p-4 pl-5 border-l-2 ${post.is_notice ? 'border-[#F2A900]' : 'border-transparent'}`}>
        <span className={`text-[10px] font-bold tracking-wider px-2.5 py-1 rounded-full whitespace-nowrap inline-block ${
          post.is_notice 
            ? 'text-[#F2A900] bg-[#F2A900]/20 border border-[#F2A900]/30' 
            : isPubgNews 
              ? 'text-white/70 bg-white/10 border border-white/20'
              : 'text-white/40 bg-white/5 border border-white/10'
        }`}>
          {post.is_notice ? "공지" : post.category}
        </span>
      </td>
      <td className="p-4 py-5">
        <div className="flex items-center gap-1.5">
          <span className={`text-[14px] transition-colors group-hover:text-white ${
            post.is_notice ? "text-[#F2A900] font-bold" : "text-white/90 font-semibold"
          }`}>
            {post.title}
          </span>
          {post.image_url && <ImageIcon />}
          {(post.comment_count || 0) > 0 && (
            <span className="text-[12px] text-[#F2A900]/70 font-bold ml-1">
              [{post.comment_count}]
            </span>
          )}
        </div>
      </td>
      <td className="p-4 text-white/50 font-medium whitespace-nowrap text-[13px]">
        <div className="flex items-center gap-1.5">
          <span>{post.author}</span>
          {/* 비회원 게시글 IP 배지 */}
          {!post.user_id && post.ip_address && (
            <span className="text-[11px] text-white/25 font-mono">({maskIp(post.ip_address)})</span>
          )}
        </div>
      </td>
      <td className="p-4 text-white/30 whitespace-nowrap text-[12px] font-medium">{formatTimeAgo(post.created_at)}</td>
      <td className="p-4 text-white/30 text-[12px]">{post.views}</td>
      <td className={`p-4 pr-5 ${post.likes >= 5 ? 'font-bold' : ''}`}>
        <span className={post.likes >= 5 ? "text-[#F2A900] bg-[#F2A900]/15 border border-[#F2A900]/20 px-2 py-0.5 rounded-full text-[12px]" : "text-white/30 text-[12px]"}>
          {post.likes}
        </span>
      </td>
    </tr>
  );
}
