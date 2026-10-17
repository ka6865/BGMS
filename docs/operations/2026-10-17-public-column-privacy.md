# 공개 키로 읽히는 칸 축소 (2026-10-17)

## 배경

2026-10-16 외부 스캔(튀르키예, 공개 키 사용)이 `profiles`·`posts`·`comments`를 각 1행씩 읽었다. 점검 결과 다음 칸이 누구에게나 읽혔다.

- `posts.ip_address`, `comments.ip_address`: 작성자 IP 원문. 화면은 `maskIp()`로 앞 두 자리만 보였지만 DB는 원문을 내보냈다.
- `posts.password_hash`, `comments.password_hash`: 값은 제약으로 항상 비어 있지만 칸은 공개였다.
- `profiles.pubg_nickname`, `pubg_platform`, `last_active_at`, `updated_at`: 회원과 배그 계정 연결, 접속 시각.

## 변경

1. `20261017010000_public_column_privacy_prepare`(기존 코드와 호환)
   - `posts.ip_masked`, `comments.ip_masked`: `ip_address`에서 앞 두 덩어리만 남기는 생성 칸(stored).
   - `public.get_my_profile()`: 로그인 사용자 본인 행 전체를 돌려주는 SECURITY DEFINER 함수. `authenticated`, `service_role`만 실행.
2. 앱 코드
   - 게시판 공개 조회는 `ip_address:ip_masked`로 읽는다(`lib/board/publicFields.ts`, `app/board/page.tsx`). 응답 필드 이름은 그대로다.
   - 본인 프로필 전체가 필요한 곳(헤더, 마이페이지, 지도, 전적 검색 기본값)은 `rpc("get_my_profile")`을 쓴다. 역할·닉네임만 필요한 곳은 해당 칸만 읽는다.
   - 마이페이지 글·댓글 수는 `select('id', { head: true })`로 센다.
3. `20261017020000_public_column_privacy_revoke`(앱 배포 후)
   - `posts`, `comments`, `profiles`의 표 단위 SELECT를 `anon`, `authenticated`에서 회수하고 공개 칸만 칸 단위로 다시 준다.
   - `profiles`의 `anon` 쓰기 권한을 없애고, `authenticated`는 `nickname`, `avatar_url`, `pubg_nickname`, `pubg_platform`, `updated_at`, `last_active_at`만 수정할 수 있다(`role`은 트리거도 막는다).

## 2026-10-17 장애와 후속

- `20261017020000` 적용 직후 웹 게시판 목록이 비었다. `comments(count)` 같은 embed 집계는 PostgreSQL에서 표 단위 SELECT 권한이 필요해 칸 단위 권한만 있는 공개 키 조회가 `42501`로 실패했다. `count: 'exact'`(HEAD) 조회는 영향이 없었다.
- `20261017030000_comments_count_hotfix`로 `comments` 표 단위 SELECT를 임시로 되돌려 복구했다(당시 IP 보유 댓글 0건).
- 게시판 목록은 `comments(id)` 목록 길이로 댓글 수를 센다. 배포 후 `20261017040000_comments_column_privacy_reapply`로 다시 칸 단위로 줄인다.
- 공개 키로 `posts`·`comments`·`profiles`에 `(count)` embed 집계를 쓰지 않는다. 필요하면 서버 권한 조회나 전용 함수를 쓴다.

## 주의

- 세 표에 새 칸을 추가하면 기본은 비공개다. 공개가 필요하면 migration에서 칸 단위로 grant 한다.
- 공개 키로 이 표들을 `select('*')`하면 권한 오류가 난다. 필요한 칸을 명시한다.
- 서버 권한(service role) 조회와 DB 함수는 영향이 없다. 비공개 칸을 읽는 DB 함수는 모두 서버 전용이다.
- 백업(`scripts/backup_core_tables.ts`)은 `ip_masked`도 담는다. 복원할 때 생성 칸은 넣지 않는다.

## 배포 순서

1. 준비 migration 적용(운영, 개별 적용 절차는 `2026-10-10-remaining-review-fixes.md`).
2. 앱 배포.
3. 회수 migration 적용(`20261017020000`, 장애 후속 `20261017040000`). 적용 후 공개 키로 `profiles?select=pubg_nickname`, `posts?select=ip_address`가 401/403(권한 오류)인지, 게시판·마이페이지·헤더가 정상인지 확인한다.

## 검증

`npm run verify:migrations`(`public-column-privacy-checks.sql`, `board-credential-privacy.sql`), `tests/board-public-fields-privacy.test.ts`, `npm run test:unit`, `npm run verify:core`.
