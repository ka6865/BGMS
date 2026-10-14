import { CrateRarity } from "@/types/crates";

export interface DrawnCard {
  id: string;
  name: string;
  asset_key: string;
  normalized_name: string;
  r2_key: string;
  asset_id?: string | null;
  rarity: CrateRarity;
  image_url: string;
  isFromPrimeParcel: boolean;
  isBonus?: boolean;
  is_prime_parcel?: boolean;
  token_count?: number;
  probability?: number;
  bonus?: {
    id: string;
    name: string;
    asset_key: string;
    normalized_name: string;
    r2_key: string;
    asset_id?: string | null;
    rarity: CrateRarity;
    image_url: string;
    is_prime_parcel: boolean;
    is_extra_crate: boolean;
    token_count: number;
    probability?: number;
  };
}

export interface HistoryItem {
  id: string;
  name: string;
  rarity: CrateRarity;
  image_url: string;
  isFromPrimeParcel: boolean;
  isBonus: boolean;
  timestamp: Date;
}

export interface CraftableItem {
  name: string;
  asset_key: string | null;
  tokenCost: number;
  image_url: string;
  rarity: CrateRarity;
  category: string;
}
