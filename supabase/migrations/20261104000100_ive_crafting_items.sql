-- 특수 제작: https://pubg.com/ko/news/11307
-- Images: source URLs are recorded in data/crates/pubg-44-1.json.
BEGIN;
INSERT INTO public.crate_item_assets (asset_key, display_name, normalized_name, r2_key, image_url, rarity) VALUES
('pubgitems_13001683_imprint_x1', '아이브 안유진 세트 도안', '아이브_안유진_세트_도안', 'crates/pubgitems-13001683.webp', '/api/images/crates/pubgitems-13001683.webp', 'LEGENDARY'),
('pubgitems_13001681_imprint_x1', '아이브 가을 세트 도안', '아이브_가을_세트_도안', 'crates/pubgitems-13001681.webp', '/api/images/crates/pubgitems-13001681.webp', 'LEGENDARY'),
('pubgitems_13001680_imprint_x1', '아이브 레이 세트 도안', '아이브_레이_세트_도안', 'crates/pubgitems-13001680.webp', '/api/images/crates/pubgitems-13001680.webp', 'LEGENDARY'),
('pubgitems_13001682_imprint_x1', '아이브 장원영 세트 도안', '아이브_장원영_세트_도안', 'crates/pubgitems-13001682.webp', '/api/images/crates/pubgitems-13001682.webp', 'LEGENDARY'),
('pubgitems_13001685_imprint_x1', '아이브 리즈 세트 도안', '아이브_리즈_세트_도안', 'crates/pubgitems-13001685.webp', '/api/images/crates/pubgitems-13001685.webp', 'LEGENDARY'),
('pubgitems_13001684_imprint_x1', '아이브 이서 세트 도안', '아이브_이서_세트_도안', 'crates/pubgitems-13001684.webp', '/api/images/crates/pubgitems-13001684.webp', 'LEGENDARY'),
('pubgitems_13001690_imprint_x1', '아이브 기어 세트 도안', '아이브_기어_세트_도안', 'crates/pubgitems-13001690.webp', '/api/images/crates/pubgitems-13001690.webp', 'LEGENDARY'),
('pubgitems_13001691_imprint_x1', '아이브 무기 세트 도안', '아이브_무기_세트_도안', 'crates/pubgitems-13001691.webp', '/api/images/crates/pubgitems-13001691.webp', 'EPIC'),
('pubgitems_13001686_imprint_x1', '아이브 ELEVEN 이모트 세트 도안', '아이브_eleven_이모트_세트_도안', 'crates/pubgitems-13001686.webp', '/api/images/crates/pubgitems-13001686.webp', 'EPIC'),
('pubgitems_13001687_imprint_x1', '아이브 LOVE DIVE 이모트 세트 도안', '아이브_love_dive_이모트_세트_도안', 'crates/pubgitems-13001687.webp', '/api/images/crates/pubgitems-13001687.webp', 'EPIC'),
('pubgitems_13001688_imprint_x1', '아이브 BANG BANG 이모트 세트 도안', '아이브_bang_bang_이모트_세트_도안', 'crates/pubgitems-13001688.webp', '/api/images/crates/pubgitems-13001688.webp', 'EPIC'),
('pubgitems_13001689_imprint_x1', '아이브 BLACKHOLE 이모트 세트 도안', '아이브_blackhole_이모트_세트_도안', 'crates/pubgitems-13001689.webp', '/api/images/crates/pubgitems-13001689.webp', 'EPIC'),
('pubgitems_14300066_x1', '아이브 화물 티켓', '아이브_화물_티켓', 'crates/pubgitems-14300066.webp', '/api/images/crates/pubgitems-14300066.webp', 'COMMON'),
('pubgitems_credit_x6000', '크레딧 x6000', '크레딧_x6000', 'crates/pubgitems-credit.webp', '/api/images/crates/pubgitems-credit.webp', 'COMMON')
ON CONFLICT (asset_key) DO UPDATE SET display_name=EXCLUDED.display_name, normalized_name=EXCLUDED.normalized_name,
  r2_key=EXCLUDED.r2_key, image_url=EXCLUDED.image_url, rarity=EXCLUDED.rarity;

DELETE FROM public.craftable_items WHERE season_key='2026_ive';

INSERT INTO public.craftable_items (season_key, display_name, token_cost, category, asset_id)
SELECT '2026_ive', v.display_name, v.token_cost, v.category, a.id
FROM (VALUES
('아이브 안유진 세트 도안', 2000, '세트', 'pubgitems_13001683_imprint_x1'),
('아이브 가을 세트 도안', 2000, '세트', 'pubgitems_13001681_imprint_x1'),
('아이브 레이 세트 도안', 2000, '세트', 'pubgitems_13001680_imprint_x1'),
('아이브 장원영 세트 도안', 2000, '세트', 'pubgitems_13001682_imprint_x1'),
('아이브 리즈 세트 도안', 2000, '세트', 'pubgitems_13001685_imprint_x1'),
('아이브 이서 세트 도안', 2000, '세트', 'pubgitems_13001684_imprint_x1'),
('아이브 기어 세트 도안', 1000, '세트', 'pubgitems_13001690_imprint_x1'),
('아이브 무기 세트 도안', 1000, '세트', 'pubgitems_13001691_imprint_x1'),
('아이브 ELEVEN 이모트 세트 도안', 500, '이모트', 'pubgitems_13001686_imprint_x1'),
('아이브 LOVE DIVE 이모트 세트 도안', 500, '이모트', 'pubgitems_13001687_imprint_x1'),
('아이브 BANG BANG 이모트 세트 도안', 500, '이모트', 'pubgitems_13001688_imprint_x1'),
('아이브 BLACKHOLE 이모트 세트 도안', 500, '이모트', 'pubgitems_13001689_imprint_x1'),
('장인 토큰 x100', 750, '재화', NULL),
('아이브 화물 티켓', 200, '재화', 'pubgitems_14300066_x1'),
('크레딧 x6000', 200, '재화', 'pubgitems_credit_x6000'),
('열쇠 x3', 180, '재화', NULL),
('열쇠', 60, '재화', NULL),
('열쇠 조각', 20, '재화', NULL)
) AS v(display_name, token_cost, category, asset_key)
LEFT JOIN public.crate_item_assets a ON a.asset_key=v.asset_key;

DO $$ BEGIN
  IF (SELECT count(*) FROM public.craftable_items WHERE season_key='2026_ive') <> 18
    OR EXISTS (SELECT 1 FROM public.craftable_items WHERE season_key='2026_ive'
      AND asset_id IS NULL AND display_name NOT IN ('장인 토큰 x100', '열쇠 x3', '열쇠', '열쇠 조각')) THEN
    RAISE EXCEPTION 'Crafting import failed: invalid item count or missing asset';
  END IF;
END $$;
COMMIT;
