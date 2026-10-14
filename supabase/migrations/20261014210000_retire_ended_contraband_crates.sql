-- 라이드 오어 다이·코스믹 칼리버 밀수품 상자는 PUBG #43.2 공식 확률표에서 빠져 판매가 끝났다.
-- 노출만 끄고 구성품과 개봉 기록은 보존한다.
UPDATE public.crate_templates SET active=false
WHERE (id, name) IN (
  ('d6b412a8-0a1b-43fe-a521-71fb342bcf32'::uuid, '라이드 오어 다이 - 밀수품 상자'),
  ('d6b412a8-0a1b-43fe-a521-71fb342bcf33'::uuid, '코스믹 칼리버 - 밀수품 상자')
);
