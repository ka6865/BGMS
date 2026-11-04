# 2026-11-04 아이브 화물·큐티 파이 상자 추가 (공식 확률표 #44.1)

- 출처: 공식 확률표 https://pubg.com/ko/game-info/probability/pc/11366, 제작 목록은 공식 공지 https://pubg.com/ko/news/11307
- 카탈로그: `data/crates/pubg-44-1.json` (신규 상자 2종만 포함. 나머지 상자는 `pubg-43-2.json` 구성 유지)
  - 아이브 화물(loot_crate, 93종, 아이브 토큰 15개), 큐티 파이 - 밀수품 상자(contraband, 53종, 스크랩 10개)
  - 아이브 특수 제작(`2026_ive`, 18종)
- 이벤트 토큰은 종류(`bonus_currency_code`)별 잔액을 따로 가진다. 벤틀리·아이브 토큰이 섞이지 않는다.

## 운영 적용 순서

1. 이미지 업로드(R2): `npx tsx scripts/sync_crates.ts --catalog data/crates/pubg-44-1.json --upload-images`
2. migration을 순서대로 파일 하나씩 적용: `20261104000000_sync_crates_pubg_44_1.sql` → `20261104000100_ive_crafting_items.sql`
3. 상자 목록 캐시 키가 `pubg-44-1`로 바뀌므로 배포 후 새 목록이 노출된다.

공식 표와의 대조: `--verify-official <html>`(공식 페이지 HTML 저장본)로 전 행을 검증한다.
