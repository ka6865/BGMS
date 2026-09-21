import type { DivIcon } from "leaflet";

export interface MapMarker {
  id: string | number;
  name: string;
  type: string;
  x: number;
  y: number;
  mapId: string;
  [key: string]: unknown;
}

export interface UserProfile {
  id?: string;
  nickname: string;
  pubg_nickname?: string;
  pubg_platform?: string;
  role?: string;
}

export interface AuthUser {
  id: string;
  email?: string;
}

// 앱 전반에서 사용하는 공통 유저 타입 (Supabase User와 호환)
export interface CurrentUser {
  id: string;
  email?: string;
  nickname?: string;
  pubg_nickname?: string;
  pubg_platform?: string;
}

export interface PendingVehicle {
  id: string | number;
  x: number;
  y: number;
  map_name: string;
  marker_type: string;
  weight?: number;
  contributor_ids?: string[];
  down_weight?: number;
  downvoter_ids?: string[];
  is_down_notified?: boolean;
  [key: string]: unknown;
}

export interface NotificationItem {
  id: string | number;
  user_id: string;
  sender_name: string;
  type: "reply" | "comment" | "support_reply";
  post_id: string | number | null;
  support_ticket_id?: string | null;
  is_read: boolean;
  preview_text?: string;
  created_at: string;
}

export interface MapTab {
  id: string;
  label: string;
  imageUrl: string;
}

export interface MapFilters {
  [key: string]: boolean;
}

export interface MapViewProps {
  activeMapId: string;
  currentMap: MapTab | undefined;
  bounds: [[number, number], [number, number]];
  visibleVehicles: MapMarker[];
  icons: Record<string, DivIcon>;
  imageHeight: number;
  imageWidth: number;
}
