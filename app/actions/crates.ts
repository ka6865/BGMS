"use server";

import { createClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";
import type { CrateRarity, CrateTemplate } from "@/types/crates";
import { resolveCrateAssetFields } from "@/lib/crates/assetMapping";

const cleanEnv = (val: string | undefined) => (val || '').replace(/['";\s]+/g, '').trim();

const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// Create a static public client that does not use cookies()
const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * 활성화 상태인 가챠 상자와 그 하위 구성품(1차/2차) 데이터를 Supabase에서 조회합니다.
 * unstable_cache를 활용해 7일 동안 캐싱하며, 'crate-data' 태그로 Revalidation을 지원합니다.
 */
export const getActiveCrates = unstable_cache(
  async (): Promise<CrateTemplate[]> => {
    try {
      // 1. 활성화 상태의 상자 템플릿 로드
      const { data: templates, error: templateError } = await supabase
        .from("crate_templates")
        .select("*")
        .eq("active", true)
        .order("created_at", { ascending: false });

      if (templateError || !templates) {
        throw new Error(templateError?.message || "Failed to load crate templates");
      }

      const result: CrateTemplate[] = [];

      for (const t of templates) {
        // 2. 해당 상자 템플릿의 모든 아이템 관계 및 자산 조회 (M:N 정규화 구조)
        const { data: relations, error: relationsError } = await supabase
          .from("crate_item_relations")
          .select(`
            id,
            drop_type,
            probability,
            token_count,
            is_prime_parcel,
            is_extra_crate,
            crate_item_assets (
              id,
              asset_key,
              display_name,
              normalized_name,
              r2_key,
              image_url,
              rarity
            )
          `)
          .eq("crate_template_id", t.id);

        if (relationsError) {
          console.error(`Error loading relations for crate ${t.id}:`, relationsError.message);
        }

        const activeRelations = relations || [];

        // 3. drop_type별로 분류 및 매핑하여 기존 UI 컴포넌트 데이터 스펙과 동기화
        const items = activeRelations
          .filter((r) => r.drop_type === "base")
          .map((r) => {
            const asset = r.crate_item_assets as any;
            const itemData = {
              id: r.id, // 기존 API 호환을 위해 relation id를 고유 id로 제공
              name: asset?.display_name || "",
              asset_key: asset?.asset_key || "",
              normalized_name: asset?.normalized_name || "",
              r2_key: asset?.r2_key || "",
              asset_id: asset?.id || null,
              rarity: (asset?.rarity || "COMMON") as CrateRarity,
              probability: Number(r.probability),
              image_url: asset?.image_url || "",
              is_prime_parcel: r.is_prime_parcel,
              token_count: r.token_count || 0,
            };
            return {
              ...resolveCrateAssetFields(itemData),
              ...itemData,
            };
          })
          .sort((a, b) => b.probability - a.probability);

        const primeItems = activeRelations
          .filter((r) => r.drop_type === "prime")
          .map((r) => {
            const asset = r.crate_item_assets as any;
            const itemData = {
              id: r.id,
              name: asset?.display_name || "",
              asset_key: asset?.asset_key || "",
              normalized_name: asset?.normalized_name || "",
              r2_key: asset?.r2_key || "",
              asset_id: asset?.id || null,
              rarity: (asset?.rarity || "COMMON") as CrateRarity,
              probability: Number(r.probability),
              image_url: asset?.image_url || "",
            };
            return {
              ...resolveCrateAssetFields(itemData),
              ...itemData,
            };
          })
          .sort((a, b) => b.probability - a.probability);

        const bonusItems = activeRelations
          .filter((r) => r.drop_type === "bonus")
          .map((r) => {
            const asset = r.crate_item_assets as any;
            const itemData = {
              id: r.id,
              name: asset?.display_name || "",
              asset_key: asset?.asset_key || "",
              normalized_name: asset?.normalized_name || "",
              r2_key: asset?.r2_key || "",
              asset_id: asset?.id || null,
              probability: Number(r.probability),
              token_count: r.token_count || 0,
              is_prime_parcel: r.is_prime_parcel,
              is_extra_crate: r.is_extra_crate,
              image_url: asset?.image_url || "",
            };
            return {
              ...resolveCrateAssetFields(itemData),
              ...itemData,
            };
          })
          .sort((a, b) => b.probability - a.probability);

        result.push({
          ...resolveCrateAssetFields(t),
          id: t.id,
          name: t.name,
          asset_id: t.asset_id || null,
          type: t.type as "loot_crate" | "contraband",
          price_gcoin: t.price_gcoin,
          bundle_price_gcoin: t.bundle_price_gcoin,
          price_bp: t.price_bp,
          price_bp_limit: t.price_bp_limit,
          ticket_currency_code: t.ticket_currency_code,
          ticket_price_single: t.ticket_price_single,
          ticket_price_bundle: t.ticket_price_bundle,
          bonus_currency_code: t.bonus_currency_code,
          bonus_amount_single: t.bonus_amount_single,
          bonus_amount_bundle: t.bonus_amount_bundle,
          image_url: t.image_url || "",
          description: t.description || "",
          end_date: t.end_date,
          items,
          prime_parcel_items: primeItems,
          bonus_items: bonusItems,
        });
      }

      return result;
    } catch (error) {
      console.error("Error inside getActiveCrates Server Action:", error);
      return [];
    }
  },
  ["active-crates-data", "pubg-43-1"],
  {
    revalidate: 604800, // 7 days
    tags: ["crate-data"],
  }
);

/**
 * 특정 시즌에 속하는 제작소의 특수 제작 아이템 목록을 Supabase에서 조회합니다.
 * unstable_cache를 사용해 캐싱하여 속도를 극대화합니다.
 */
export const getCraftableItems = unstable_cache(
  async (seasonKey: string): Promise<any[]> => {
    try {
      const { data, error } = await supabase
        .from("craftable_items")
        .select(`
          id,
          season_key,
          display_name,
          token_cost,
          category,
          crate_item_assets (
            id,
            asset_key,
            display_name,
            normalized_name,
            r2_key,
            image_url,
            rarity
          )
        `)
        .eq("season_key", seasonKey)
        .order("token_cost", { ascending: false });

      if (error) {
        throw new Error(error.message);
      }

      return (data || []).map((item: any) => {
        const asset = item.crate_item_assets as any;
        return {
          name: item.display_name,
          tokenCost: item.token_cost,
          category: item.category,
          rarity: asset?.rarity || "LEGENDARY",
          image_url: asset?.image_url || "",
        };
      });
    } catch (error) {
      console.error("Error in getCraftableItems Server Action:", error);
      return [];
    }
  },
  ["craftable-items-data"],
  {
    revalidate: 604800, // 7 days
    tags: ["crate-data"],
  }
);
