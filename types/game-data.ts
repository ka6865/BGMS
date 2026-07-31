/**
 * @fileoverview 인게임 아이템(무기, 소비품, 차량 등)의 데이터 구조를 정의하는 타입 파일입니다.
 * DB 스키마 검증 및 백팩 인벤토리 시뮬레이터(장착/수납)에 활용됩니다.
 */

/** 게임 내 아이템의 대분류 카테고리 */
export type ItemCategory = "weapons" | "consumables" | "throwables" | "attachments" | "ammo" | "vehicles" | "crates" | "system" | "users" | "weapon-patch";

export interface UserProfile {
  id: string;
  nickname: string | null;
  avatar_url: string | null;
  role: string | null;
  pubg_nickname: string | null;
  pubg_platform: string | null;
  updated_at: string | null;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string;
  last_active_at?: string | null; // 🌟 실시간 접속/활동 시각 추가
  provider?: string;
  email_confirmed?: boolean;
  is_missing_profile?: boolean;
}

export interface BaseGameItem {
  id: string;
  name: string;
  patch_notes?: string;
  patch_version?: string | null;
  patch_applied_at?: string | null;
  weight?: number;
  can_be_in_backpack?: boolean;
  /** 게임에서 제거된 항목의 삭제 시각. null 이면 현역입니다. */
  removed_at?: string | null;
  /** 어느 패치에서 제거되었는지. 도감에 단종 배지로 표시합니다. */
  removed_patch_version?: string | null;
}

export interface Weapon extends BaseGameItem {
  damage?: number;
  ammo?: string;
  type: "AR" | "DMR" | "SR" | "SMG" | "SG" | "HG" | "Melee" | "Other" | "LMG" | "ALL";
  bullet_speed?: number;
  availability?: string;
}

export interface Vehicle extends BaseGameItem {
  trunk_capacity: number;
}

export interface Consumable extends BaseGameItem {
  type?: string;
  heal_amount?: number;
  cast_time?: number;
}

export interface Ammo extends BaseGameItem {
  type: string;
}

export type GameItem = BaseGameItem | Weapon | Vehicle | Consumable | Ammo | UserProfile;
