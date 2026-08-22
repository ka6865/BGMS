// 게시글 및 하위 댓글 데이터 구조 타입 명세 인터페이스

export interface Comment {
  id: number;
  post_id: number;
  user_id: string | null;
  author: string;
  content: string;
  created_at: string;
  parent_id: number | null;
  ip_address?: string | null;
  profiles?: { nickname: string; role?: string } | null;
}

export interface ClanInfo {
  id: string;
  name: string;
  tag: string;
  level: number;
  memberCount: number;
}

export interface Post {
  id: number;
  title: string;
  content: string;
  author: string;
  user_id: string | null;
  category: string;
  image_url: string;
  discord_url?: string; // 🌟 디스코드 채널 링크 필드 추가
  discord_channel_id?: string; // 🌟 디스코드 채널 ID 추가 (자동 삭제용)
  is_notice: boolean;
  created_at: string;
  views: number;
  likes: number;
  comment_count?: number;
  comments?: { count: number }[];
  clan_info?: ClanInfo | null; // 🌟 클랜 정보 첨부 필드 추가
  ip_address?: string | null;
  status?: "published" | "draft" | "hidden";
  revision: number;
  parent_id: number | null;
  profiles?: { nickname: string; role?: string } | null;
}

export interface BoardPostPromotionState {
  expectedParentRevision: number | null;
}

export interface Report {
  id: number;
  target_type: "post" | "comment";
  target_id: number;
  reason: string;
  detail?: string | null;
  reporter_ip?: string | null;
  reporter_id?: string | null;
  status: "pending" | "resolved" | "dismissed";
  admin_note?: string | null;
  created_at: string;
}
