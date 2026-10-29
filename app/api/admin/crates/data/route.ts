import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { revalidateTag } from "next/cache";
import { resolveCrateAssetFields } from "@/lib/crates/assetMapping";

function buildAssetPayload(row: any) {
  const assetFields = resolveCrateAssetFields(row);
  return {
    ...assetFields,
    display_name: row.name,
    image_url: row.image_url || "",
    aliases: [row.name].filter(Boolean),
  };
}

function buildTemplatePayload(template: any, assetIdByKey = new Map<string, string>()) {
  const assetFields = resolveCrateAssetFields(template);
  return {
    ...assetFields,
    asset_id: assetIdByKey.get(assetFields.asset_key) || template.asset_id || null,
    id: template.id,
    name: template.name,
    type: template.type,
    price_gcoin: Number(template.price_gcoin || 0),
    bundle_price_gcoin: Number(template.bundle_price_gcoin || 0),
    price_bp: template.price_bp !== undefined && template.price_bp !== null && template.price_bp !== "" ? Number(template.price_bp) : null,
    price_bp_limit: template.price_bp_limit !== undefined && template.price_bp_limit !== null && template.price_bp_limit !== "" ? Number(template.price_bp_limit) : null,
    ticket_currency_code: template.ticket_currency_code || null,
    ticket_price_single: template.ticket_price_single !== undefined && template.ticket_price_single !== null && template.ticket_price_single !== "" ? Number(template.ticket_price_single) : null,
    ticket_price_bundle: template.ticket_price_bundle !== undefined && template.ticket_price_bundle !== null && template.ticket_price_bundle !== "" ? Number(template.ticket_price_bundle) : null,
    bonus_currency_code: template.bonus_currency_code || null,
    bonus_amount_single: template.bonus_amount_single !== undefined && template.bonus_amount_single !== null && template.bonus_amount_single !== "" ? Number(template.bonus_amount_single) : null,
    bonus_amount_bundle: template.bonus_amount_bundle !== undefined && template.bonus_amount_bundle !== null && template.bonus_amount_bundle !== "" ? Number(template.bonus_amount_bundle) : null,
    image_url: template.image_url || "",
    description: template.description || "",
    active: template.active === true || template.active === "true",
    end_date: template.end_date || null
  };
}

function buildCrateItemPayload(templateId: string, item: any, assetIdByKey = new Map<string, string>()) {
  const assetFields = resolveCrateAssetFields(item);
  return {
    ...assetFields,
    asset_id: assetIdByKey.get(assetFields.asset_key) || item.asset_id || null,
    crate_template_id: templateId,
    name: item.name,
    rarity: item.rarity,
    probability: Number(item.probability),
    image_url: item.image_url || "",
    is_prime_parcel: item.is_prime_parcel === true || item.is_prime_parcel === "true",
    token_count: Number(item.token_count || 0)
  };
}

function buildPrimeItemPayload(templateId: string, item: any, assetIdByKey = new Map<string, string>()) {
  const assetFields = resolveCrateAssetFields(item);
  return {
    ...assetFields,
    asset_id: assetIdByKey.get(assetFields.asset_key) || item.asset_id || null,
    crate_template_id: templateId,
    name: item.name,
    rarity: item.rarity,
    probability: Number(item.probability),
    image_url: item.image_url || ""
  };
}

function buildBonusItemPayload(templateId: string, item: any, assetIdByKey = new Map<string, string>()) {
  const assetFields = resolveCrateAssetFields(item);
  return {
    ...assetFields,
    asset_id: assetIdByKey.get(assetFields.asset_key) || item.asset_id || null,
    crate_template_id: templateId,
    name: item.name,
    probability: Number(item.probability),
    token_count: Number(item.token_count || 0),
    is_prime_parcel: item.is_prime_parcel === true || item.is_prime_parcel === "true",
    is_extra_crate: item.is_extra_crate === true || item.is_extra_crate === "true",
    image_url: item.image_url || ""
  };
}

async function upsertCrateAssets(supabaseAdmin: any, rows: any[]) {
  const assetsByKey = new Map<string, ReturnType<typeof buildAssetPayload>>();
  rows.forEach((row) => {
    const asset = buildAssetPayload(row);
    if (asset.asset_key) assetsByKey.set(asset.asset_key, asset);
  });

  const assets = Array.from(assetsByKey.values());
  if (assets.length === 0) return new Map<string, string>();

  const { error } = await supabaseAdmin
    .from("crate_item_assets")
    .upsert(assets, { onConflict: "asset_key" });

  if (error) throw new Error(`아이템 이미지 매핑 저장 실패: ${error.message}`);

  const { data, error: selectError } = await supabaseAdmin
    .from("crate_item_assets")
    .select("id, asset_key")
    .in("asset_key", assets.map((asset) => asset.asset_key));

  if (selectError) throw new Error(`아이템 이미지 매핑 조회 실패: ${selectError.message}`);

  return new Map<string, string>((data || []).map((asset: any) => [asset.asset_key, asset.id]));
}

// 1. GET: 은신처 상점 목록 및 세부 정보 로드
export async function GET(request: Request) {
  const adminContext = await requireAdmin();
  if (!adminContext.ok) return adminContext.error;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  try {
    // 특정 상자의 상세 구성품 목록 로드
    if (id) {
      const { data: template, error: tErr } = await adminContext.supabaseAdmin
        .from("crate_templates")
        .select("*")
        .eq("id", id)
        .single();
      
      if (tErr || !template) {
        throw new Error(tErr?.message || "상자 템플릿을 찾을 수 없습니다.");
      }

      // 1차 구성품 조회
      const { data: items } = await adminContext.supabaseAdmin
        .from("crate_items")
        .select("*")
        .eq("crate_template_id", id)
        .order("probability", { ascending: false });

      // 2차 최고급 꾸러미 구성품 조회
      const { data: primeItems } = await adminContext.supabaseAdmin
        .from("prime_parcel_items")
        .select("*")
        .eq("crate_template_id", id)
        .order("probability", { ascending: false });

      // 보너스 아이템 조회
      const { data: bonusItems } = await adminContext.supabaseAdmin
        .from("bonus_items")
        .select("*")
        .eq("crate_template_id", id)
        .order("probability", { ascending: false });

      return NextResponse.json({
        template,
        items: items || [],
        prime_parcel_items: primeItems || [],
        bonus_items: bonusItems || []
      });
    }

    // 전체 상자 템플릿 목록 로드
    const { data: templates, error: tErr } = await adminContext.supabaseAdmin
      .from("crate_templates")
      .select("*")
      .order("created_at", { ascending: false });

    if (tErr) throw new Error(tErr.message);

    return NextResponse.json(templates || []);

  } catch (error: any) {
    console.error("Crates load error:", error?.message || error);
    return NextResponse.json({ error: "상자 데이터를 불러오지 못했습니다." }, { status: 500 });
  }
}

// 2. POST: 은신처 상자 및 하위 아이템 일괄 Upsert
export async function POST(request: Request) {
  const adminContext = await requireAdmin();
  if (!adminContext.ok) return adminContext.error;

  try {
    const body = await request.json();
    const { template, items, prime_parcel_items, bonus_items } = body;

    if (!template || !template.name) {
      return NextResponse.json({ error: "상자 기본 정보가 누락되었습니다." }, { status: 400 });
    }

    const templateId = template.id;

    // A. 상자 템플릿 정보 저장
    const assetIdByKey = await upsertCrateAssets(adminContext.supabaseAdmin, [
      template,
      ...(items || []),
      ...(prime_parcel_items || []),
      ...(bonus_items || []),
    ]);
    const templatePayload = buildTemplatePayload(template, assetIdByKey);

    const { error: tErr } = await adminContext.supabaseAdmin
      .from("crate_templates")
      .upsert(templatePayload);

    if (tErr) throw new Error(`상자 정보 저장 실패: ${tErr.message}`);

    // B. 1차 구성품 (crate_items) 동기화 (기존 데이터 일괄 삭제 후 새 데이터 Insert)
    await adminContext.supabaseAdmin
      .from("crate_items")
      .delete()
      .eq("crate_template_id", templateId);

    if (items && items.length > 0) {
      const itemsToInsert = items.map((item: any) => buildCrateItemPayload(templateId, item, assetIdByKey));

      const { error: itemsErr } = await adminContext.supabaseAdmin
        .from("crate_items")
        .insert(itemsToInsert);
      
      if (itemsErr) throw new Error(`1차 구성품 저장 실패: ${itemsErr.message}`);
    }

    // C. 2차 최고급 꾸러미 (prime_parcel_items) 동기화 (전리품 상자일 때만 수행)
    await adminContext.supabaseAdmin
      .from("prime_parcel_items")
      .delete()
      .eq("crate_template_id", templateId);

    if (template.type === "loot_crate" && prime_parcel_items && prime_parcel_items.length > 0) {
      const primeToInsert = prime_parcel_items.map((pItem: any) => buildPrimeItemPayload(templateId, pItem, assetIdByKey));

      const { error: primeErr } = await adminContext.supabaseAdmin
        .from("prime_parcel_items")
        .insert(primeToInsert);

      if (primeErr) throw new Error(`최고급 꾸러미 구성품 저장 실패: ${primeErr.message}`);
    }

    // D. 보너스 구성품 (bonus_items) 동기화
    await adminContext.supabaseAdmin
      .from("bonus_items")
      .delete()
      .eq("crate_template_id", templateId);

    if (bonus_items && bonus_items.length > 0) {
      const bonusToInsert = bonus_items.map((bItem: any) => buildBonusItemPayload(templateId, bItem, assetIdByKey));

      const { error: bonusErr } = await adminContext.supabaseAdmin
        .from("bonus_items")
        .insert(bonusToInsert);

      if (bonusErr) throw new Error(`보너스 구성품 저장 실패: ${bonusErr.message}`);
    }

    // E. Next.js ISR 캐시 강제 만료 처리
    revalidateTag("crate-data", "max");

    return NextResponse.json({ success: true, id: templateId });

  } catch (error: any) {
    console.error("Crates save error:", error);
    return NextResponse.json({ error: "상자 데이터를 저장하지 못했습니다." }, { status: 500 });
  }
}

// 3. DELETE: 은신처 상자 삭제 (ON DELETE CASCADE로 하위 데이터는 자동 제거됨)
export async function DELETE(request: Request) {
  const adminContext = await requireAdmin();
  if (!adminContext.ok) return adminContext.error;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "삭제할 상자의 ID가 필요합니다." }, { status: 400 });
  }

  try {
    const { error } = await adminContext.supabaseAdmin
      .from("crate_templates")
      .delete()
      .eq("id", id);

    if (error) throw new Error(error.message);

    // Next.js ISR 캐시 무효화
    revalidateTag("crate-data", "max");

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error("Crates delete error:", error);
    return NextResponse.json({ error: "상자를 삭제하지 못했습니다." }, { status: 500 });
  }
}
